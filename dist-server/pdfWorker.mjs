// Runs in a worker thread (see pdf.ts). Plain JS so it loads the same way under tsx, vitest and production.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

const post = (m) => parentPort.postMessage(m);
try {
  let doc;
  try { doc = await getDocumentProxy(new Uint8Array(workerData.data), { isEvalSupported: false, useSystemFonts: false, verbosity: 0 }); }
  catch (e) {
    if (e?.name === 'PasswordException') post({ type: 'error', code: 'encrypted', message: 'This PDF is password-protected. Remove the password (or print it to a new PDF) and upload it again.' });
    else if (['InvalidPDFException', 'FormatError', 'MissingPDFException'].includes(e?.name)) post({ type: 'error', code: 'corrupt', message: 'This file looks damaged or is not a readable PDF. Try opening and re-saving it, or upload a different copy.' });
    else post({ type: 'error', code: 'failed', message: 'This PDF could not be read.' });
    process.exit(0);
  }
  if (doc.numPages > workerData.maxPages) { post({ type: 'error', code: 'too_many_pages', message: `This PDF has ${doc.numPages} pages; the limit is ${workerData.maxPages}. Split it into smaller parts.` }); process.exit(0); }
  post({ type: 'pages', pageCount: doc.numPages });
  if (workerData.testDelayMs) await new Promise((r) => setTimeout(r, workerData.testDelayMs)); // test hook: simulate a page that takes very long
  let chars = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.transform) continue;
      chars += it.str.length;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: Math.abs(it.height || it.transform[3] || 10) });
    }
    if (chars > workerData.maxChars * 1.5) { post({ type: 'error', code: 'too_long', message: `This PDF has more than ${workerData.maxChars.toLocaleString()} characters of text. Split it into smaller parts.` }); process.exit(0); }
    post({ type: 'page', n, items });
  }
  post({ type: 'done' });
} catch {
  post({ type: 'error', code: 'failed', message: 'This PDF could not be read.' });
}
