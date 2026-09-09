/* ============================================================
   ATLAS IELTS Academy — Speaking view (replaces the FINAL
   Batch-3 scaffold — with this file, every frontend view is
   real)

   Thin by design: the day record drives everything. The session
   owns the §7.3 window re-check, coarse mid-round resume, round
   generation, per-answer feedback, active-time banking and day
   completion (§7.7 + §8.1). Done days render the review.
   ============================================================ */

import React, { useState } from 'react';
import { useProfileStore } from '../store/useProfileStore.js';
import { useDayStore } from '../store/useDayStore.js';
import SpeakingSession from '../components/speaking/SpeakingSession.jsx';
import SpeakingLive from '../components/speaking/SpeakingLive.jsx';
import SpeakingResults from '../components/speaking/SpeakingResults.jsx';
import { cn } from '../lib/utils.js';

export default function SpeakingView() {
  const phase = useProfileStore((s) => s.profile?.phase);
  const target = useProfileStore((s) => s.profile?.targetBand) ?? 6.5;
  const status = useDayStore((s) => s.record?.speaking?.status);
  const [mode, setMode] = useState('live');   // 'live' | 'exam'

  if (status === 'done') {
    return <SpeakingResults phase={phase} target={target} />;
  }

  return (
    <div className="stack">
      <div className="panel session-controls coach-tabs">
        <button
          type="button"
          className={cn('btn', mode === 'live' ? 'btn-primary' : 'btn-ghost')}
          onClick={() => setMode('live')}
        >
          Live conversation
        </button>
        <button
          type="button"
          className={cn('btn', mode === 'exam' ? 'btn-primary' : 'btn-ghost')}
          onClick={() => setMode('exam')}
        >
          Exam mode
        </button>
        <p className="muted coach-tabs-note">
          {mode === 'live'
            ? 'A Gemini-style live conversation: talk out loud, get coached instantly, keep going until you say stop.'
            : 'The full exam structure — Part 1, the cue card long turn and Part 3, timed like test day.'}
        </p>
      </div>
      {mode === 'live'
        ? <SpeakingLive key="live" phase={phase} target={target} />
        : <SpeakingSession key="exam" phase={phase} target={target} />}
    </div>
  );
}