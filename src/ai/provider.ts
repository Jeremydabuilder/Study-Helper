import type { ConceptExtraction, GradeResult, QuestionBatch } from './schemas';

export type AIErrorCode = 'budget_reached' | 'timeout' | 'rate_limited' | 'unavailable' | 'malformed' | 'limit_reached' | 'not_configured' | 'rejected';
/**
 * What we know about whether a failed request could have been billed.
 *  not_sent      – it never left this machine (e.g. connection refused, DNS failure): confirmed zero cost
 *  none_reported – the provider answered with an error status and reported no usage: treated as zero, labelled as such
 *  unknown       – we sent it and got no usable answer (timeout, reset, unreadable body): it MAY have been billed
 */
export type BillingHint = 'not_sent' | 'none_reported' | 'unknown';
export class AIError extends Error {
  constructor(public code: AIErrorCode, message: string, public retryAfterMs?: number, public billing?: BillingHint) { super(message); }
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
  /** Another concept the student tends to confuse this one with (for discrimination questions). */
  contrast?: { name: string; summary: string };
  /** Rubric points the student's last answer missed (for gap-filling questions). */
  gapPoints?: string[];
  /** Regeneration after unsupported output: quote only what the excerpts literally say. */
  strict?: boolean;
  /** The student's own description of their grade/course (data, may be empty). Used to pitch reading level and difficulty. */
  gradeLevel?: string;
  focus?: 'diagnostic' | 'practice' | 'transfer' | 'repair' | 'discriminate' | 'gap' | 'simpler';
}
export interface GradeInput {
  question: { prompt: string; kind: string; rubric: { point: string; keywords: string[] }[]; sampleAnswer?: string };
  answer: string; reasoning: string; excerpts: { label: string; text: string }[];
  gradeLevel?: string;
  /** Earlier observations on this concept (from saved memory), so the grader can check whether the same issue recurs. */
  knownIssues?: string[];
}

/** A question about ONE piece of feedback. Only the current question, the student's answer, its feedback and the concept's source passages are provided. */
export interface ClarifyInput {
  question: { prompt: string; kind: string }; answer: string; feedback: string; explanation: string | null; keyPoints: string[];
  excerpts: { label: string; text: string }[]; conceptName: string; ask: string; gradeLevel?: string;
}

/** Page content sent to a vision-capable provider: raw bytes, base64. `pages` is the page count of a PDF attachment. */
export interface Attachment { kind: 'image' | 'pdf'; mediaType: string; data: string; pages?: number }
export interface ReadInput { attachment: Attachment; pageCount: number; label: string }
export interface ReadResult { pages: { page: number; blocks: { kind: 'text' | 'math' | 'table' | 'diagram' | 'handwriting' | 'other'; text: string; readable: boolean; note?: string }[] }[] }

/** Questions whose key should be checked against the source passage they cite. */
export interface AssessItem { index: number; question: string; kind: string; key: string[]; passage: string; label: string; interpretive: boolean }
export interface AssessResult { items: { index: number; verdict: 'supported' | 'contradicted' | 'insufficient'; note: string }[] }

/** Help with ONE selected passage of a reading. All text is student material (data). */
export interface AssistInput {
  kind: 'explain' | 'define' | 'question';
  passage: string; context: string; location: string; term?: string;
  readingTitle: string; subjectName: string; prompt?: { kind: 'prompt' | 'rubric'; text: string } | null; gradeLevel?: string;
}
/** Feedback on the student's OWN written annotation. `overlap` is a rule-based 0..1 measure of how much of the note just repeats the passage's words. */
export interface AnnotationFeedbackInput {
  passage: string; context: string; location: string; category: string; note: string; overlap: number;
  readingTitle: string; subjectName: string; prompt?: { kind: 'prompt' | 'rubric'; text: string } | null; gradeLevel?: string;
}
export interface ChatInput {
  mode: 'study' | 'general'; direct: boolean;
  /** Study mode only: the retrieved context block, already labelled. Empty in general mode. */
  context: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  message: string; gradeLevel?: string;
}

/** Help with one homework question. Instructions, the question, the student's work and any rubric are DATA; only `rules` in the prompt are instructions. */
export interface HomeworkHelpInput {
  action: 'explain_instructions' | 'start' | 'hint' | 'concept' | 'worked_solution' | 'draft_help';
  /** hint strength: 1 a nudge, 2 a stronger hint, 3 the next step spelled out */
  level: 1 | 2 | 3;
  kind: 'math' | 'science' | 'history' | 'english' | 'other';
  subjectName: string; gradeLevel?: string; label: string; instructions: string; question: string; working: string;
  /** labelled context retrieved for this question (the student's own materials); empty when none matched */
  context: string; rubric: string | null; ask: string | null;
  /** what the app's own deterministic check found about the working (math), already verified */
  verifiedNote: string | null;
  priorHelp: { action: string; text: string }[];
}
export interface HomeworkCheckInput {
  kind: 'math' | 'science' | 'history' | 'english' | 'other';
  subjectName: string; gradeLevel?: string; label: string; instructions: string; question: string; working: string;
  context: string; rubric: string | null; quotations: { quote: string; inSource: boolean | null }[]; verifiedNote: string | null;
}

export type AITask = 'extract' | 'generate' | 'grade';

/** How a request's cost is known. 'estimated' and 'unknown' are held at the conservative reservation, never at zero. */
export type BillingKind = 'reported' | 'estimated' | 'none_reported' | 'not_sent' | 'unknown';

/** One HTTP request to a provider. A repair retry is a separate record. */
export interface RequestRecord {
  purpose: string; provider: string; model: string; attempt: number;
  /** ok | invalid_output | empty | truncated | refused | <AIErrorCode> */
  outcome: string;
  latencyMs: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number; cacheWriteTokens: number;
  billing: BillingKind;
  stopReason: string | null; requestId: string | null;
}
export interface PreRequest {
  purpose: string; provider: string; model: string; attempt: number; maxOutputTokens: number;
  /** UTF-8 bytes of everything sent (system + user). A token covers at least one byte, so this bounds input tokens. */
  inputBytes: number;
  /** Non-reversible fingerprint of the credential + endpoint, so verification never carries over to a different key. */
  credFp: string | null;
}

/**
 * Spend accounting for provider requests. `reserve` is synchronous and atomic: it checks the budget against
 * everything already spent AND everything currently reserved, and records the reservation in the same step, so
 * concurrent callers cannot each spend the same remaining budget. Exactly one of settle/fail follows each reserve.
 */
export interface RequestLedger {
  /** Returns a unique request id, or throws AIError('budget_reached' | 'limit_reached') without sending anything. */
  reserve(p: PreRequest): string | Promise<string>;
  settle(id: string, r: RequestRecord): void | Promise<void>;
  fail(id: string, f: { outcome: string; billing: BillingKind; latencyMs: number }): void | Promise<void>;
}
export interface CallOpts { ledger?: RequestLedger }

export interface AIProvider {
  /** 'anthropic' | 'groq' for live providers. */
  readonly providerId?: string;
  /** Non-reversible fingerprint of the credential + endpoint; verification never carries over to a different key. */
  readonly credentialFingerprint?: string;
  /** Model that will serve a task (for display and for recording which model graded an attempt). */
  modelFor?(task: AITask): string;
  /** Tiny real request proving the credentials work. Offline providers omit it. */
  /** Optional: answer a short question about one piece of feedback. */
  clarify?(i: ClarifyInput, opts?: CallOpts): Promise<{ answer: string }>;
  /** Optional vision reading of page images / PDF pages. Only used when the operator has explicitly enabled it and the student has approved exactly what is sent. */
  /** Optional: a structured semantic check of question + key against the cited passage (one request for a whole batch). */
  assist?(i: AssistInput, opts?: CallOpts): Promise<{ text: string }>;
  annotationFeedback?(i: AnnotationFeedbackInput, opts?: CallOpts): Promise<import('./schemas').AnnotationFeedback>;
  chat?(i: ChatInput, opts?: CallOpts): Promise<{ reply: string }>;
  homeworkHelp?(i: HomeworkHelpInput, opts?: CallOpts): Promise<import('./schemas').HomeworkReply>;
  homeworkCheck?(i: HomeworkCheckInput, opts?: CallOpts): Promise<import('./schemas').HomeworkCheck>;
  assessSupport?(items: AssessItem[], opts?: CallOpts): Promise<AssessResult>;
  readPages?(i: ReadInput, opts?: CallOpts): Promise<ReadResult>;
  ocrModel?(): string;
  verify?(opts?: CallOpts, model?: string): Promise<{ model: string; latencyMs: number }>;
  readonly name: string;
  /** true if a real model is behind it (answers may be fallible); false for offline/template mode */
  readonly live: boolean;
  readonly label: string;
  extractConcepts(i: ExtractInput, opts?: CallOpts): Promise<ConceptExtraction>;
  generateQuestions(i: GenerateInput, opts?: CallOpts): Promise<QuestionBatch>;
  gradeAnswer(i: GradeInput, opts?: CallOpts): Promise<GradeResult>;
}
