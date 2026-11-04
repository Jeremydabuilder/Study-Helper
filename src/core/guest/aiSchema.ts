/** What the assistant may return when asked to find study information in pasted text. Everything is validated, clipped and turned into the same unticked candidates as the local rules. */
import { z } from 'zod';
import { resolveDate } from './dates';
import { clean, newId, parseDays } from './extract';
import { Candidates, emptyCandidates } from './types';

const s = (n: number) => z.string().transform((x) => clean(x, n));
export const AiExtraction = z.object({
  classes: z.array(s(40)).max(15).default([]),
  assignments: z.array(z.object({ title: s(120), class: s(40).default(''), due_text: s(60).default(''), type: z.enum(['homework', 'test', 'project', 'reading']).catch('homework') })).max(40).default([]),
  commitments: z.array(z.object({ title: s(60), days: z.array(s(12)).max(7).default([]), start: z.string().regex(/^\d{2}:\d{2}$/).catch('16:00'), end: z.string().regex(/^\d{2}:\d{2}$/).catch('17:00') })).max(20).default([]),
  preferences: z.array(z.object({ kind: z.enum(['sleepHours', 'sessionMinutes', 'bestTime']), value: z.union([z.string(), z.number()]) })).max(6).default([]),
  goals: z.array(s(160)).max(8).default([]),
});
export type AiExtractionT = z.infer<typeof AiExtraction>;

/** Anything the assistant found is inferred: it is shown unticked, with a label, and only saved if the person ticks it. */
export function candidatesFromAi(r: AiExtractionT, today: string): Candidates {
  const out = emptyCandidates();
  const base = { include: false, inferred: true, duplicateOf: null, resolution: null } as const;
  for (const c of r.classes) if (c) out.classes.push({ id: newId('c'), item: { name: c }, flags: ['Found by the assistant'], ...base });
  for (const a of r.assignments) {
    if (!a.title) continue;
    const due = a.due_text ? resolveDate(a.due_text, today) : resolveDate('', today);
    const flags = ['Found by the assistant']; if (due.certainty === 'uncertain' && due.reason) flags.push(due.reason); if (a.due_text && due.certainty === 'none') flags.push(`The date “${a.due_text}” could not be read.`);
    out.assignments.push({ id: newId('c'), item: { title: a.title, className: a.class, type: a.type, due, estimateMin: a.type === 'test' ? 60 : a.type === 'project' ? 90 : 40, instructions: '' }, flags, ...base });
  }
  for (const c of r.commitments) {
    const days = parseDays(c.days.join(' ')); if (!c.title || !days.length) continue;
    out.commitments.push({ id: newId('c'), item: { title: c.title, days, start: c.start, end: c.end }, flags: ['Found by the assistant', 'Check the days and times.'], ...base });
  }
  for (const p of r.preferences) {
    const v = typeof p.value === 'number' ? p.value : Number(p.value);
    if (p.kind === 'bestTime') { const t = String(p.value).toLowerCase(); if (['morning', 'afternoon', 'evening', 'night'].includes(t)) out.preferences.push({ id: newId('c'), item: { key: 'bestTime', value: t, label: `Studies best in the ${t}` }, flags: ['Found by the assistant'], ...base }); }
    else if (Number.isFinite(v)) out.preferences.push({ id: newId('c'), item: { key: p.kind, value: v, label: p.kind === 'sleepHours' ? `Sleep about ${v} hours a night` : `Study in ${v}-minute sessions` }, flags: ['Found by the assistant'], ...base });
  }
  for (const g of r.goals) if (g) out.goals.push({ id: newId('c'), item: { text: g }, flags: ['Found by the assistant'], ...base });
  return out;
}
