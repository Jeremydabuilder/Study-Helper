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
