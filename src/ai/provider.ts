import type { ConceptExtraction, GradeResult, QuestionBatch } from './schemas';

export type AIErrorCode = 'budget_reached' | 'timeout' | 'rate_limited' | 'unavailable' | 'malformed' | 'limit_reached' | 'not_configured' | 'rejected';
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

export type AITask = 'extract' | 'generate' | 'grade';

/** One billable HTTP request to a provider. A repair retry is a separate record. */
export interface RequestRecord {
  purpose: string; provider: string; model: string; attempt: number;
  outcome: string; // ok | invalid_output | truncated | <AIErrorCode>
  latencyMs: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number; cacheWriteTokens: number;
  usageSource: 'provider' | 'estimated' | 'none';
  stopReason: string | null; requestId: string | null;
}
export interface PreRequest { purpose: string; provider: string; model: string; attempt: number; maxOutputTokens: number; inputChars: number }
export interface CallOpts {
  /** Called once per HTTP request, after it finishes (including failures). */
  onRequest?: (r: RequestRecord) => void;
  /** Called before each HTTP request; throw an AIError to block it (budget / call cap). */
  beforeRequest?: (p: PreRequest) => void;
}

export interface AIProvider {
  /** Model that will serve a task (for display and for recording which model graded an attempt). */
  modelFor?(task: AITask): string;
  /** Tiny real request proving the credentials work. Offline providers omit it. */
  verify?(opts?: CallOpts, model?: string): Promise<{ model: string; latencyMs: number }>;
  readonly name: string;
  /** true if a real model is behind it (answers may be fallible); false for offline/template mode */
  readonly live: boolean;
  readonly label: string;
  extractConcepts(i: ExtractInput, opts?: CallOpts): Promise<ConceptExtraction>;
  generateQuestions(i: GenerateInput, opts?: CallOpts): Promise<QuestionBatch>;
  gradeAnswer(i: GradeInput, opts?: CallOpts): Promise<GradeResult>;
}
