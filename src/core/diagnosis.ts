/**
 * What kind of mistake was this? One answer shows one observed mistake; only repetition across different questions justifies
 * calling something a recurring pattern. Classification uses evidence the app can see (the question's structure, a deterministic
 * math check, rubric points, or the grader's own label) and says "unreliable" rather than guessing when the grade can't be trusted.
 */
export type MistakeKind = 'missing_knowledge' | 'concept_confusion' | 'reasoning_error' | 'slip' | 'partial_explanation' | 'unreliable';

export const MISTAKE_LABEL: Record<MistakeKind, string> = {
  missing_knowledge: 'Missing basics', concept_confusion: 'Mixed up two ideas', reasoning_error: 'Reasoning error', slip: 'Careless slip',
  partial_explanation: 'Partly right', unreliable: 'Grade or question unclear',
};
export const MISTAKE_BLURB: Record<MistakeKind, string> = {
  missing_knowledge: 'The key fact or idea did not show up in the answer.',
  concept_confusion: 'The answer fits a different, related idea.',
  reasoning_error: 'The idea was there, but the steps or logic went wrong.',
  slip: 'The method looked right; a sign or calculation was off.',
  partial_explanation: 'Some of the key ideas were there, others were missing.',
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
}
export interface Diagnosis { kind: MistakeKind; confusedWith: { id: string; name: string } | null; why: string }

export function diagnose(i: DiagnoseInput): Diagnosis | null {
  if (i.reportedUnclear) return { kind: 'unreliable', confusedWith: null, why: 'You reported this question or its grading as unclear, so it is not counted as evidence.' };
  if (i.gradeStatus === 'failed') return { kind: 'unreliable', confusedWith: null, why: 'Grading failed, so this answer is not counted yet. Retry grading or grade yourself.' };
  if (i.gradeStatus === 'uncertain') return { kind: 'unreliable', confusedWith: null, why: 'The grade is uncertain, so this answer is not counted as evidence until you confirm how you did.' };
  if (i.gradeStatus !== 'graded' || i.correctness === null) return null;
  if (i.correctness >= 0.8) return null;
  if (i.idk || i.blank) return { kind: 'missing_knowledge', confusedWith: null, why: 'You said you did not know, which tells us where to start.' };
  if (i.slipTag) return { kind: 'slip', confusedWith: null, why: 'The method looked right but a sign or calculation was off.' };
  if (i.mathTags?.length) return { kind: 'reasoning_error', confusedWith: null, why: 'The setup or logic of the solution went wrong.' };
  if (i.questionKind === 'math') return { kind: 'reasoning_error', confusedWith: null, why: 'The solution did not match, and the app could not tell why from the answer alone. Adding your steps next time helps tell a slip from a misunderstanding.' };
  if (i.confusedWith && (i.chosenMisconception || i.questionKind === 'compare' || i.questionKind === 'multiple_choice' || i.graderKind === 'concept_confusion'))
    return { kind: 'concept_confusion', confusedWith: i.confusedWith, why: `The answer fits “${i.confusedWith.name}” rather than this idea.` };
  if (i.graderKind && i.graderKind !== 'unreliable') return { kind: i.graderKind, confusedWith: i.confusedWith ?? null, why: MISTAKE_BLURB[i.graderKind] };
  if (i.questionKind === 'multiple_choice') return { kind: i.chosenMisconception ? 'reasoning_error' : 'missing_knowledge', confusedWith: null, why: i.chosenMisconception ? 'The chosen option reflects a common wrong idea.' : 'The chosen option does not match the idea.' };
  const met = i.rubricMet ?? 0, total = i.rubricTotal ?? 0;
  if (total > 0 && met > 0 && met < total) return { kind: 'partial_explanation', confusedWith: null, why: `${met} of ${total} key ideas were there.` };
  if (total > 0 && met === 0 && (i.correctness ?? 0) < 0.2) return { kind: 'missing_knowledge', confusedWith: null, why: 'None of the key ideas showed up.' };
  return { kind: (i.correctness ?? 0) >= 0.4 ? 'partial_explanation' : 'reasoning_error', confusedWith: null, why: 'The answer was partly or wholly off the key ideas.' };
}
