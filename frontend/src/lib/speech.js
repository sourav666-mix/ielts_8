/* ============================================================
   ATLAS IELTS Academy — voice engine (spec §13)

   TTS: Kokoro-82M via the backend on the same OpenRouter key
        (§13.1). Multi-speaker Listening parts play through a
        sequential SpeechPlayer so every speaker has their own
        voice (§13.2/§13.3). Browser speechSynthesis is the
        zero-cost safety net — a TTS outage never blocks a module
        (§13.5).

   STT: Web Speech API with live interim captions (§3.5) where
        supported; MediaRecorder → backend Whisper elsewhere
        (§13.4). Typed fallback lives in the Speaking view.

   HONESTY RULE (§13.4): transcripts are kept RAW — fillers,
        false starts and all. We never clean them before grading;
        only the displayed corrected version is cleaned, by the
        AI feedback itself.
   ============================================================ */

import { api } from './api.js';
import { THINKING_ACKS } from '../config/duplexConfig.js';

/** §13.5 — one consistent coach identity across all 270 days.
 *  The DEFAULT; the student's pick (VoicePicker) overrides it and
 *  persists in localStorage under VOICE_KEY. */
export const COACH_VOICE = 'af_heart';

const VOICE_KEY = 'atlas_voice';

/* The Kokoro-82M voice catalogue (server-side TTS, §13.1).
 * Every id matches voice.py's ^[ab][fm]_[a-z0-9]+$ validation. */
export const KOKORO_VOICES = [
  { id: 'af_heart',   name: 'Heart',   group: 'American · Female', tone: 'Warm & encouraging — the default coach' },
  { id: 'af_bella',   name: 'Bella',   group: 'American · Female', tone: 'Bright & upbeat' },
  { id: 'af_nicole',  name: 'Nicole',  group: 'American · Female', tone: 'Calm & steady' },
  { id: 'af_sarah',   name: 'Sarah',   group: 'American · Female', tone: 'Clear & precise' },
  { id: 'af_sky',     name: 'Sky',     group: 'American · Female', tone: 'Light & airy' },
  { id: 'am_adam',    name: 'Adam',    group: 'American · Male',   tone: 'Steady & grounded' },
  { id: 'am_michael', name: 'Michael', group: 'American · Male',   tone: 'Friendly & relaxed' },
  { id: 'am_fenrir',  name: 'Fenrir',  group: 'American · Male',   tone: 'Deep & resonant' },
  { id: 'am_puck',    name: 'Puck',    group: 'American · Male',   tone: 'Lively & playful' },
  { id: 'bf_emma',    name: 'Emma',    group: 'British · Female',  tone: 'Polished & composed' },
  { id: 'bf_isabella', name: 'Isabella', group: 'British · Female', tone: 'Graceful & warm' },
  { id: 'bm_george',  name: 'George',  group: 'British · Male',    tone: 'Distinguished & calm' },
  { id: 'bm_lewis',   name: 'Lewis',   group: 'British · Male',    tone: 'Clear & articulate' },
];

/** The student's chosen coach voice (falls back to the default). */
export function getCoachVoice() {
  try {
    const saved = localStorage.getItem(VOICE_KEY);
    return KOKORO_VOICES.some((v) => v.id === saved) ? saved : COACH_VOICE;
  } catch {
    return COACH_VOICE;
  }
}

/** Persist a voice choice. Returns the stored id (validated). */
export function setCoachVoice(id) {
  const valid = KOKORO_VOICES.some((v) => v.id === id) ? id : COACH_VOICE;
  try {
    localStorage.setItem(VOICE_KEY, valid);
  } catch { /* private mode — choice lives for this session only */ }
  return valid;
}

/* ── TTS: cached line audio ────────────────────────────────── */

const cache = new Map(); // `${voice}::${text}` → object URL
const CACHE_MAX = 80;

const cacheKey = (voice, text) => `${voice}::${text}`;

function evictOldest() {
  const oldest = cache.keys().next().value;
  const url = cache.get(oldest);
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  cache.delete(oldest);
}

async function lineAudio(text, voice) {
  const key = cacheKey(voice, text);
  if (cache.has(key)) return cache.get(key);
  const url = await api.tts(text, voice);
  if (cache.size >= CACHE_MAX) evictOldest();
  cache.set(key, url);
  return url;
}

/* ── Browser fallback synth (§13.5 safety net) ─────────────── */

function pickSynthVoice(voiceHint) {
  try {
    const voices = window.speechSynthesis.getVoices();
    const wantGB = voiceHint && (voiceHint.startsWith('bf') || voiceHint.startsWith('bm'));
    const lang = wantGB ? 'en-GB' : 'en-US';
    return (
      voices.find((v) => v.lang === lang) ||
      voices.find((v) => v.lang && v.lang.startsWith('en')) ||
      null
    );
  } catch {
    return null;
  }
}

export function browserSpeak(text, { voiceHint } = {}) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voiceHint && (voiceHint.startsWith('bf') || voiceHint.startsWith('bm')) ? 'en-GB' : 'en-US';
    const v = pickSynthVoice(voiceHint);
    if (v) u.voice = v;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(true); // resolve so callers' queues keep moving
    try { window.speechSynthesis.speak(u); } catch { resolve(true); }
  });
}

/* ── One-shot speaking (coach questions, cue card §7.4) ────── */
/* v2 §6: playback is INTERRUPTION-AWARE. stopAllSpeech() bumps a
 * session counter, so a queued line whose audio is still being
 * fetched never plays after a barge-in, and pausing the audio
 * element resolves as 'interrupted' — the coach can be stopped
 * mid-sentence, instantly. */

let singleAudio = null;
let speechSession = 0;      // bumped on every stop — stale plays become no-ops
let coachSpeaking = false;  // §12 — lets listeners ignore the coach's own audio

function playUrl(url) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    singleAudio = a;
    coachSpeaking = true;
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      coachSpeaking = false;
      resolve(why);
    };
    a.onended = () => done('ended');
    a.onerror = () => done('error');
    a.onpause = () => done('interrupted');  // §6 — external stop = barge-in
    a.play().catch(() => done('blocked'));
  });
}

/** True while coach audio (Kokoro or the browser fallback) is live. */
export function isCoachSpeaking() {
  return coachSpeaking;
}

export async function speakOnce(text, voice = getCoachVoice()) {
  if (!text) return false;
  const session = ++speechSession;
  try {
    const url = await lineAudio(text, voice);
    if (session !== speechSession) return 'interrupted'; // superseded while fetching
    const how = await playUrl(url);
    if (how === 'ended') return true;
    if (how === 'interrupted') return 'interrupted';     // never fall through to the synth
    return browserSpeak(text, { voiceHint: voice });
  } catch {
    if (session !== speechSession) return 'interrupted';
    return browserSpeak(text, { voiceHint: voice });
  }
}

/* ── Sequential multi-voice player (Listening §5.4) ────────── */

export class SpeechPlayer {
  /**
   * @param {object} [opts]
   * @param {(index:number, line:object)=>void} [opts.onLineStart]  highlight current line
   * @param {(state:string, index:number)=>void} [opts.onStateChange] 'playing'|'paused'|'finished'|'idle'
   */
  constructor({ onLineStart, onStateChange } = {}) {
    this.lines = [];
    this.index = -1;
    this.onLineStart = onLineStart;
    this.onStateChange = onStateChange;
    this._stopped = true;
    this._audio = null;
  }

  /**
   * Play an ordered list of transcript lines:
   * [{ text, voice, speaker }] — voices resolved server-side per
   * speaker (§13.3), so a 4-person Part 3 discussion genuinely
   * sounds like four different people.
   */
  async play(lines = []) {
    this.stop();
    this.lines = lines;
    this.index = 0;
    this._stopped = false;
    this._emit('playing', 0);
    while (this.index < this.lines.length && !this._stopped) {
      await this._playLine(this.index);
      this.index += 1;
    }
    if (!this._stopped) this._emit('finished', this.lines.length - 1);
    this._stopped = true;
    this._emit('idle', this.index);
  }

  async _playLine(i) {
    const line = this.lines[i];
    this.onLineStart?.(i, line);
    try {
      const url = await lineAudio(line.text, line.voice);
      if (this._stopped) return;
      // prefetch the next line while this one plays — no gap between turns
      const next = this.lines[i + 1];
      if (next) lineAudio(next.text, next.voice).catch(() => {});
      const result = await new Promise((resolve) => {
        const a = new Audio(url);
        this._audio = a;
        a.onended = () => resolve('ended');
        a.onerror = () => resolve('error');
        a.play().catch(() => resolve('blocked'));
      });
      this._audio = null;
      if (result !== 'ended') await browserSpeak(line.text, { voiceHint: line.voice });
    } catch {
      this._audio = null;
      await browserSpeak(line.text, { voiceHint: line.voice });
    }
  }

  pause() { try { this._audio?.pause(); } catch { /* ignore */ } this._emit('paused', this.index); }
  resume() { try { this._audio?.play()?.catch(() => {}); } catch { /* ignore */ } this._emit('playing', this.index); }
  stop() {
    this._stopped = true;
    try { this._audio?.pause(); } catch { /* ignore */ }
    this._audio = null;
    stopAllSpeech();
  }

  _emit(state, i) { this.onStateChange?.(state, i); }
}

export function stopAllSpeech() {
  speechSession += 1;                     // stale queued plays become no-ops (§6)
  coachSpeaking = false;
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* ignore */ }
  try { singleAudio?.pause(); } catch { /* ignore */ }
  singleAudio = null;
}

/* ── STT: Web Speech API (live interim captions §3.5) ──────── */

export function webSpeechSupported() {
  return typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class MicRecognizer {
  /**
   * Continuous recognition that lets the student finish a thought
   * (§3.5): it does NOT cut off at the first pause, and interim
   * captions fire on every update so the student sees they are
   * being heard. Transcripts are RAW — fillers preserved (§13.4).
   */
  constructor({ lang = 'en-US', onInterim, onFinal, onError } = {}) {
    this.lang = lang;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onError = onError;
    this._rec = null;
    this._active = false;
    this._finals = [];
  }

  start() {
    if (this._active) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.onError?.('unsupported'); return; }
    const rec = new SR();
    this._rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          this._finals.push(r[0].transcript);
          this.onFinal?.(r[0].transcript);
        } else {
          interim += r[0].transcript;
        }
      }
      this._errCount = 0;                       // real audio is flowing again
      this.onInterim?.(interim); // live caption
    };

    rec.onerror = (e) => {
      const err = e.error || '';
      if (err === 'no-speech' || err === 'aborted') return;   // auto-restart handles these
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this._active = false;     // mic denied — permanent, surface to the view
        this.onError?.(err);
        return;
      }
      if (err === 'audio-capture') {
        this._active = false;     // no microphone hardware reachable
        this.onError?.(err);
        return;
      }
      // 'network' (webspeech needs Google's servers) and any repeated
      // failure: stop the silent restart loop and tell the view, so it
      // can offer push-to-talk / typed input instead of a dead mic.
      this._errCount = (this._errCount || 0) + 1;
      if (err === 'network' || this._errCount >= 4) {
        this._active = false;
        this.onError?.('mic-failed');
      }
    };

    rec.onend = () => {
      // Chrome stops after silence; restart while still actively recording
      if (this._active) {
        setTimeout(() => { try { this._rec?.start(); } catch { /* too-fast restart */ } }, 250);
      }
    };

    this._active = true;
    try { rec.start(); } catch {
      this._active = false;
      this.onError?.('start-failed');
    }
  }

  /** Stop and return the accumulated RAW transcript. */
  stop() {
    this._active = false;
    try { this._rec?.stop(); } catch { /* ignore */ }
    return this.text();
  }

  abort() {
    this._active = false;
    try { this._rec?.abort(); } catch { /* ignore */ }
  }

  /** RAW text — fillers kept deliberately (§13.4). Never clean here. */
  text() {
    return this._finals.join(' ').trim();
  }
}

/* ── STT: MediaRecorder → backend Whisper (§13.4) ──────────── */

const extFor = (mime) => (mime && mime.includes('mp4') ? 'm4a' : 'webm');

export class RecorderTranscriber {
  /** Used where Web Speech is unavailable (notably iOS Safari). */
  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    this._rec = new MediaRecorder(this._stream, mime ? { mimeType: mime } : undefined);
    this._chunks = [];
    this._rec.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
    this._rec.start(400); // timeslice keeps mobile browsers flushing
    return this._stream;  // lets callers attach a silence-detecting level meter
  }

  /** Stop recording, upload to Whisper, return the RAW transcript. */
  async stop() {
    await new Promise((resolve) => {
      this._rec.onstop = resolve;
      try { this._rec.stop(); } catch { resolve(); }
    });
    this._stream?.getTracks?.().forEach((t) => t.stop());
    const type = this._rec.mimeType || 'audio/webm';
    const blob = new Blob(this._chunks, { type });
    if (!blob.size) return '';
    const { text } = await api.stt(blob, `answer.${extFor(type)}`);
    return text || ''; // raw — fillers preserved (§13.4)
  }
}

/** 'webspeech' | 'recorder' | 'typed' — the typed fallback is full
 *  parity everywhere, so the mic never blocks progress (§7.4). */
export function pickCaptureMode() {
  if (webSpeechSupported()) return 'webspeech';
  if (typeof navigator !== 'undefined' &&
      navigator.mediaDevices?.getUserMedia && window.MediaRecorder) return 'recorder';
  return 'typed';
}

/* ── Thinking acknowledgments (v2 §9 masked-latency trick) ──── */

/* Spoken AND shown the INSTANT the student finishes a turn — no
 * AI call, no network wait — while the real grading runs behind
 * it. The same trick GPT-Live uses: talk through the gap rather
 * than sit in dead silence. Lines live in duplexConfig.js (§16 —
 * one place to tune). */
export function ackLine() {
  return THINKING_ACKS[Math.floor(Math.random() * THINKING_ACKS.length)];
}

/* ── Voice-activity meter (silence-based turn ending) ───────── */

/**
 * Watches a live microphone stream and fires onActivity() whenever
 * real audio energy is present. Used by the conversation turn to
 * detect a natural end of speech on the Whisper path (where there
 * are no interim transcripts to watch). Returns a stop function.
 */
export function createLevelMeter(stream, onActivity) {
  let ctx = null;
  let raf = 0;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor || !stream) return () => {};
    ctx = new AudioCtor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128);
        if (v > peak) peak = v;
      }
      if (peak > 6) onActivity();          // voice energy, not room silence
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    return () => {};                       // no analyser — manual end still works
  }
  return () => {
    try { cancelAnimationFrame(raf); } catch { /* ignore */ }
    try { ctx?.close(); } catch { /* ignore */ }
  };
}