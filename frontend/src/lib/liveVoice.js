/* ============================================================
   ATLAS IELTS Academy — Live voice engine (§7.9 rebuild)

   Two small classes, one job each, zero cleverness:

   LiveMic     — owns the MediaStream. Records utterances with
                MediaRecorder, detects "stopped speaking" with the
                voice-energy meter (no web-speech dependency, works
                on every device with a mic), transcribes with Whisper.
   LiveSpeaker — speaks the coach's streamed text: sentences are
                synthesized with gpt-audio and played back-to-back;
                synthesis of the next sentence hides behind playback.

   Nothing here speaks unless real text exists.
   ============================================================ */

import { api } from './api.js';
import { browserSpeak } from './speech.js';

const extFor = (mime) => (mime && mime.includes('mp4') ? 'm4a' : 'webm');

/* ── LiveMic ────────────────────────────────────────────────── */

export class LiveMic {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
    this.hasSpoken = false;          // voice energy seen this turn
    this.lastActivity = 0;           // ms timestamp
    this._meterStop = null;
    this.failed = false;
  }

  /** Acquire the mic (once, on the user's click) + start the meter. */
  async open() {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.failed = true;
      return false;
    }
    this._meterStop = this._meter();
    return true;
  }

  /** Voice-energy meter → hasSpoken/lastActivity + onLevel (0..1). */
  _meter() {
    let ctx = null;
    let raf = 0;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      // ⚠ Autoplay policy: a context created off a gesture chain can be
      // born SUSPENDED — a suspended context produces no audio data and
      // the mic would look permanently dead. Resume it, and keep trying.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(this.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
        else {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i] - 128);
            if (v > peak) peak = v;
          }
          // speaking gate: the coach's own TTS must never count as the user
          if (peak > 6 && !this.coachSpeaking) {
            this.hasSpoken = true;
            this.lastActivity = Date.now();
          }
          if (this.onLevel) this.onLevel(Math.min(1, peak / 60));
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
      return () => {
        cancelAnimationFrame(raf);
        try { ctx.close(); } catch { /* ignore */ }
      };
    } catch {
      return () => {};
    }
  }

  /** Begin capturing one utterance (call when a listening turn starts). */
  beginUtterance() {
    this.hasSpoken = false;
    this.lastActivity = Date.now();
    if (!this.stream || typeof window.MediaRecorder !== 'function') return false;
    if (this.recorder) return true;
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((m) => MediaRecorder.isTypeSupported(m)) || '';
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.recorder.start(400);
      this.recording = true;
      return true;
    } catch {
      this.recorder = null;
      return false;
    }
  }

  /** Stop and transcribe the utterance → RAW text ('' if nothing).
   *  One automatic retry: a single hiccup must not lose the answer. */
  async endUtterance() {
    const rec = this.recorder;
    this.recorder = null;
    this.recording = false;
    if (!rec) return '';
    const blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      try { rec.stop(); } catch { resolve(new Blob(this.chunks)); }
    });
    this.hasSpoken = false;
    if (!blob.size) return '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await api.stt(blob, `answer.${extFor(rec.mimeType)}`);
        if ((text || '').trim()) return text.trim();   // RAW — fillers preserved (§13.4)
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
      }
    }
    return '';
  }

  close() {
    this._meterStop?.();
    try { this.recorder?.stop?.(); } catch { /* ignore */ }
    try { this.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.stream = null;
    this.recorder = null;
    this.recording = false;
  }
}

/* ── LiveSpeaker ────────────────────────────────────────────── */

const MIN_SENT = 24;

function takeSentences(buffer) {
  const out = [];
  const re = /[^.!?…]+[.!?…]+["'”’)]?\s+/g;
  let match;
  let last = 0;
  while ((match = re.exec(buffer))) {
    const sentence = buffer.slice(last, match.index + match[0].length).trim();
    last = match.index + match[0].length;
    if (sentence.length >= MIN_SENT || /[.!?…]$/.test(sentence)) out.push(sentence);
  }
  return { sentences: out, rest: buffer.slice(last) };
}

export class LiveSpeaker {
  constructor(voice) {
    this.voice = voice;
    this.session = 0;
    this.queue = [];
    this.buffer = '';
    this.finished = false;
    this.playing = false;
    this.audio = null;
    this._pumping = false;
    this._cache = new Map();
    this._done = null;
  }

  feed(text) {
    if (this.finished) return;
    this.buffer += text;
    const { sentences, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    if (sentences.length) {
      this.queue.push(...sentences);
      this._pump();
    }
  }

  finish() {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) this.queue.push(tail);
    this.finished = true;
    this._pump();
  }

  /** Resolves once everything fed has been spoken. */
  done() {
    if (this.finished && !this.queue.length && !this.playing) return Promise.resolve();
    return new Promise((resolve) => { this._done = resolve; });
  }

  stop() {
    this.session += 1;
    this.queue = [];
    this.buffer = '';
    this.finished = true;
    try { this.audio?.pause(); } catch { /* ignore */ }
    this.audio = null;
    this.playing = false;
    this._pumping = false;
    this._resolveDone();
  }

  _resolveDone() {
    if (this._done && this.finished && !this.queue.length && !this.playing) {
      const r = this._done;
      this._done = null;
      r();
    }
  }

  async _audioFor(text) {
    const key = `${this.voice}::${text}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const url = await api.tts(text, this.voice);
    this._cache.set(key, url);
    return url;
  }

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    const session = this.session;
    while (this.queue.length && session === this.session) {
      const sentence = this.queue.shift();
      this.playing = true;
      try {
        let url = null;
        try { url = await this._audioFor(sentence); } catch { url = null; }
        if (session !== this.session) return;      // stopped mid-flight
        if (url) {
          await new Promise((resolve) => {
            const a = new Audio(url);
            this.audio = a;
            const done = () => { try { a.pause(); } catch { /* ignore */ } resolve(); };
            a.onended = done;
            a.onerror = done;
            a.play().catch(done);
          });
        } else {
          await browserSpeak(sentence, { voiceHint: this.voice });
        }
      } catch { /* one failed sentence never stalls the coach */ }
      this.playing = false;
      this._resolveDone();
    }
    this._pumping = false;
    if (session === this.session) this._resolveDone();
  }
}
