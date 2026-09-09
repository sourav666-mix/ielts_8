/* ============================================================
   ATLAS IELTS Academy — live Conversation Coach (§7.9)

   The spoken loop the student experiences:

     1. coach greets → asks to start          (auto mic listens)
     2. student speaks their answer           (auto mic, silence-ended)
     3. coach's feedback STREAMS in and is SPOKEN sentence-by-
        sentence while it is still being written (grammar fixes,
        sentence fixes, best answer — pipelined TTS, no waiting)
     4. coach asks: "shall I ask the next one?"
     5. student says yes / no                 (auto mic, voice + buttons)
     6. yes → next question · no → day is scored and done

   Scoring is NOT a parallel system: the streamed reply carries a
   [BAND] marker that coachToFeedback() converts into the exact
   shape normalizeSpeakingFeedback produces, so answers land in the
   same day-record rounds the exam mode uses and finalizeSpeaking /
   §8.1 signals keep working unchanged. If a stream comes back
   unscoreable, the original /speaking/feedback call is the
   fallback — the day is never left unscoreable.
   ============================================================ */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDayStore, newRound } from '../../store/useDayStore.js';
import { useProfileStore, weakAreaSummary } from '../../store/useProfileStore.js';
import { useHistoryStore } from '../../store/useHistoryStore.js';
import { useToastStore } from '../../store/useToastStore.js';
import { Stopwatch } from '../../lib/timers.js';
import {
  MicRecognizer, RecorderTranscriber, pickCaptureMode,
  stopAllSpeech, speakOnce, getCoachVoice, ackLine, browserSpeak,
} from '../../lib/speech.js';
import { CoachSpeaker } from '../../lib/coachVoice.js';
import { coachToFeedback, parseCoachSections, stripMarkers, detectYesNo } from '../../lib/coachParser.js';
import { api } from '../../lib/api.js';
import {
  generateRound, roundAverage, finalizeSpeaking, speakingSignals,
  buildFeedbackPayload, normalizeSpeakingFeedback,
} from '../../lib/speakingFlow.js';
import { applyAccuracySignals } from '../../lib/accuracyBatch.js';
import { cn, formatBand } from '../../lib/utils.js';
import VoicePicker from './VoicePicker.jsx';
import { ErrorState, LoadingHero } from '../ui.jsx';
import '../../styles/speaking.css';

const SILENCE_END_MS = 2200;      // speech → silence gap that ends a turn
const MAX_TURN_MS = 90_000;       // hard cap on one answer

export default function ConversationCoach({ phase, target, initialStage, initialInputMode }) {
  const [stage, setStage] = useState(initialStage || 'boot');   // boot|greet|asking|listening|coach|permission|loading|summary
  const stageRef = useRef('boot'); stageRef.current = stage;
  const [round, setRound] = useState(null);
  const [genError, setGenError] = useState(null);
  const [genToken, setGenToken] = useState(0);
  const [qIndex, setQIndex] = useState(0);
  const [coachText, setCoachText] = useState('');
  const [coachError, setCoachError] = useState(null);
  const [captions, setCaptions] = useState({ final: '', interim: '' });
  const [micHint, setMicHint] = useState('');
  const [lastBand, setLastBand] = useState(null);
  const [answered, setAnswered] = useState(0);
  const [permissionRetry, setPermissionRetry] = useState(0);
  // 'auto' = live mic (webspeech) · 'push' = record→Whisper button · 'type'
  const [inputMode, setInputMode] = useState(initialInputMode || 'auto');
  const [recording, setRecording] = useState(false);

  const captureMode = useMemo(() => pickCaptureMode(), []);
  const micSupported = captureMode !== 'typed';

  const recRef = useRef(null);
  const handlerRef = useRef(() => {});
  const speakerRef = useRef(null);           // CoachSpeaker (pipelined TTS)
  const recTransRef = useRef(null);          // RecorderTranscriber fallback
  const roundRef = useRef(null); roundRef.current = round;
  const turnRef = useRef([]);                // this turn's final transcripts
  const lastSpeechRef = useRef(0);
  const turnStartRef = useRef(0);
  const swRef = useRef(null);
  const bankedRef = useRef(0);
  const qIndexRef = useRef(0); qIndexRef.current = qIndex;
  const questionsRef = useRef([]);
  const hasBegunRef = useRef(false);

  const questions = useMemo(() => {
    const r = round;
    if (!r) return [];
    return [...(r.part1 || []), ...(r.part3 || [])];   // cue card is exam-mode only
  }, [round]);
  questionsRef.current = questions;
  const currentQuestion = questions[qIndex] || null;

  /* ── Active-time banking (same discipline as the exam mode) ── */
  function bankTime() {
    const sw = swRef.current;
    if (!sw) return;
    const total = sw.elapsedSec();
    const delta = total - bankedRef.current;
    bankedRef.current = total;
    if (delta >= 1) useDayStore.getState().addTimeSpent('speaking', delta);
  }

  useEffect(() => {
    useDayStore.getState().startSpeakingSession();
    const sw = new Stopwatch();
    swRef.current = sw;
    sw.start();
    const iv = setInterval(bankTime, 30000);
    return () => {
      clearInterval(iv);
      bankTime();
      swRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Round generation (boot + every exhausted round) ──────── */
  useEffect(() => {
    setGenError(null);
    setStage('boot');
    let alive = true;
    const p = useProfileStore.getState().profile;
    const roundsCount = useDayStore.getState().record?.speaking?.rounds?.length ?? 0;
    generateRound({
      phase,
      day: p?.day ?? 1,
      roundIndex: roundsCount,
      targetBand: p?.targetBand ?? 6.5,
      avoidTopics: p?.topicsUsed?.speaking || [],
      weakAreas: weakAreaSummary(p, 'speaking'),
      difficulty: useHistoryStore.getState().moduleDifficulty('speaking', p?.targetBand ?? 6.5),
    })
      .then((r) => {
        if (!alive) return;
        const nr = newRound(r.topic, { part1: r.part1, part3: r.part3, cueCard: null });
        setRound(nr);
        roundRef.current = nr;
        useDayStore.getState().upsertSpeakingRound(nr);
        useProfileStore.getState().addTopics('speaking', [r.topic]);
        setQIndex(0);
        // First boot greets; later rounds flow straight into a question.
        setStage(hasBegunRef.current ? 'asking' : 'greet');
      })
      .catch((err) => {
        if (alive) setGenError(err?.message || "The coach couldn't prepare this conversation — one more try usually sorts it.");
      });
    return () => { alive = false; };
  }, [genToken, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Mic lifecycle: ONE recognizer for the whole conversation, live
   *    from mount (greet needs to hear "start"); transcripts are routed
   *    by the CURRENT stage via handlerRef — during coach playback they
   *    are deliberately ignored so the coach never hears itself. ── */
  useEffect(() => {
    if (captureMode !== 'mic') return undefined;
    const rec = new MicRecognizer({
      onFinal: (t) => handlerRef.current?.(t),
      onInterim: (t) => {
        if (t.trim()) {
          lastSpeechRef.current = Date.now();
          setCaptions((c) => ({ ...c, interim: t }));
        }
      },
      onError: (e) => {
        const map = {
          'not-allowed': 'Microphone blocked — allow it in the browser, or switch to Push-to-talk or Type below.',
          'service-not-allowed': 'Microphone blocked — allow it in the browser, or switch to Push-to-talk or Type below.',
          'audio-capture': 'No microphone was found — switch to Push-to-talk (if a mic exists) or Type.',
          'mic-failed': 'The live mic isn\u2019t responding — switched to Push-to-talk. You can also type.',
        };
        setMicHint(map[e] || '');
        // Live mic dead → don't strand the student: fall back to Whisper.
        if (e === 'mic-failed' || e === 'audio-capture') setInputMode('push');
      },
    });
    recRef.current = rec;
    rec.start();                          // live from the greeting onward
    return () => { recRef.current = null; rec.abort(); };
  }, [captureMode]);

  /* ── Speak a line through Kokoro, browser synth as the net. ── */
  const sayLine = useCallback(async (text) => {
    if (!text) return;
    stopAllSpeech();
    await speakOnce(text, getCoachVoice());
  }, []);

  /* ── Question asking: narrate, then hands-free listening. ── */
  const askQuestion = useCallback(async (index) => {
    const q = questionsRef.current[index];
    if (!q) return;
    setStage('asking');
    stopAllSpeech();
    await sayLine(q);
    if (stageRef.current !== 'asking') return;   // user ended the session mid-read
    turnRef.current = [];
    setCaptions({ final: '', interim: '' });
    lastSpeechRef.current = 0;
    turnStartRef.current = Date.now();
    setStage('listening');
    recRef.current?.start?.();
    if (captureMode === 'recorder') recTransRef.current?.start?.();
  }, [captureMode, sayLine]);

  /* ── End-of-turn watcher: silence after speech submits; a hard
   *    cap protects against runaway silence. ── */
  const endTurnRef = useRef(null);
  useEffect(() => {
    const iv = setInterval(() => {
      if (stageRef.current !== 'listening') return;
      const spoken = lastSpeechRef.current > 0;
      const silentFor = spoken ? Date.now() - lastSpeechRef.current : 0;
      const waited = Date.now() - turnStartRef.current;
      const hasWords = (turnRef.current.join(' ') || captionsRef.current.interim || '').trim();
      if (spoken && silentFor >= SILENCE_END_MS && hasWords) endTurnRef.current?.();
      else if (waited >= MAX_TURN_MS && hasWords) endTurnRef.current?.();
    }, 250);
    return () => clearInterval(iv);
  }, []);

  const captionsRef = useRef({ final: '', interim: '' });
  captionsRef.current = captions;

  /* ── Turn capture: freeze the mic, collect the RAW transcript. ── */
  const captureTranscript = useCallback(async () => {
    if (captureMode === 'mic') return turnRef.current.join(' ').trim();
    if (captureMode === 'recorder') {
      const text = recTransRef.current ? await recTransRef.current.stop() : '';
      return text.trim();
    }
    return '';
  }, [captureMode]);

  /* ── THE COACH TURN (§7.9): stream feedback, speak it sentence-
   *    by-sentence while it's still being written, then bank the
   *    answer into the SAME day-record pipeline the exam uses. ── */
  const runCoachTurn = useCallback(async (question, answer) => {
    setStage('coach');
    setCoachError(null);
    setCoachText('');
    const speaker = new CoachSpeaker(getCoachVoice());
    speakerRef.current = speaker;

    let spokenBuffer = '';
    let pendingRaw = '';
    const feedLines = (raw) => {
      // Deltas can split marker lines; only complete lines are routed.
      pendingRaw += raw;
      let nl;
      while ((nl = pendingRaw.indexOf('\n')) >= 0) {
        const line = pendingRaw.slice(0, nl).trim();
        pendingRaw = pendingRaw.slice(nl + 1);
        if (!line || /^\[[A-Z]+\]$/.test(line)) continue;   // markers never spoken
        const spoken = stripMarkers(line);
        if (spoken) {
          spokenBuffer = spokenBuffer ? `${spokenBuffer} ${spoken}` : spoken;
          speaker.feed(`${spoken} `);
        }
      }
    };

    let fullText = '';
    try {
      fullText = await api.speaking.coachStream({
        question, answer, phase,
        topic: roundRef.current?.topic || '',
        targetBand: target,
      }, {
        onDelta: (delta, full) => {
          setCoachText(full);
          feedLines(delta);
        },
      });
    } catch (err) {
      setCoachError(err?.message || "The coach couldn't respond just now — try saying that again.");
      speaker.stop();
      setStage('permission');
      return;
    }
    feedLines('\n');                       // flush a trailing partial line
    speaker.end();
    await speaker.waitDone();

    /* Bank the answer — coach protocol → normalizeSpeakingFeedback shape. */
    const fb = coachToFeedback(fullText);
    let feedback = fb;
    if (!fb.scored) {
      // Fallback: the structured per-answer endpoint guarantees a band.
      try {
        const raw = await api.speaking.feedback(buildFeedbackPayload({
          phase, part: 1, question, answer, targetBand: target,
          topic: roundRef.current?.topic || '',
        }));
        feedback = normalizeSpeakingFeedback(raw);
      } catch { /* unscored answer — finalizeSpeaking tolerates it */ }
    }
    setLastBand(Number.isFinite(feedback.band) ? feedback.band : null);

    const r = roundRef.current;
    if (r) {
      const updated = {
        ...r,
        answers: [...r.answers, {
          part: 1, question, answer,
          band: Number.isFinite(feedback.band) ? feedback.band : null,
          feedback,
        }],
      };
      roundRef.current = updated;
      setRound(updated);
      useDayStore.getState().upsertSpeakingRound(updated);
      setAnswered((n) => n + 1);
    }
    setStage('permission');
    setPermissionRetry(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, target]);

  /* ── Push-to-talk (RecorderTranscriber → Whisper): the reliable
   *    fallback when the live mic (webspeech) can't run. ── */
  const startPush = useCallback(async () => {
    if (!recTransRef.current) recTransRef.current = new RecorderTranscriber();
    try {
      await recTransRef.current.start();
      setRecording(true);
      turnStartRef.current = Date.now();
      setMicHint('');
    } catch {
      setRecording(false);
      setMicHint("Couldn't access the microphone — check browser permissions, or Type your answer.");
    }
  }, []);

  const stopPush = useCallback(async () => {
    if (!recTransRef.current || !recording) return;
    setRecording(false);
    setStage('coach');
    let text = '';
    try { text = await recTransRef.current.stop(); } catch { text = ''; }
    const answer = (text || '').trim();
    if (!answer) {
      setStage('listening');
      setMicHint('Nothing was captured — try Push-to-talk again, or switch to Type.');
      return;
    }
    const q = questionsRef.current[qIndexRef.current];
    browserSpeak(ackLine(), { voiceHint: getCoachVoice() });
    await runCoachTurn(q, answer);
  }, [recording, runCoachTurn, sayLine]);

  /* ── End of a listening turn → the coach takes over. ── */
  const endTurn = useCallback(async () => {
    if (stageRef.current !== 'listening') return;
    setStage('coach');
    const answer = await captureTranscript();
    const interim = captionsRef.current.interim || '';
    const final = answer || interim;
    if (!final.trim()) {
      // Nothing said — gently re-open the turn instead of coaching air.
      setCaptions({ final: '', interim: '' });
      sayLine('Take your time — whenever you\'re ready.');
      setStage('listening');
      turnStartRef.current = Date.now();
      lastSpeechRef.current = 0;
      return;
    }
    const q = questionsRef.current[qIndexRef.current];
    browserSpeak(ackLine(), { voiceHint: getCoachVoice() });   // masked-latency ack
    await runCoachTurn(q, final);
  }, [captureTranscript, runCoachTurn, sayLine]);
  endTurnRef.current = endTurn;

  /* ── Round completion + §7.7 day finish (same pipeline as exam). ── */
  const completeRound = useCallback(() => {
    const r = roundRef.current;
    if (!r || r.completedAt) return r;
    const completed = {
      ...r,
      avgBand: roundAverage(r.answers),
      completedAt: new Date().toISOString(),
    };
    roundRef.current = completed;
    setRound(completed);
    useDayStore.getState().upsertSpeakingRound(completed);
    return completed;
  }, []);

  const finishConversation = useCallback(() => {
    speakerRef.current?.stop();
    stopAllSpeech();
    recRef.current?.stop?.();
    const completed = completeRound();
    const rounds = useDayStore.getState().record?.speaking?.rounds || [];
    const fin = finalizeSpeaking(rounds);
    if (Number.isFinite(fin.band)) {
      useDayStore.getState().setScore('speaking', { band: fin.band });
      const ps = useProfileStore.getState();
      if (ps.profile) {
        ps.update({
          weakAreaProfile: applyAccuracySignals(ps.profile, 'speaking', speakingSignals(rounds)),
        });
      }
      useToastStore.getState().push(
        `Conversation logged — Band ${formatBand(fin.band)} across ${fin.totalAnswers} ${fin.totalAnswers === 1 ? 'answer' : 'answers'}. The full review's waiting.`,
        'success', 7000,
      );
    } else {
      useToastStore.getState().push(
        'Conversation wrapped — no scored answers this time, so nothing was recorded.',
        'info', 6000,
      );
    }
    setStage('summary');
  }, [completeRound]);

  /* ── Greet → first question (voice "start/yes" or the button). ── */
  const beginConversation = useCallback(() => {
    hasBegunRef.current = true;
    permissionReadyRef.current = false;
    askQuestion(0);
  }, [askQuestion]);

  /* ── Permission gate: voice yes/no with button + typed fallbacks. ── */
  const permissionNext = useCallback(() => {
    const nextIndex = qIndexRef.current + 1;
    if (nextIndex < questionsRef.current.length) {
      setQIndex(nextIndex);
      askQuestion(nextIndex);
    } else {
      // Round exhausted — complete it, generate the next, keep talking.
      completeRound();
      setGenToken((t) => t + 1);   // round effect → stage 'asking'
    }
  }, [askQuestion, completeRound]);

  const handlePermissionAnswer = useCallback((choice) => {
    if (choice === 'yes') permissionNext();
    else finishConversation();
  }, [permissionNext, finishConversation]);

  const permissionReadyRef = useRef(false);
  useEffect(() => { if (stage === 'permission') permissionReadyRef.current = true; else permissionReadyRef.current = false; }, [stage]);

  /* ── Route every spoken final transcript by the current stage. ── */
  const handlerDepsRef = useRef({}); handlerDepsRef.current = { handlePermissionAnswer, beginConversation };
  useEffect(() => {
    handlerRef.current = (text) => {
      const t = String(text || '').trim();
      if (!t) return;
      const s = stageRef.current;
      if (s === 'greet') {
        if (detectYesNo(t) === 'yes' || /\b(start|begin)\b/.test(t)) handlerDepsRef.current.beginConversation();
        else lastSpeechRef.current = Date.now();
      } else if (s === 'listening') {
        turnRef.current.push(t);
        lastSpeechRef.current = Date.now();
        setCaptions((c) => ({ final: turnRef.current.join(' '), interim: '' }));
      } else if (s === 'permission' && permissionReadyRef.current) {
        const choice = detectYesNo(t);
        if (choice) handlerDepsRef.current.handlePermissionAnswer(choice);
        // Unclear → the retry effect nudges the student again.
      }
      // 'coach' stage: the coach is speaking — never listen to ourselves.
    };
  }, []);

  /* ── Permission limbo: if no clear yes/no lands, nudge once, then
   *    the buttons are the answer (voice is a bonus, not a gate). ── */
  useEffect(() => {
    if (stage !== 'permission') return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      if (!alive || !permissionReadyRef.current) return;
      const heard = (captionsRef.current.final + captionsRef.current.interim).trim();
      if (heard) return;
      await sayLine('Sorry — was that a yes or a no?');
      setPermissionRetry((n) => n + 1);
    }, 3200);
    return () => { alive = false; clearTimeout(t); };
  }, [stage, permissionRetry, sayLine]);

  /* ── Typed fallback: full parity when the mic can't be used. ── */
  const [typed, setTyped] = useState('');
  function submitTyped() {
    const text = typed.trim();
    if (!text || stage !== 'listening') return;
    setTyped('');
    endTurnRef.current && (turnRef.current = [text]);   // feed the pipeline
    endTurnRef.current?.();
  }

  /* ── Live display parse — sections appear as the stream arrives. ── */
  const sections = useMemo(() => {
    const s = parseCoachSections(coachText);
    return {
      reaction: s.REACTION || '',
      grammar: (s.GRAMMAR || '').split('\n').map((l) => l.trim()).filter(Boolean),
      sentence: (s.SENTENCE || '').split('\n').map((l) => l.trim()).filter(Boolean),
      best: s.BEST || '',
      ask: s.ASK || '',
    };
  }, [coachText]);

  const pushPossible = captureMode !== 'typed';
  const mode = inputMode === 'auto'
    ? (captureMode === 'mic' ? 'auto' : captureMode === 'recorder' ? 'push' : 'type')
    : (inputMode === 'push' && !pushPossible ? 'type' : inputMode);

  /* ── Render ── */
  if (stage === 'boot') {
    return (
      <div className="stack">
        <div className="panel session-controls">
          <h2 className="title-3">Conversation Coach</h2>
          <p className="muted">Your coach is picking today's topics…</p>
        </div>
        {genError
          ? <ErrorState title="The conversation didn't start" message={genError} onRetry={() => setGenToken((t) => t + 1)} />
          : <LoadingHero kind="speaking-gen" />}
      </div>
    );
  }

  if (stage === 'summary') {
    return (
      <div className="stack">
        <div className="panel session-controls">
          <h2 className="title-3">Conversation wrapped</h2>
          <p className="muted">
            {answered} answer{answered === 1 ? '' : 's'} coached today. Nothing was
            recorded this time — every answer needs a scoreable band to count.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              useDayStore.getState().resetSpeaking();
              setRound(null);
              roundRef.current = null;
              hasBegunRef.current = false;
              setAnswered(0);
              setLastBand(null);
              setStage('boot');
              setGenToken((t) => t + 1);
            }}
          >
            Start a fresh conversation
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Header */}
      <div className="panel session-controls">
        <div>
          <h2 className="title-3">Conversation Coach</h2>
          <p className="muted">
            {phase === 'mock' ? 'Mock practice' : 'Training'} · topic “{round?.topic || '…'}” ·{' '}
            {answered} coached answer{answered === 1 ? '' : 's'}
            {lastBand != null ? ` · last answer ~Band ${formatBand(lastBand)}` : ''}
          </p>
        </div>
        <div className="session-actions">
          <VoicePicker />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => (stage === 'greet' ? finishConversation() : handlePermissionAnswer('no'))}
            disabled={stage === 'boot' || stage === 'asking'}
          >
            End conversation
          </button>
        </div>
      </div>

      {micHint && <div className="coach-hint panel">{micHint}</div>}

      {/* 1 — greeting */}
      {stage === 'greet' && (
        <section className="panel coach-panel">
          <p className="coach-bubble">
            Hi! I'm your speaking coach. We'll just chat — you answer my questions out
            loud, and after every answer I'll fix your grammar and show you a better way
            to say it. Say <strong>“start”</strong> whenever you're ready, or tap the button.
          </p>
          <button type="button" className="btn btn-primary coach-start" onClick={beginConversation}>
            Start the conversation
          </button>
          {micSupported
            ? <p className="muted">Mic is live — just speak. {captureMode === 'recorder' ? 'Tap start/stop under each question.' : ''}</p>
            : <p className="muted">No microphone here — type your answers instead; everything else works the same.</p>}
        </section>
      )}

      {/* 2 — the question (being asked aloud) */}
      {(stage === 'asking' || stage === 'listening') && currentQuestion && (
        <section className="panel coach-panel">
          <p className="coach-label">Coach asks</p>
          <p className="coach-question">{currentQuestion}</p>
          {stage === 'asking' && <p className="muted">The coach is asking — your mic opens when it finishes.</p>}
          {stage === 'listening' && (
            <>
              {/* Input-mode chips — the student is never locked into a broken mic */}
              <div className="coach-chips">
                {captureMode === 'mic' && (
                  <button type="button" className={cn('chip', mode === 'auto' && 'chip-on')} onClick={() => setInputMode('auto')}>
                    Live mic
                  </button>
                )}
                {pushPossible && (
                  <button type="button" className={cn('chip', mode === 'push' && 'chip-on')} onClick={() => { setInputMode('push'); setRecording(false); }}>
                    Push-to-talk
                  </button>
                )}
                <button type="button" className={cn('chip', mode === 'type' && 'chip-on')} onClick={() => setInputMode('type')}>
                  Type
                </button>
              </div>

              {mode === 'auto' && (
                <>
                  <div className={cn('coach-mic', captions.interim || captions.final ? 'live' : '')}>
                    <span className="coach-mic-dot" />
                    {captions.interim || captions.final
                      ? <span>{captions.final} <em className="coach-interim">{captions.interim}</em></span>
                      : <span className="muted">Listening… just answer naturally; I'll know when you're done.</span>}
                  </div>
                  <button type="button" className="btn" onClick={() => endTurnRef.current?.()}>
                    I'm done
                  </button>
                </>
              )}

              {mode === 'push' && (
                <>
                  <div className={cn('coach-mic', recording ? 'live' : '')}>
                    <span className={cn('coach-mic-dot', recording && 'live')} />
                    {recording
                      ? <span>Recording… speak your answer, then press done.</span>
                      : <span className="muted">Press start, answer out loud, then press done — it's transcribed and coached.</span>}
                  </div>
                  {recording
                    ? <button type="button" className="btn btn-primary" onClick={stopPush}>I'm done</button>
                    : <button type="button" className="btn btn-primary" onClick={startPush}>Start speaking</button>}
                </>
              )}

              {mode === 'type' && (
                <div className="coach-typed">
                  <input
                    type="text"
                    value={typed}
                    placeholder="Type your answer"
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitTyped(); }}
                    autoFocus
                  />
                  <button type="button" className="btn btn-primary" onClick={submitTyped}>Send</button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 3 — streamed spoken feedback */}
      {stage === 'coach' && (
        <section className="panel coach-panel">
          <p className="coach-label">
            <span className="coach-mic-dot live" /> Coach is responding…
          </p>
          {sections.reaction && <p className="coach-bubble">{sections.reaction}</p>}
          {sections.grammar.length > 0 && (
            <div className="coach-section">
              <p className="coach-label">Grammar fixes</p>
              {sections.grammar.map((line, i) => <p key={i} className="coach-fix">{line}</p>)}
            </div>
          )}
          {sections.sentence.length > 0 && (
            <div className="coach-section">
              <p className="coach-label">Better sentence building</p>
              {sections.sentence.map((line, i) => <p key={i} className="coach-fix">{line}</p>)}
            </div>
          )}
          {sections.best && (
            <div className="coach-section">
              <p className="coach-label">A stronger answer</p>
              <p className="coach-best">{sections.best}</p>
            </div>
          )}
          {!coachText && <p className="muted">{ackLine()}</p>}
          <button type="button" className="btn btn-ghost" onClick={() => { speakerRef.current?.stop(); setStage('permission'); }}>
            Skip to the next question
          </button>
        </section>
      )}

      {/* 4 — the permission gate */}
      {stage === 'permission' && (
        <section className="panel coach-panel">
          <p className="coach-bubble">{sections.ask || 'Shall I ask you the next question?'}</p>
          {micSupported && <p className="muted">Say yes or no — or tap.</p>}
          <div className="coach-actions">
            <button type="button" className="btn btn-primary" onClick={() => handlePermissionAnswer('yes')}>
              Yes — next question
            </button>
            <button type="button" className="btn" onClick={() => handlePermissionAnswer('no')}>
              No — finish for today
            </button>
          </div>
        </section>
      )}

      {coachError && (
        <ErrorState
          title="The coach dropped out mid-answer"
          message={coachError}
          onRetry={() => handlePermissionAnswer('yes')}
        />
      )}
    </div>
  );
}
