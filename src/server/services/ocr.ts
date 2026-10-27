/**
 * Optional automatic reading of screenshots and scanned pages with a vision model.
 *
 * Off by default. It needs AI_OCR=anthropic plus an Anthropic key (set on the server, never sent to the browser). Before anything leaves this computer the
 * student is shown the provider, the model, exactly which file/pages will be sent, what will not be sent and the worst-case cost, and must approve THAT
 * content (a consent token binds the approval to provider + model + file + pages). Usage is reserved and counted in the same budget as every other AI call.
 *
 * There is no numeric "OCR confidence": the reader only reports what it could and could not read. Math, diagrams, tables and handwriting are always flagged for
 * the student to check against the original, and the text cannot be confirmed until flagged pages have been looked at.
 */
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { ReadResult } from '../../ai/provider';
import { reservationUsd } from '../../ai/pricing';
import { IMAGE_TOKEN_ALLOWANCE, PDF_PAGE_TOKEN_ALLOWANCE } from '../../ai/llm';
import { Ctx, HttpError, parse } from './common';
import { applyText, joinPages, working } from './files';
import { MIME, FileKind } from '../pdf';

const BATCH_PAGES = 3;
export type FlagKind = 'math' | 'diagram' | 'unreadable' | 'handwriting' | 'table';
export const FLAG_NOTE: Record<FlagKind, string> = {
  math: 'Contains math. Check every symbol, exponent, fraction, minus sign and inequality against the original.',
  diagram: 'Contains a diagram, graph or figure that was not interpreted. Add a description yourself if you need it.',
  unreadable: 'Part of this could not be read. It is marked [unreadable] in the text.',
  handwriting: 'Handwriting can be misread. Check every word and number.',
  table: 'Contains a table. Its layout may be lost.',
};

export function ocrAvailability(ctx: Ctx) {
  const steps = ['Set ANTHROPIC_API_KEY in .env (server-side only).', 'Set AI_OCR=anthropic in .env — an explicit opt-in to sending page images to Anthropic.', 'Restart the app.', 'Open this material again; you will see exactly what will be sent before anything is.'];
  if (ctx.workspace === 'demo') return { available: false, reason: 'The sample workspace never calls an AI provider.', steps: [] as string[] };
  if (!ctx.cfg.ocr.enabled) return { available: false, reason: 'Automatic reading is off. Nothing is ever sent to an outside service to read your files unless you turn it on.', steps };
  if (!ctx.ai.live || ctx.ai.providerId !== 'anthropic' || !ctx.ai.readPages) return { available: false, reason: 'Automatic reading needs the Anthropic provider and an API key.', steps };
  return { available: true, reason: null as string | null, steps: [] as string[] };
}

async function pdfBatches(data: Uint8Array, pages: number[]) {
  const src = await PDFDocument.load(data, { ignoreEncryption: false, updateMetadata: false });
  const out: { pages: number[]; bytes: Uint8Array }[] = [];
  for (let i = 0; i < pages.length; i += BATCH_PAGES) {
    const group = pages.slice(i, i + BATCH_PAGES);
    const doc = await PDFDocument.create();
    const copied = await doc.copyPages(src, group.map((n) => n - 1));
    copied.forEach((p) => doc.addPage(p));
    out.push({ pages: group, bytes: await doc.save() });
  }
  return out;
}

function target(ctx: Ctx, sourceId: string, pagesWanted?: number[]) {
  const src = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', sourceId);
  if (!src?.file_id) throw new HttpError(404, 'not_found', 'Material not found.');
  const w = working(ctx, src);
  if (src.status === 'confirmed' && !w.pending) throw new HttpError(409, 'not_in_review', 'Automatic reading only applies while a file is being reviewed, so confirmed text is never changed behind your back. Replace the file to review a new reading.');
  const f = ctx.db.get<any>('SELECT id, filename, kind, bytes, sha256, data FROM source_files WHERE id = ?', w.fileId);
  const texts = w.text.split('\f');
  const empty = texts.map((t, i) => (t.replace(/\s/g, '').length < 15 ? i + 1 : 0)).filter(Boolean);
  const pages = (pagesWanted?.length ? pagesWanted : empty).filter((n, i, a) => Number.isInteger(n) && n >= 1 && n <= w.pageCount && a.indexOf(n) === i).sort((a, b) => a - b);
  return { src, w, f, texts, pages };
}

const digest = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24);

/** Everything the student must see before approving: provider, model, what is sent, what is not, and the worst-case cost. */
export async function ocrDisclosure(ctx: Ctx, sourceId: string, pagesWanted?: number[]) {
  const av = ocrAvailability(ctx);
  const t = target(ctx, sourceId, pagesWanted);
  if (!av.available) return { ...av, pages: t.pages, file: { name: t.f.filename, kind: t.f.kind } };
  if (!t.pages.length) throw new HttpError(409, 'nothing_to_read', 'Every page already has text. Pick the pages you want read, or edit the text yourself.');
  const model = ctx.ai.ocrModel?.() ?? ctx.cfg.model;
  const data = new Uint8Array(t.f.data as Uint8Array);
  const batches = t.f.kind === 'pdf' ? await pdfBatches(data, t.pages) : [{ pages: [1], bytes: data }];
  const bytes = batches.reduce((a, b) => a + b.bytes.length, 0);
  const allowance = t.f.kind === 'pdf' ? t.pages.length * PDF_PAGE_TOKEN_ALLOWANCE : IMAGE_TOKEN_ALLOWANCE;
  const worstCaseUsd = batches.reduce((a, b) => a + reservationUsd(model, 1500 + (t.f.kind === 'pdf' ? b.pages.length * PDF_PAGE_TOKEN_ALLOWANCE : IMAGE_TOKEN_ALLOWANCE), ctx.cfg.ocr.maxOutputTokens ?? 6000, ctx.cfg.aiPriceOverride), 0);
  return {
    available: true as const, provider: 'Anthropic', providerId: 'anthropic', model, file: { name: t.f.filename, kind: t.f.kind, bytes: t.f.bytes },
    pages: t.pages, requests: batches.length, sentBytes: bytes,
    willSend: t.f.kind === 'pdf' ? `${t.pages.length} page${t.pages.length === 1 ? '' : 's'} (${t.pages.join(', ')}) of “${t.f.filename}”, as a PDF extract, in ${batches.length} request${batches.length === 1 ? '' : 's'} (about ${(bytes / 1024).toFixed(0)} KB)` : `the image “${t.f.filename}” (about ${(bytes / 1024).toFixed(0)} KB)`,
    wontSend: ['Any other page of this file', 'Your other materials, answers, notes or memory', 'Your API key (it stays on this computer’s server)'],
    worstCaseUsd, budgetNote: 'Counted in your daily AI budget, like every other AI request. The figure is a conservative upper estimate from list prices, not a quote; the provider’s billing is authoritative.',
    allowanceTokens: allowance,
    consentToken: digest({ p: 'anthropic', model, sha: t.f.sha256, pages: t.pages }),
    privacyNote: 'Anthropic receives these pages to produce text. Review Anthropic’s data policies for your account before sending anything sensitive.',
  };
}

function composeBlock(b: ReadResult['pages'][number]['blocks'][number]) {
  const txt = b.text.trim();
  if (b.kind === 'diagram') return `[diagram: ${txt || 'figure'} — not interpreted]`;
  if (!b.readable) return `[unreadable${b.note ? `: ${b.note}` : ''}]${txt ? ` ${txt}` : ''}`;
  return txt;
}
function flagsOf(blocks: ReadResult['pages'][number]['blocks']) {
  const kinds = new Set<FlagKind>();
  for (const b of blocks) {
    if (b.kind === 'math') kinds.add('math');
    if (b.kind === 'diagram') kinds.add('diagram');
    if (b.kind === 'handwriting') kinds.add('handwriting');
    if (b.kind === 'table') kinds.add('table');
    if (!b.readable && b.kind !== 'diagram') kinds.add('unreadable');
    if (/\[\?\]/.test(b.text)) kinds.add('unreadable');
  }
  return [...kinds].map((kind) => ({ kind, note: FLAG_NOTE[kind] }));
}

/** Run the approved reading. Results go into the draft/pending text per page; every flagged page must be checked before the text can be confirmed. */
export async function runOcr(ctx: Ctx, sourceId: string, o: { pages?: number[]; consentToken: string; overwrite?: boolean }) {
  const d = await ocrDisclosure(ctx, sourceId, o.pages);
  if (!d.available) throw new HttpError(409, 'ocr_unavailable', d.reason ?? 'Automatic reading is not available.');
  if (!o.consentToken || o.consentToken !== d.consentToken) throw new HttpError(409, 'consent_required', 'Approve exactly what will be sent first. What is sent changed or no approval was given, so nothing was sent.', { required: true });
  const t = target(ctx, sourceId, o.pages);
  const data = new Uint8Array(t.f.data as Uint8Array);
  const batches = t.f.kind === 'pdf' ? await pdfBatches(data, t.pages) : [{ pages: [1], bytes: data }];
  const done: number[] = [], skipped: number[] = [], failed: { pages: number[]; code: string; message: string }[] = [];
  let usage = 0;
  for (const b of batches) {
    let res: ReadResult;
    try {
      res = await ctx.ai.readPages!({ attachment: { kind: t.f.kind === 'pdf' ? 'pdf' : 'image', mediaType: MIME[t.f.kind as FileKind], data: Buffer.from(b.bytes).toString('base64'), pages: b.pages.length }, pageCount: b.pages.length, label: t.f.filename }, {});
    } catch (e: any) {
      failed.push({ pages: b.pages, code: e?.code ?? 'error', message: e?.message ?? 'Reading failed.' });
      if (['budget_reached', 'limit_reached', 'not_configured'].includes(e?.code)) break; // stop rather than keep trying
      continue;
    }
    usage++;
    ctx.db.tx(() => {
      const cur = ctx.db.get<any>('SELECT * FROM sources WHERE id = ?', sourceId);
      const w = working(ctx, cur);
      const pages = w.text.split('\f'); while (pages.length < w.pageCount) pages.push('');
      const meta = parse<any>(w.extraction, { method: 'none', pages: [] });
      meta.pages = meta.pages ?? [];
      b.pages.forEach((n, idx) => {
        const got = res.pages.find((p) => p.page === idx + 1);
        if (!got) { failed.push({ pages: [n], code: 'not_returned', message: 'The reader returned nothing for this page.' }); return; }
        if (pages[n - 1].replace(/\s/g, '').length >= 15 && !o.overwrite) { skipped.push(n); return; }
        pages[n - 1] = got.blocks.map(composeBlock).filter(Boolean).join('\n\n');
        meta.pages[n - 1] = { ...(meta.pages[n - 1] ?? { n }), n, warning: null, source: 'vision', provider: 'anthropic', model: d.model, flags: flagsOf(got.blocks), reviewed: false, edited: false, readAt: ctx.now() };
        done.push(n);
      });
      meta.vision = true;
      const text = joinPages(pages.map((tx) => ({ text: tx })));
      const metaJson = JSON.stringify(meta);
      if (w.pending) ctx.db.run('UPDATE source_pending SET text=?, rev=rev+1, extraction=? WHERE source_id=?', text, metaJson, sourceId);
      else { applyText(ctx, cur, text, 'transcribed', `Pages ${b.pages.join(', ')} read with Anthropic (${d.model}); to be checked by the student.`); ctx.db.run('UPDATE sources SET extraction=? WHERE id=?', metaJson, sourceId); }
    });
  }
  return { read: done, skipped, failed, requests: usage };
}
