/**
 * Does a quoted passage actually contain what a question needs?
 *
 * A verbatim quote only proves the quote exists. It does not prove the question or its key is supported by it: a model can copy a real
 * sentence and attach it to an unrelated question. This is a deliberately simple lexical check (are the answer's key terms in the
 * passage?). It catches the obvious mismatch; it cannot prove a question is well grounded, and the UI says so.
 */
const STOP = new Set('about above after again also because been before being between both could does doing during each from have having here into just like made make many more most much must only other over same should some such than that their them then there these they this those through under until very what when where which while will with would your you are was were the and for not but can its it\'s'.split(' '));

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
export function contentWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))];
}

export interface KeySpec { kind: string; correctChoice?: string; keyPoints?: { point: string; keywords: string[] }[]; sample?: string }

/** The ideas an answer must contain, as groups of acceptable words (a group counts as present if any of its words is). */
export function keyGroups(k: KeySpec): string[][] {
  if (k.kind === 'multiple_choice') return k.correctChoice ? contentWords(k.correctChoice).map((w) => [w]) : [];
  const groups = (k.keyPoints ?? []).map((p) => { const kw = (p.keywords ?? []).flatMap((x) => contentWords(x)); return kw.length ? kw : contentWords(p.point); }).filter((g) => g.length);
  if (groups.length) return groups;
  return k.sample ? contentWords(k.sample).slice(0, 8).map((w) => [w]) : [];
}

export interface SupportResult { support: 'supported' | 'quote_only'; matched: number; total: number }
export function assessSupport(passage: string, key: KeySpec): SupportResult {
  const have = new Set(contentWords(passage));
  const groups = keyGroups(key);
  if (!groups.length) return { support: 'quote_only', matched: 0, total: 0 };
  const matched = groups.filter((g) => g.some((w) => have.has(w))).length;
  return { support: matched / groups.length >= 0.6 ? 'supported' : 'quote_only', matched, total: groups.length };
}

/* ------------------------------------------------------------------------------------------------------------------------------
 * Deterministic contradiction checks. They look for specific, recognisable ways a key can conflict with the passage it cites:
 * negation flipped, a date that differs, "A before B" with the dates reversed, and the wrong person/institution (a different
 * First/Second…, or different named entities in an otherwise matching sentence). They are HEURISTICS: a hit means "check this", not proof,
 * and silence means nothing. Keyword overlap alone never establishes support; only a structured semantic assessment can mark a question
 * "plausible", and that is fallible too.
 * ---------------------------------------------------------------------------------------------------------------------------- */

export const splitSentences = (t: string) => t.replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+|\s*;\s*/).map((x) => x.trim()).filter((x) => x.length > 3);
const NEG = /\b(not|never|no|neither|nor|without|cannot|hardly|rarely)\b|n't\b/i;
const negated = (s: string) => NEG.test(s.replace(/\bnot only\b/gi, '').replace(/\bno (longer|more)\b/gi, 'x'));
const YEAR = /\b(1[0-9]{3}|20[0-9]{2})\b/g;
const years = (s: string) => [...s.matchAll(YEAR)].map((m) => Number(m[1]));
const DISTINCT = /\b(first|second|third|fourth|fifth|northern|southern|eastern|western|upper|lower)\b/gi;
const distinct = (s: string) => new Set([...s.matchAll(DISTINCT)].map((m) => m[1].toLowerCase()));
const entities = (s: string) => {
  const out = new Set<string>(); const words = s.split(/\s+/);
  words.forEach((w, i) => { const c = w.replace(/[^A-Za-z]/g, ''); if (c.length >= 3 && !STOP.has(c.toLowerCase()) && /^[A-Z][a-z]+$/.test(c) && (i > 0 || /^[A-Z][a-z]+$/.test((words[1] ?? '').replace(/[^A-Za-z]/g, '')))) { if (!DISTINCT.test(c)) out.add(stem(c.toLowerCase())); DISTINCT.lastIndex = 0; } });
  return out;
};
const ov = (a: string[], b: Set<string>) => (a.length ? a.filter((w) => b.has(w)).length / a.length : 0);

/** The passage sentence that says (nearly) the same thing as the key statement, or null if none does. */
function bestSentence(key: string, passage: string) {
  const kw = contentWords(key); if (kw.length < 2) return null;
  let best: { s: string; r: number } | null = null;
  for (const s of splitSentences(passage)) { const r = ov(kw, new Set(contentWords(s))); if (!best || r > best.r) best = { s, r }; }
  return best && best.r >= 0.5 ? best : null;
}
function yearNear(sentence: string, phrase: string[]): number | null {
  const toks = sentence.toLowerCase().split(/\s+/); const pos = toks.map((t, i) => (phrase.some((w) => stem(t.replace(/[^a-z0-9'-]/g, '')) === w) ? i : -1)).filter((i) => i >= 0);
  const ys = toks.map((t, i) => ({ y: /^(1[0-9]{3}|20[0-9]{2})\W*$/.test(t) ? Number(t.replace(/\D/g, '')) : null, i })).filter((x) => x.y !== null);
  if (!pos.length || !ys.length) return null;
  const mid = pos.reduce((a, b) => a + b, 0) / pos.length;
  return ys.sort((a, b) => Math.abs(a.i - mid) - Math.abs(b.i - mid))[0].y;
}

/** Returns a plain-language reason when the key statement appears to conflict with the passage, else null. */
export function findContradiction(keyStatement: string, passage: string): string | null {
  const hit = bestSentence(keyStatement, passage);
  if (hit) {
    const { s } = hit;
    if (negated(s) !== negated(keyStatement)) return `The source says: “${s.slice(0, 160)}”, which is the opposite way round (negation) from the answer key.`;
    const yk = years(keyStatement), ys = years(s);
    if (yk.length && ys.length && !yk.some((y) => ys.includes(y))) return `The dates differ: the answer key says ${yk.join(', ')}; the source sentence says ${ys.join(', ')}.`;
    const dk = distinct(keyStatement), dp = distinct(s);
    if (dk.size && dp.size && ![...dk].some((x) => dp.has(x))) return `The key and the source name different ones (“${[...dk].join('/')}” vs “${[...dp].join('/')}”): possibly the wrong person or body.`;
    const ek = entities(keyStatement), ep = entities(s);
    const plain = contentWords(keyStatement).filter((w) => !ek.has(w));
    if (ek.size && ep.size && ![...ek].some((x) => ep.has(x)) && ov(plain, new Set(contentWords(s))) >= 0.5) return `The key names ${[...ek].join(', ')} but the matching source sentence names ${[...ep].join(', ')}: possibly the wrong person or institution.`;
  }
  // "A before/after B" against the dates the passage gives for A and B
  const m = keyStatement.match(/^(.+?)\b(before|after)\b(.+)$/i);
  if (m) {
    const L = contentWords(m[1]), R = contentWords(m[3]);
    const find = (w: string[]) => { for (const s of splitSentences(passage)) if (w.length && ov(w, new Set(contentWords(s))) >= 0.6) { const y = yearNear(s, w); if (y !== null) return y; } return null; };
    const yl = L.length ? find(L) : null, yr = R.length ? find(R) : null;
    if (yl !== null && yr !== null && yl !== yr && ((m[2].toLowerCase() === 'before') !== (yl < yr))) return `Order: the answer key says “${m[1].trim().slice(0, 60)}” came ${m[2].toLowerCase()} “${m[3].trim().slice(0, 60)}”, but the source dates them ${yl} and ${yr}.`;
  }
  return null;
}

/** A named person/place/body in the key that the cited passage never mentions: the passage cannot be what supports that part of the answer. */
export function findUnmentioned(keyStatement: string, passage: string): string | null {
  const have = new Set((passage.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).map(stem));
  const missing = [...entities(keyStatement)].filter((e) => !have.has(e));
  return missing.length ? `The answer key names “${missing.slice(0, 3).join(', ')}”, which the cited part of your material never mentions.` : null;
}

/** All key statements of a question that can be compared with a passage. */
export function keyStatements(k: KeySpec & { prompt?: string }): string[] {
  if (k.kind === 'multiple_choice') return k.correctChoice ? [k.correctChoice] : [];
  const pts = (k.keyPoints ?? []).map((p) => p.point).filter((x) => x.split(/\s+/).length >= 4);
  return pts.length ? pts : k.sample ? splitSentences(k.sample).slice(0, 3) : [];
}

/** Questions where several answers can be defensible (reading, themes, motives): a single-key support check does not apply. */
export function looksInterpretive(subject: string, prompt: string, kind: string): boolean {
  if (kind === 'math' || kind === 'multiple_choice') return false;
  const cues = /\b(how does the author|why does the author|what does .{0,40}(suggest|reveal|show|symbolize)|character|theme|tone|mood|motive|symbol|interpret|in your opinion|do you agree|which .{0,30} best)\b/i;
  return kind === 'evidence' || (/english|literature|\bela\b|reading|writing/i.test(subject) && cues.test(prompt)) || cues.test(prompt) && /english|literature|\bela\b|reading|writing/i.test(subject);
}

export type SupportState = 'none' | 'located' | 'plausible' | 'contradicted' | 'insufficient' | 'accepted';
export const SUPPORT_LABEL: Record<SupportState, string> = {
  none: 'General question — not tied to your material',
  located: 'Quote located — support not assessed',
  plausible: 'Support checked — plausibly from your material',
  contradicted: 'The key may conflict with your material',
  insufficient: 'Your material may not say enough to check this',
  accepted: 'You accepted this question',
};
