import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const Review = z.object({ status: z.enum(['draft', 'approved']), by: z.string().nullable(), at: z.string().nullable() });
export const Band = z.enum(['low', 'mid', 'high']);
export type Band = z.infer<typeof Band>;
const Excerpt = z.object({ label: z.string(), text: z.string() });

export const GradingItem = z.object({
  id: z.string(), category: z.string(), subject: z.string(), concept: z.string(), question: z.string(),
  rubric: z.array(z.object({ point: z.string(), keywords: z.array(z.string()) })), sampleAnswer: z.string().nullable(),
  excerpts: z.array(Excerpt), answer: z.string(), reasoning: z.string(),
  /** acceptable outcome bands (high ≥ 0.8, mid 0.35–0.8, low < 0.35); mustNotBeConfident = the grader should not claim "high" confidence */
  expected: z.object({ acceptable: z.array(Band).min(1), mustNotBeConfident: z.boolean().optional() }),
  note: z.string(), review: Review,
});
export const ExtractionItem = z.object({
  id: z.string(), subject: z.string(), text: z.string(), expectedConcepts: z.array(z.string()), forbiddenPatterns: z.array(z.string()),
  expectedSkillTags: z.record(z.string()), note: z.string(), review: Review,
});
export const GenerationItem = z.object({
  id: z.string(), subject: z.string(), concept: z.object({ name: z.string(), summary: z.string(), skillTag: z.string().nullable() }),
  excerpts: z.array(Excerpt), otherConcepts: z.array(z.object({ name: z.string(), summary: z.string() })), practice: z.number(), heldout: z.number(), review: Review,
});
export const MathItem = z.object({
  id: z.string(), category: z.string(), spec: z.union([
    z.object({ type: z.literal('math_set'), answer: z.string(), variable: z.string().optional() }),
    z.object({ type: z.literal('math_expr'), answer: z.string(), variable: z.string().optional() }),
    z.object({ type: z.literal('math_number'), answer: z.string() })]),
  student: z.string(), expected: z.enum(['correct', 'partial', 'incorrect', 'unparseable']), tags: z.array(z.string()).optional(), note: z.string(), review: Review,
});
export type GradingItem = z.infer<typeof GradingItem>;
export type ExtractionItem = z.infer<typeof ExtractionItem>;
export type GenerationItem = z.infer<typeof GenerationItem>;
export type MathItem = z.infer<typeof MathItem>;

export interface Dataset { grading: GradingItem[]; extraction: ExtractionItem[]; generation: GenerationItem[]; math: MathItem[] }

export function loadDataset(dir = join(process.cwd(), 'eval', 'dataset')): Dataset {
  const read = <T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>) => z.array(schema).parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
  return { grading: read('grading.json', GradingItem), extraction: read('extraction.json', ExtractionItem), generation: read('generation.json', GenerationItem), math: read('math.json', MathItem) };
}

export function reviewStatus(d: Dataset) {
  const all = [...d.grading, ...d.extraction, ...d.generation, ...d.math];
  return { total: all.length, approved: all.filter((x) => x.review.status === 'approved').length };
}
