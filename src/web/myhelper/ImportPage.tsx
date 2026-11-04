import { useState } from 'react';
import { ApiError, post } from '../api';
import { PageTop } from './Shell';

/** Bring in the old browser-only My Helper data: choose the export file (or paste it), look at what would change, then confirm. Doing it again is safe. */
export function ImportPage({ go }: { go: (p: string) => void }) {
  const [text, setText] = useState(''); const [payload, setPayload] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null); const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const parse = (raw: string) => { const j = JSON.parse(raw.trim().replace(/^﻿/, '')); return j; };
  const run = async (raw: string) => {
    setErr(null); setPreview(null); setDone(null); setBusy(true);
    try { const p = parse(raw); const pv = await post('/myhelper/import/preview', { payload: p }); setPayload(p); setPreview(pv); }
    catch (e) { setPayload(null); setErr(e instanceof SyntaxError ? 'That is not a My Helper export. Choose the my-helper-export.json file, or paste what the console printed.' : e instanceof ApiError ? e.message : 'Could not read that.'); }
    finally { setBusy(false); }
  };
  const file = async (f: File | undefined) => { if (!f) return; if (f.size > 5_000_000) { setErr('That file is too large to be a My Helper export.'); return; } const t = await f.text(); setText(t); run(t); };
  const apply = async () => { setBusy(true); setErr(null); try { setDone(await post('/myhelper/import', { payload, confirm: true })); setPreview(null); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Import failed.'); } finally { setBusy(false); } };
  const pv = preview ?? done;
  const fresh = pv ? pv.totals.new + pv.totals.imported : 0;
  const STATUS: Record<string, [string, string]> = { new: ['New', 'mint'], imported: ['Imported', 'mint'], already_imported: ['Already here', ''], invalid: ['Skipped', 'peach'] };
  return (<>
    <PageTop eyebrow="One time (or any time)" title="Import old My Helper data" />
    <section className="mh-panel">
      <h3>1. Export from the original page</h3>
      <p className="mh-sub" style={{ fontSize: 13 }}>Open your original My Helper HTML file in the same browser you always used and use its <strong>Export my data</strong> button (the copy in <code>legacy/my-helper-with-export.html</code> has it). Your data lives in that browser only, so it has to be exported from there.</p>
      <h3 style={{ marginTop: 20 }}>2. Choose the file</h3>
      <div className="mh-field" style={{ marginTop: 10 }}><label htmlFor="imp-f">my-helper-export.json</label><input id="imp-f" type="file" accept="application/json,.json" onChange={(e) => file(e.target.files?.[0])} /></div>
      <details><summary className="mh-sub" style={{ cursor: 'pointer' }}>Or paste it instead</summary>
        <div className="mh-field" style={{ marginTop: 10 }}><label htmlFor="imp-t">Pasted export</label><textarea id="imp-t" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"format":"my-helper-export", …}' /></div>
        <button className="mh-secondary" disabled={!text.trim() || busy} onClick={() => run(text)}>Preview</button></details>
      {err && <div className="mh-notice bad" role="alert">{err}</div>}
    </section>
    {pv && <section className="mh-panel" style={{ marginTop: 18 }} aria-live="polite">
      <h3>{done ? 'Imported' : '3. Preview — nothing has been saved yet'}</h3>
      <div className="mh-list" style={{ marginTop: 12 }}>
        {([['task', 'Tasks and school assignments'], ['project', 'Projects'], ['memory', 'Memory notes']] as const).map(([k, label]) => { const c = pv.byKind[k]; return <div className="mh-task" key={k}><span className="mh-title">{label}</span><span className="mh-tag mint">{c.new + c.imported} {done ? 'added' : 'new'}</span><span className="mh-tag">{c.alreadyImported} already here</span>{c.invalid > 0 && <span className="mh-tag peach">{c.invalid} skipped</span>}</div>; })}
      </div>
      <details style={{ marginTop: 12 }}><summary className="mh-sub" style={{ cursor: 'pointer' }}>See every entry{pv.truncated ? ' (first 200)' : ''}</summary>
        <div className="mh-list" style={{ marginTop: 8 }}>{pv.items.map((it: any, i: number) => { const [t, tone] = STATUS[it.status] ?? [it.status, '']; return <div className="mh-task" key={i}><span className="mh-title">{it.label}<br /><span className="mh-meta">{it.where}{it.reason ? ` · ${it.reason}` : ''}</span></span><span className={`mh-tag ${tone}`}>{t}</span></div>; })}</div></details>
      <p className="mh-sub" style={{ fontSize: 12 }}>Anything already here is skipped, so importing the same file again never creates duplicates.</p>
      {!done && fresh === 0 && <div className="mh-notice good">Everything in this file is already here. Nothing to import.</div>}
      {!done && <div className="mh-row end"><button className="mh-primary" disabled={busy || fresh === 0} onClick={apply}>{busy ? 'Importing…' : `Import ${fresh} new ${fresh === 1 ? 'entry' : 'entries'}`}</button></div>}
      {done && <div className="mh-row end"><button className="mh-primary" onClick={() => go('/')}>Go to Today</button></div>}
    </section>}
  </>);
}
