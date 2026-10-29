import { createHash } from 'node:crypto';
import { AIError } from '../../ai/provider';
import { isMathSkill } from '../../core/mathgen';
import { chunkText, verifyQuotes, Support, looksLikeInjectedOutput } from '../../core/sources';
import { assessSupport, contentWords, keyGroups } from '../../core/grounding';
import { uid } from '../db';
import { Ctx, HttpError, clip, parse } from './common';
import { sweepOrphanFiles } from './files';
import { heldQuestions } from './questions';
import { exclusionsFor, ensureFlags, modelChunks, sourceFlags } from './sourceSafety';

export function listSubjects(ctx: Ctx) {
  const rows = ctx.db.all<any>(`SELECT s.*, 
    (SELECT COUNT(*) FROM sources WHERE subject_id = s.id) AS source_count,
    (SELECT COUNT(*) FROM concepts WHERE subject_id = s.id AND status = 'confirmed') AS concept_count,
    (SELECT COUNT(*) FROM concepts WHERE subject_id = s.id AND status = 'proposed') AS proposed_count
    FROM subjects s WHERE archived = 0 ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, aliases: parse<string[]>(r.aliases, []), sourceCount: r.source_count, conceptCount: r.concept_count, proposedCount: r.proposed_count }));
}

export function createSubject(ctx: Ctx, b: { name: string; description?: string; aliases?: string[] }) {
  const name = clip(b.name, 60).trim();
  if (!name) throw new HttpError(400, 'invalid', 'Give the subject a name.');
  if (ctx.db.get('SELECT 1 FROM subjects WHERE lower(name) = lower(?) AND archived = 0', name)) throw new HttpError(409, 'duplicate', `You already have a subject called “${name}”.`);
  const id = uid();
  ctx.db.run('INSERT INTO subjects (id,name,description,aliases,created_at) VALUES (?,?,?,?,?)', id, name, clip(b.description, 300), JSON.stringify((b.aliases ?? []).map((a) => clip(a, 40)).filter(Boolean).slice(0, 8)), ctx.now());
  return { id };
}

export function updateSubject(ctx: Ctx, id: string, b: { name?: string; description?: string; aliases?: string[]; archived?: boolean }) {
  const s = ctx.db.get<any>('SELECT * FROM subjects WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'not_found', 'Subject not found.');
  ctx.db.run('UPDATE subjects SET name=?, description=?, aliases=?, archived=? WHERE id=?',
    b.name !== undefined ? clip(b.name, 60).trim() || s.name : s.name, b.description !== undefined ? clip(b.description, 300) : s.description,
    b.aliases ? JSON.stringify(b.aliases.map((a) => clip(a, 40)).slice(0, 8)) : s.aliases, b.archived === undefined ? s.archived : Number(b.archived), id);
}

export function deleteSubject(ctx: Ctx, id: string) {
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM memories WHERE subject_id = ?', id);
    ctx.db.run('DELETE FROM subjects WHERE id = ?', id); // cascades sources, concepts, questions, attempts, state
  });
}

const MAX_SOURCE_CHARS = 150_000;
export function addSource(ctx: Ctx, subjectId: string, b: { title?: string; kind?: string; text: string; origin?: string; ocr?: boolean }) {
  if (!ctx.db.get('SELECT 1 FROM subjects WHERE id = ?', subjectId)) throw new HttpError(404, 'not_found', 'Subject not found.');
  const text = String(b.text ?? '').replace(/\r\n/g, '\n');
  if (text.trim().length < 20) throw new HttpError(400, 'too_short', 'Paste a bit more text (at least a couple of sentences).');
  if (text.length > MAX_SOURCE_CHARS) throw new HttpError(413, 'too_long', `That is too long (${text.length.toLocaleString()} characters). The limit is ${MAX_SOURCE_CHARS.toLocaleString()}; split it into parts.`);
  const hash = createHash('sha256').update(text.trim()).digest('hex');
  const dup = ctx.db.get<{ id: string }>('SELECT id FROM sources WHERE subject_id = ? AND content_hash = ?', subjectId, hash);
  if (dup) return { id: dup.id, duplicate: true };
  const kinds = ['notes', 'review_packet', 'rubric', 'teacher_instructions', 'passage', 'textbook', 'other'];
  const id = uid();
  const chunks = chunkText(text, { ocr: !!b.ocr });
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO sources (id,subject_id,title,kind,text,content_hash,origin,ocr,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, subjectId, clip(b.title, 120).trim() || 'Untitled material', kinds.includes(b.kind ?? '') ? b.kind : 'notes', text, hash, clip(b.origin, 120) || 'pasted', Number(!!b.ocr), ctx.now());
    for (const c of chunks) ctx.db.run('INSERT INTO source_chunks (id,source_id,idx,text,page,para,char_start,char_end,label,uncertain) VALUES (?,?,?,?,?,?,?,?,?,?)',
      uid(), id, c.idx, c.text, c.page, c.para, c.start, c.end, c.label, Number(c.uncertain));
  });
  ensureFlags(ctx, id);
  const flags = sourceFlags(ctx, id);
  return { id, duplicate: false, chunks: chunks.length, flagged: { strong: flags.filter((f) => f.severity === 'strong').length, weak: flags.filter((f) => f.severity === 'weak').length } };
}

export function noDemoUpload(ctx: Ctx): never | undefined {
  if (ctx.workspace === 'demo') throw new HttpError(409, 'demo_workspace', 'The sample workspace is read-only for uploads. Switch to your own workspace to add files.');
  return undefined;
}
export function deleteSource(ctx: Ctx, id: string) { ctx.db.tx(() => { ctx.db.run('DELETE FROM sources WHERE id = ?', id); sweepOrphanFiles(ctx); }); }

const EXTRACT_CHAR_BUDGET = 14_000;
/** Ask the provider for concept *proposals*. Nothing is trusted until the student confirms. */
export async function extractConcepts(ctx: Ctx, sourceId: string, opts: { useOffline?: boolean; force?: boolean } = {}) {
  const src = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src) throw new HttpError(404, 'not_found', 'Material not found.');
  if (src.status !== 'confirmed') throw new HttpError(409, 'not_confirmed', 'Review and confirm the extracted text first. Nothing is built from a file until you have checked what was read from it.');
  // Don't pay for the same extraction twice: concepts already came from this exact text.
  const already = ctx.db.get<any>('SELECT COUNT(*) n FROM concepts WHERE source_id = ?', sourceId).n;
  if (already > 0 && !opts.force) return { created: 0, skippedExisting: already, discardedQuotes: 0, truncated: false, provider: 'none (already extracted)', reused: true };
  const rows = ctx.db.all<any>('SELECT id, source_id, label, text, char_start, uncertain FROM source_chunks WHERE source_id = ? ORDER BY idx', sourceId);
  // The model sees a masked view; the original text and every chunk stay as uploaded. What was left out is listed in the source viewer.
  const visible = modelChunks(ctx, rows);
  const excludedSpans = (exclusionsFor(ctx, [sourceId]).get(sourceId) ?? []).length;
  let used = 0; const chunks: { id: string; label: string; text: string }[] = [];
  for (const r of visible) {
    if (used + r.text.length > EXTRACT_CHAR_BUDGET) break; chunks.push({ id: r.id, label: r.label, text: r.text }); used += r.text.length;
  }
  const truncated = chunks.length < visible.length;
  const provider = opts.useOffline ? ctx.offline : ctx.ai;
  let out;
  try { out = await provider.extractConcepts({ subjectName: ctx.db.get<any>('SELECT name FROM subjects WHERE id=?', src.subject_id).name, chunks, maxConcepts: 12 }); }
  catch (e) {
    if (e instanceof AIError) throw e;
    throw new HttpError(422, 'nothing_found', 'I could not find clear concepts in this text. Try adding a definition list or headings, or add concepts by hand.');
  }
  const excluded = exclusionsFor(ctx, [sourceId]).get(sourceId) ?? [];
  const existing = new Map(ctx.db.all<any>('SELECT id, lower(name) n FROM concepts WHERE subject_id = ?', src.subject_id).map((r) => [r.n, r.id]));
  const created: string[] = []; let skipped = 0, rejectedQuotes = 0, suspicious = 0;
  const idByName = new Map<string, string>(existing);
  const vchunks = chunksForVerify(ctx, sourceId);
  ctx.db.tx(() => {
    for (const c of out.concepts) {
      const key = c.name.toLowerCase().trim();
      if (existing.has(key)) { skipped++; continue; }
      // a concept whose own wording reads like an order to an AI suggests the model followed an injection; it is dropped and counted, never silently
      if (looksLikeInjectedOutput(c.name) || looksLikeInjectedOutput(c.summary)) { suspicious++; continue; }
      const vq = verifyQuotes(src.text, vchunks, c.quotes ?? []);
      // quotes inside passages that were left out of the AI view are not evidence; a concept supported only by them is dropped
      const inBad = vq.verified.filter((x) => excluded.some((r) => x.start < r.end && x.end > r.start));
      if (inBad.length && inBad.length === vq.verified.length) { suspicious++; continue; }
      const verified = vq.verified.filter((x) => !inBad.includes(x)), rejected = vq.rejected;
      rejectedQuotes += rejected.length;
      let support: Support, note: string;
      // A quote that exists is not the same as a quote that supports the concept: for model-proposed concepts, require the concept's own key words in the quoted passage.
      const supported = !provider.live || verified.length === 0 || verified.some((v) => {
        const ch = vchunks.find((r: any) => v.start >= r.start && v.start < r.end);
        const groups = keyGroups({ kind: 'explain', keyPoints: contentWords(c.name).map((w) => ({ point: w, keywords: [w] })) });
        return !groups.length || assessSupport(`${ch?.text ?? ''} ${v.quote}`, { kind: 'explain', keyPoints: contentWords(c.name).map((w) => ({ point: w, keywords: [w] })) }).support === 'supported';
      });
      if (verified.length && !supported) { support = 'unverified'; note = `A quote from “${src.title}” was attached, but it does not clearly mention “${c.name}”, so the link is unconfirmed. Check it against your material.`; }
      else if (verified.length) { support = 'source'; note = `${verified.length} supporting quote${verified.length > 1 ? 's' : ''} found in “${src.title}”.`; }
      else if (provider.live) { support = (c.quotes ?? []).length ? 'unverified' : 'ai'; note = (c.quotes ?? []).length ? 'The AI quoted text that could not be found in your material, so the quote was discarded.' : 'Not found in your material — this is background knowledge added by the AI. Verify it.'; }
      else { support = 'unverified'; note = 'No exact supporting text located. Check it against your material.'; }
      const id = uid();
      ctx.db.run('INSERT INTO concepts (id,subject_id,name,summary,status,skill_tag,support,support_note,origin,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id, src.subject_id, clip(c.name, 90), clip(c.summary, 500), 'proposed', isMathSkill(c.skill_tag) ? c.skill_tag : null, support, note, provider.live ? 'ai' : 'offline', sourceId, ctx.now(), ctx.now());
      const chunkRows = ctx.db.all<any>('SELECT id, char_start, char_end FROM source_chunks WHERE source_id = ?', sourceId);
      for (const v of verified) {
        const ch = chunkRows.find((r) => v.start >= r.char_start && v.start < r.char_end);
        ctx.db.run('INSERT INTO concept_refs (id,concept_id,source_id,chunk_id,quote,char_start,char_end,label) VALUES (?,?,?,?,?,?,?,?)', uid(), id, sourceId, ch?.id ?? null, v.quote, v.start, v.end, v.label);
      }
      created.push(id); idByName.set(key, id);
    }
    // prerequisites by name (only among known concepts; self-links and cycles ignored)
    for (const c of out.concepts) {
      const cid = idByName.get(c.name.toLowerCase().trim()); if (!cid || !created.includes(cid)) continue;
      for (const p of c.prerequisites ?? []) { const pid = idByName.get(p.toLowerCase().trim()); if (pid && pid !== cid && !wouldCycle(ctx, cid, pid)) ctx.db.run('INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id) VALUES (?,?)', cid, pid); }
    }
  });
  return { created: created.length, skippedExisting: skipped, discardedQuotes: rejectedQuotes, truncated, provider: provider.label, excludedPassages: excludedSpans, droppedSuspiciousConcepts: suspicious };
}

function chunksForVerify(ctx: Ctx, sourceId: string) {
  return ctx.db.all<any>('SELECT idx, text, page, para, char_start AS start, char_end AS end, label, uncertain FROM source_chunks WHERE source_id = ? ORDER BY idx', sourceId);
}

export function wouldCycle(ctx: Ctx, conceptId: string, prereqId: string): boolean {
  // adding prereq edge concept -> prereq creates a cycle if prereq already (transitively) depends on concept
  const seen = new Set<string>(); const stack = [prereqId];
  while (stack.length) {
    const cur = stack.pop()!; if (cur === conceptId) return true; if (seen.has(cur)) continue; seen.add(cur);
    for (const r of ctx.db.all<any>('SELECT prereq_id FROM concept_prereqs WHERE concept_id = ?', cur)) stack.push(r.prereq_id);
  }
  return false;
}

export function addConcept(ctx: Ctx, subjectId: string, b: { name: string; summary?: string; skillTag?: string | null }) {
  if (!ctx.db.get('SELECT 1 FROM subjects WHERE id = ?', subjectId)) throw new HttpError(404, 'not_found', 'Subject not found.');
  const name = clip(b.name, 90).trim();
  if (!name) throw new HttpError(400, 'invalid', 'Give the concept a name.');
  if (ctx.db.get('SELECT 1 FROM concepts WHERE subject_id=? AND lower(name)=lower(?)', subjectId, name)) throw new HttpError(409, 'duplicate', 'That concept already exists.');
  const id = uid();
  ctx.db.run('INSERT INTO concepts (id,subject_id,name,summary,status,skill_tag,support,support_note,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, subjectId, name, clip(b.summary, 500), 'confirmed', isMathSkill(b.skillTag) ? b.skillTag : null, 'unverified', 'Added by you; not linked to a source.', 'student', ctx.now(), ctx.now());
  return { id };
}

export function updateConcept(ctx: Ctx, id: string, b: { name?: string; summary?: string; status?: string; skillTag?: string | null; prereqIds?: string[] }) {
  const c = ctx.db.get<any>('SELECT * FROM concepts WHERE id = ?', id);
  if (!c) throw new HttpError(404, 'not_found', 'Concept not found.');
  if (b.status && !['proposed', 'confirmed', 'rejected'].includes(b.status)) throw new HttpError(400, 'invalid', 'Bad status.');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE concepts SET name=?, summary=?, status=?, skill_tag=?, updated_at=? WHERE id=?',
      b.name !== undefined ? clip(b.name, 90).trim() || c.name : c.name, b.summary !== undefined ? clip(b.summary, 500) : c.summary, b.status ?? c.status,
      b.skillTag === undefined ? c.skill_tag : isMathSkill(b.skillTag) ? b.skillTag : null, ctx.now(), id);
    if (b.prereqIds) {
      ctx.db.run('DELETE FROM concept_prereqs WHERE concept_id = ?', id);
      for (const p of b.prereqIds) if (p !== id && !wouldCycle(ctx, id, p)) ctx.db.run('INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id) VALUES (?,?)', id, p);
    }
  });
}

export function bulkConceptStatus(ctx: Ctx, ids: string[], status: 'confirmed' | 'rejected') {
  ctx.db.tx(() => { for (const id of ids) ctx.db.run('UPDATE concepts SET status=?, updated_at=? WHERE id=?', status, ctx.now(), id); });
}
export function deleteConcept(ctx: Ctx, id: string) { ctx.db.run('DELETE FROM concepts WHERE id = ?', id); }

export function subjectOverview(ctx: Ctx, id: string) {
  const s = ctx.db.get<any>('SELECT * FROM subjects WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'not_found', 'Subject not found.');
  const sources = ctx.db.all<any>(`SELECT id, title, kind, origin, ocr, created_at, length(text) chars, status, file_id, page_count,
    (SELECT COUNT(*) FROM source_chunks WHERE source_id = sources.id) chunks,
    (SELECT COUNT(*) FROM source_chunks WHERE source_id = sources.id AND uncertain = 1) uncertain_chunks FROM sources WHERE subject_id = ? ORDER BY created_at`, id);
  const concepts = ctx.db.all<any>('SELECT * FROM concepts WHERE subject_id = ? ORDER BY created_at, name', id).map((c) => {
    const refs = ctx.db.all<any>('SELECT quote, label, source_id, stale FROM concept_refs WHERE concept_id = ?', c.id);
    const st = ctx.db.get<any>('SELECT state, level, due_at FROM concept_state WHERE concept_id = ?', c.id);
    return {
      id: c.id, name: c.name, summary: c.summary, status: c.status, sourceId: c.source_id, skillTag: c.skill_tag, support: c.support, supportNote: c.support_note, origin: c.origin,
      refs, level: st?.level ?? 'not_assessed', dueAt: st?.due_at ?? null, state: st ? parse(st.state, null) : null,
      prereqIds: ctx.db.all<any>('SELECT prereq_id FROM concept_prereqs WHERE concept_id = ?', c.id).map((r) => r.prereq_id),
      activeMisconceptions: ctx.db.get<any>("SELECT COUNT(*) n FROM misconceptions WHERE concept_id = ? AND status = 'active'", c.id).n,
    };
  });
  return { subject: { id: s.id, name: s.name, description: s.description, aliases: parse<string[]>(s.aliases, []) }, sources, concepts, heldQuestions: heldQuestions(ctx, id) };
}

export function getSource(ctx: Ctx, id: string) {
  const s = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'not_found', 'Material not found.');
  return { id: s.id, title: s.title, kind: s.kind, subjectId: s.subject_id, text: s.text, originalIsUnchanged: s.original_text === s.text, chunks: ctx.db.all<any>('SELECT idx, label, char_start start, char_end end, uncertain FROM source_chunks WHERE source_id = ? ORDER BY idx', id), flags: sourceFlags(ctx, id) };
}
