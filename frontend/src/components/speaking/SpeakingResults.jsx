/* ============================================================
   ATLAS IELTS Academy — Speaking session review (§7.8)

   Honest hero (day band from §7.7 aggregation, rounds, answers,
   time logged) → the §7.7 pronunciation honesty note → each
   round collapsible with every answer's band, corrected version
   and vocabulary tip → back to the dashboard.
   ============================================================ */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDayStore } from '../../store/useDayStore.js';
import { bandTone } from '../../lib/scoring.js';
import { cn, formatBand, formatDuration } from '../../lib/utils.js';
import { BandPill, StatBlock } from '../ui.jsx';
import { paragraphs } from './AnswerFeedback.jsx';
import '../../styles/speaking.css';
import '../../styles/reading.css';   // shared .band-pill-lg (documented)

const PART_LABELS = { 1: 'Part 1', 2: 'Part 2', 3: 'Part 3' };

function summaryLine(band, target) {
  const gap = target - band;
  if (gap <= 0) {
    return `Band ${formatBand(band)} — at or above your ${formatBand(target)} target, sustained across every answer today.`;
  }
  if (gap <= 0.5) {
    return `Band ${formatBand(band)} — half a band from your target. The per-answer bands below show which turns are holding it back.`;
  }
  return `Band ${formatBand(band)} — ${formatBand(gap)} below your ${formatBand(target)} target. The fault patterns below are your fastest route forward.`;
}

export default function SpeakingResults({ phase, target }) {
  const s = useDayStore((st) => st.record?.speaking);
  const score = s?.score || {};
  const rounds = (s?.rounds || []).filter((r) => r.completedAt);
  const totalAnswers = rounds.reduce((n, r) => n + (r.answers?.length || 0), 0);

  if (!Number.isFinite(score.band)) return null;

  return (
    <div className="stack">
      <section className="panel stack-t">
        <div className="spread">
          <p className="kicker">Module 4 · Speaking · complete</p>
          {phase === 'mock' && <span className="tag gold">Full exam conditions</span>}
        </div>
        <div className="row">
          <span className={cn('band-pill', 'band-pill-lg', bandTone(score.band, target))}>
            {formatBand(score.band)}
          </span>
          <span className="mono small">
            {rounds.length} {rounds.length === 1 ? 'round' : 'rounds'} · {totalAnswers} answers
            · {formatDuration(s?.timeSpentSec || 0)} logged
          </span>
        </div>
        <p>{summaryLine(score.band, target)}</p>
        <div className="grid-auto">
          <StatBlock value={rounds.length} label="rounds completed" />
          <StatBlock value={totalAnswers} label="answers coached" />
          {phase !== 'mock' && (
            <StatBlock value={`${Math.floor((s?.timeSpentSec || 0) / 60)}m`} label="active practice" />
          )}
        </div>
        <p className="pron-note">
          Pronunciation is estimated from your transcribed speech patterns, not phonetic audio
          analysis — stated plainly, because a real number you can trust beats a flattering one
          you can’t.
        </p>
      </section>

      <section className="stack-t">
        <p className="kicker">Round by round</p>
        {rounds.map((r, i) => (
          <RoundItem key={r.id || i} round={r} index={i} target={target} />
        ))}
      </section>

      <div className="coach-actions" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { useDayStore.getState().resetModule('speaking'); }}
        >
          Practice again
        </button>
        <Link to="/" className="btn btn-ghost">
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}

function RoundItem({ round, index, target }) {
  const [open, setOpen] = useState(false);
  const answers = round.answers || [];

  return (
    <div className="round-item">
      <button
        type="button"
        className="round-item-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mono small">Round {index + 1}</span>
        <span style={{ fontWeight: 600 }}>{round.topic}</span>
        <BandPill band={round.avgBand} target={target} />
        <span className="small" style={{ marginLeft: 'auto' }}>
          {answers.length} answers {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="round-item-body">
          {answers.map((a, i) => (
            <AnswerBlock key={i} answer={a} target={target} />
          ))}
        </div>
      )}
    </div>
  );
}

function AnswerBlock({ answer, target }) {
  const fb = answer.feedback || {};
  const faultCount =
    (fb.grammarFaults?.length || 0) +
    (fb.sentenceFaults?.length || 0) +
    (fb.meaningFaults?.length || 0);
  const q = String(answer.question || '');
  const snippet = q.length > 90 ? `${q.slice(0, 90)}…` : q;

  return (
    <div className="ans-block stack-t">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <span className="tag">{PART_LABELS[answer.part] || `Part ${answer.part}`}</span>
        <BandPill band={answer.band} target={target} />
        <span className="small">
          {faultCount === 0
            ? 'no faults flagged'
            : `${faultCount} ${faultCount === 1 ? 'fault' : 'faults'} flagged`}
        </span>
      </div>
      {snippet && <p className="ans-q">“{snippet}”</p>}
      {fb.correctedVersion && (
        <div className="paper">
          {paragraphs(fb.correctedVersion).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}
      {fb.vocabularyTip && (
        <div className="fb-block tip">
          <p><strong>Worth stealing:</strong> {fb.vocabularyTip}</p>
        </div>
      )}
    </div>
  );
}