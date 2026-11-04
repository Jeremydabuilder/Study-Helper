/** The guest's study profile. It lives only in the browser (see src/web/guest/store.ts). Every fact says where it came from and whether the person confirmed it. */
import type { DueInfo } from './dates';

export type Origin = 'typed' | 'pasted' | 'answer' | 'ai';
export interface ClassItem { id: string; name: string; origin: Origin }
export interface AssignmentItem {
  id: string; title: string; className: string; type: 'homework' | 'test' | 'project' | 'reading';
  due: DueInfo; /** minutes the student expects it to take (0 = unknown) */ estimateMin: number;
  /** the text of the assignment, kept so Homework help can start with it filled in */ instructions: string;
  done: boolean; origin: Origin; createdAt: number;
}
export interface CommitmentItem { id: string; title: string; days: number[]; start: string; end: string; origin: Origin }
export interface Preferences {
  sleepHours?: number; bedtime?: string; sessionMinutes?: number; bestTime?: 'morning' | 'afternoon' | 'evening' | 'night';
  weekdayStudyMinutes?: number; weekendStudyMinutes?: number; trouble?: string; hardestClass?: string; materials?: string; method?: string;
}
export interface GoalItem { id: string; text: string; origin: Origin }
export interface NoteItem { id: string; title: string; text: string; className: string; addedAt: number }
export interface PracticeCard { id: string; noteId: string; prompt: string; answer: string; box: number; due: string; lastResult: 'right' | 'wrong' | null; seen: number }
export interface InterviewState {
  status: 'not_started' | 'in_progress' | 'finished' | 'skipped';
  /** question id → what was answered, or null when skipped */
  answers: Record<string, string | null>; asked: string[]; startedAt?: number;
}
export interface Profile {
  version: 1; createdAt: number; updatedAt: number;
  classes: ClassItem[]; assignments: AssignmentItem[]; commitments: CommitmentItem[]; preferences: Preferences; goals: GoalItem[]; notes: NoteItem[]; cards: PracticeCard[];
  interview: InterviewState;
  /** The student confirmed the plan basis at least once (so the Today plan may be shown as "confirmed"). */
  confirmedAt: number | null;
}
export const emptyProfile = (now = Date.now()): Profile => ({
  version: 1, createdAt: now, updatedAt: now, classes: [], assignments: [], commitments: [], preferences: {}, goals: [], notes: [], cards: [],
  interview: { status: 'not_started', answers: {}, asked: [] }, confirmedAt: null,
});

/** What extraction proposes. Nothing here is saved until the person ticks it in the preview. */
export interface Candidate<T> { id: string; item: T; include: boolean; /** why it is shown unticked, or flagged */ flags: string[]; inferred: boolean; /** a profile item it may duplicate */ duplicateOf: string | null; resolution: 'merge' | 'keep_both' | 'skip' | null }
export interface Candidates {
  classes: Candidate<{ name: string }>[];
  assignments: Candidate<Pick<AssignmentItem, 'title' | 'className' | 'type' | 'due' | 'estimateMin' | 'instructions'>>[];
  commitments: Candidate<Pick<CommitmentItem, 'title' | 'days' | 'start' | 'end'>>[];
  preferences: Candidate<{ key: keyof Preferences; value: string | number; label: string }>[];
  goals: Candidate<{ text: string }>[];
  /** lines that looked like instructions to an AI, or were too long to read: shown, never used */
  ignored: { line: string; reason: string }[];
  truncated: boolean;
}
export const emptyCandidates = (): Candidates => ({ classes: [], assignments: [], commitments: [], preferences: [], goals: [], ignored: [], truncated: false });
