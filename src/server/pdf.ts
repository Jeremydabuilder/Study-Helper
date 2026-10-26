/**
 * Local text extraction from PDFs (pdf.js via unpdf). Nothing leaves this machine.
 *
 * What this can and cannot do:
 *  - It reads the text layer a PDF already contains (exported documents, word processors, most school packets).
 *  - It does NOT do OCR. A scanned page or a photo has no text layer; such pages come back empty and are reported as such.
 *  - Reading order, paragraph breaks and superscripts are reconstructed from glyph positions, which is a best effort. Pages are
 *    returned separately so the student can compare each one with the original and correct it.
 */
export const LIMITS = { maxPdfBytes: 15 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024, maxPages: 60, maxChars: 150_000, timeoutMs: 30_000 };

export type FileKind = 'pdf' | 'png' | 'jpeg' | 'webp';
export const MIME: Record<FileKind, string> = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Decide the type from the bytes themselves, never from the file name or the client's claim. */
export function sniff(b: Uint8Array): FileKind | null {
  const s = (i: number, str: string) => str.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length > 8 && b[0] === 0x89 && s(1, 'PNG') && b[4] === 0x0d) return 'png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 12 && s(0, 'RIFF') && s(8, 'WEBP')) return 'webp';
  const head = Buffer.from(b.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

export type PdfErrorCode = 'encrypted' | 'corrupt' | 'too_many_pages' | 'timeout' | 'too_long' | 'failed';
export class PdfError extends Error { constructor(public code: PdfErrorCode, message: string) { super(message); } }

export interface PdfPage { n: number; text: string; warning: 'no_text' | 'garbled' | null }

interface Item { str: string; x: number; y: number; w: number; h: number }
interface Line { y: number; x0: number; x1: number; h: number; text: string }

const BULLET = /^(?:[-•*▪◦‣–]\s|\(?\d{1,3}[.)]\s|\(?[a-zA-Z][.)]\s|[IVX]{1,4}[.)]\s)/;
const PUA = /[-]/g;

function buildLines(items: Item[]): Line[] {
  items.sort((a, b) => (Math.abs(a.y - b.y) > Math.max(2, 0.45 * Math.max(a.h, b.h)) ? b.y - a.y : a.x - b.x));
  const rows: Item[][] = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    const ref = last && last[0];
    if (ref && Math.abs(ref.y - it.y) <= Math.max(2, 0.45 * Math.max(ref.h, it.h))) last.push(it); else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const h = Math.max(...row.map((r) => r.h));
    const base = row.reduce((best, r) => (r.h >= best.h ? r : best), row[0]).y; // baseline of the largest text
    let text = '', prevEnd = -Infinity, prevHadMark = false;
    for (const r of row) {
      if (!r.str) continue;
      if (!r.str.trim()) { if (text && !text.endsWith(' ')) text += ' '; prevEnd = r.x + r.w; prevHadMark = false; continue; } // spacing glyphs carry no meaningful height or baseline
      const small = r.h < 0.92 * h && row.length > 1, dy = r.y - base;
      const mark = small && dy > 0.12 * h ? '^' : small && dy < -0.12 * h ? '_' : '';
      const gap = r.x - prevEnd;
      if (!mark && !prevHadMark && text && gap > 0.18 * h && !text.endsWith(' ') && !r.str.startsWith(' ')) text += ' ';
      text += mark ? (r.str.trim().length > 1 ? `${mark}(${r.str.trim()})` : `${mark}${r.str.trim()}`) : r.str;
      prevEnd = r.x + r.w; prevHadMark = !!mark;
    }
    return { y: base, x0: row[0].x, x1: Math.max(...row.map((r) => r.x + r.w)), h, text: text.replace(/\s+/g, ' ').trim() };
  }).filter((l) => l.text);
}

/** Join soft-wrapped lines into paragraphs; keep real line breaks for lists, headings and short lines. */
function reflow(lines: Line[]): string {
  if (!lines.length) return '';
  const maxW = Math.max(...lines.map((l) => l.x1 - l.x0));
  const out: string[] = [];
  let cur = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1], l = lines[i];
    const gap = prev.y - l.y, lh = Math.max(prev.h, l.h);
    if (gap > 1.55 * lh) { out.push(cur); out.push(''); cur = l.text; continue; } // paragraph gap
    const prevShort = prev.x1 - prev.x0 < 0.72 * maxW;
    const sizeChange = Math.abs(prev.h - l.h) > 0.15 * lh; // heading ↔ body text
    const hardBreak = sizeChange || BULLET.test(l.text) || (prevShort && /[.!?:;)"”]$/.test(prev.text)) || /:$/.test(prev.text) || (prevShort && /^[A-Z0-9#]/.test(l.text) && prev.text.length < 70 && !/[,;]$/.test(prev.text));
    if (hardBreak) { out.push(cur); cur = l.text; } else cur += ' ' + l.text;
  }
  out.push(cur);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new PdfError('timeout', `Reading this PDF took longer than ${Math.round(ms / 1000)} seconds, so I stopped. Try a smaller file or split it into parts.`)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

export async function extractPdf(data: Uint8Array): Promise<{ pageCount: number; pages: PdfPage[] }> {
  const { getDocumentProxy } = await import('unpdf');
  return withTimeout((async () => {
    let doc;
    try { doc = await getDocumentProxy(new Uint8Array(data), { isEvalSupported: false, useSystemFonts: false, verbosity: 0 } as any); }
    catch (e: any) {
      if (e?.name === 'PasswordException') throw new PdfError('encrypted', 'This PDF is password-protected. Remove the password (or print it to a new PDF) and upload it again.');
      if (e?.name === 'InvalidPDFException' || e?.name === 'FormatError' || e?.name === 'MissingPDFException') throw new PdfError('corrupt', 'This file looks damaged or is not a readable PDF. Try opening and re-saving it, or upload a different copy.');
      throw new PdfError('failed', 'This PDF could not be read.');
    }
    if (doc.numPages > LIMITS.maxPages) throw new PdfError('too_many_pages', `This PDF has ${doc.numPages} pages; the limit is ${LIMITS.maxPages}. Split it into smaller parts.`);
    const pages: PdfPage[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const items: Item[] = [];
      for (const it of tc.items as any[]) {
        if (typeof it.str !== 'string' || !it.transform) continue;
        items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: Math.abs(it.height || it.transform[3] || 10) });
      }
      const text = reflow(buildLines(items));
      chars += text.length;
      if (chars > LIMITS.maxChars) throw new PdfError('too_long', `This PDF has more than ${LIMITS.maxChars.toLocaleString()} characters of text. Split it into smaller parts.`);
      const bad = (text.match(PUA)?.length ?? 0) + (text.match(/�/g)?.length ?? 0);
      pages.push({ n, text, warning: text.replace(/\s/g, '').length < 15 ? 'no_text' : bad > 0 && bad / text.length > 0.01 ? 'garbled' : null });
    }
    try { await (doc as any).cleanup?.(); } catch { /* best effort */ }
    return { pageCount: doc.numPages, pages };
  })(), LIMITS.timeoutMs);
}
