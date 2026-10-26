import type { ConceptExtraction, GradeResult, QuestionBatch } from './schemas';

export type AIErrorCode = 'timeout' | 'rate_limited' | 'unavailable' | 'malformed' | 'limit_reached' | 'not_configured' | 'rejected';
export class AIError extends Error {
  constructor(public code: AIErrorCode, message: string, public retryAfterMs?: number) { super(message); }
  get retryable() { return this.code === 'timeout' || this.code === 'rate_limited' || this.code === 'unavailable' || this.code === 'malformed'; }
}

export interface ExtractInput { subjectName: string; chunks: { id: string; label: string; text: string }[]; maxConcepts: number }
export interface GenerateInput {
  subjectName: string;
  concept: { name: string; summary: string; skillTag: string | null };
  excerpts: { label: string; text: string }[];
  otherConcepts: { name: string; summary: string }[];
  misconceptions: string[];
  studentNotes: string[];
  practice: number; heldout: number;
  avoidPrompts: string[]; seed: number;
  focus?: 'diagnostic' | 'practice' | 'transfer' | 'repair';
}
export interface GradeInput {
  question: { prompt: string; kind: string; rubric: { point: string; keywords: string[] }[]; sampleAnswer?: string };
  answer: string; reasoning: string; excerpts: { label: string; text: string }[];
}

export interface AIProvider {
  readonly name: string;
  /** true if a real model is behind it (answers may be fallible); false for offline/template mode */
  readonly live: boolean;
  readonly label: string;
  extractConcepts(i: ExtractInput): Promise<ConceptExtraction>;
  generateQuestions(i: GenerateInput): Promise<QuestionBatch>;
  gradeAnswer(i: GradeInput): Promise<GradeResult>;
}
