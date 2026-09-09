/* ============================================================
   ATLAS IELTS Academy — Speaking Live (§7.9 REBUILD)

   A Gemini-Live-style full-duplex conversation, rebuilt from zero:

   · ONE mic path: local MediaRecorder + voice-energy silence
     detection + Whisper STT. No browser speech API, no silent
     failure loops — if a mic exists, this works.
   · The coach ONLY speaks real streamed text (no placeholder
     acknowledgments), sentence-by-sentence via natural gpt-audio.
   · Fully hands-free after one tap: question → you answer →
     spoken coaching → "next question?" → yes/no → repeat.
   · The orb is the interface: it listens, thinks, and speaks.

   Scoring flows through the same day-record rounds as exam mode.
   ============================================================ */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDayStore, newRound } from '../../store/useDayStore.js';
import { useProfileStore, weakAreaSummary } from '../../store/useProfileStore.js';
import { useHistoryStore } from '../../store/useHistoryStore.js';
import { useToastStore } from '../../store/useToastStore.js';
import { Stopwatch } from '../../lib/timers.js';
import { getCoachVoice, stopAllSpeech } from '../../lib/speech.js';
import { LiveMic, LiveSpeaker } from '../../lib/liveVoice.js';
import { coachToFeedback, parseCoachSections, stripMarkers, detectYesNo } from '../../lib/coachParser.js';
import { api } from '../../lib/api.js';
import {
  generateRound, roundAverage, finalizeSpeaking, speakingSignals,
  buildFeedbackPayload, normalizeSpeakingFeedback,
} from '../../lib/speakingFlow.js';
import { applyAccuracySignals } from '../../lib/accuracyBatch.js';
import { cn, formatBand } from '../../lib/utils.js';
import VoicePicker from './VoicePicker.jsx';
import '../../styles/speaking.css';

const SILENCE_MS = 1900;          // speech → silence ends a turn
const MAX_TURN_MS = 90_000;       // hard cap on one answer
const HEAR_HINT_MS = 12_000;      // "I can't hear you" nudge

const GREETING = "Hi! I'm your speaking coach. We'll just have a conversation — you answer out loud, and after every answer I'll fix your grammar and show you a better way to say it. Let's begin.";

export default function SpeakingLive({ phase, target, initialStage }) {
  const navigate = useNavigate();
  const [stage, setStage] = useState(initialStage || 'ready');  // ready|boot|speaking|listening|thinking|gate|summary
  const stageRef = useRef('ready'); stageRef.current = stage;
  const [round, setRound] = useState(null);
  const [qIndex, setQIndex] = useState(0);
  const [genError, setGenError] = useState(null);
  const [genToken, setGenToken] = useState(0);
  const [coachText, setCoachText] = useState('');
  const [error, setError] = useState(null);
  const [micHint, setMicHint] = useState('');
  const [heard, setHeard] = useState('');       // last transcript shown under the orb
  const [lastBand, setLastBand] = useState(null);
  const [answered, setAnswered] = useState(0);
  const [micOpen, setMicOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const orbRef = useRef(null);
  const micRef = useRef(null);
  const speakerRef = useRef(null);
  const roundRef = useRef(null); roundRef.current = round;
  const questionsRef = useRef([]);
  const historyRef = useRef([]);
  const qIndexRef = useRef(0); qIndexRef.current = qIndex;
  const turnRef = useRef([]);
  const swRef = useRef(null);
  const bankedRef = useRef(0);
  const finishRef = useRef(null);
  const nextQuestionRef = useRef(null);
  const hintShownRef = useRef(false);

  const questions = useMemo(() => {
    const r = round;
    if (!r) return [];
    return [...(r.part1 || []), ...(r.part3 || [])];
  }, [round]);
  questionsRef.current = questions;
  const currentQuestion = questions[qIndex] || null;

  /* ── Active-time banking (30s + unmount, single owner). ── */
  function bankTime() {
    const sw = swRef.current;
    if (!sw) return;
    const total = sw.elapsedSec();
    const delta = total - bankedRef.current;
    bankedRef.current = total;
    if (delta >= 1) useDayStore.getState().addTimeSpent('speaking', delta);
  }

  useEffect(() => {
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

  /* ── Orb level: mic energy → CSS var, no re-renders. ── */
  const onLevel = useCallback((level) => {
    orbRef.current?.style.setProperty('--level', String(level));
  }, []);

  /* ── Round generation (boot + every exhausted round). ── */
  useEffect(() => {
    if (stage !== 'boot') return undefined;
    let alive = true;
    setGenError(null);
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
        setStage('greet');
      })
      .catch((err) => { if (alive) setGenError(err?.message || "The coach couldn't prepare this conversation — one more try usually sorts it."); });
    return () => { alive = false; };
  }, [stage, genToken, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Speak one line (greeting / question) through the LiveSpeaker. ── */
  const sayLine = useCallback(async (text) => {
    if (!text) return;
    setStage('speaking');
    stopAllSpeech();
    if (micRef.current) micRef.current.coachSpeaking = true;   // meter: ignore coach TTS
    const speaker = new LiveSpeaker(getCoachVoice());
    speakerRef.current = speaker;
    speaker.feed(`${text} `);
    speaker.finish();
    await speaker.done();
    if (micRef.current) micRef.current.coachSpeaking = false;
  }, []);

  /* ── Ask a question, then open the mic hands-free. ── */
  const askQuestion = useCallback(async (index) => {
    const q = questionsRef.current[index];
    if (!q) return;
    setHeard('');
    hintShownRef.current = false;
    await sayLine(q);
    if (stageRef.current !== 'speaking') return;
    micRef.current?.beginUtterance();
    setStage('listening');
  }, [sayLine]);

  /* ── THE COACH TURN: stream feedback + speak it as it arrives. ── */
  const coachTurn = useCallback(async (question, answer) => {
    setStage('thinking');
    setCoachText('');
    setError(null);
    const speaker = new LiveSpeaker(getCoachVoice());
    speakerRef.current = speaker;
    if (micRef.current) micRef.current.coachSpeaking = true;   // meter: ignore coach TTS
    let pending = '';
    const feedLines = (raw) => {
      pending += raw;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line || /^\[[A-Z]+\]$/.test(line)) continue;   // markers never spoken
        const spoken = stripMarkers(line);
        if (spoken) speaker.feed(`${spoken} `);
      }
    };

    let fullText = '';
    try {
      fullText = await api.speaking.coachStream({
        question, answer, phase,
        topic: roundRef.current?.topic || '',
        targetBand: target,
        history: historyRef.current.slice(-4),
      }, {
        onDelta: (delta, full) => { setCoachText(full); feedLines(delta); },
      });
    } catch (err) {
      setError(err?.message || "The coach couldn't respond just now — try that answer once more.");
      speaker.stop();
      // ⚠ the meter gate MUST be released here — a stuck flag would mute
      // the mic for every following turn ("STT failed" forever).
      if (micRef.current) micRef.current.coachSpeaking = false;
      setStage('gate');
      micRef.current?.beginUtterance();
      return;
    }
    feedLines('\n');
    speaker.finish();
    await speaker.done();
    if (micRef.current) micRef.current.coachSpeaking = false;

    /* Bank the answer — coach protocol → the exam scoring shape. */
    const fb = coachToFeedback(fullText);
    let feedback = fb;
    if (!fb.scored) {
      try {
        const raw = await api.speaking.feedback(buildFeedbackPayload({
          phase, part: 1, question, answer, targetBand: target,
          topic: roundRef.current?.topic || '',
        }));
        feedback = normalizeSpeakingFeedback(raw);
      } catch { /* unscored — finalizeSpeaking tolerates it */ }
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
      historyRef.current = [...historyRef.current, { question, answer: String(answer).slice(0, 200) }];
    }
    /* → the yes/no gate, hands-free. */
    setStage('gate');
    micRef.current?.beginUtterance();
  }, [phase, target]);

  /* ── End of a listening turn → route by what we're listening for. ── */
  const finishTurn = useCallback(async () => {
    const s = stageRef.current;
    if (s !== 'listening' && s !== 'gate') return;
    const kind = s === 'gate' ? 'gate' : 'answer';
    setStage('thinking');
    setHeard('');
    // Safety cap: if the meter never detected speech (dead context,
    // blocked mic) don't leave the student hanging — end the turn anyway.
    let answer = '';
    try { answer = await micRef.current.endUtterance(); } catch { answer = ''; }

    if (kind === 'gate') {
      const choice = detectYesNo(answer);
      if (choice === 'yes') { nextQuestionRef.current?.(); return; }
      if (choice === 'no') { finishRef.current?.(); return; }
      if (answer) {
        // said something, but unclear — ask once more, hands-free
        await sayLine('Sorry — was that a yes or a no?');
        if (stageRef.current === 'speaking') {
          micRef.current?.beginUtterance();
          setStage('gate');
        }
      } else {
        setStage('gate');
        micRef.current?.beginUtterance();
      }
      return;
    }

    if (!answer.trim()) {
      setStage('listening');
      micRef.current?.beginUtterance();
      setMicHint("I didn't catch that — try again, or type below.");
      return;
    }
    const q = questionsRef.current[qIndexRef.current];
    await coachTurn(q, answer);
  }, [coachTurn, sayLine]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Watcher: silence ends turns; total silence nudges the user. ── */
  useEffect(() => {
    const iv = setInterval(() => {
      const s = stageRef.current;
      const mic = micRef.current;
      if (!mic || (s !== 'listening' && s !== 'gate')) return;
      const now = Date.now();
      if (mic.hasSpoken && mic.lastActivity && now - mic.lastActivity >= SILENCE_MS) {
        finishTurn();
        return;
      }
      if (s === 'listening' && !mic.hasSpoken && !hintShownRef.current && mic.recording && now - turnStartRef.current > HEAR_HINT_MS) {
        hintShownRef.current = true;
        setMicHint("I can't hear you — check your microphone, or type your answer below.");
      }
      // Hard cap: a dead meter (suspended context, blocked mic) must never
      // leave the student stuck listening forever.
      if (s === 'listening' && !mic.hasSpoken && now - turnStartRef.current > 25_000) {
        finishTurn();
      }
    }, 250);
    return () => clearInterval(iv);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Next question / round exhaustion → finish pipeline. ── */
  const nextQuestion = useCallback(() => {
    const nextIndex = qIndexRef.current + 1;
    if (nextIndex < questionsRef.current.length) {
      setQIndex(nextIndex);
      askQuestion(nextIndex);
    } else {
      // Round exhausted — bank it, generate the next, keep talking.
      const r = roundRef.current;
      if (r && !r.completedAt) {
        const completed = { ...r, avgBand: roundAverage(r.answers), completedAt: new Date().toISOString() };
        roundRef.current = completed;
        setRound(completed);
        useDayStore.getState().upsertSpeakingRound(completed);
      }
      setGenToken((t) => t + 1);   // round effect → 'greet' → flows on
      setStage('boot');
    }
  }, [askQuestion]);

  const finishConversation = useCallback(() => {
    speakerRef.current?.stop();
    stopAllSpeech();
    const r = roundRef.current;
    if (r && !r.completedAt) {
      const completed = { ...r, avgBand: roundAverage(r.answers), completedAt: new Date().toISOString() };
      roundRef.current = completed;
      setRound(completed);
      useDayStore.getState().upsertSpeakingRound(completed);
    }
    const rounds = useDayStore.getState().record?.speaking?.rounds || [];
    const fin = finalizeSpeaking(rounds);
    if (Number.isFinite(fin.band)) {
      useDayStore.getState().setScore('speaking', { band: fin.band });
      const ps = useProfileStore.getState();
      if (ps.profile) {
        ps.update({ weakAreaProfile: applyAccuracySignals(ps.profile, 'speaking', speakingSignals(rounds)) });
      }
      useToastStore.getState().push(
        `Conversation logged — Band ${formatBand(fin.band)} across ${fin.totalAnswers} ${fin.totalAnswers === 1 ? 'answer' : 'answers'}. The full review's waiting.`,
        'success', 7000,
      );
    } else {
      useToastStore.getState().push('Conversation wrapped — nothing scoreable this time.', 'info', 6000);
      setStage('summary');
      return;
    }
    setStage('done');
  }, []);

  nextQuestionRef.current = nextQuestion;
  finishRef.current = finishConversation;

  /* ── Skip speaking today: marks the module done (no band) so the
   *    dashboard's §2.3 advance can move to the next day without it.
   *    The backend excludes a skipped module from the overall band. ── */
  const skipSpeaking = useCallback(() => {
    speakerRef.current?.stop();
    stopAllSpeech();
    try { micRef.current?.close?.(); } catch { /* ignore */ }
    micRef.current = null;
    bankTime();
    useDayStore.getState().patchModule('speaking', {
      status: 'done',
      score: null,
      skipped: true,
    });
    useToastStore.getState().push(
      'Speaking skipped — head to the dashboard and move to the next day.',
      'info', 6500,
    );
    navigate('/');
  }, [navigate, bankTime]);

  /* ── Start: ONE tap unlocks mic + audio, then it's all hands-free. ── */
  const startConversation = useCallback(async () => {
    setStage('boot');
    const ok = micRef.current ? true : false;
    const mic = micRef.current || new LiveMic({ onLevel });
    micRef.current = mic;
    const opened = ok || (await mic.open());
    setMicOpen(opened);
    if (!opened) setMicHint("Couldn't access the microphone — allow it, or type your answers below.");
    useDayStore.getState().startSpeakingSession();
    // Greeting → first question → hands-free listening.
    await sayLine(GREETING);
    if (stageRef.current !== 'speaking') return;
    askQuestion(0);
  }, [askQuestion, onLevel, sayLine]);

  /* ── Typed fallback — full parity, never blocks progress. ── */
  function submitTyped() {
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    if (stageRef.current === 'listening') {
      setStage('thinking');
      const q = questionsRef.current[qIndexRef.current];
      coachTurn(q, text);
    }
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

  /* ── Render ── */
  const orbState = stage === 'listening' || stage === 'gate'
    ? 'listening'
    : stage === 'thinking' ? 'thinking'
    : stage === 'speaking' ? 'speaking'
    : stage === 'boot' ? 'thinking'
    : 'idle';

  const caption = {
    ready: 'Tap start — then just talk to your coach.',
    boot: 'Preparing today\u2019s conversation…',
    greet: 'Warming up…',
    speaking: coachText ? coachText.slice(-180) : (currentQuestion || 'Listen…'),
    listening: micOpen ? 'Listening… just answer naturally.' : 'Mic is off — allow it, or type below.',
    thinking: 'Understanding what you said…',
    gate: 'Shall I ask the next question?',
    summary: 'Conversation wrapped.',
    done: 'All logged.',
  }[stage] || '';

  const handleGateChoice = (choice) => {
    if (choice === 'yes') nextQuestionRef.current?.();
    else finishRef.current?.();
  };

  if (stage === 'ready') {
    return (
      <div className="stack">
        <div className="orb-stage">
          <div ref={orbRef} className="orb orb-idle">
            <div className="orb-ring r1" /><div className="orb-ring r2" /><div className="orb-ring r3" />
            <div className="orb-core"><div className="orb-glare" /></div>
          </div>
        </div>
        <section className="panel coach-panel">
          <p className="coach-bubble">{GREETING}</p>
          <p className="muted">
            One tap to begin — after that it's completely hands-free: the coach asks,
            you answer out loud, it fixes your grammar and asks to continue.
          </p>
          {genError && <ErrorState title="Couldn't prepare the conversation" message={genError} onRetry={() => setGenToken((t) => t + 1)} />}
          <button type="button" className="btn btn-primary coach-start" onClick={startConversation}>
            Start the conversation
          </button>
          <VoicePicker />
        </section>
      </div>
    );
  }

  if (stage === 'summary') {
    return (
      <div className="stack">
        <section className="panel coach-panel">
          <p className="coach-bubble">
            {answered} answer{answered === 1 ? '' : 's'} coached. Nothing was recorded this
            time — answers need a scoreable band to count.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              useDayStore.getState().resetSpeaking();
              setRound(null); roundRef.current = null;
              setAnswered(0); setLastBand(null);
              setCoachText(''); historyRef.current = [];
              setStage('ready');
            }}
          >
            Start a fresh conversation
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="panel session-controls">
        <div>
          <h2 className="title-3">Conversation Coach</h2>
          <p className="muted">
            {phase === 'mock' ? 'Mock practice' : 'Training'} · topic “{round?.topic || '…'}” ·{' '}
            {answered} answer{answered === 1 ? '' : 's'} coached
            {lastBand != null ? ` · last ~Band ${formatBand(lastBand)}` : ''}
          </p>
        </div>
        <div className="session-actions">
          <VoicePicker />
          <button type="button" className="btn btn-ghost" onClick={skipSpeaking} disabled={stage === 'boot'}>
            Skip speaking
          </button>
          <button type="button" className="btn btn-ghost" onClick={finishConversation} disabled={stage === 'boot'}>
            End conversation
          </button>
        </div>
      </div>

      {/* The 3D orb — the whole interface */}
      <div className="orb-stage">
        <div ref={orbRef} className={cn('orb', `orb-${orbState}`)}>
          <div className="orb-ring r1" /><div className="orb-ring r2" /><div className="orb-ring r3" />
          <div className="orb-core"><div className="orb-glare" /></div>
        </div>
        <p className="orb-caption">{caption}</p>
        {stage === 'listening' && micHint && <p className="orb-hint">{micHint}</p>}
      </div>

      {/* Live coach transcript — appears as it streams */}
      {(stage === 'thinking' || stage === 'speaking') && coachText && (
        <section className="panel coach-panel">
          <p className="coach-label">Coach</p>
          {sections.reaction && <p className="coach-bubble">{sections.reaction}</p>}
          {sections.grammar.length > 0 && (
            <div className="coach-section">
              <p className="coach-label">Grammar fixes</p>
              {sections.grammar.map((line, i) => <p key={i} className="coach-fix">{line}</p>)}
            </div>
          )}
          {sections.sentence.length > 0 && (
            <div className="coach-section">
              <p className="coach-label">Better sentences</p>
              {sections.sentence.map((line, i) => <p key={i} className="coach-fix">{line}</p>)}
            </div>
          )}
          {sections.best && (
            <div className="coach-section">
              <p className="coach-label">A stronger answer</p>
              <p className="coach-best">{sections.best}</p>
            </div>
          )}
        </section>
      )}

      {/* Question reminder while answering */}
      {stage === 'listening' && currentQuestion && (
        <section className="panel coach-panel">
          <p className="coach-label">Coach asked</p>
          <p className="coach-question">{currentQuestion}</p>
          <div className="coach-typed">
            <input
              type="text"
              value={typed}
              placeholder="…or type your answer"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitTyped(); }}
            />
            <button type="button" className="btn" onClick={submitTyped}>Send</button>
          </div>
        </section>
      )}

      {/* Yes / No gate — voice + buttons */}
      {stage === 'gate' && (
        <section className="panel coach-panel">
          <div className="coach-actions">
            <button type="button" className="btn btn-primary" onClick={() => handleGateChoice('yes')}>
              Yes — next question
            </button>
            <button type="button" className="btn" onClick={() => handleGateChoice('no')}>
              No — finish for today
            </button>
          </div>
        </section>
      )}

      {error && (
        <ErrorState title="The coach dropped out" message={error} onRetry={() => handleGateChoice('yes')} />
      )}
    </div>
  );
}
