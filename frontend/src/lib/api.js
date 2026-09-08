/* ============================================================
   ATLAS IELTS Academy — API client

   ⚠ CONTRACT FILE: every endpoint below is the single source of
   truth for the whole build. Module views (Batches 5–8) call ONLY
   these helpers, and the FastAPI backend (Batches 9–11) implements
   ONLY these paths. If either side changes, change it here first.

   Endpoint map
   ────────────
   POST /auth/guest | /auth/register | /auth/login   GET /auth/me
   GET/PUT /profile                                POST /days/advance
   GET/PUT /days/:phase/:day                       GET  /history
   POST /reading/generate · /reading/questions · /reading/insight
   POST /listening/generate · /listening/questions
   POST /warmup/reading · /warmup/listening        (§8.3 retrieval warm-ups)
   POST /writing/generate · /writing/grade (multipart)
        · /writing/model-answer · /writing/image    (§14, process/map only)
   POST /speaking/generate · /speaking/feedback     (§7.5)
   POST /tts  {text, voice} → audio blob            (§13.1 Kokoro)
   POST /stt  multipart audio → {text}              (§13.4 Whisper)
   ============================================================ */

import { sleep } from './utils.js';

export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const TOKEN_KEY = 'atlas_token'; // additive to §10.4 — auth lives server-side

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* private mode */ }

export const getToken = () => token;
export function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}
export const clearToken = () => setToken(null);

export class ApiError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT = 30_000;   // profile / history / day fetches
const GEN_TIMEOUT = 240_000;      // AI content generation can take minutes
const GRADE_TIMEOUT = 300_000;    // writing photo/PDF two-step grading

function fallbackMessage(status) {
  if (status === 0) return 'No connection to the server — check your internet and try again.';
  if (status === 400) return 'That request looked malformed — please refresh and try again.';
  if (status === 401) return 'Your session expired — signing you in again.';
  if (status === 403) return 'You don\'t have access to that.';
  if (status === 404) return 'That wasn\'t found on the server.';
  if (status === 409) return 'The server refused that — your data may be out of sync; refreshing usually fixes it.';
  if (status === 429) return 'The AI is busy right now — trying again in a moment.';
  if (status >= 500) return 'The coach is unreachable right now. Give it a moment and try again.';
  return 'Something went wrong — please try again.';
}

async function throwApiError(res) {
  let detail = null;
  try { detail = await res.json(); } catch { /* non-JSON body */ }
  const raw = detail && (detail.detail || detail.message);
  const msg = typeof raw === 'string' && raw.trim() ? raw : fallbackMessage(res.status);
  throw new ApiError(msg, res.status, detail);
}

async function attempt(path, opts) {
  const {
    method = 'GET', body, formData,
    timeoutMs = DEFAULT_TIMEOUT, expect = 'json', signal,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!formData && body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
    if (!res.ok) await throwApiError(res);
    if (expect === 'blob') return res.blob();
    if (res.status === 204) return null;
    return res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw err; // the caller cancelled — propagate, never retry
      throw new ApiError('That took too long — the AI may be slower than usual. Try again in a moment.', 408);
    }
    throw new ApiError(fallbackMessage(0), 0); // network failure
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

function retriable(err) {
  if (!(err instanceof ApiError)) return true;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}

/* ── SSE streaming request (§7.9 Conversation Coach) ────────── */

/**
 * POST with a JSON body; the reply is a text/event-stream of
 * `data: {json}` frames. onDelta fires per text delta AS IT ARRIVES
 * (this is the whole point — feedback starts speaking while the
 * model is still writing). Resolves with the full accumulated text.
 * No auto-retry: a stream that already delivered text must not be
 * restarted from zero.
 */
async function streamRequest(path, body, { onDelta, timeoutMs = GEN_TIMEOUT, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  headers['Content-Type'] = 'application/json';

  let text = '';
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) await throwApiError(res);

    const reader = res.body?.getReader();
    if (!reader) throw new ApiError(fallbackMessage(0), 0);
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5)); } catch { continue; }
          if (evt.type === 'delta' && evt.text) {
            text += evt.text;
            onDelta?.(evt.text, text);
          } else if (evt.type === 'error') {
            throw new ApiError(evt.detail || fallbackMessage(res.status), res.status);
          }
          // 'done' — nothing to do; the stream closes next
        }
      }
    }
    return text;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw err;
      // Timeout mid-stream: the partial text is still usable by the caller.
      return text;
    }
    throw new ApiError(fallbackMessage(0), 0);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function request(path, opts = {}) {
  const attempts = opts.method === 'GET' ? 3 : 2; // one retry for POSTs, two for GETs
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt(path, opts);
    } catch (err) {
      lastErr = err;
      if (i === attempts || !retriable(err)) throw err;
      await sleep(700 * 2 ** (i - 1) + Math.random() * 300);
    }
  }
  throw lastErr;
}

/* ── The contract (see header map) ─────────────────────────── */

export const api = {
  auth: {
    guest: () => request('/auth/guest', { method: 'POST' }),
    register: (email, password) =>
      request('/auth/register', { method: 'POST', body: { email, password } }),
    login: (email, password) =>
      request('/auth/login', { method: 'POST', body: { email, password } }),
    me: () => request('/auth/me'),
  },

  profile: {
    get: () => request('/profile'),
    /** Accepts a full profile object or a patch; returns the stored profile. */
    update: (profileOrPatch) =>
      request('/profile', { method: 'PUT', body: profileOrPatch }),
  },

  days: {
    get: (phase, day) => request(`/days/${phase}/${day}`),
    put: (phase, day, record) =>
      request(`/days/${phase}/${day}`, { method: 'PUT', body: record }),
    /**
     * §2.3 advance — server-authoritative: it verifies all four modules
     * are done, appends the history entry, updates streak/phase, rolls
     * Day 150 → Mock Day 1, and marks Day 270 complete.
     * Returns { profile, day, history }.
     */
    advance: () => request('/days/advance', { method: 'POST', timeoutMs: 60_000 }),
  },

  history: { list: () => request('/history') },

  reading: {
    /** §4.4 call 1 — passages + 30 vocabulary items. */
    generate: (payload) =>
      request('/reading/generate', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /** §4.4 call 2 — 40 questions against the finished passages. */
    questions: (payload) =>
      request('/reading/questions', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /** §4.5 warm coaching insight on missed questions. */
    insight: (payload) =>
      request('/reading/insight', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
  },

  listening: {
    /** §5.5 call 1 — 4 transcripts with per-speaker Kokoro voices (§13.3). */
    generate: (payload) =>
      request('/listening/generate', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /** §5.5 call 2 — 40 questions with exact-wording answer keys. */
    questions: (payload) =>
      request('/listening/questions', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
  },

  warmup: {
    /** §8.3 — 2–3 retrieval questions rebuilt from yesterday's misses. */
    reading: (missed) =>
      request('/warmup/reading', { method: 'POST', body: { missed }, timeoutMs: GEN_TIMEOUT }),
    listening: (missed) =>
      request('/warmup/listening', { method: 'POST', body: { missed }, timeoutMs: GEN_TIMEOUT }),
  },

  writing: {
    /** §6.2/§6.3 — task 1 (visual + chartData) + task 2 (essay type). */
    generate: (payload) =>
      request('/writing/generate', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /**
     * §6.5 grading. FormData fields: task1Text, task2Text (strings),
     * task1File / task2File (optional File), task1 / task2 (JSON strings
     * of the generated task objects).
     */
    grade: (formData) =>
      request('/writing/grade', { method: 'POST', formData, timeoutMs: GRADE_TIMEOUT }),
    /** §6.6 model answer — Training phase only (server enforces). */
    modelAnswer: (payload) =>
      request('/writing/model-answer', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /** §14.4 — illustrated process/map image; falls back to schematics client-side. */
    image: (chartData) =>
      request('/writing/image', { method: 'POST', body: { chartData }, timeoutMs: 120_000 }),
  },

  speaking: {
    /** §7.5 call 1 — whole round: part1[5], cueCard, part3[6] on one topic. */
    generate: (payload) =>
      request('/speaking/generate', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /** §7.6 per-answer feedback — runs after EVERY single answer. */
    feedback: (payload) =>
      request('/speaking/feedback', { method: 'POST', body: payload, timeoutMs: GEN_TIMEOUT }),
    /** §7.9 live Conversation Coach — streamed feedback (SSE deltas). */
    coachStream: (payload, handlers = {}) =>
      streamRequest('/speaking/coach/stream', payload, handlers),
  },

  /** §13.1 Kokoro-82M via backend → object URL for <audio>. */
  tts: async (text, voice, speed) => {
    const blob = await request('/tts', {
      method: 'POST', body: { text, voice, speed }, timeoutMs: 180_000, expect: 'blob',
    });
    return URL.createObjectURL(blob);
  },

  /** §13.4 Groq Whisper via backend. Returns { text } — the RAW transcript. */
  stt: (audioBlob, filename = 'answer.webm') => {
    const fd = new FormData();
    fd.append('file', audioBlob, filename);
    return request('/stt', { method: 'POST', formData: fd, timeoutMs: 120_000 });
  },
};