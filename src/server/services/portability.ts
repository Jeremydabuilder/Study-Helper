/**
 * Import / export. Export is explicit and sectioned; import is a two-step preview -> commit, per section and
 * per item, so unrelated personal information is never silently brought in.
 */
import { z } from 'zod';
import { chunkText } from '../../core/sources';
import { uid } from '../db';
import { Ctx, HttpError, getProfile, getSetting, parse, setSetting } from './common';
import { recomputeConcept } from './practice';

export const FORMAT = 'study-helper-export';
export const VERSION = 1;
const SETTING_KEYS = ['priority_weights', 'availability', 'scheduler_params'];

const Row = z.record(z.string(), z.any());
const Learning = z.object({
  subjects: z.array(Row).default([]), sources: z.array(Row).default([]), concepts: z.array(Row).default([]), concept_refs: z.array(Row).default([]),
  concept_prereqs: z.array(Row).default([]), questions: z.array(Row).default([]), attempts: z.array(Row).default([]),
  misconceptions: z.array(Row).default([]), misconception_evidence: z.array(Row).default([]),
  annotations: z.array(Row).default([]), reading_prompts: z.array(Row).default([]), outlines: z.array(Row).default([]),
});
export const ExportFile = z.object({
  format: z.literal(FORMAT), version: z.number().int().max(VERSION), exportedAt: z.number(), workspace: z.enum(['real', 'demo']).optional(),
  sections: z.object({
    profile: z.object({ name: z.string().max(60), grade: z.string().max(30), timezone: z.string().max(60), default_minutes: z.number(), about: z.string().max(600) }).optional(),
    settings: z.record(z.string(), z.any()).optional(),
    memories: z.array(z.object({ id: z.string(), kind: z.enum(['student_stated', 'observed', 'ai_inferred']), text: z.string().max(400), subject_id: z.string().nullable().optional(), concept_id: z.string().nullable().optional(), provenance: z.any().optional() })).optional(),
    learning: Learning.optional(),
    items: z.array(Row).optional(),
  }),
});
export type ExportFile = z.infer<typeof ExportFile>;

const COLS: Record<string, string[]> = {
  subjects: ['id', 'name', 'description', 'aliases', 'archived', 'created_at'],
  sources: ['id', 'subject_id', 'title', 'kind', 'text', 'content_hash', 'origin', 'ocr', 'created_at'],
  concepts: ['id', 'subject_id', 'name', 'summary', 'status', 'skill_tag', 'support', 'support_note', 'origin', 'source_id', 'created_at', 'updated_at'],
  concept_refs: ['id', 'concept_id', 'source_id', 'quote', 'char_start', 'char_end', 'label'],
  concept_prereqs: ['concept_id', 'prereq_id'],
  questions: ['id', 'concept_id', 'subject_id', 'kind', 'prompt', 'choices', 'answer_spec', 'rubric', 'hints', 'worked_example', 'explanation', 'difficulty', 'family', 'heldout', 'origin', 'verified', 'verify_note', 'source_note', 'created_at'],
  attempts: ['id', 'question_id', 'concept_id', 'answer_text', 'reasoning_text', 'confidence', 'hints_used', 'saw_answer', 'idk', 'response_ms', 'correctness', 'grade_status', 'grade_source', 'grade_confidence', 'feedback', 'diagnosis', 'feedback_shown', 'student_note', 'created_at'],
  misconceptions: ['id', 'concept_id', 'label', 'description', 'status', 'origin', 'count', 'first_seen_at', 'last_seen_at', 'repaired_at'],
  misconception_evidence: ['misconception_id', 'attempt_id'],
};

export function exportData(ctx: Ctx, o: { sections: string[]; includeSourceText?: boolean }): ExportFile {
  const want = new Set(o.sections);
  const sections: ExportFile['sections'] = {};
  if (want.has('profile')) { const p = getProfile(ctx.db); sections.profile = { name: p.name, grade: p.grade, timezone: p.timezone, default_minutes: p.default_minutes, about: p.about }; }
  if (want.has('settings')) sections.settings = Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(ctx.db, k, null)]).filter(([, v]) => v !== null));
  if (want.has('memories')) sections.memories = ctx.db.all<any>('SELECT id,kind,text,subject_id,concept_id,provenance FROM memories WHERE deleted_at IS NULL').map((m) => ({ ...m, provenance: parse(m.provenance, {}) }));
  if (want.has('learning')) {
    const L: any = {};
    for (const [t, cols] of Object.entries(COLS)) {
      L[t] = ctx.db.all<any>(`SELECT ${cols.join(',')} FROM ${t}`);
    }
    // highlights, prompts and outlines quote the reading, so they travel only with the source text
    L.annotations = o.includeSourceText ? ctx.db.all<any>('SELECT id,source_id,char_start,char_end,quote,source_rev,category,note,created_at,updated_at FROM annotations') : [];
    L.reading_prompts = o.includeSourceText ? ctx.db.all<any>('SELECT source_id,kind,text,updated_at FROM reading_prompts') : [];
    L.outlines = o.includeSourceText ? ctx.db.all<any>('SELECT id,source_id,title,body,created_at,updated_at FROM outlines') : [];
    if (!o.includeSourceText) L.sources = L.sources.map((s: any) => ({ ...s, text: '' })); // metadata only
    sections.learning = L;
  }
  if (want.has('items')) sections.items = ctx.db.all<any>("SELECT id,subject_id,type,title,due_kind,due_date,due_at,topics_text,format,notes,estimate_min,completed_at FROM academic_items WHERE source='manual' AND status='confirmed'");
  return { format: FORMAT, version: VERSION, exportedAt: ctx.now(), workspace: ctx.workspace, sections };
}

function validate(raw: unknown): ExportFile {
  const r = ExportFile.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(422, 'invalid_file', `This is not a valid Study Helper export (${first.path.join('.') || 'file'}: ${first.message}).`);
  }
  return r.data;
}

export function previewImport(ctx: Ctx, raw: unknown) {
  const f = validate(raw);
  const warnings: string[] = [];
  if (f.workspace === 'demo') warnings.push('This file was exported from the sample (demo) workspace. It contains sample data, not real study history.');
  const s = f.sections;
  const existing = (table: string, id: string) => !!ctx.db.get(`SELECT 1 FROM ${table} WHERE id=?`, id);
  const L = s.learning;
  const subjects = (L?.subjects ?? []).map((sub: any) => {
    const concepts = (L!.concepts ?? []).filter((c: any) => c.subject_id === sub.id);
    const cids = new Set(concepts.map((c: any) => c.id));
    return { id: sub.id, name: String(sub.name), isNew: !existing('subjects', sub.id), sources: (L!.sources ?? []).filter((x: any) => x.subject_id === sub.id).length, concepts: concepts.length, attempts: (L!.attempts ?? []).filter((a: any) => cids.has(a.concept_id)).length };
  });
  if (L && (L.sources ?? []).some((x: any) => !x.text)) warnings.push('Some materials were exported without their text; you will see them as empty entries.');
  return {
    file: { version: f.version, exportedAt: f.exportedAt, workspace: f.workspace ?? null },
    warnings,
    profile: s.profile ? { present: true, ...s.profile, differsFromCurrent: JSON.stringify(s.profile) !== JSON.stringify({ name: getProfile(ctx.db).name, grade: getProfile(ctx.db).grade, timezone: getProfile(ctx.db).timezone, default_minutes: getProfile(ctx.db).default_minutes, about: getProfile(ctx.db).about }) } : { present: false },
    settings: s.settings ? { present: true, keys: Object.keys(s.settings).filter((k) => SETTING_KEYS.includes(k)) } : { present: false },
    memories: (s.memories ?? []).map((m) => ({ id: m.id, kind: m.kind, text: m.text, isNew: !ctx.db.get('SELECT 1 FROM memories WHERE id=? AND deleted_at IS NULL', m.id) })),
    subjects, items: (s.items ?? []).map((i: any) => ({ id: i.id, title: i.title, type: i.type, due: i.due_date ?? null, isNew: !existing('academic_items', i.id) })),
  };
}

export interface Selection { profile?: boolean; settings?: boolean; memoryIds?: string[]; subjectIds?: string[]; itemIds?: string[] }

export function commitImport(ctx: Ctx, raw: unknown, sel: Selection) {
  const f = validate(raw);
  const s = f.sections, now = ctx.now();
  const counts: Record<string, number> = {};
  const from = { origin: 'import', importedAt: now, exportedFrom: f.workspace ?? 'unknown', fileExportedAt: f.exportedAt };
  ctx.db.tx(() => {
    if (sel.profile && s.profile) ctx.db.run('UPDATE profile SET name=?, grade=?, timezone=?, default_minutes=?, about=?, updated_at=? WHERE id=1', s.profile.name, s.profile.grade, s.profile.timezone, s.profile.default_minutes, s.profile.about, now);
    if (sel.settings && s.settings) for (const k of SETTING_KEYS) if (s.settings[k] !== undefined) setSetting(ctx.db, k, s.settings[k], now);
    counts.memories = 0;
    for (const m of s.memories ?? []) if (sel.memoryIds?.includes(m.id) && !ctx.db.get('SELECT 1 FROM memories WHERE id=?', m.id)) {
      ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', m.id, m.kind, m.text, null, null, JSON.stringify({ ...from, original: m.provenance ?? null }), now, now);
      counts.memories++;
    }
    const L = s.learning;
    if (L && sel.subjectIds?.length) {
      const subj = new Set(sel.subjectIds);
      const ins = (table: string, rows: any[], fix?: (r: any) => any) => {
        let n = 0;
        for (const r0 of rows) {
          const r = fix ? fix(r0) : r0; if (!r) continue;
          const cols = COLS[table];
          const res = ctx.db.run(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => (r[c] === undefined ? null : typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : r[c])));
          n += Number(res.changes);
        }
        counts[table] = n;
      };
      ins('subjects', L.subjects.filter((x: any) => subj.has(x.id)));
      const srcRows = L.sources.filter((x: any) => subj.has(x.subject_id));
      ins('sources', srcRows);
      for (const sr of srcRows) { // chunks are derived, not imported
        if (!sr.text || ctx.db.get('SELECT 1 FROM source_chunks WHERE source_id=? LIMIT 1', sr.id)) continue;
        for (const c of chunkText(sr.text)) ctx.db.run('INSERT INTO source_chunks (id,source_id,idx,text,page,para,char_start,char_end,label,uncertain) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), sr.id, c.idx, c.text, c.page, c.para, c.start, c.end, c.label, Number(c.uncertain));
      }
      const concepts = L.concepts.filter((x: any) => subj.has(x.subject_id));
      const cids = new Set(concepts.map((c: any) => c.id));
      ins('concepts', concepts, (r) => ({ ...r, source_id: srcRows.some((x: any) => x.id === r.source_id) ? r.source_id : null }));
      ins('concept_refs', L.concept_refs.filter((r: any) => cids.has(r.concept_id) && srcRows.some((x: any) => x.id === r.source_id)));
      ins('concept_prereqs', L.concept_prereqs.filter((r: any) => cids.has(r.concept_id) && cids.has(r.prereq_id)));
      const qs = L.questions.filter((q: any) => cids.has(q.concept_id));
      ins('questions', qs);
      const qids = new Set(qs.map((q: any) => q.id));
      ins('attempts', L.attempts.filter((a: any) => cids.has(a.concept_id) && qids.has(a.question_id)), (a) => ({ ...a, session_id: null }));
      const ms = L.misconceptions.filter((m: any) => cids.has(m.concept_id));
      ins('misconceptions', ms);
      const mids = new Set(ms.map((m: any) => m.id));
      const aids = new Set(L.attempts.map((a: any) => a.id));
      ins('misconception_evidence', L.misconception_evidence.filter((e: any) => mids.has(e.misconception_id) && aids.has(e.attempt_id)));
      // reading workspace: a highlight is kept only if its quote still matches the imported text at the saved position
      const textOf = new Map<string, string>(srcRows.map((x: any) => [x.id, String(x.text ?? '')]));
      counts.annotations = 0;
      for (const a of L.annotations ?? []) {
        const t = textOf.get(a.source_id);
        if (!t || !ctx.db.get('SELECT 1 FROM sources WHERE id=?', a.source_id) || t.slice(a.char_start, a.char_end) !== a.quote || !a.quote) continue;
        counts.annotations += Number(ctx.db.run('INSERT OR IGNORE INTO annotations (id,source_id,char_start,char_end,quote,source_rev,category,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          a.id, a.source_id, a.char_start, a.char_end, a.quote, a.source_rev ?? 1, ['theme', 'characterization', 'imagery', 'argument', 'evidence', 'question', 'vocabulary', 'other'].includes(a.category) ? a.category : 'none', String(a.note ?? '').slice(0, 2000), a.created_at ?? now, a.updated_at ?? now).changes);
      }
      for (const p of L.reading_prompts ?? []) if (textOf.has(p.source_id) && ctx.db.get('SELECT 1 FROM sources WHERE id=?', p.source_id) && ['prompt', 'rubric'].includes(p.kind))
        ctx.db.run('INSERT OR IGNORE INTO reading_prompts (source_id,kind,text,updated_at) VALUES (?,?,?,?)', p.source_id, p.kind, String(p.text ?? '').slice(0, 6000), p.updated_at ?? now);
      for (const o of L.outlines ?? []) if (textOf.has(o.source_id) && ctx.db.get('SELECT 1 FROM sources WHERE id=?', o.source_id) && typeof o.body === 'string')
        ctx.db.run('INSERT OR IGNORE INTO outlines (id,source_id,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)', o.id, o.source_id, String(o.title ?? 'Outline').slice(0, 120), o.body, o.created_at ?? now, o.updated_at ?? now);
      for (const cid of cids) if (ctx.db.get('SELECT 1 FROM concepts WHERE id=?', cid)) recomputeConcept(ctx, cid as string);
    }
    counts.items = 0;
    for (const i of s.items ?? []) if (sel.itemIds?.includes(i.id) && !ctx.db.get('SELECT 1 FROM academic_items WHERE id=?', i.id)) {
      ctx.db.run(`INSERT INTO academic_items (id,subject_id,type,title,due_kind,due_date,due_at,topics_text,format,notes,status,source,estimate_min,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        i.id, ctx.db.get('SELECT 1 FROM subjects WHERE id=?', i.subject_id) ? i.subject_id : null, i.type, String(i.title).slice(0, 120), i.due_kind ?? 'unknown', i.due_date ?? null, i.due_at ?? null, i.topics_text ?? null, i.format ?? '', i.notes ?? '', 'confirmed', 'manual', i.estimate_min ?? null, i.completed_at ?? null, now, now);
      counts.items++;
    }
  });
  return { imported: counts };
}
