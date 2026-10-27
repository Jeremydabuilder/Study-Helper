import { MistakeKind } from './diagnosis';

/**
 * Ask → attempt → diagnose → explain or hint → fresh follow-up → later review.
 * Given what just happened, what should the NEXT question be? Pure rules, so they can be tested and explained to the student.
 */
export interface NextInput {
  mistake: MistakeKind | null; correctness: number | null; independent: boolean; // independent = no hint, no reveal, not "I don't know"
  confidence: 1 | 2 | 3 | null; confusedWith?: { id: string; name: string } | null; missedPoints: string[];
  streakIndependent: number;                 // independent successes in a row on this concept this session, including this one
  failuresOnConcept: number;                 // consecutive wrong answers on this concept this session, including this one
  prerequisite?: { id: string; name: string } | null; questionKind: string; conceptName: string;
}
export type ActionType = 'move_on' | 'another_application' | 'discriminate' | 'targeted_fix' | 'teach_then_practice' | 'simplify' | 'confirm_grade';
export interface NextAction {
  type: ActionType; reason: string;
  focus?: 'practice' | 'discriminate' | 'gap' | 'simpler'; contrast?: { id: string; name: string }; gapPoints?: string[]; prerequisite?: { id: string; name: string };
  avoidKind?: string; preferKind?: string; alternativeRepresentation?: boolean; closeSlot?: boolean;
}

export function nextAction(i: NextInput): NextAction {
  if (i.mistake === 'unreliable') return { type: 'confirm_grade', reason: 'That result is not counted because the grade or question was unclear. Next is a different question on the same idea.', focus: 'practice', avoidKind: i.questionKind };
  const ok = (i.correctness ?? 0) >= 0.8;
  if (ok && i.independent) {
    if (i.streakIndependent >= 2 || (i.confidence === 3 && i.streakIndependent >= 1 && i.questionKind !== 'multiple_choice')) return { type: 'move_on', reason: `Two independent successes on “${i.conceptName}” today. Moving on; it will be checked again later with a question you haven’t seen.`, closeSlot: true };
    return { type: 'another_application', reason: i.confidence === 1 ? 'Right, but you weren’t sure. One more application, in a different form, to see whether it holds.' : 'Correct on your own. One more application in a different form before moving on.', focus: 'practice', avoidKind: i.questionKind };
  }
  if (ok) return { type: 'another_application', reason: 'Right, but with help. Next is a similar question to try without hints.', focus: 'practice', avoidKind: i.questionKind };
  if (i.failuresOnConcept >= 2 && i.prerequisite) return { type: 'simplify', reason: `Two misses in a row. Instead of repeating the same explanation, let’s check the building block first: “${i.prerequisite.name}”.`, prerequisite: i.prerequisite, alternativeRepresentation: true };
  if (i.failuresOnConcept >= 2) return { type: 'simplify', reason: 'Two misses in a row. Next is a simpler question on the core idea, and the explanation will be shown a different way.', focus: 'simpler', alternativeRepresentation: true };
  switch (i.mistake) {
    case 'concept_confusion': return i.confusedWith
      ? { type: 'discriminate', reason: `You mixed up “${i.conceptName}” with “${i.confusedWith.name}”. Next is a question that makes you tell them apart.`, focus: 'discriminate', contrast: i.confusedWith }
      : { type: 'discriminate', reason: 'It looks like two related ideas got mixed up. Next is a comparison question.', focus: 'discriminate' };
    case 'slip': return { type: 'targeted_fix', reason: 'Your method looked right; a small slip cost the answer. Next is a fresh problem of the same kind. Slow down on the step that went wrong.', focus: 'practice' };
    case 'partial_explanation': return { type: 'targeted_fix', reason: 'Part of it was there. Next is a question about the missing idea.', focus: 'gap', gapPoints: i.missedPoints };
    case 'reasoning_error': return { type: 'targeted_fix', reason: 'The idea was there but the steps went wrong. Look at the worked example, then try a fresh one.', focus: 'practice', avoidKind: i.questionKind };
    default: return { type: 'teach_then_practice', reason: 'This looks like a missing basic. Read the short explanation and worked example, then try a fresh question on your own.', focus: 'simpler' };
  }
}
