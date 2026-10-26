import { useEffect, useRef, useState } from 'react';
import { ApiError, fmtDate, post, put, upload, useApi } from '../api';
import { Chip, ErrorBox, Spinner } from '../ui';

const draftKey = (id: string, rev: number, n: number) => `sh.pagedraft.${id}.${rev}.${n}`;
const readDraft = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeDraft = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable: edits still live in memory */ } };

/** Review what was read from an uploaded file, page by page, next to the original, before anything is built from it. */
export function ReviewSource({ id, go }: { id: string; go: (p: string) => void }) {
  const rv = useApi<any>(`/sources/${id}/review`);
  const [n, setN] = useState(1);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ack, setAck] = useState<{ pages: number[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const d = rv.data;

  useEffect(() => { // restore unsaved edits that survived a reload or an accidental navigation
    if (!d) return;
    const restored: Record<number, string> = {};
    d.pages.forEach((p: any) => { const t = readDraft(draftKey(id, d.rev, p.n)); if (t !== null && t !== p.text) restored[p.n] = t; });
    if (Object.keys(restored).length) setEdits((e) => ({ ...restored, ...e }));
  }, [d?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rv.loading && !d) return <div className="narrow"><Spinner /></div>;
  if (rv.error && !d) return <div className="narrow"><ErrorBox error={rv.error} onRetry={rv.reload} /></div>;
  if (!d) return <div className="narrow"><p className="muted">This material was pasted as text, so there is no file to compare. <a href="#/subjects">Back to subjects</a></p></div>;

  const page = d.pages[n - 1];
  const text = edits[n] ?? page.text;
  const dirty = (p: number) => edits[p] !== undefined && edits[p] !== d.pages[p - 1].text;
  const anyDirty = d.pages.some((p: any) => dirty(p.n));
  const isPdf = d.file.kind === 'pdf';
  const confirmed = d.status === 'confirmed';
  const setText = (v: string) => { setEdits((e) => ({ ...e, [n]: v })); writeDraft(draftKey(id, d.rev, n), v); };
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(null); setNote(null); try { await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(null); } };

  const savePage = (p: number) => run('Saving…', async () => {
    const r = await put(`/sources/${id}/pages/${p}`, { text: edits[p], baseRev: d.rev });
    writeDraft(draftKey(id, d.rev, p), null);
    setEdits((e) => { const c = { ...e }; delete c[p]; return c; });
    await rv.reload();
    if (r.reconcile && (r.reconcile.refsStale || r.reconcile.questionsRetired || r.reconcile.conceptsDowngraded)) setNote(`Saved. ${r.reconcile.refsStale} quote${r.reconcile.refsStale === 1 ? '' : 's'} used by concepts could no longer be found; ${r.reconcile.questionsRetired} question${r.reconcile.questionsRetired === 1 ? '' : 's'} built on them ${r.reconcile.questionsRetired === 1 ? 'was' : 'were'} retired from future practice (your past answers are kept).`);
  });
  const confirm = (acknowledgeEmptyPages = false) => run('Confirming…', async () => {
    try { await post(`/sources/${id}/confirm`, { acknowledgeEmptyPages }); }
    catch (e) { if ((e as ApiError).code === 'empty_pages') { setAck({ pages: (e as ApiError).extra.emptyPages }); return; } throw e; }
    setAck(null);
    try { await post(`/sources/${id}/extract`, {}); go(`/subjects/${d.subjectId}`); }
    catch (e) { await rv.reload(); setErr(e as ApiError); }
  });
  const replace = (f?: File) => f && run('Reading the new file…', async () => {
    if (anyDirty && !confirm_('You have unsaved page edits. Replacing the file discards them. Continue?')) return;
    const r = await upload(`/sources/${id}/replace`, f);
    setEdits({}); await rv.reload(); setN(1);
    setNote(`New file read (${r.pageCount} page${r.pageCount === 1 ? '' : 's'}). ${r.reconcile ? `${r.reconcile.refsRelinked} concept quote${r.reconcile.refsRelinked === 1 ? '' : 's'} re-linked, ${r.reconcile.refsStale} no longer found, ${r.reconcile.questionsRetired} question${r.reconcile.questionsRetired === 1 ? '' : 's'} retired.` : ''} The previous file and text are kept in the history below.`);
  });

  return (
    <div>
      <p className="small"><a href={`#/subjects/${d.subjectId}`} onClick={(e) => { if (anyDirty && !confirm_('You have unsaved page edits. Leave anyway?')) e.preventDefault(); }}>← Back to the subject</a></p>
      <div className="row between"><h1>{d.title}</h1><Chip tone={confirmed ? 'good' : 'warn'}>{confirmed ? 'In use' : 'Needs your review'}</Chip></div>
      {!confirmed && <div className="notice info small" role="status"><strong>Check what was read before anything is built from it.</strong> {d.method === 'pdf_text'
        ? 'The text below was read from the PDF on this computer — nothing was sent anywhere. Reading order, line breaks and math symbols can be wrong, so compare each page with the original and fix mistakes.'
        : <>No text could be read from this {isPdf ? 'PDF — it looks like a scan or photo' : 'image'}. This app does <strong>not</strong> do OCR, and nothing is sent to an outside service to read it. Type or paste the text of each page beside the original instead.</>}
        {' '}Only the confirmed <em>text</em> (never the file or picture) is used for concepts and questions, and is sent to an AI only if you have set one up.</div>}
      {err && <ErrorBox error={err} />}
      {note && <div className="notice good small" role="status">{note}</div>}
      {busy && <Spinner label={busy} />}

      <div className="row gap-s" role="tablist" aria-label="Pages" style={{ flexWrap: 'wrap', margin: '.6rem 0' }}>
        {d.pages.map((p: any) => <button key={p.n} role="tab" aria-selected={p.n === n} className={`btn small${p.n === n ? ' primary' : ''}`} onClick={() => setN(p.n)}>
          {isPdf ? 'Page' : 'Image'} {p.n}{p.noText ? ' · no text' : ''}{p.reviewMath ? ' · check math' : ''}{dirty(p.n) ? ' · unsaved' : ''}</button>)}
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <section className="card" aria-label="Original">
          <h2 style={{ marginTop: 0 }}>Original</h2>
          {isPdf ? <iframe title={`Original page ${n}`} src={`${d.file.url}#page=${n}&view=FitH`} style={{ width: '100%', height: '70vh', border: '1px solid var(--line, #ccc)', borderRadius: 6 }} />
            : <img alt={`Original upload ${d.file.name}`} src={d.file.url} style={{ maxWidth: '100%', borderRadius: 6 }} />}
          <p className="small muted">{d.file.name} · {(d.file.bytes / 1024).toFixed(0)} KB · kept unchanged. <a href={d.file.url} target="_blank" rel="noreferrer">Open in a new tab</a></p>
        </section>
        <section className="card" aria-label="Extracted text">
          <h2 style={{ marginTop: 0 }}>{d.method === 'pdf_text' ? 'Text read from this page' : 'Text for this page'}</h2>
          {page.noText && !text.trim() && <div className="notice warn small">{d.method === 'pdf_text' ? 'No text was found on this page — it may be an image, a scanned page or a blank page.' : 'Nothing has been read from this page.'} Type or paste what it says, or confirm later and leave it out.</div>}
          {page.warning === 'garbled' && <div className="notice warn small">Some characters on this page look garbled (the PDF’s fonts may not map to real letters). Compare carefully with the original.</div>}
          {page.reviewMath && <div className="notice info small">Contains symbols the reader had to guess, such as <code>^</code> for a superscript. Check exponents, fractions and minus signs against the original.</div>}
          <textarea aria-label={`Text of page ${n}`} value={text} onChange={(e) => setText(e.target.value)} rows={16} style={{ width: '100%', fontFamily: 'inherit' }} />
          <div className="row gap-s mt-s">
            <button className="btn primary" disabled={!dirty(n) || !!busy} onClick={() => savePage(n)}>Save page {n}</button>
            {dirty(n) && <button className="btn ghost" onClick={() => { setEdits((e) => { const c = { ...e }; delete c[n]; return c; }); writeDraft(draftKey(id, d.rev, n), null); }}>Discard changes</button>}
            {n < d.pages.length && <button className="btn" onClick={() => setN(n + 1)}>Next page →</button>}
          </div>
        </section>
      </div>

      {!confirmed && <section className="card">
        <h2 style={{ marginTop: 0 }}>Next step</h2>
        {anyDirty && <p className="small unknown">You have unsaved edits on page {d.pages.filter((p: any) => dirty(p.n)).map((p: any) => p.n).join(', ')}. Save them first.</p>}
        {ack && <div className="notice warn small" role="alert">{ack.pages.length === 1 ? `Page ${ack.pages[0]} has` : `Pages ${ack.pages.join(', ')} have`} no text, so nothing from {ack.pages.length === 1 ? 'it' : 'them'} can be studied. <div className="row gap-s mt-s"><button className="btn" onClick={() => confirm(true)}>Confirm without {ack.pages.length === 1 ? 'it' : 'them'}</button><button className="btn ghost" onClick={() => { setN(ack.pages[0]); setAck(null); }}>Add the text first</button></div></div>}
        <button className="btn primary" disabled={anyDirty || !!busy} onClick={() => confirm(false)}>The text is right — find concepts</button>
        <p className="small muted">Next you’ll check the proposed concepts, then take a short check before practising.</p>
      </section>}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Replace the file or see its history</h2>
        <p className="small muted">A corrected copy of the file replaces the text read from it. Concepts and questions that quote the old text are re-linked by finding the same words; anything that can’t be found is marked out of date and questions built on it stop being used.</p>
        <input ref={fileRef} type="file" hidden accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => { replace(e.target.files?.[0]); e.target.value = ''; }} />
        <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>Replace with another file…</button>
        <ul className="small muted">{d.revisions.map((r: any) => <li key={r.rev}>Version {r.rev} · {r.kind} · {fmtDate(r.at)}{r.note ? ` — ${r.note}` : ''}</li>)}</ul>
      </section>
    </div>
  );
}
const confirm_ = (m: string) => window.confirm(m);
