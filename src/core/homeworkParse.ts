/**
 * Reading an assignment sheet WITHOUT inventing anything. Everything here is a proposal the student confirms:
 *  - the questions are split by their visible numbering only; if no numbering is found the whole text is ONE question (flagged), never guessed at
 *  - a due date is only suggested when the text states a calendar date; "due Friday" is quoted back but never turned into a date
 *  - text that could not be read (OCR markers) is marked, so the app can show it before anything is solved
 */
import { EXCLUDED_MARKER, detectInstructionLike, findQuote, maskForModel } from './sources';

export interface ParsedQuestion { label: string; prompt: string; stem: string; start: number; end: number; unreadable: boolean }
export interface ParsedSheet { preamble: string; questions: ParsedQuestion[]; split: 'numbered' | 'none' }

const MAIN = /^[ \t]*(?:(?:q(?:uestion)?|problem|exercise)\s*)?\(?(\d{1,3})\s*[.):\]]\s*(\S.*)?$/i;
const PART = /^[ \t]*\(?([a-h])\s*[.)]\s+(\S.*)$/i;
export const UNREADABLE = /\[(?:unreadable|illegible|unclear|\?+)[^\]]*\]|�|\?{3,}|\[…[^\]]*\]/i;

/** Split on visible numbering (1. / 1) / Q1 / Question 1) and lettered parts (a. / (b)). Offsets point into `text`. */
export function splitSheet(text: string): ParsedSheet {
  const lines: { t: string; start: number }[] = [];
  let off = 0; for (const l of text.replace(/\r\n/g, '\n').split('\n')) { lines.push({ t: l, start: off }); off += l.length + 1; }
  const mains: { n: string; idx: number }[] = [];
  let expect = 1;
  lines.forEach((l, i) => { const m = MAIN.exec(l.t); if (m && Number(m[1]) === expect) { mains.push({ n: m[1], idx: i }); expect++; } });
  // "1." followed by prose that is only a sentence number, e.g. "1. Read the instructions": still a question number by position; the student can merge or remove it
  if (mains.length < 1) return { preamble: '', questions: [{ label: '1', prompt: text.trim(), stem: text.trim(), start: 0, end: text.length, unreadable: UNREADABLE.test(text) }], split: 'none' };
  const preamble = lines.slice(0, mains[0].idx).map((l) => l.t).join('\n').trim();
  const out: ParsedQuestion[] = [];
  mains.forEach((mq, k) => {
    const endIdx = k + 1 < mains.length ? mains[k + 1].idx : lines.length;
    const block = lines.slice(mq.idx, endIdx);
    const start = block[0].start, last = block[block.length - 1];
    const end = last.start + last.t.length;
    const first = block[0].t.replace(MAIN, (_s, _n, rest) => rest ?? '').trim();
    const parts: { label: string; text: string; start: number }[] = [];
    const stem: string[] = first ? [first] : [];
    for (const l of block.slice(1)) {
      const p = PART.exec(l.t);
      if (p && (parts.length === 0 ? p[1].toLowerCase() === 'a' : p[1].toLowerCase().charCodeAt(0) === parts[parts.length - 1].label.toLowerCase().charCodeAt(0) + 1)) parts.push({ label: p[1].toLowerCase(), text: p[2].trim(), start: l.start });
      else if (parts.length) parts[parts.length - 1].text += `\n${l.t.trim()}`;
      else if (l.t.trim()) stem.push(l.t.trim());
    }
    const stemText = stem.join('\n').trim();
    if (parts.length >= 2) for (const p of parts) { const prompt = `${stemText ? `${stemText}\n` : ''}(${p.label}) ${p.text.trim()}`.trim(); out.push({ label: `${mq.n}${p.label}`, prompt, stem: stemText, start: p.start, end, unreadable: UNREADABLE.test(prompt) }); }
    else { const prompt = [stemText, ...parts.map((p) => `(${p.label}) ${p.text}`)].filter(Boolean).join('\n').trim(); out.push({ label: mq.n, prompt, stem: stemText, start, end, unreadable: UNREADABLE.test(prompt) }); }
  });
  return { preamble, questions: out.filter((q) => q.prompt), split: 'numbered' };
}

export interface DueHint { quote: string; date: string | null; note: string }
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

/**
 * Looks for the words "due"/"deadline"/"hand in" near a stated date. Always returns the exact quote so the student can see where it came from.
 * A date with no year is placed in the next occurrence on or after `today` and said to be a guess. Weekday or relative words ("due Friday") are quoted but give no date.
 */
export function dueHints(text: string, today: string): DueHint[] {
  const out: DueHint[] = [];
  const [ty, tm, td] = today.split('-').map(Number);
  const re = /\b(?:due|deadline|hand(?:ed)?[ -]?in|turn(?:ed)?[ -]?in|submit(?:ted)?)\b[^\n.;]{0,40}/gi;
  for (const m of text.matchAll(re)) {
    const seg = m[0];
    const iso = seg.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    const mdy = seg.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    const word = seg.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
    const dmy = seg.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/i);
    let y: number | null = null, mo = 0, d = 0, yearStated = true;
    if (iso) { y = Number(iso[1]); mo = Number(iso[2]); d = Number(iso[3]); }
    else if (word) { mo = MONTHS.indexOf(word[1].toLowerCase()) + 1; d = Number(word[2]); y = word[3] ? Number(word[3]) : null; }
    else if (dmy) { d = Number(dmy[1]); mo = MONTHS.indexOf(dmy[2].toLowerCase()) + 1; y = dmy[3] ? Number(dmy[3]) : null; }
    else if (mdy) { mo = Number(mdy[1]); d = Number(mdy[2]); y = mdy[3] ? (Number(mdy[3]) < 100 ? 2000 + Number(mdy[3]) : Number(mdy[3])) : null; }
    else {
      if (/\b(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+|end of (?:the )?(?:week|class)|class)\b/i.test(seg)) out.push({ quote: seg.trim(), date: null, note: 'The sheet gives a day or time but not a calendar date. Pick the date yourself.' });
      continue;
    }
    if (y === null) { yearStated = false; y = ty; if (!valid(y, mo, d) || `${y}-${pad(mo)}-${pad(d)}` < today) y = ty + 1; }
    if (!valid(y, mo, d)) continue;
    out.push({ quote: seg.trim(), date: `${y}-${pad(mo)}-${pad(d)}`, note: yearStated ? 'Stated on the sheet.' : `No year is written, so this assumes ${y}. Check it.` });
    void tm; void td;
  }
  return out.slice(0, 3);
}

/** Text the AI may see: strong instruction-like passages are replaced by a visible marker. Returns whether anything was left out. */
export function safeForModel(text: string): { text: string; masked: boolean } {
  const spans = detectInstructionLike(text).filter((f) => f.severity === 'strong').map((f) => ({ start: f.start, end: f.end }));
  if (!spans.length) return { text, masked: false };
  return { text: maskForModel(text, 0, spans), masked: true };
}
export { EXCLUDED_MARKER };

export interface QuoteCheck { quote: string; inSource: boolean | null }
/** Quoted passages in a student's writing, and whether each appears word for word in the provided source. `null` = no source to compare with. */
export function checkQuotations(writing: string, source: string | null): QuoteCheck[] {
  const out: QuoteCheck[] = [];
  for (const m of writing.matchAll(/["“]([^"”\n]{12,400})["”]/g)) out.push({ quote: m[1].trim(), inSource: source ? !!findQuote(source, m[1].trim()) : null });
  return out.slice(0, 12);
}

/** Meaning of common task words, used when the assistant is unavailable and to point at what an instruction asks for. Plain, short, and not a grading rule. */
export const TASK_WORDS: Record<string, string> = {
  analyze: 'break something into parts and explain how the parts work or connect', analyse: 'break something into parts and explain how the parts work or connect',
  compare: 'say how things are alike (and usually different)', contrast: 'say how things are different', describe: 'say what something is like, with details',
  explain: 'say how or why, step by step', evaluate: 'judge how good, strong or true something is, and give reasons', justify: 'give reasons or evidence for a claim',
  summarize: 'give the main points briefly in your own words', summarise: 'give the main points briefly in your own words', identify: 'name or point out', define: 'give the meaning',
  outline: 'give the main points in order', discuss: 'look at different sides of an idea with reasons', cite: 'point to where in the text or source the evidence comes from',
  solve: 'find the value(s) that make it true', simplify: 'rewrite in a simpler equivalent form', 'show your work': 'write the steps you used, not only the answer',
  predict: 'say what you expect to happen and why', infer: 'work out something the text implies but does not say directly', support: 'back up a claim with evidence',
};
export function taskWordsIn(text: string): { word: string; meaning: string }[] {
  const low = text.toLowerCase(); const seen = new Set<string>(); const out: { word: string; meaning: string }[] = [];
  for (const [w, meaning] of Object.entries(TASK_WORDS)) if (new RegExp(`\\b${w}\\b`).test(low) && !seen.has(meaning)) { seen.add(meaning); out.push({ word: w, meaning }); }
  return out.slice(0, 6);
}

/** Rough subject kind from the student's subject name; used only to pick the right kind of help and checking. The student can override it. */
export function guessKind(subjectName: string, prompt: string): 'math' | 'science' | 'history' | 'english' | 'other' {
  const s = `${subjectName}`.toLowerCase();
  if (/math|algebra|geometry|calculus|trig|statistic|arithmetic/.test(s)) return 'math';
  if (/english|literature|lit\b|writing|language arts|composition|ela\b/.test(s)) return 'english';
  if (/history|social|geograph|civics|government|econom/.test(s)) return 'history';
  if (/science|biolog|chem|physic|earth|environment/.test(s)) return 'science';
  if (/^\s*(solve|simplify|expand|factor|evaluate)\b/i.test(prompt) && /[=<>^]|\d/.test(prompt)) return 'math';
  return 'other';
}
