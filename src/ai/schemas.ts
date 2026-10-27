import { z } from 'zod';

export const ExtractedConcept = z.object({
  name: z.string().trim().min(2).max(90),
  summary: z.string().trim().min(5).max(500),
  /** Verbatim snippets from the source that support this concept. Verified by the app; invented ones are dropped. */
  quotes: z.array(z.string().max(400)).max(3).default([]),
  prerequisites: z.array(z.string().max(90)).max(4).default([]),
  skill_tag: z.string().max(40).nullable().optional(),
});
export const ConceptExtraction = z.object({ concepts: z.array(ExtractedConcept).min(1).max(20) });
export type ConceptExtraction = z.infer<typeof ConceptExtraction>;

const Rubric = z.object({
  key_points: z.array(z.object({ point: z.string().max(300), keywords: z.array(z.string().max(40)).max(8).default([]) })).min(1).max(8),
  sample_answer: z.string().max(800).optional(),
});
export const GeneratedQuestion = z.object({
  kind: z.enum(['multiple_choice', 'short_answer', 'explain', 'math', 'compare', 'cause_effect', 'evidence']),
  prompt: z.string().trim().min(8).max(1200),
  choices: z.array(z.object({ text: z.string().max(300), misconception: z.string().max(200).optional() })).min(2).max(5).optional(),
  correct_choice: z.number().int().min(0).max(4).optional(),
  /** For math: canonical answer, e.g. "x = 5 or x = -2", "x > 3", "2x+6". */
  answer: z.string().max(200).optional(),
  math_type: z.enum(['set', 'expr', 'number']).optional(),
  /** Machine-readable problem statement, e.g. "|2x-3| = 7". Lets the app verify the key independently. */
  relation: z.string().max(200).optional(),
  rubric: Rubric.optional(),
  hints: z.array(z.string().max(400)).min(1).max(3),
  worked_example: z.string().max(1500),
  explanation: z.string().max(1200),
  difficulty: z.number().int().min(1).max(3).default(2),
  source_quote: z.string().max(400).optional(),
}).superRefine((q, ctx) => {
  if (q.kind === 'multiple_choice' && (!q.choices || q.correct_choice === undefined || q.correct_choice >= q.choices.length))
    ctx.addIssue({ code: 'custom', message: 'multiple_choice needs choices and a valid correct_choice' });
  if (q.kind === 'math' && !q.answer) ctx.addIssue({ code: 'custom', message: 'math needs an answer' });
  if (q.kind !== 'multiple_choice' && q.kind !== 'math' && !q.rubric) ctx.addIssue({ code: 'custom', message: 'open questions need a rubric' });
});
export type GeneratedQuestion = z.infer<typeof GeneratedQuestion>;
export const QuestionBatch = z.object({ questions: z.array(GeneratedQuestion).min(1).max(8) });
export type QuestionBatch = z.infer<typeof QuestionBatch>;

export const GradeResult = z.object({
  correctness: z.number().min(0).max(1),
  confidence: z.enum(['high', 'medium', 'low']),
  feedback: z.string().trim().min(3).max(1500),
  points: z.array(z.object({ point: z.string().max(300), met: z.boolean(), evidence_quote: z.string().max(300).optional() })).max(10).default([]),
  misconception: z.object({ label: z.string().max(80), description: z.string().max(300) }).nullable().optional(),
  next_step: z.string().max(300).optional(),
  /** What kind of mistake, if any. The app only trusts this as one input; it never turns a single answer into a 'pattern'. */
  mistake_kind: z.enum(['missing_knowledge', 'concept_confusion', 'reasoning_error', 'slip', 'partial_explanation', 'none']).nullable().optional(),
  /** Name of the related concept the answer was really about, when mistake_kind is concept_confusion. */
  confused_with: z.string().max(90).nullable().optional(),
});
export type GradeResult = z.infer<typeof GradeResult>;

export const Clarification = z.object({ answer: z.string().trim().min(3).max(1500) });
export type Clarification = z.infer<typeof Clarification>;
