/**
 * The study-profile interview. Five opening questions, then follow-ups, about 20 at most, each asked only when its answer would change the plan
 * and the profile does not already hold it (so confirmed information from pasted notes is never asked for again). Every question can be skipped;
 * the person can finish early and come back: progress lives in profile.interview.
 * No AI is involved: the next question is chosen by fixed rules, so this works with the assistant switched off.
 */
import { Candidates, Profile } from './types';
import { clean, extractLocal, newId, norm } from './extract';

export interface Question {
  id: string; text: string; help?: string; kind: 'text' | 'choice' | 'number';
  choices?: string[]; placeholder?: string;
  /** a question is redundant when the profile already holds its answer */
  redundant(p: Profile): boolean;
  /** a question applies only when its answer could change the plan */
  applies?(p: Profile): boolean;
  /** how this answer is stored: either candidates for the preview, or a direct profile change */
  apply(p: Profile, answer: string, today: string): { profile: Profile; candidates?: Candidates };
}
export const MAX_QUESTIONS = 20;
const withPref = (p: Profile, patch: Profile['preferences']): Profile => ({ ...p, preferences: { ...p.preferences, ...patch } });
const num = (s: string) => { const m = s.match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
const minutesFrom = (s: string) => { const n = num(s); if (!Number.isFinite(n)) return NaN; return /h(?:our|r)/i.test(s) ? Math.round(n * 60) : n; };
const hasClass = (p: Profile) => p.classes.length > 0, hasWork = (p: Profile) => p.assignments.some((a) => !a.done);

export const QUESTIONS: Question[] = [
  { id: 'classes', kind: 'text', text: 'Which classes are you taking?', help: 'A list is fine: “Algebra 2, Biology, English 10”.', placeholder: 'Algebra 2, Biology, English 10', redundant: hasClass,
    apply: (p, a) => { const names = a.split(/,|;|\n|\band\b/i).map((x) => clean(x, 40)).filter(Boolean).slice(0, 12); return { profile: { ...p, classes: [...p.classes, ...names.filter((n) => !p.classes.some((k) => norm(k.name) === norm(n))).map((name) => ({ id: newId('k'), name, origin: 'answer' as const }))] } }; } },
  { id: 'deadlines', kind: 'text', text: 'What homework, tests or projects are coming up, and when are they due?', help: 'One per line is easiest: “Math worksheet 4 due Friday”. You will check the dates before anything is saved.', placeholder: 'Math worksheet 4 due Friday\nBiology test Nov 12', redundant: hasWork,
    apply: (p, a, today) => ({ profile: p, candidates: extractLocal(a.split(/;/).join('\n'), today) }) },
  { id: 'commitments', kind: 'text', text: 'What regular commitments take up your time (sports, practice, work, family, clubs)?', help: 'Say when, if you can: “Soccer Mon/Wed 4-6pm”.', placeholder: 'Soccer Mon/Wed 4-6pm\nPiano lesson Thursdays 5pm', redundant: (p) => p.commitments.length > 0,
    apply: (p, a, today) => ({ profile: p, candidates: extractLocal(a.split(/;/).join('\n'), today) }) },
  { id: 'sleep', kind: 'number', text: 'About how many hours do you usually sleep on a school night?', placeholder: '8', redundant: (p) => p.preferences.sleepHours !== undefined,
    apply: (p, a) => { const n = num(a); return { profile: Number.isFinite(n) && n >= 3 && n <= 14 ? withPref(p, { sleepHours: n }) : p }; } },
  { id: 'help', kind: 'text', text: 'What do you most want help with?', help: 'For example: getting started, remembering for tests, understanding one subject, staying on top of deadlines.', placeholder: 'Remembering things for tests', redundant: (p) => p.goals.length > 0,
    apply: (p, a) => { const t = clean(a, 160); return { profile: t ? { ...p, goals: [...p.goals, { id: newId('g'), text: t, origin: 'answer' }] } : p }; } },

  { id: 'hardest', kind: 'text', text: 'Which class is hardest for you right now?', redundant: (p) => !!p.preferences.hardestClass, applies: (p) => p.classes.length > 1,
    apply: (p, a) => ({ profile: withPref(p, { hardestClass: clean(a, 40) }) }) },
  { id: 'tests', kind: 'text', text: 'Any tests or quizzes coming up? Give the class and the date.', placeholder: 'Chemistry quiz next Tuesday', redundant: (p) => p.assignments.some((x) => x.type === 'test' && !x.done), applies: (p) => hasClass(p) || hasWork(p),
    apply: (p, a, today) => ({ profile: p, candidates: extractLocal(a.split(/;/).map((x) => (/\b(test|quiz|exam)\b/i.test(x) ? x : `${x} test`)).join('\n'), today) }) },
  { id: 'weekday_minutes', kind: 'number', text: 'On a normal school day, about how many minutes can you really spend on homework and studying?', placeholder: '90', redundant: (p) => p.preferences.weekdayStudyMinutes !== undefined, applies: (p) => hasWork(p) || hasClass(p),
    apply: (p, a) => { const n = minutesFrom(a); return { profile: Number.isFinite(n) && n >= 10 && n <= 480 ? withPref(p, { weekdayStudyMinutes: n }) : p }; } },
  { id: 'weekend_minutes', kind: 'number', text: 'And on a weekend day?', placeholder: '120', redundant: (p) => p.preferences.weekendStudyMinutes !== undefined, applies: (p) => p.preferences.weekdayStudyMinutes !== undefined,
    apply: (p, a) => { const n = minutesFrom(a); return { profile: Number.isFinite(n) && n >= 0 && n <= 600 ? withPref(p, { weekendStudyMinutes: n }) : p }; } },
  { id: 'best_time', kind: 'choice', choices: ['Morning', 'Afternoon', 'Evening', 'Night'], text: 'When do you focus best?', redundant: (p) => !!p.preferences.bestTime, applies: (p) => hasWork(p),
    apply: (p, a) => { const v = a.toLowerCase(); const t = (['morning', 'afternoon', 'evening', 'night'] as const).find((x) => v.includes(x)); return { profile: t ? withPref(p, { bestTime: t }) : p }; } },
  { id: 'session', kind: 'choice', choices: ['15 minutes', '25 minutes', '45 minutes', '60 minutes'], text: 'How long can you work before you need a break?', redundant: (p) => !!p.preferences.sessionMinutes, applies: (p) => hasWork(p),
    apply: (p, a) => { const n = minutesFrom(a); return { profile: Number.isFinite(n) && n >= 10 && n <= 120 ? withPref(p, { sessionMinutes: n }) : p }; } },
  { id: 'trouble', kind: 'choice', choices: ['Getting started', 'Staying focused', 'Remembering it later', 'Understanding it', 'Running out of time'], text: 'What usually goes wrong?', redundant: (p) => !!p.preferences.trouble, applies: (p) => hasWork(p) || p.goals.length > 0,
    apply: (p, a) => ({ profile: withPref(p, { trouble: clean(a, 60) }) }) },
  { id: 'method', kind: 'text', text: 'How do you study for a test now?', placeholder: 'Reread my notes', redundant: (p) => !!p.preferences.method, applies: (p) => p.assignments.some((x) => x.type === 'test') || p.goals.some((g) => /test|remember|memor/i.test(g.text)),
    apply: (p, a) => ({ profile: withPref(p, { method: clean(a, 80) }) }) },
  { id: 'materials', kind: 'text', text: 'What do you have to study from (notes, textbook, slides, worksheets)?', redundant: (p) => !!p.preferences.materials || p.notes.length > 0, applies: (p) => hasWork(p),
    apply: (p, a) => ({ profile: withPref(p, { materials: clean(a, 80) }) }) },
  { id: 'bedtime', kind: 'text', text: 'What time do you usually go to bed?', placeholder: '10:30 pm', redundant: (p) => !!p.preferences.bedtime || p.preferences.sleepHours === undefined, applies: (p) => p.preferences.sleepHours !== undefined,
    apply: (p, a) => { const m = a.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i); if (!m) return { profile: p }; let h = Number(m[1]); const ap = m[3]?.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap && h >= 6 && h <= 11) h += 12; return { profile: withPref(p, { bedtime: `${String(h % 24).padStart(2, '0')}:${m[2] ?? '00'}` }) }; } },
  { id: 'goal_grade', kind: 'text', text: 'Is there a grade or result you are aiming for in a class?', placeholder: 'An A- in Biology', redundant: (p) => p.goals.length >= 2, applies: (p) => hasClass(p) && p.goals.length > 0,
    apply: (p, a) => { const t = clean(a, 160); return { profile: t ? { ...p, goals: [...p.goals, { id: newId('g'), text: t, origin: 'answer' }] } : p }; } },
  { id: 'anything_else', kind: 'text', text: 'Anything else that would help plan your days (trips, exams, a hard week)?', redundant: () => false, applies: (p) => hasWork(p) || p.commitments.length > 0,
    apply: (p, a, today) => ({ profile: p, candidates: extractLocal(a.split(/;/).join('\n'), today) }) },
];
const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
export const questionById = (id: string) => BY_ID.get(id) ?? null;

/** The next question to ask, or null when the interview is complete. The first five come in order; later ones only when they would change the plan. */
export function nextQuestion(p: Profile): Question | null {
  if (p.interview.status === 'finished' || p.interview.status === 'skipped') return null;
  if (p.interview.asked.length >= MAX_QUESTIONS) return null;
  for (const q of QUESTIONS) {
    if (p.interview.asked.includes(q.id)) continue;
    if (q.redundant(p)) continue;
    if (q.applies && !q.applies(p)) continue;
    return q;
  }
  return null;
}
/** Progress for display: how many have been asked and the most that could still be asked. */
export function interviewProgress(p: Profile) { const asked = p.interview.asked.length; let rest = 0; const probe: Profile = { ...p, interview: { ...p.interview, asked: [...p.interview.asked] } }; for (let i = asked; i < MAX_QUESTIONS; i++) { const q = nextQuestion(probe); if (!q) break; probe.interview.asked.push(q.id); rest++; } return { asked, remaining: rest }; }
/** Record that a question was asked (answered or skipped). */
export function markAsked(p: Profile, id: string, answer: string | null): Profile {
  return { ...p, interview: { ...p.interview, status: 'in_progress', startedAt: p.interview.startedAt ?? Date.now(), asked: p.interview.asked.includes(id) ? p.interview.asked : [...p.interview.asked, id], answers: { ...p.interview.answers, [id]: answer === null ? null : clean(answer, 600) } } };
}
export const finishInterview = (p: Profile, skipped = false): Profile => ({ ...p, interview: { ...p.interview, status: skipped ? 'skipped' : 'finished' } });
export const resumeInterview = (p: Profile): Profile => ({ ...p, interview: { ...p.interview, status: 'in_progress' } });
