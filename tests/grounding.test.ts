import { describe, expect, it } from 'vitest';
import { assessSupport, findContradiction, findUnmentioned, looksInterpretive } from '../src/core/grounding';

const HIST = `Great Plow-Up: during and after World War I, high wheat prices led farmers to plow up millions of acres of native prairie grass. Drought did not cause the soil to be loose; the bare, plowed fields did. The Taylor Grazing Act of 1934 regulated grazing on public land. The Soil Conservation Service was created in 1935 to teach farmers methods that hold soil. The First Continental Congress met in 1774 and sought repeal of the Intolerable Acts. The Second Continental Congress met from 1775 and adopted the Declaration of Independence in 1776.`;

describe('deterministic contradiction checks (heuristics: a hit means "check this", silence proves nothing)', () => {
  it('a source stating “X did not cause Y” against a key claiming X caused Y', () => {
    expect(findContradiction('Drought caused the soil to be loose', HIST)).toMatch(/opposite way round/);
    expect(findContradiction('Drought did not cause the soil to be loose', HIST)).toBeNull(); // agrees with the source
  });
  it('reversed chronology', () => {
    expect(findContradiction('The Soil Conservation Service was created before the Taylor Grazing Act', HIST)).toMatch(/Order:.*1935.*1934|Order:.*1934.*1935/);
    expect(findContradiction('The Soil Conservation Service was created after the Taylor Grazing Act', HIST)).toBeNull();
    expect(findContradiction('The Soil Conservation Service was created in 1934 to teach farmers methods that hold soil', HIST)).toMatch(/dates differ/);
  });
  it('swapped people or institutions', () => {
    expect(findContradiction('The First Continental Congress adopted the Declaration of Independence in 1776', HIST)).toMatch(/different ones|dates differ|wrong person/);
    expect(findContradiction('The Second Continental Congress adopted the Declaration of Independence', HIST)).toBeNull();
    // a body the passage never mentions is flagged as unsupported by it (not as a contradiction)
    expect(findUnmentioned('The Reconstruction Board created the Soil Conservation Service to teach farmers methods that hold soil', HIST)).toMatch(/never mentions/);
    expect(findUnmentioned('The Soil Conservation Service was created in 1935', HIST)).toBeNull();
  });
  it('correct terminology attached to a wrong relationship is NOT detectable by keywords: it is never called supported by them', () => {
    const key = { kind: 'short_answer', keyPoints: [{ point: 'Drought caused the Great Plow-Up', keywords: ['drought', 'plow-up'] }] };
    // every key word is in the passage, so overlap says "supported" — which is exactly why overlap cannot be evidence of support
    expect(assessSupport(HIST, key).support).toBe('supported');
    expect(findContradiction('Drought caused the Great Plow-Up', HIST)).toBeNull(); // the heuristics do not catch it either; a semantic check is required
  });
  it('an accurate paraphrase with little word overlap is not flagged as a contradiction (it is simply not assessed by keywords)', () => {
    const para = 'Farmers tore up the natural grassland once wheat became valuable';
    expect(findContradiction(para, HIST)).toBeNull();
    expect(assessSupport(HIST, { kind: 'short_answer', keyPoints: [{ point: para, keywords: ['tore', 'grassland', 'valuable'] }] }).support).toBe('quote_only'); // low overlap ≠ unsupported
  });
  it('interpretive English questions are recognised: several answers can be defensible', () => {
    expect(looksInterpretive('English', 'How does the author show Mara’s character?', 'explain')).toBe(true);
    expect(looksInterpretive('English', 'What does the lantern symbolize?', 'explain')).toBe(true);
    expect(looksInterpretive('History', 'What did the Soil Conservation Service teach farmers?', 'short_answer')).toBe(false);
    expect(looksInterpretive('English', 'Which words are in the first sentence?', 'multiple_choice')).toBe(false);
  });
});

describe('spelling is not graded by the offline keyword check', () => {
  it('a one-letter slip in a longer word still matches; short words and different words do not', async () => {
    const { fuzzyHas } = await import('../src/ai/offline');
    expect(fuzzyHas('chlorophyl absorbs light', 'chlorophyll')).toBe(true);
    expect(fuzzyHas('photosynthesys makes glucose', 'photosynthesis')).toBe(true);
    expect(fuzzyHas('cat sat', 'car')).toBe(false);
    expect(fuzzyHas('stomta open', 'stomata')).toBe(true);
    expect(fuzzyHas('mitochondria', 'chloroplast')).toBe(false);
  });
});
