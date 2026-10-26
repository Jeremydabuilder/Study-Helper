import { describe, expect, it } from 'vitest';
import { chunkText, findQuote, verifyQuotes } from '../src/core/sources';
import { buildContext, rank } from '../src/core/retrieval';

const TEXT = `--- Page 1 ---
Absolute value measures distance from zero. It is always non-negative.

To solve |x| = 5, consider two cases: x = 5 or x = -5.

--- Page 2 ---
Inequalities flip direction when you multiply or divide by a negative number.
`;

describe('source references', () => {
  it('keeps page numbers and paragraph locations with exact offsets', () => {
    const cs = chunkText(TEXT);
    expect(cs.map((c) => c.label)).toEqual(['p. 1, ¶1', 'p. 1, ¶2', 'p. 2, ¶1']);
    for (const c of cs) expect(TEXT.slice(c.start, c.end)).toBe(c.text);
  });
  it('verifies quotes despite case/whitespace/curly-quote differences, and rejects invented ones', () => {
    const cs = chunkText(TEXT);
    const { verified, rejected } = verifyQuotes(TEXT, cs, [
      'absolute value  measures distance\nfrom zero', 'flip direction when you multiply', 'The teacher said this will be on the test',
    ]);
    expect(verified).toHaveLength(2);
    expect(verified[0].label).toBe('p. 1, ¶1');
    expect(verified[1].label).toBe('p. 2, ¶1');
    expect(rejected).toEqual(['The teacher said this will be on the test']);
    expect(TEXT.slice(verified[0].start, verified[0].end).toLowerCase()).toContain('distance');
  });
  it('rejects too-short quotes', () => expect(findQuote(TEXT, 'abs')).toBeNull());
  it('supports form-feed page breaks and flags suspicious OCR math', () => {
    const cs = chunkText('First page text here.\f2l3 = x\n\nsecond para', { ocr: true });
    expect(cs[0].page).toBe(1); expect(cs[1].page).toBe(2);
    expect(cs.some((c) => c.uncertain)).toBe(true);
  });
  it('splits very long paragraphs but keeps offsets exact', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} explains something.`).join(' ');
    const cs = chunkText(long);
    expect(cs.length).toBeGreaterThan(1);
    for (const c of cs) expect(long.slice(c.start, c.end)).toBe(c.text);
  });
});

describe('relevant-context retrieval', () => {
  it('ranks relevant chunks and caps the context instead of resending everything', () => {
    const chunks = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, label: `¶${i}`, text: i === 7 ? 'The French Revolution began in 1789 with the Estates-General.' : `Unrelated filler about photosynthesis number ${i}.` }));
    expect(rank('French Revolution 1789', chunks, (c) => c.text, 2)[0].item.id).toBe('c7');
    const ctx = buildContext({
      concept: { id: 'k', name: 'French Revolution', summary: 'began 1789', subjectId: 's' }, chunks, refChunkIds: [],
      memories: [
        { id: 'm1', kind: 'student_stated', text: 'I prefer short sessions', subjectId: null, conceptId: null },
        { id: 'm2', kind: 'student_stated', text: 'Other subject note', subjectId: 'other', conceptId: null },
        { id: 'm3', kind: 'ai_inferred', text: 'unscoped inference', subjectId: null, conceptId: null },
      ], misconceptions: [{ description: 'Confuses 1789 with 1776', count: 2 }], maxChars: 3000,
    });
    expect(ctx.sourceExcerpts[0].id).toBe('c7');
    expect(ctx.sourceExcerpts.length).toBeLessThanOrEqual(2);
    expect(ctx.memories).toEqual(['[student_stated] I prefer short sessions']);
    expect(ctx.chars).toBeLessThan(3000);
  });
});
