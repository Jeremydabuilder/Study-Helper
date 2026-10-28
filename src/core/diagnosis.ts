/**
 * What kind of mistake was this? One answer shows one observed mistake; only repetition across different questions justifies
 * calling something a recurring pattern. Classification uses evidence the app can see (the question's structure, a deterministic
 * math check, rubric points, or the grader's own label) and says "unreliable" rather than guessing when the grade can't be trusted.
 */
export type MistakeKind = 'missing_knowledge' | 'concept_confusion' | 'reasoning_error' | 'slip' | 'partial_explanation' | 'unknown_cause' | 'unreliable';
/** direct: the student said so · likely: a tag, a chosen distractor or rubric evidence points to it · unknown: a wrong answer alone does not say why */
export type Certainty = 'direct' | 'likely' | 'unknown';

export const MISTAKE_LABEL: Record<MistakeKind, string> = {
  missing_knowledge: 'Missing basics', concept_confusion: 'Mixed up two ideas', reasoning_error: 'Reasoning error', slip: 'Careless slip',
  partial_explanation: 'Partly right', unknown_cause: 'Cause unknown', unreliable: 'Grade or question unclear',
};
export const MISTAKE_BLURB: Record<MistakeKind, string> = {
  missing_knowledge: 'The key fact or idea did not show up in the answer.',
  concept_confusion: 'The answer fits a different, related idea.',
  reasoning_error: 'The idea was there, but the steps or logic went wrong.',
  slip: 'The method looked right; a sign or calculation was off.',
  partial_explanation: 'Some of the key ideas were there, others were missing.',
  unknown_cause: 'The answer did not match, and the answer alone does not show why.',
  unreliable: 'This result is not counted because the grade or the question could not be trusted.',
};

export interface DiagnoseInput {
  questionKind: string; correctness: number | null; gradeStatus: 'graded' | 'uncertain' | 'failed' | 'pending'; reportedUnclear?: boolean;
  idk?: boolean; blank?: boolean; mathTags?: string[]; slipTag?: boolean;
  /** For multiple choice: the chosen option carried a "mixed up with ..." label, naming the confusion. */
  chosenMisconception?: string | null;
  /** Another concept of the same subject that the wrong choice / answer text mentions. */
  confusedWith?: { id: string; name: string } | null;
  rubricMet?: number; rubricTotal?: number; graderKind?: MistakeKind | null;
  /** The student wrote their steps / reasoning, so a cause can be judged from more than the final answer. */
  hasWorking?: boolean;
}
export interface Diagnosis { kind: MistakeKind; confusedWith: { id: string; name: string } | null; why: string; certainty: Certainty; /** for unknown_cause: what it might be, never stated as fact */ possible?: MistakeKind }

const UNKNOWN: Diagnosis = { kind: 'unknown_cause', confusedWith: null, certainty: 'unknown', why: 'The answer did not match, and the answer alone does not show why. Say what happened below, or show your steps next time.' };
const unrel = (why: string): Diagnosis => ({ kind: 'unreliable', confusedWith: null, why, certainty: 'unknown' });

export function diagnose(i: DiagnoseInput): Diagnosis | null {
  if (i.reportedUnclear) return unrel('You reported this question or its grading as unclear, so it is not counted as evidence.');
  if (i.gradeStatus === 'failed') return unrel('Grading failed, so this answer is not counted yet. Retry grading or grade yourself.');
  if (i.gradeStatus === 'uncertain') return unrel('The grade is uncertain, so this answer is not counted as evidence until you confirm how you did.');
  if (i.gradeStatus !== 'graded' || i.correctness === null) return null;
  if (i.correctness >= 0.8) return null;
  if (i.idk || i.blank) return { kind: 'missing_knowledge', confusedWith: null, certainty: 'direct', why: 'You said you did not know, which tells us where to start.' };
  if (i.slipTag) {
    // the checker saw a sign/arithmetic-sized difference in the FINAL answer; without working that is a guess about cause, not a finding
    return i.hasWorking
      ? { kind: 'slip', confusedWith: null, certainty: 'likely', why: 'Your steps look reasonable and the final answer differs only in a sign or calculation, so a slip is likely.' }
      : { ...UNKNOWN, possible: 'slip', why: 'The answer is close to the right one (a sign or calculation differs), which could be a slip, but without your steps I can’t tell that from a misunderstanding.' };
  }
  if (i.mathTags?.length) return { kind: 'reasoning_error', confusedWith: null, certainty: 'likely', why: 'The answer matches a known kind of error for this skill. That shows the pattern in the answer, not why it happened.' };
  if (i.questionKind === 'math') return UNKNOWN;
  if (i.confusedWith && (i.chosenMisconception || i.questionKind === 'compare' || i.questionKind === 'multiple_choice' || i.graderKind === 'concept_confusion'))
    return { kind: 'concept_confusion', confusedWith: i.confusedWith, certainty: 'likely', why: `The answer fits “${i.confusedWith.name}” rather than this idea.` };
  if (i.graderKind && i.graderKind !== 'unreliable') return { kind: i.graderKind, confusedWith: i.confusedWith ?? null, certainty: 'likely', why: `${MISTAKE_BLURB[i.graderKind]} (the grader’s reading of this answer)` };
  if (i.questionKind === 'multiple_choice') return i.chosenMisconception ? { kind: 'reasoning_error', confusedWith: null, certainty: 'likely', why: 'The chosen option reflects a common wrong idea.' } : UNKNOWN;
  const met = i.rubricMet ?? 0, total = i.rubricTotal ?? 0;
  if (total > 0 && met > 0 && met < total) return { kind: 'partial_explanation', confusedWith: null, certainty: 'likely', why: `${met} of ${total} key ideas were there.` };
  if (total > 0 && met === 0 && (i.correctness ?? 0) < 0.2) return { kind: 'missing_knowledge', confusedWith: null, certainty: 'likely', why: 'None of the key ideas showed up, though a correct answer worded in an unexpected way could have been missed.' };
  return UNKNOWN;
}

/** The student's own account of a miss overrides inference; it is kept as THEIR statement. */
export const SELF_CAUSES = ['didnt_know', 'slip', 'mixed_up', 'misread', 'unsure'] as const;
export type SelfCause = (typeof SELF_CAUSES)[number];
export const SELF_CAUSE_LABEL: Record<SelfCause, string> = { didnt_know: 'I didn’t know how to start', slip: 'I knew it but made a slip', mixed_up: 'I mixed up two ideas', misread: 'I misread the question', unsure: 'I’m not sure' };
export function fromSelfCause(c: SelfCause): { kind: MistakeKind; label: string } | null {
  switch (c) {
    case 'didnt_know': return { kind: 'missing_knowledge', label: 'Didn’t know how to start (you said)' };
    case 'slip': return { kind: 'slip', label: 'A slip (you said)' };
    case 'mixed_up': return { kind: 'concept_confusion', label: 'Mixed up two ideas (you said; which ones is not known)' };
    case 'misread': return { kind: 'slip', label: 'Misread the question (you said)' };
    default: return null;
  }
}
