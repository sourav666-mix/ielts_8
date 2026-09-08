/* ============================================================
   ATLAS IELTS Academy — pipelined "streaming TTS" (§7.9)

   Kokoro on OpenRouter returns one full MP3 per request, so true
   audio streaming isn't available. The perceived-stream trick is
   the same one live-radio uses: SPLIT the coach's text into
   sentences and pipeline them —

       text delta → sentence boundary → synth sentence N
                                        synth sentence N+1 (while N plays)
                                        play N → play N+1 → …

   First audio lands ~2–3s after the stream starts and playback is
   gapless. A session counter makes stop() instant and turns every
   in-flight fetch/play into a no-op (barge-in safe, §6 pattern).
   ============================================================ */

import { api } from './api.js';
import { browserSpeak } from './speech.js';

const MIN_SENT = 24;

/** Split buffered text into complete sentences; keep the tail. */
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

export class CoachSpeaker {
  constructor(voice = undefined) {
    this.voice = voice;
    this.session = 0;
    this.queue = [];
    this.buffer = '';
    this.finished = false;
    this.stopped = false;
    this.playing = false;
    this.audio = null;
    this._pumping = false;
    this._doneResolve = null;
    this._cache = new Map();
  }

  /** Feed streamed text as it arrives — sentences queue automatically. */
  feed(text) {
    if (this.stopped) return;
    this.buffer += text;
    const { sentences, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    if (sentences.length) {
      this.queue.push(...sentences);
      this._pump();
    }
  }

  /** Stream finished — flush any tail and let playback run out. */
  end() {
    if (this.stopped) return;
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) this.queue.push(tail);
    this.finished = true;
    this._pump();
  }

  /** Resolves when everything fed has been spoken (or stop() was called). */
  waitDone() {
    if (this.finished && !this.queue.length && !this.playing) return Promise.resolve();
    return new Promise((resolve) => { this._doneResolve = resolve; });
  }

  /** Instant barge-in: everything queued/stopped, playback dead. */
  stop() {
    this.session += 1;
    this.queue = [];
    this.buffer = '';
    this.finished = true;
    this.stopped = true;
    try { this.audio?.pause(); } catch { /* ignore */ }
    this.audio = null;
    this.playing = false;
    this._pumping = false;
    this._resolveDone();
  }

  _resolveDone() {
    if (this._doneResolve && this.finished && !this.queue.length && !this.playing) {
      const r = this._doneResolve;
      this._doneResolve = null;
      r();
    }
  }

  async _audioFor(text, key) {
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
      const key = `${this.voice}::${sentence}`;

      // PIPELINE: start synthesizing the NEXT sentence while this one plays.
      const audioPromise = this._audioFor(sentence, key).catch(() => null);
      const nextPromise = this.queue.length
        ? this._audioFor(this.queue[0], `${this.voice}::${this.queue[0]}`).catch(() => null)
        : null;

      this.playing = true;
      try {
        const url = await audioPromise;
        if (session !== this.session) return;   // stopped mid-flight
        if (url) await this._playUrl(url);
        else await browserSpeak(sentence, { voiceHint: this.voice });
      } catch { /* keep the loop alive — one failed sentence never stalls the coach */ }
      this.playing = false;
      void nextPromise;                          // already warming the cache
      this._resolveDone();
    }

    this._pumping = false;
    if (session === this.session) this._resolveDone();
  }

  _playUrl(url) {
    return new Promise((resolve) => {
      const a = new Audio(url);
      this.audio = a;
      const done = () => { try { a.pause(); } catch { /* ignore */ } resolve(); };
      a.onended = done;
      a.onerror = done;
      a.play().catch(done);
    });
  }
}
