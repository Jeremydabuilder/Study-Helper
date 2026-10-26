import { createHash } from 'node:crypto';
import { chunkAt, chunkText, findQuote } from '../../core/sources';
import { uid } from '../db';
import { LIMITS, FileKind, MIME, PdfError, PdfPage, extractPdf, sniff } from '../pdf';
import { Ctx, HttpError, clip, parse } from './common';
import { ensureFlags } from './sourceSafety';

const MAX_PAGE_CHARS = 40_000;
const NO_TEXT_BELOW = 15;
const KINDS = ['notes', 'review_packet', 'rubric', 'teacher_instructions', 'passage', 'textbook', 'other'];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Extracted { kind: FileKind; pages: PdfPage[]; method: 'pdf_text' | 'none' }

/** Validate the bytes and read whatever text layer exists. Never invents text. */
async function readUpload(data: Buffer): Promise<Extracted> {
  if (!data.length) throw new HttpError(400, 'empty_file', 'That file is empty.');
  const kind = sniff(data);
  if (!kind) throw new HttpError(415, 'unsupported_type', 'I can read PDF files, and PNG, JPEG or WebP screenshots. This file is none of those (the type is checked from the file’s contents, not its name). For other documents, export to PDF or paste the text.');
  const limit = kind === 'pdf' ? LIMITS.maxPdfBytes : LIMITS.maxImageBytes;
  if (data.length > limit) throw new HttpError(413, 'file_too_large', `That ${kind === 'pdf' ? 'PDF' : 'image'} is ${(data.length / 1048576).toFixed(1)} MB; the limit is ${limit / 1048576} MB.`);
  if (kind !== 'pdf') return { kind, pages: [{ n: 1, text: '', warning: 'no_text' }], method: 'none' };
  try {
    const r = await extractPdf(data);
    return { kind, pages: r.pages, method: r.pages.some((p) => p.warning !== 'no_text') ? 'pdf_text' : 'none' };
  } catch (e) {
    if (e instanceof PdfError) throw new HttpError(e.code === 'too_many_pages' || e.code === 'too_long' ? 413 : e.code === 'timeout' ? 504 : 422, `pdf_${e.code}`, e.message);
    throw e;
  }
}

const joinPages = (pages: { text: string }[]) => pages.map((p) => p.text).join('\f');
const extractionMeta = (x: Extracted) => JSON.stringify({ method: x.method, kind: x.kind, pages: x.pages.map((p) => ({ n: p.n, warning: p.warning })) });

function writeChunks(ctx: Ctx, sourceId: string, text: string) {
  ctx.db.run('DELETE FROM source_chunks WHERE source_id = ?', sourceId);
  const chunks = chunkText(text, { review: true, paged: true });
  for (const c of chunks) ctx.db.run('INSERT INTO source_chunks (id,source_id,idx,text,page,para,char_start,char_end,label,uncertain) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), sourceId, c.idx, c.text, c.page, c.para, c.start, c.end, c.label, Number(c.uncertain));
  return chunks;
}

const locate = (text: string, quote: string) => findQuote(text, quote) ?? (quote.length < 6 && quote.trim() ? ((i) => (i >= 0 ? { start: i, end: i + quote.length } : null))(text.indexOf(quote)) : null);

export interface ReconcileResult { refsRelinked: number; refsStale: number; conceptsDowngraded: number; questionsRetired: number }

/**
 * After the working text of a material changed: re-link every concept quote and question quote to its new location by finding the
 * exact quote again. Anything that cannot be found is marked stale, concepts left with no live support are downgraded, and questions
 * built on a missing passage are retired from future practice (their past attempts stay in the history).
 */
function reconcile(ctx: Ctx, sourceId: string, text: string, chunks: ReturnType<typeof chunkText>): ReconcileResult {
  const res: ReconcileResult = { refsRelinked: 0, refsStale: 0, conceptsDowngraded: 0, questionsRetired: 0 };
  const rows = ctx.db.all<{ id: string; idx: number }>('SELECT id, idx FROM source_chunks WHERE source_id = ?', sourceId);
  const chunkId = (c: { idx: number } | null) => rows.find((r) => r.idx === c?.idx)?.id ?? null;
  const touched = new Set<string>();
  for (const r of ctx.db.all<any>('SELECT * FROM concept_refs WHERE source_id = ?', sourceId)) {
    const hit = locate(text, r.quote);
    touched.add(r.concept_id);
    if (hit) { const c = chunkAt(chunks, hit.start); ctx.db.run('UPDATE concept_refs SET char_start=?, char_end=?, chunk_id=?, label=?, stale=0 WHERE id=?', hit.start, hit.end, chunkId(c), c?.label ?? 'location unknown', r.id); res.refsRelinked++; }
    else { ctx.db.run('UPDATE concept_refs SET stale=1, chunk_id=NULL WHERE id=?', r.id); res.refsStale++; }
  }
  for (const id of touched) {
    const live = ctx.db.get<any>('SELECT COUNT(*) n FROM concept_refs WHERE concept_id=? AND stale=0', id).n;
    const c = ctx.db.get<any>('SELECT support FROM concepts WHERE id=?', id);
    if (!live && c?.support === 'source') {
      ctx.db.run("UPDATE concepts SET support='unverified', support_note=?, updated_at=? WHERE id=?", 'The passage this was based on was changed or removed when the material was edited or replaced. Check it against your material.', ctx.now(), id);
      res.conceptsDowngraded++;
    }
  }
  const retire = new Set<string>();
  for (const e of ctx.db.all<any>('SELECT rowid AS rid, * FROM question_evidence WHERE source_id = ?', sourceId)) {
    const hit = locate(text, e.quote);
    if (hit) { const c = chunkAt(chunks, hit.start); ctx.db.run('UPDATE question_evidence SET char_start=?, char_end=?, label=?, stale=0 WHERE rowid=?', hit.start, hit.end, c?.label ?? 'location unknown', e.rid); }
    else { ctx.db.run('UPDATE question_evidence SET stale=1 WHERE rowid=?', e.rid); retire.add(e.question_id); }
  }
  for (const q of retire) {
    const r = ctx.db.run("UPDATE questions SET retired_at=?, retired_reason=? WHERE id=? AND retired_at IS NULL", ctx.now(), 'The passage this question was based on changed or was removed.', q);
    res.questionsRetired += Number(r.changes);
  }
  return res;
}

function applyText(ctx: Ctx, src: any, text: string, kind: 'corrected' | 'transcribed' | 'replaced', note: string, extra: { fileId?: string; pageCount?: number; extraction?: string } = {}) {
  const rev = src.rev + 1;
  ctx.db.run('UPDATE sources SET text=?, rev=?, flags_version=0, file_id=COALESCE(?, file_id), page_count=COALESCE(?, page_count), extraction=COALESCE(?, extraction), content_hash=? WHERE id=?',
    text, rev, extra.fileId ?? null, extra.pageCount ?? null, extra.extraction ?? null, createHash('sha256').update(extra.fileId ? (ctx.db.get<any>('SELECT sha256 FROM source_files WHERE id=?', extra.fileId).sha256 as string) : `${src.content_hash}:${rev}`).digest('hex'), src.id);
  ctx.db.run('INSERT INTO source_revisions (id,source_id,rev,kind,text,file_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)', uid(), src.id, rev, kind, text, extra.fileId ?? src.file_id, note, ctx.now());
  const chunks = writeChunks(ctx, src.id, text);
  return { rev, reconcile: src.status === 'confirmed' ? reconcile(ctx, src.id, text, chunks) : null };
}

export async function uploadFile(ctx: Ctx, subjectId: string, o: { data: Buffer; filename: string; title?: string; kind?: string }) {
  if (!ctx.db.get('SELECT 1 FROM subjects WHERE id = ?', subjectId)) throw new HttpError(404, 'not_found', 'Subject not found.');
  const x = await readUpload(o.data);
  const hash = sha(o.data);
  const dup = ctx.db.get<{ id: string }>('SELECT s.id FROM sources s JOIN source_files f ON f.id = s.file_id WHERE s.subject_id = ? AND f.sha256 = ?', subjectId, hash);
  if (dup) return { id: dup.id, duplicate: true };
  const fileId = uid(), id = uid();
  const filename = clip(o.filename, 160).replace(/[\\/\u0000-\u001f]/g, '_') || `upload.${x.kind}`;
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO source_files (id,sha256,filename,kind,bytes,data,created_at) VALUES (?,?,?,?,?,?,?)', fileId, hash, filename, x.kind, o.data.length, o.data, ctx.now());
    ctx.db.run(`INSERT INTO sources (id,subject_id,title,kind,text,content_hash,origin,ocr,created_at,status,file_id,page_count,rev,extraction) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, subjectId, clip(o.title, 120).trim() || filename.replace(/\.[^.]+$/, ''), KINDS.includes(o.kind ?? '') ? o.kind : 'notes', joinPages(x.pages), hash, `file:${x.kind}`, 0, ctx.now(), 'draft', fileId, x.pages.length, 1, extractionMeta(x));
    ctx.db.run('INSERT INTO source_revisions (id,source_id,rev,kind,text,file_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)', uid(), id, 1, 'extracted', joinPages(x.pages), fileId, x.method === 'pdf_text' ? 'Text layer read locally from the PDF.' : 'No text layer found.', ctx.now());
    writeChunks(ctx, id, joinPages(x.pages));
  });
  return { id, duplicate: false, ...fileSummary(ctx, id) };
}

function fileSummary(ctx: Ctx, id: string) {
  const s = ctx.db.get<any>('SELECT status, page_count, extraction, text FROM sources WHERE id = ?', id);
  const pages = (s.text as string).split('\f');
  const meta = parse<any>(s.extraction, { method: 'none', pages: [] });
  return { status: s.status as string, pageCount: s.page_count as number, method: meta.method as string, emptyPages: pages.map((t, i) => [t, i + 1] as const).filter(([t]) => t.replace(/\s/g, '').length < NO_TEXT_BELOW).map(([, n]) => n) };
}

export function getFile(ctx: Ctx, id: string) {
  const f = ctx.db.get<any>('SELECT filename, kind, data FROM source_files WHERE id = ?', id);
  if (!f) throw new HttpError(404, 'not_found', 'File not found.');
  return { filename: f.filename as string, mime: MIME[f.kind as FileKind], data: Buffer.from(f.data as Uint8Array) };
}

/** Everything the review screen needs: the file, the text by page, and which pages need a human look. */
export function reviewPages(ctx: Ctx, id: string) {
  const s = ctx.db.get<any>('SELECT s.*, f.filename, f.kind AS fkind, f.bytes, f.id AS fid FROM sources s LEFT JOIN source_files f ON f.id = s.file_id WHERE s.id = ?', id);
  if (!s) throw new HttpError(404, 'not_found', 'Material not found.');
  if (!s.file_id) return null;
  const texts = (s.text as string).split('\f');
  const meta = parse<any>(s.extraction, { pages: [] });
  const chunks = ctx.db.all<any>('SELECT page, uncertain FROM source_chunks WHERE source_id = ?', id);
  return {
    file: { id: s.fid, name: s.filename, kind: s.fkind, bytes: s.bytes, url: `/api/files/${s.fid}` }, status: s.status, rev: s.rev, method: meta.method ?? 'none',
    pages: texts.map((text, i) => ({ n: i + 1, text, chars: text.length, noText: text.replace(/\s/g, '').length < NO_TEXT_BELOW, warning: meta.pages?.[i]?.warning ?? null, reviewMath: chunks.some((c) => c.page === i + 1 && c.uncertain) })),
    revisions: ctx.db.all<any>('SELECT rev, kind, note, created_at at FROM source_revisions WHERE source_id = ? ORDER BY rev DESC LIMIT 10', id),
  };
}

export function savePage(ctx: Ctx, sourceId: string, n: number, raw: string, baseRev: number) {
  const src = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src) throw new HttpError(404, 'not_found', 'Material not found.');
  if (!src.file_id) throw new HttpError(409, 'not_file_based', 'Only materials uploaded from a file are edited page by page.');
  if (src.rev !== baseRev) throw new HttpError(409, 'stale_edit', 'This material changed since you opened it (another tab or an earlier save). Reload it before editing so nothing is overwritten.', { rev: src.rev });
  if (!Number.isInteger(n) || n < 1 || n > src.page_count) throw new HttpError(400, 'invalid', `Page ${n} does not exist (this file has ${src.page_count}).`);
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\f/g, '\n');
  if (text.length > MAX_PAGE_CHARS) throw new HttpError(413, 'too_long', `That page text is ${text.length.toLocaleString()} characters; the limit is ${MAX_PAGE_CHARS.toLocaleString()}.`);
  const pages = (src.text as string).split('\f'); while (pages.length < src.page_count) pages.push('');
  if (pages[n - 1] === text) return { rev: src.rev, unchanged: true, reconcile: null };
  pages[n - 1] = text;
  const meta = parse<any>(src.extraction, { method: 'none' });
  const out = ctx.db.tx(() => applyText(ctx, src, joinPages(pages.map((t) => ({ text: t }))), meta.method === 'none' ? 'transcribed' : 'corrected', `Page ${n} edited.`));
  return { ...out, unchanged: false };
}

export function confirmSource(ctx: Ctx, sourceId: string, o: { acknowledgeEmptyPages?: boolean } = {}) {
  const src = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src) throw new HttpError(404, 'not_found', 'Material not found.');
  if (src.status === 'confirmed') return { status: 'confirmed', alreadyConfirmed: true };
  const sum = fileSummary(ctx, sourceId);
  if (sum.emptyPages.length === sum.pageCount) throw new HttpError(422, 'no_text', 'No text has been read from this file. It looks like a scan or a photo, which this app cannot read automatically. Type or paste the text for each page next to the original, then confirm.', { emptyPages: sum.emptyPages });
  if (sum.emptyPages.length && !o.acknowledgeEmptyPages) throw new HttpError(409, 'empty_pages', `${sum.emptyPages.length === 1 ? 'Page' : 'Pages'} ${sum.emptyPages.join(', ')} ${sum.emptyPages.length === 1 ? 'has' : 'have'} no text, so nothing from ${sum.emptyPages.length === 1 ? 'it' : 'them'} can be used for studying. Add the text, or confirm anyway to leave ${sum.emptyPages.length === 1 ? 'it' : 'them'} out.`, { emptyPages: sum.emptyPages });
  ctx.db.run("UPDATE sources SET status='confirmed' WHERE id = ?", sourceId);
  ensureFlags(ctx, sourceId);
  return { status: 'confirmed', pageCount: sum.pageCount, emptyPages: sum.emptyPages };
}

/** Replace the uploaded file with a newer copy. The old text, file and edits stay in the revision history. */
export async function replaceFile(ctx: Ctx, sourceId: string, o: { data: Buffer; filename: string }) {
  const src = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src) throw new HttpError(404, 'not_found', 'Material not found.');
  if (!src.file_id) throw new HttpError(409, 'not_file_based', 'Only materials uploaded from a file can be replaced by a file. Paste new text as a new material instead.');
  const x = await readUpload(o.data);
  const hash = sha(o.data);
  if (ctx.db.get('SELECT 1 FROM source_files WHERE id = ? AND sha256 = ?', src.file_id, hash)) throw new HttpError(409, 'same_file', 'That is the same file that is already attached.');
  const fileId = uid();
  const out = ctx.db.tx(() => {
    ctx.db.run('INSERT INTO source_files (id,sha256,filename,kind,bytes,data,created_at) VALUES (?,?,?,?,?,?,?)', fileId, hash, clip(o.filename, 160).replace(/[\\/\u0000-\u001f]/g, '_') || `upload.${x.kind}`, x.kind, o.data.length, o.data, ctx.now());
    return applyText(ctx, src, joinPages(x.pages), 'replaced', 'File replaced; text re-read from the new file.', { fileId, pageCount: x.pages.length, extraction: extractionMeta(x) });
  });
  return { ...out, ...fileSummary(ctx, sourceId) };
}

/** Remove stored files that no material or revision refers to any more (called after deleting a material). */
export function sweepOrphanFiles(ctx: Ctx) {
  ctx.db.run('DELETE FROM source_files WHERE id NOT IN (SELECT file_id FROM sources WHERE file_id IS NOT NULL) AND id NOT IN (SELECT file_id FROM source_revisions WHERE file_id IS NOT NULL)');
}
