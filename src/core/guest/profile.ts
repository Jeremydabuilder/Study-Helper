/** Profile changes. Pure functions: take a profile, return a new one. The browser store saves the result. */
import { NO_DATE } from './dates';
import { clean, newId, norm } from './extract';
import { AssignmentItem, Candidates, ClassItem, CommitmentItem, GoalItem, Preferences, Profile } from './types';

/** Mark candidates that look like something already in the profile. The person decides: nothing is merged here. */
export function markDuplicates(p: Profile, c: Candidates): Candidates {
  const out: Candidates = { ...c, classes: c.classes.map((x) => ({ ...x })), assignments: c.assignments.map((x) => ({ ...x, flags: [...x.flags] })), commitments: c.commitments.map((x) => ({ ...x, flags: [...x.flags] })), preferences: c.preferences, goals: c.goals.map((x) => ({ ...x })) };
  for (const x of out.classes) { const d = p.classes.find((k) => norm(k.name) === norm(x.item.name)); if (d) { x.duplicateOf = d.id; x.include = false; x.flags = [...x.flags, 'You already have this class.']; } }
  for (const x of out.assignments) {
    const d = p.assignments.find((k) => !k.done && (norm(k.title) === norm(x.item.title) || (similar(k.title, x.item.title) && (k.due.date ?? '') === (x.item.due.date ?? ''))));
    if (d) { x.duplicateOf = d.id; x.include = false; x.resolution = null; x.flags = [...x.flags, `Looks like “${d.title}”${d.due.date ? ` (due ${d.due.date})` : ''} that you already have.`]; }
  }
  for (const x of out.commitments) { const d = p.commitments.find((k) => norm(k.title) === norm(x.item.title) && k.days.join() === x.item.days.join()); if (d) { x.duplicateOf = d.id; x.include = false; x.flags = [...x.flags, 'You already have this commitment.']; } }
  for (const x of out.goals) { const d = p.goals.find((k) => norm(k.text) === norm(x.item.text)); if (d) { x.duplicateOf = d.id; x.include = false; x.flags = [...x.flags, 'You already saved this goal.']; } }
  return out;
}
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
export function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b); if (!x.size || !y.size) return false;
  const common = [...x].filter((w) => y.has(w)).length; return common / Math.min(x.size, y.size) >= 0.75;
}

/**
 * Save what the person ticked. A possible duplicate is only touched when they chose: merge (update the existing item), keep both, or skip.
 * A candidate with a duplicate and no choice is NOT saved (the preview asks first).
 */
export function applyCandidates(p: Profile, c: Candidates, now = Date.now(), origin: 'pasted' | 'answer' = 'pasted'): { profile: Profile; saved: number; skipped: number } {
  const next: Profile = { ...p, classes: [...p.classes], assignments: [...p.assignments], commitments: [...p.commitments], preferences: { ...p.preferences }, goals: [...p.goals], updatedAt: now };
  let saved = 0, skipped = 0;
  const ensureClass = (name: string) => { if (name && !next.classes.some((k) => norm(k.name) === norm(name))) next.classes.push({ id: newId('k'), name: clean(name, 40), origin }); };
  for (const x of c.classes) {
    if (!x.include || x.duplicateOf) { skipped++; continue; }
    if (!next.classes.some((k) => norm(k.name) === norm(x.item.name))) { next.classes.push({ id: newId('k'), name: clean(x.item.name, 40), origin }); saved++; }
  }
  for (const x of c.assignments) {
    if (!x.include) { skipped++; continue; }
    if (x.duplicateOf && !x.resolution) { skipped++; continue; }
    if (x.resolution === 'skip') { skipped++; continue; }
    const it = x.item;
    if (x.duplicateOf && x.resolution === 'merge') {
      const i = next.assignments.findIndex((k) => k.id === x.duplicateOf);
      if (i >= 0) { const k = next.assignments[i]; next.assignments[i] = { ...k, title: clean(it.title, 120) || k.title, className: it.className || k.className, due: it.due.date ? it.due : k.due, estimateMin: it.estimateMin || k.estimateMin, instructions: it.instructions && it.instructions.length > k.instructions.length ? it.instructions : k.instructions, type: it.type }; ensureClass(it.className); saved++; continue; }
    }
    next.assignments.push({ id: newId('a'), title: clean(it.title, 120), className: clean(it.className, 40), type: it.type, due: it.due ?? NO_DATE, estimateMin: it.estimateMin, instructions: clean(it.instructions, 4000), done: false, origin, createdAt: now });
    ensureClass(it.className); saved++;
  }
  for (const x of c.commitments) {
    if (!x.include) { skipped++; continue; }
    if (x.duplicateOf && x.resolution !== 'keep_both' && x.resolution !== 'merge') { skipped++; continue; }
    if (x.duplicateOf && x.resolution === 'merge') { const i = next.commitments.findIndex((k) => k.id === x.duplicateOf); if (i >= 0) { next.commitments[i] = { ...next.commitments[i], ...x.item, title: clean(x.item.title, 60) }; saved++; continue; } }
    next.commitments.push({ id: newId('m'), title: clean(x.item.title, 60), days: x.item.days, start: x.item.start, end: x.item.end, origin }); saved++;
  }
  for (const x of c.preferences) {
    if (!x.include) { skipped++; continue; }
    (next.preferences as Record<string, unknown>)[x.item.key] = x.item.value; saved++;
  }
  for (const x of c.goals) {
    if (!x.include || x.duplicateOf) { skipped++; continue; }
    next.goals.push({ id: newId('g'), text: clean(x.item.text, 160), origin }); saved++;
  }
  return { profile: next, saved, skipped };
}

/** True once the profile holds enough for a plan to mean something. */
export const hasBasis = (p: Profile) => p.assignments.some((a) => !a.done) || p.commitments.length > 0 || p.classes.length > 0;
export const openAssignments = (p: Profile) => p.assignments.filter((a) => !a.done);
export type { AssignmentItem, ClassItem, CommitmentItem, GoalItem, Preferences };
