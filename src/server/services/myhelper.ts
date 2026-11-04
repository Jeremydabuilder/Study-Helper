/**
 * My Helper: the owner's tasks and projects, and the one-time (repeatable, safe) import of the old browser-only app.
 * School assignments are Study Helper assignments (academic_items): there is exactly one copy, here shown as "School".
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addDaysKey, localDateKey } from '../../core/time';
import { uid } from '../db';
import { Ctx, HttpError, clip, getProfile } from './common';
import { createItem, listItems, setCompleted } from './items';

export const CATEGORIES = ['School', 'Personal', 'Project'] as const;
export const WHEN = ['Today', 'Tomorrow', 'This week'] as const;
type Category = (typeof CATEGORIES)[number]; type When = (typeof WHEN)[number];
const MAX_TASKS = 2000, MAX_PROJECTS = 300;

const todayKey = (ctx: Ctx, at = ctx.now()) => localDateKey(new Date(at), getProfile(ctx.db).timezone);
/** "Today" and "Tomorrow" are real dates; "This week" is deliberately NOT turned into a made-up deadline. */
export function dueFor(ctx: Ctx, when: When, at = ctx.now()): string | null {
  const t = todayKey(ctx, at);
  return when === 'Today' ? t : when === 'Tomorrow' ? addDaysKey(t, 1) : null;
}
const taskView = (ctx: Ctx, r: any) => ({ id: r.id, title: r.title, category: r.category as Category, when: r.when_label as When, dueDate: r.due_date as string | null, done: r.done_at != null, overdue: r.done_at == null && !!r.due_date && r.due_date < todayKey(ctx) });
const projectView = (r: any) => ({ id: r.id, name: r.name, description: r.description, stage: r.stage as number, notes: r.notes, nextAction: r.next_action, updatedAt: r.updated_at });

/** Everything the My Helper pages show, in one request. */
export function state(ctx: Ctx) {
  const tasks = ctx.db.all<any>('SELECT * FROM mh_tasks ORDER BY (done_at IS NOT NULL), COALESCE(due_date, \'9999\'), created_at DESC').map((r) => taskView(ctx, r));
  const assignments = listItems(ctx, 'confirmed').map((i) => ({
    id: i.id, title: i.title, subjectId: i.subjectId, subjectName: i.subjectName, type: i.type, typeLabel: i.typeLabel, dueDate: i.dueDate, dueLabel: i.dueLabel, daysLeft: i.daysLeft,
    done: i.completed, hasInstructions: (i.instructions ?? '').trim().length >= 20, instructions: i.instructions ?? '', estimateMin: i.estimateMin,
    homework: ctx.db.get<any>('SELECT id, state, work_status FROM homework WHERE item_id = ?', i.id) ?? null,
  }));
  const projects = ctx.db.all<any>('SELECT * FROM mh_projects ORDER BY updated_at DESC').map(projectView);
  return { tasks, assignments: assignments.map((a) => ({ ...a, homework: a.homework ? { id: a.homework.id, state: a.homework.state, status: a.homework.work_status } : null })), projects };
}

/* ------------------------------ tasks ------------------------------ */

export function addTask(ctx: Ctx, b: { title: string; category: string; when: string }) {
  const title = clip(b.title, 200).trim();
  if (!title) throw new HttpError(400, 'invalid', 'Give the task a name first.');
  if (!(CATEGORIES as readonly string[]).includes(b.category) || !(WHEN as readonly string[]).includes(b.when)) throw new HttpError(400, 'invalid', 'Choose a category and a time.');
  if (b.category === 'School') return { kind: 'assignment' as const, id: createItem(ctx, { title, type: 'homework', dueDate: dueFor(ctx, b.when as When), notes: b.when === 'This week' ? 'Due sometime this week (date not set).' : '' }).id };
  if (ctx.db.get<any>('SELECT COUNT(*) n FROM mh_tasks').n >= MAX_TASKS) throw new HttpError(409, 'limit', 'That is a lot of tasks. Delete some you no longer need first.');
  const id = uid(), now = ctx.now();
  ctx.db.run('INSERT INTO mh_tasks (id,title,category,when_label,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, title, b.category, b.when, dueFor(ctx, b.when as When), now, now);
  return { kind: 'task' as const, id };
}
export function setTaskDone(ctx: Ctx, id: string, done: boolean) {
  if (!ctx.db.get('SELECT 1 FROM mh_tasks WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Task not found.');
  ctx.db.run('UPDATE mh_tasks SET done_at = ?, updated_at = ? WHERE id = ?', done ? ctx.now() : null, ctx.now(), id);
}
export function deleteTask(ctx: Ctx, id: string) {
  if (!ctx.db.get('SELECT 1 FROM mh_tasks WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Task not found.');
  ctx.db.run('DELETE FROM mh_tasks WHERE id = ?', id);
}
export { setCompleted as setAssignmentDone };

/* ------------------------------ projects ------------------------------ */

export function addProject(ctx: Ctx, b: { name: string; description?: string }) {
  const name = clip(b.name, 120).trim();
  if (!name) throw new HttpError(400, 'invalid', 'Give the project a name first.');
  if (ctx.db.get<any>('SELECT COUNT(*) n FROM mh_projects').n >= MAX_PROJECTS) throw new HttpError(409, 'limit', 'That is a lot of projects. Delete some first.');
  const id = uid(), now = ctx.now();
  ctx.db.run('INSERT INTO mh_projects (id,name,description,stage,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, name, clip(b.description, 600).trim() || 'A project in progress.', 1, now, now);
  return { id };
}
export function updateProject(ctx: Ctx, id: string, b: { name?: string; description?: string; notes?: string; nextAction?: string; stage?: number; advance?: boolean }) {
  const p = ctx.db.get<any>('SELECT * FROM mh_projects WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'not_found', 'Project not found.');
  let stage = b.stage !== undefined ? Math.min(5, Math.max(1, Math.round(b.stage))) : p.stage;
  if (b.advance) stage = p.stage >= 5 ? 1 : p.stage + 1; // the last stage restarts at Idea, as in the original
  ctx.db.run('UPDATE mh_projects SET name = ?, description = ?, notes = ?, next_action = ?, stage = ?, updated_at = ? WHERE id = ?',
    b.name === undefined ? p.name : clip(b.name, 120).trim() || p.name, b.description === undefined ? p.description : clip(b.description, 600).trim() || p.description,
    b.notes === undefined ? p.notes : clip(b.notes, 20_000), b.nextAction === undefined ? p.next_action : clip(b.nextAction, 300).trim(), stage, ctx.now(), id);
  return projectView(ctx.db.get<any>('SELECT * FROM mh_projects WHERE id = ?', id));
}
export function deleteProject(ctx: Ctx, id: string) {
  if (!ctx.db.get('SELECT 1 FROM mh_projects WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Project not found.');
  ctx.db.tx(() => { ctx.db.run('DELETE FROM mh_projects WHERE id = ?', id); ctx.db.run("DELETE FROM mh_import_keys WHERE kind = 'project' AND target_id = ?", id); });
}

/* ------------------------------ import from the old browser-only My Helper ------------------------------ */

const Id = z.union([z.string().max(80), z.number()]);
const Legacy = z.object({
  tasks: z.array(z.object({ id: Id.optional(), title: z.unknown(), category: z.unknown().optional(), due: z.unknown().optional(), done: z.unknown().optional() }).passthrough()).max(5000).optional(),
  projects: z.array(z.object({ id: Id.optional(), name: z.unknown(), desc: z.unknown().optional(), notes: z.unknown().optional(), nextAction: z.unknown().optional(), stage: z.unknown().optional() }).passthrough()).max(1000).optional(),
  memory: z.array(z.object({ id: Id.optional(), text: z.unknown() }).passthrough()).max(1000).optional(),
}).passthrough();
/** The export file (made by the patched original page) or the bare `myHelperState` value pasted from the browser. */
export const ImportPayload = z.union([z.object({ format: z.literal('my-helper-export'), version: z.literal(1), state: Legacy }).passthrough().transform((x) => x.state), Legacy]);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const keyOf = (kind: string, id: unknown, parts: string[], index: number) => (id !== undefined && id !== null && String(id) !== '' ? `id:${String(id)}` : `h:${createHash('sha256').update(`${kind}|${parts.join('|')}|${index}`).digest('hex').slice(0, 24)}`);
interface Row { kind: 'task' | 'project' | 'memory'; key: string; label: string; status: 'new' | 'imported' | 'already_imported' | 'invalid'; reason?: string; where?: string; plan: () => string }

function plan(ctx: Ctx, raw: z.infer<typeof Legacy>) {
  const rows: Row[] = []; const seen = new Set<string>();
  const known = (kind: string, key: string) => !!ctx.db.get('SELECT 1 FROM mh_import_keys WHERE kind = ? AND legacy_key = ?', kind, key);
  const place = (kind: Row['kind'], key: string, label: string, ok: boolean, reason: string, where: string, make: () => string) => {
    const dupe = seen.has(`${kind}|${key}`); seen.add(`${kind}|${key}`);
    rows.push({ kind, key, label, where, plan: make, status: !ok ? 'invalid' : dupe || known(kind, key) ? 'already_imported' : 'new', reason: !ok ? reason : dupe ? 'Appears twice in this file.' : known(kind, key) ? 'Already imported earlier.' : undefined });
  };
  (raw.tasks ?? []).forEach((t, i) => {
    const title = clip(str(t.title), 200).trim(); const cat = (CATEGORIES as readonly string[]).includes(str(t.category)) ? (str(t.category) as Category) : 'Personal';
    const when = ((WHEN as readonly string[]).includes(str(t.due)) ? str(t.due) : 'This week') as When; const done = t.done === true;
    const createdAt = typeof t.id === 'number' && t.id > 1.4e12 && t.id < 4e12 ? t.id : ctx.now(); // old ids were Date.now(): the day it was added
    place('task', keyOf('task', t.id, [title, cat], i), title || '(no title)', !!title, 'Has no title.', cat === 'School' ? 'School assignments' : cat === 'Project' ? 'Tasks (project)' : 'Tasks (personal)', () => {
      const due = dueFor(ctx, when, createdAt);
      if (cat === 'School') {
        const id = createItem(ctx, { title, type: 'homework', dueDate: due, notes: `Imported from My Helper (${when}${due ? '' : ', date not set'}).` }).id;
        if (done) ctx.db.run('UPDATE academic_items SET completed_at = ? WHERE id = ?', ctx.now(), id);
        return id;
      }
      const id = uid(); ctx.db.run('INSERT INTO mh_tasks (id,title,category,when_label,due_date,done_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, title, cat, when, due, done ? ctx.now() : null, createdAt, ctx.now()); return id;
    });
  });
  (raw.projects ?? []).forEach((p, i) => {
    const name = clip(str(p.name), 120).trim();
    place('project', keyOf('project', p.id, [name], i), name || '(no name)', !!name, 'Has no name.', 'Projects', () => {
      const id = uid(); const stage = typeof p.stage === 'number' ? Math.min(5, Math.max(1, Math.round(p.stage))) : 1;
      ctx.db.run('INSERT INTO mh_projects (id,name,description,stage,notes,next_action,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, clip(str(p.desc), 600).trim() || 'A project in progress.', stage, clip(str(p.notes), 20_000), clip(str(p.nextAction), 300).trim(), ctx.now(), ctx.now()); return id;
    });
  });
  (raw.memory ?? []).forEach((m, i) => {
    const text = clip(str(m.text), 400).trim();
    const same = text ? ctx.db.all<any>('SELECT id, text FROM memories WHERE deleted_at IS NULL').find((r) => norm(r.text) === norm(text)) : null;
    const key = keyOf('memory', m.id, [norm(text)], i);
    place('memory', key, text || '(empty)', text.length >= 3, 'Too short to keep.', 'Memory', () => {
      if (same) return same.id as string; // the same note is already there: link it, add nothing
      const id = uid(); ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'student_stated', text, null, null, JSON.stringify({ origin: 'student', note: 'Imported from My Helper', pinned: (m as { pinned?: unknown }).pinned === true }), ctx.now(), ctx.now()); return id;
    });
    if (same && rows[rows.length - 1].status === 'new') { rows[rows.length - 1].status = 'already_imported'; rows[rows.length - 1].reason = 'The same note is already in Memory.'; }
  });
  return rows;
}
const summarize = (rows: Row[]) => {
  const by = (s: Row['status']) => rows.filter((r) => r.status === s);
  const count = (k: Row['kind'], s: Row['status']) => rows.filter((r) => r.kind === k && r.status === s).length;
  return {
    totals: { new: by('new').length, imported: by('imported').length, alreadyImported: by('already_imported').length, invalid: by('invalid').length },
    byKind: Object.fromEntries((['task', 'project', 'memory'] as const).map((k) => [k, { new: count(k, 'new'), imported: count(k, 'imported'), alreadyImported: count(k, 'already_imported'), invalid: count(k, 'invalid') }])),
    items: rows.slice(0, 200).map((r) => ({ kind: r.kind, label: r.label, status: r.status, reason: r.reason ?? null, where: r.where ?? null })),
    truncated: rows.length > 200,
  };
};
/** What WOULD happen. Writes nothing. */
export function previewImport(ctx: Ctx, payload: z.infer<typeof ImportPayload>) { return summarize(plan(ctx, payload)); }
/** Do it. Repeating the same import changes nothing: every item is remembered by its old id (or, when it had none, by a fingerprint of its content). */
export function applyImport(ctx: Ctx, payload: z.infer<typeof ImportPayload>) {
  const rows = plan(ctx, payload);
  ctx.db.tx(() => {
    for (const r of rows) {
      if (r.status === 'new') { const target = r.plan(); ctx.db.run('INSERT INTO mh_import_keys (kind,legacy_key,target_id,imported_at) VALUES (?,?,?,?)', r.kind, r.key, target, ctx.now()); r.status = 'imported'; }
      else if (r.status === 'already_imported' && r.reason?.startsWith('The same note')) ctx.db.run('INSERT OR IGNORE INTO mh_import_keys (kind,legacy_key,target_id,imported_at) VALUES (?,?,?,?)', r.kind, r.key, r.plan(), ctx.now());
    }
  });
  return { applied: true, ...summarize(rows) };
}

/** Owner's My Helper data in the account export. */
export function exportMyHelper(ctx: Ctx) {
  return { tasks: ctx.db.all<any>('SELECT * FROM mh_tasks ORDER BY created_at').map((r) => ({ title: r.title, category: r.category, when: r.when_label, dueDate: r.due_date, done: r.done_at != null })),
    projects: ctx.db.all<any>('SELECT * FROM mh_projects ORDER BY created_at').map((r) => ({ name: r.name, description: r.description, stage: r.stage, notes: r.notes, nextAction: r.next_action })) };
}
