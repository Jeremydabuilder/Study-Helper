import { useEffect, useRef, useState } from 'react';
import { ApiError, fmtDate, post, put, upload, useApi } from '../api';
import { Chip, ErrorBox, Modal, Spinner } from '../ui';

const draftKey = (id: string, rev: number, n: number) => `sh.pagedraft.${id}.${rev}.${n}`;
const readDraft = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeDraft = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable: edits still live in memory */ } };
const flowQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
const usd = (x: number) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;

/** Review what was read from an uploaded file, page by page, next to the original, before anything is built from it. */
export function ReviewSource({ id, go }: { id: string; go: (p: string) => void }) {
  const rv = useApi<any>(`/sources/${id}/review`);
  const [n, setN] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [ack, setAck] = useState<{ pages: number[] } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [disclosure, setDisclosure] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const flow = flowQuery(); const inFlow = !!flow.get('goal');
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

  const needs = (p: any) => p.noText || !!p.warning || p.reviewMath || p.flags.length > 0;
  const attention: number[] = d.pages.filter(needs).map((p: any) => p.n);
  const unchecked: number[] = d.pages.filter((p: any) => p.source === 'vision' && p.flags.length > 0 && !p.reviewed).map((p: any) => p.n);
  const visible: any[] = showAll || !attention.length ? d.pages : d.pages.filter((p: any) => needs(p) || p.n === n);
  const cur = n ?? (attention[0] ?? 1);
  const page = d.pages[cur - 1];
  const text = edits[cur] ?? page.text;
  const dirty = (p: number) => edits[p] !== undefined && edits[p] !== d.pages[p - 1].text;
  const anyDirty = d.pages.some((p: any) => dirty(p.n));
  const isPdf = d.file.kind === 'pdf';
  const live = d.status === 'confirmed' && !d.pending; // already in use; nothing to confirm
  const setText = (v: string) => { setEdits((e) => ({ ...e, [cur]: v })); writeDraft(draftKey(id, d.rev, cur), v); };
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(null); setNote(null); try { await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(null); } };

  const savePage = (p: number) => run('Saving…', async () => {
    const r = await put(`/sources/${id}/pages/${p}`, { text: edits[p], baseRev: d.rev });
    writeDraft(draftKey(id, d.rev, p), null);
    setEdits((e) => { const c = { ...e }; delete c[p]; return c; });
    await rv.reload();
    if (r.reconcile && (r.reconcile.refsStale || r.reconcile.questionsRetired || r.reconcile.conceptsDowngraded)) setNote(`Saved. ${r.reconcile.refsStale} quote${r.reconcile.refsStale === 1 ? '' : 's'} used by concepts could no longer be found; ${r.reconcile.questionsRetired} question${r.reconcile.questionsRetired === 1 ? '' : 's'} built on them ${r.reconcile.questionsRetired === 1 ? 'was' : 'were'} retired from future practice (your past answers are kept).`);
  });
  const markChecked = (p: number) => run('Saving…', async () => { await post(`/sources/${id}/pages/reviewed`, { pages: [p] }); await rv.reload(); });
  const afterConfirm = async (r: any) => {
    if (r?.replaced) { await rv.reload(); setNote(`The new file is now in use. ${r.reconcile ? `${r.reconcile.refsRelinked} concept quote${r.reconcile.refsRelinked === 1 ? '' : 's'} re-linked, ${r.reconcile.refsStale} no longer found, ${r.reconcile.questionsRetired} question${r.reconcile.questionsRetired === 1 ? '' : 's'} retired (past answers kept).` : ''}`); return; }
    if (inFlow) { go(`/prepare/${id}?goal=${flow.get('goal')}&min=${flow.get('min') ?? 20}`); return; }
    try { const x = await post(`/sources/${id}/extract`, {}); try { sessionStorage.setItem('sh.flash', `Read ${d.pages.length} page${d.pages.length === 1 ? '' : 's'} and found ${x.created} proposed concept${x.created === 1 ? '' : 's'}. Check them below — nothing is practised until you confirm.`); } catch { /* no flash */ } go(`/subjects/${d.subjectId}`); }
    catch (e) { await rv.reload(); setErr(e as ApiError); }
  };
  const confirm = (acknowledgeEmptyPages = false) => run('Confirming…', async () => {
    let r;
    try { r = await post(`/sources/${id}/confirm`, { acknowledgeEmptyPages }); }
    catch (e) { if ((e as ApiError).code === 'empty_pages') { setAck({ pages: (e as ApiError).extra.emptyPages }); return; } throw e; }
    setAck(null); await afterConfirm(r);
  });
  const replace = (f?: File) => f && run('Reading the new file…', async () => {
    if (anyDirty && !window.confirm('You have unsaved page edits. Replacing the file discards them. Continue?')) return;
    await upload(`/sources/${id}/replace`, f);
    setEdits({}); await rv.reload(); setN(1); setShowAll(false);
    setNote('The new file was read, but it is NOT in use yet. Your confirmed text and its questions stay as they are until you review the new reading and confirm it below.');
  });
  const discard = () => run('Discarding…', async () => { await post(`/sources/${id}/discard-replacement`); setEdits({}); await rv.reload(); setN(null); });
  const preview = (pages?: number[]) => run('Checking what would be sent…', async () => { const r = await post(`/sources/${id}/ocr/preview`, { pages }); setDisclosure(r); });
  const sendOcr = () => run('Reading with Anthropic…', async () => {
    const r = await post(`/sources/${id}/ocr`, { pages: disclosure.pages, consentToken: disclosure.consentToken });
    setDisclosure(null); setEdits({}); await rv.reload(); setShowAll(false); setN(r.read?.[0] ?? null);
    setNote(`${r.read.length ? `Read page${r.read.length === 1 ? '' : 's'} ${r.read.join(', ')}.` : 'Nothing was read.'}${r.failed?.length ? ` ${r.failed.map((f: any) => `Pages ${f.pages.join(', ')}: ${f.message}`).join(' ')}` : ''} Check the flagged areas against the original before using this text.`);
  });

  return (
    <div>
      <p className="small"><a href={`#/subjects/${d.subjectId}`} onClick={(e) => { if (anyDirty && !window.confirm('You have unsaved page edits. Leave anyway?')) e.preventDefault(); }}>← Back to the subject</a></p>
      <div className="row between"><h1>{d.title}</h1><Chip tone={d.pending ? 'warn' : live ? 'good' : 'warn'}>{d.pending ? 'Replacement waiting for review' : live ? 'In use' : 'Needs your review'}</Chip></div>

      {d.pending && <div className="notice warn small" role="status"><strong>This is a replacement file, not yet in use.</strong> Your earlier confirmed text, its concepts and its questions are unchanged until you review this reading and confirm it.
        <div className="row gap-s mt-s"><button className="btn small" onClick={discard}>Discard the replacement</button></div></div>}
      {!live && !d.pending && <div className="notice info small" role="status"><strong>{attention.length ? `${attention.length} of ${d.pages.length} page${d.pages.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} a look.` : `All ${d.pages.length} page${d.pages.length === 1 ? ' was' : 's were'} read cleanly.`}</strong> {d.method === 'pdf_text' || d.pages.some((p: any) => p.source === 'vision')
        ? `${d.pages.some((p: any) => p.source === 'vision') ? 'Some pages were read by Anthropic after you approved it; the rest was read on this computer. ' : 'Text was read from the file on this computer. '}Reading order, line breaks and math can still be wrong, so skim anything that matters. Nothing is sent anywhere unless you approve it.`
        : <>No text could be read from this {isPdf ? 'PDF — it looks like a scan or photo' : 'image'}. Read it automatically (optional, you choose and see what is sent first) or type each page beside the original.</>}
        {' '}Only confirmed <em>text</em> (never the file or picture) is used for concepts and questions.</div>}
      {err && <ErrorBox error={err} />}
      {note && <div className="notice good small" role="status">{note}</div>}
      {busy && <Spinner label={busy} />}

      <div className="row gap-s" role="tablist" aria-label="Pages" style={{ flexWrap: 'wrap', margin: '.6rem 0' }}>
        {visible.map((p: any) => <button key={p.n} role="tab" aria-selected={p.n === cur} className={`btn small${p.n === cur ? ' primary' : ''}`} onClick={() => setN(p.n)}>
          {isPdf ? 'Page' : 'Image'} {p.n}{p.noText ? ' · no text' : ''}{p.flags.length ? ' · check' : p.reviewMath ? ' · check math' : ''}{p.source === 'vision' && p.reviewed ? ' · checked' : ''}{dirty(p.n) ? ' · unsaved' : ''}</button>)}
        {attention.length > 0 && !showAll && visible.length < d.pages.length && <button className="btn small ghost" onClick={() => setShowAll(true)}>Show all {d.pages.length} pages</button>}
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <section className="card" aria-label="Original">
          <h2 style={{ marginTop: 0 }}>Original</h2>
          {isPdf && !(navigator as any).pdfViewerEnabled ? <div className="notice info small">This browser can’t show PDFs inside the page. <a href={`${d.file.url}#page=${cur}`} target="_blank" rel="noreferrer">Open the original (page {cur}) in a new tab</a> and compare it with the text on the right.</div>
            : isPdf ? <iframe title={`Original page ${cur}`} src={`${d.file.url}#page=${cur}&view=FitH`} style={{ width: '100%', height: '70vh', border: '1px solid var(--line, #ccc)', borderRadius: 6 }} />
            : <img alt={`Original upload ${d.file.name}`} src={d.file.url} style={{ maxWidth: '100%', borderRadius: 6 }} />}
          <p className="small muted">{d.file.name} · {(d.file.bytes / 1024).toFixed(0)} KB · kept unchanged. <a href={d.file.url} target="_blank" rel="noreferrer">Open in a new tab</a></p>
        </section>
        <section className="card" aria-label="Extracted text">
          <h2 style={{ marginTop: 0 }}>{page.source === 'vision' ? 'Text read by Anthropic' : d.method === 'pdf_text' ? 'Text read from this page' : 'Text for this page'}</h2>
          {page.noText && !text.trim() && <div className="notice warn small">{d.method === 'pdf_text' ? 'No text was found on this page — it may be an image, a scanned page or a blank page.' : 'Nothing has been read from this page.'} {d.ocr?.available ? 'You can have it read automatically, or type it.' : 'Type or paste what it says, or confirm later and leave it out.'}</div>}
          {page.warning === 'garbled' && <div className="notice warn small">Some characters on this page look garbled (the PDF’s fonts may not map to real letters). Compare carefully with the original.</div>}
          {page.flags.map((f: any) => <div key={f.kind} className="notice warn small" role="note"><strong>{({ math: 'Math to check', diagram: 'Diagram not interpreted', unreadable: 'Part could not be read', handwriting: 'Handwriting', table: 'Table' } as Record<string, string>)[f.kind]}.</strong> {f.note}</div>)}
          {!page.flags.length && page.reviewMath && <div className="notice info small">Contains symbols the reader had to guess, such as <code>^</code> for a superscript. Check exponents, fractions and minus signs against the original.</div>}
          <textarea aria-label={`Text of page ${cur}`} value={text} onChange={(e) => setText(e.target.value)} rows={16} style={{ width: '100%', fontFamily: 'inherit' }} />
          <div className="row gap-s mt-s">
            <button className="btn primary" disabled={!dirty(cur) || !!busy} onClick={() => savePage(cur)}>Save page {cur}</button>
            {dirty(cur) && <button className="btn ghost" onClick={() => { setEdits((e) => { const c = { ...e }; delete c[cur]; return c; }); writeDraft(draftKey(id, d.rev, cur), null); }}>Discard changes</button>}
            {page.source === 'vision' && page.flags.length > 0 && !page.reviewed && !dirty(cur) && <button className="btn" disabled={!!busy} onClick={() => markChecked(cur)}>I checked page {cur} against the original</button>}
            {cur < d.pages.length && <button className="btn" onClick={() => setN(cur + 1)}>Next page →</button>}
          </div>
          {!live && d.ocr && (
            <div className="mt-s small">
              {d.ocr.available
                ? (d.pages.some((p: any) => p.noText && !p.source) && <button className="btn small" disabled={!!busy} onClick={() => preview(page.noText ? [cur] : undefined)}>{page.noText ? `Read page ${cur} automatically…` : 'Read blank pages automatically…'}</button>)
                : <details><summary className="muted">Automatic reading is off</summary><p className="muted">{d.ocr.reason}</p>{d.ocr.steps.length > 0 && <ol>{d.ocr.steps.map((x: string, i: number) => <li key={i}>{x}</li>)}</ol>}<p>Until then, type the text beside the original — that always works.</p></details>}
            </div>)}
        </section>
      </div>

      {!live && <section className="card">
        <h2 style={{ marginTop: 0 }}>Next step</h2>
        {anyDirty && <p className="small unknown">You have unsaved edits on page {d.pages.filter((p: any) => dirty(p.n)).map((p: any) => p.n).join(', ')}. Save them first.</p>}
        {unchecked.length > 0 && <p className="small unknown">Page{unchecked.length === 1 ? '' : 's'} {unchecked.join(', ')} contain{unchecked.length === 1 ? 's' : ''} math, a diagram or text that could not be read. Check {unchecked.length === 1 ? 'it' : 'each'} against the original (or fix the text) first.</p>}
        {ack && <div className="notice warn small" role="alert">{ack.pages.length === 1 ? `Page ${ack.pages[0]} has` : `Pages ${ack.pages.join(', ')} have`} no text, so nothing from {ack.pages.length === 1 ? 'it' : 'them'} can be studied. <div className="row gap-s mt-s"><button className="btn" onClick={() => confirm(true)}>Confirm without {ack.pages.length === 1 ? 'it' : 'them'}</button><button className="btn ghost" onClick={() => { setN(ack.pages[0]); setAck(null); }}>Add the text first</button></div></div>}
        <button className="btn primary" disabled={anyDirty || unchecked.length > 0 || !!busy} onClick={() => confirm(false)}>{d.pending ? 'Use this replacement' : inFlow ? 'The text is right — continue' : 'The text is right — find concepts'}</button>
        <p className="small muted">{d.pending ? 'Quotes will be re-linked by exact match; anything that can’t be found is marked out of date and questions built on it stop being used. Past answers are kept.' : 'Next you’ll check the proposed concepts, then study.'}</p>
      </section>}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Replace the file or see its history</h2>
        <p className="small muted">A corrected copy is read first and shown here for review. The material in use doesn’t change until you confirm the new reading.</p>
        <input ref={fileRef} type="file" hidden accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => { replace(e.target.files?.[0]); e.target.value = ''; }} />
        <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>Replace with another file…</button>
        <ul className="small muted">{d.revisions.map((r: any) => <li key={r.rev}>Version {r.rev} · {r.kind} · {fmtDate(r.at)}{r.note ? ` — ${r.note}` : ''}</li>)}</ul>
      </section>

      {disclosure && <Modal title="Send pages to Anthropic to be read?" onClose={() => setDisclosure(null)}>
        {!disclosure.available ? <p>{disclosure.reason}</p> : <>
          <p>Reading a scan or screenshot means sending it to an outside company. Nothing has been sent yet.</p>
          <dl className="small">
            <dt><strong>Provider</strong></dt><dd>{disclosure.provider} · model <span className="mono">{disclosure.model}</span></dd>
            <dt><strong>What will be sent</strong></dt><dd>{disclosure.willSend}</dd>
            <dt><strong>What will not be sent</strong></dt><dd><ul>{disclosure.wontSend.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></dd>
            <dt><strong>Cost</strong></dt><dd>At most about {usd(disclosure.worstCaseUsd)} (worst-case estimate). {disclosure.budgetNote}</dd>
          </dl>
          <p className="small muted">{disclosure.privacyNote} The reader only transcribes. It will mark math, diagrams and anything unclear, and you must check those against the original. It gives no accuracy percentage because it cannot know one.</p>
          <div className="row mt"><button className="btn primary" onClick={sendOcr} disabled={!!busy}>Send and read</button><button className="btn" onClick={() => setDisclosure(null)}>Cancel — nothing is sent</button></div></>}
      </Modal>}
    </div>
  );
}
