/* ============================================================
   ATLAS IELTS Academy — Conversation Coach text protocol (§7.9)

   The coach's streamed reply follows a strict marker protocol so
   one LLM call can serve THREE consumers at once:
     · the on-screen feedback cards (parseCoachText)
     · the pipelined TTS voice (stripMarkers — markers never spoken)
     · the day-record scoring pipeline (the [BAND] line feeds
       normalizeSpeakingFeedback's band requirement)
   ============================================================ */

const SECTIONS = ['REACTION', 'GRAMMAR', 'SENTENCE', 'BEST', 'BAND', 'ASK'];

/** Split the raw streamed text into { REACTION, GRAMMAR, ... } blocks. */
export function parseCoachSections(raw) {
  const out = {};
  if (!raw) return out;
  const lines = String(raw).split('\n');
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*\[([A-Z]+)\]\s*$/);
    if (m && SECTIONS.includes(m[1])) {
      current = m[1];
      out[current] = '';
      continue;
    }
    if (current) out[current] = (out[current] ? out[current] + '\n' : '') + line;
  }
  for (const key of Object.keys(out)) out[key] = out[key].trim();
  return out;
}

/** `You said "x" — "y" because z.` → { original, corrected, why } */
function parseFaultLine(line) {
  const m = line.match(/[“"](.+?)[”"]\s*[—–-]+\s*[“"](.+?)[”"](?:\s+because\s+(.*))?$/i)
    || line.match(/'(.+?)'\s*[—–-]+\s*'(.+?)'(?:\s+because\s+(.*))?$/i);
  if (!m) return null;
  return { original: m[1].trim(), corrected: m[2].trim(), why: (m[3] || '').trim() };
}

function parseFaults(block) {
  const cleanLine = /clean/i.test(block) && !/[“"]/.test(block) ? [] : null;
  if (cleanLine) return [];
  const faults = (block || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean)
    .map(parseFaultLine)
    .filter(Boolean);
  return faults;
}

/** Full parse → the exact shape normalizeSpeakingFeedback produces,
 *  so the coach's feedback drops straight into the scoring pipeline. */
export function coachToFeedback(raw) {
  const s = parseCoachSections(raw);
  const bandNum = Number(String(s.BAND || '').replace(/[^\d.]/g, ''));
  const halfBand = Number.isFinite(bandNum)
    ? Math.min(9, Math.max(2, Math.round(bandNum * 2) / 2))
    : NaN;
  return {
    reaction: s.REACTION || '',
    band: halfBand,
    grammarFaults: parseFaults(s.GRAMMAR),
    sentenceFaults: parseFaults(s.SENTENCE),
    meaningFaults: [],
    correctedVersion: '',
    bestAnswer: s.BEST || '',
    vocabularyTip: '',
    fluencyNote: '',
    ask: s.ASK || 'Shall I ask you the next one?',
    scored: Number.isFinite(halfBand),
  };
}

/** Strip the protocol so TTS reads natural speech only:
 *  markers vanish, bullets flatten, arrows become spoken words. */
export function stripMarkers(raw) {
  if (!raw) return '';
  return String(raw)
    .split('\n')
    .filter((line) => !/^\s*\[[A-Z]+\]\s*$/.test(line))
    .map((line) => line
      .replace(/^\s*[-•*]\s*/, '')
      .replace(/\s*[—–]\s*[“"]/g, ', which should be "')
      .replace(/\s*[—–]\s*'/g, ", which should be '")
      .replace(/\s*→\s*/g, ', which should be ')
      .trim())
    .filter(Boolean)
    .join(' ');
}

/** yes / no intent from a RAW spoken transcript (the §13.4 honesty
 *  rule still applies — we match intent, we never rewrite the words). */
export function detectYesNo(transcript) {
  const t = String(transcript || '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(no|nope|not now|stop|later|don'?t|do not|enough|finish|that'?s all|that is all|enough for today)\b/.test(t)) return 'no';
  if (/\b(yes|yeah|yep|yup|sure|okay|ok|please|go ahead|next|ready|let'?s go|lets go|continue|start)\b/.test(t)) return 'yes';
  return null;
}
