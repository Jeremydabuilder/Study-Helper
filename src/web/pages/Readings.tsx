import { useEffect, useState } from 'react';
import { ApiError, patch, post, useApi } from '../api';
import { Chip, Empty, ErrorBox, Field, Spinner } from '../ui';

export function Readings({ go }: { go: (p: string) => void }) {
  const d = useApi<any>('/readings');
  const [adding, setAdding] = useState(false);
  if (d.loading && !d.data) return <div><h1>Readings</h1><div className="skeleton" style={{ height: 90 }} /><div className="skeleton" /></div>;
  if (d.error && !d.data) return <div><h1>Readings</h1><ErrorBox error={d.error} onRetry={d.reload} /></div>;
  const list: any[] = d.data.readings;
  return (
    <div className="narrow">
      <div className="row between"><h1>Readings</h1><div className="row gap-s"><button className="btn primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Close' : 'Add a reading'}</button></div></div>
      <p className="muted">Highlight passages, write what you notice, and turn your notes into practice. Your highlights and notes work without an AI; explanations and AI feedback are optional.</p>
      {adding && <AddReading subjects={d.data.subjects} go={go} onDone={() => { setAdding(false); d.reload(); }} />}
      {list.length === 0 && !adding && <Empty title="No readings yet" action={<div className="row"><button className="btn primary" onClick={() => setAdding(true)}>Paste a reading</button><button className="btn" onClick={() => go('/start')}>Upload a PDF or screenshot</button></div>}>Paste text, or upload a PDF or screenshot and check what was read. Nothing is guessed from a scan you have not confirmed.</Empty>}
      {list.map((r) => (
        <article key={r.id} className="card">
          <div className="row between top"><div className="grow"><h2 style={{ marginBottom: '.1rem' }}><a href={`#/read/${r.id}`}>{r.title}</a></h2><p className="small muted" style={{ margin: 0 }}>{r.subject} · {Math.round(r.chars / 100) / 10}k characters{r.hasFile ? ' · from a file' : ''}</p></div>
            <button className="btn" onClick={() => go(`/read/${r.id}`)}>Open</button></div>
          <p className="small" style={{ margin: '.4rem 0 0' }}>{r.annotations} highlight{r.annotations === 1 ? '' : 's'}{r.annotations ? ` (${r.noted} with your note)` : ''} {r.hasPrompt && <Chip tone="info">prompt/rubric attached</Chip>}</p>
        </article>
      ))}
      <p className="small muted mt">To add a PDF or screenshot, use <a href="#/start">Study new material</a>: you check the extracted text page by page, then it appears here.</p>
    </div>
  );
}

function AddReading({ subjects, go, onDone }: { subjects: any[]; go: (p: string) => void; onDone: () => void }) {
  const [subject, setSubject] = useState<string>(subjects[0]?.id ?? '__new');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState(() => { try { return sessionStorage.getItem('sh.draft.newreading') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const keep = (v: string) => { setText(v); try { v ? sessionStorage.setItem('sh.draft.newreading', v) : sessionStorage.removeItem('sh.draft.newreading'); } catch { /* ignore */ } };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post('/readings', { ...(subject === '__new' ? { subjectName: name } : { subjectId: subject }), title, text });
      keep(''); onDone(); go(`/read/${r.id}`);
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <section className="card hero" aria-labelledby="add-h"><h2 id="add-h">Add a reading</h2>
      <div className="grid2">
        <Field label="Subject"><select value={subject} onChange={(e) => setSubject(e.target.value)}>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="__new">New subject…</option></select></Field>
        {subject === '__new' && <Field label="New subject name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>}
        <Field label="Title"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Chapter 3" /></Field>
      </div>
      <Field label="Text" hint="Paste the reading. It is kept exactly as pasted. Page markers like “--- Page 2 ---” let the app cite page numbers; without them it names sections (¶).">
        <textarea value={text} onChange={(e) => keep(e.target.value)} rows={10} />
      </Field>
      {err && <ErrorBox error={err} />}
      <div className="row mt-s"><button className="btn primary" disabled={busy || text.trim().length < 20 || (subject === '__new' && !name.trim())} onClick={save}>{busy ? 'Saving…' : 'Save and open'}</button></div>
    </section>
  );
}

export function Outline({ id, go }: { id: string; go: (p: string) => void }) {
  const o = useApi<any>(`/outlines/${id}`);
  const [thesis, setThesis] = useState('');
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (o.data) { setThesis(o.data.thesis ?? ''); setClaims(Object.fromEntries(o.data.sections.map((s: any) => [s.id, s.claim ?? '']))); } }, [o.data]);
  if (o.loading && !o.data) return <div className="narrow"><h1>Outline</h1><Spinner /></div>;
  if (o.error && !o.data) return <div className="narrow"><h1>Outline</h1><ErrorBox error={o.error} onRetry={o.reload} /></div>;
  const d = o.data;
  const dirty = thesis !== (d.thesis ?? '') || d.sections.some((s: any) => (claims[s.id] ?? '') !== (s.claim ?? ''));
  const save = async () => { setSaved('saving'); setErr(null); try { await patch(`/outlines/${id}`, { thesis, claims }); setSaved('saved'); o.reload(); } catch (e) { setErr(e as ApiError); setSaved('error'); } };
  const asText = () => [`${d.title}`, '', `Thesis: ${thesis || '(write your thesis)'}`, '', ...d.sections.flatMap((s: any) => [`${s.heading}`, `  Claim: ${claims[s.id] || '(write your claim)'}`, ...s.evidence.flatMap((e: any) => [`  Evidence (${e.location}): “${e.quote}”`, ...(e.note ? [`    My note: ${e.note}`] : [])]), ''])].join('\n');
  return (
    <div className="narrow">
      <p className="small muted" style={{ margin: 0 }}><a href={`#/read/${d.sourceId}`}>Back to “{d.readingTitle}”</a></p>
      <h1>{d.title}</h1>
      <p className="small muted">{d.basis}</p>
      {d.prompt && <div className="notice info small"><strong>Your {d.prompt.kind}:</strong> <span style={{ whiteSpace: 'pre-wrap' }}>{d.prompt.text}</span></div>}
      <Field label="Thesis (your argument in one or two sentences)"><textarea value={thesis} onChange={(e) => setThesis(e.target.value)} rows={2} maxLength={1500} /></Field>
      {d.sections.map((s: any, i: number) => (
        <section key={s.id} className="card">
          <h2>{i + 1}. {s.heading}</h2>
          <p className="small muted">Guiding question: {s.guidingQuestion}</p>
          <Field label="Your claim for this section"><textarea value={claims[s.id] ?? ''} onChange={(e) => setClaims({ ...claims, [s.id]: e.target.value })} rows={2} maxLength={1500} /></Field>
          {s.evidence.map((e: any) => (
            <div key={e.annotationId} className="mt-s">
              <blockquote className="quote">“{e.quote}”<div className="small muted">{e.location}{e.stillAnnotated ? '' : ' · the highlight this came from was deleted'}</div></blockquote>
              {e.note && <p className="small"><strong>My note:</strong> {e.note}</p>}
            </div>
          ))}
        </section>
      ))}
      {err && <ErrorBox error={err} onRetry={save} />}
      <div className="row"><button className="btn primary" disabled={!dirty || saved === 'saving'} onClick={save}>{saved === 'saving' ? 'Saving…' : 'Save outline'}</button>
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(asText()).then(() => setSaved('saved'), () => alert('Copy failed — select the text and copy it manually.')); }}>Copy as text</button>
        <button className="btn ghost danger" onClick={async () => { if (confirm('Delete this outline? Your highlights are not affected.')) { await fetch(`/api/outlines/${id}`, { method: 'DELETE', headers: { 'x-workspace': localStorage.getItem('sh.workspace') === 'demo' ? 'demo' : 'real' } }); go(`/read/${d.sourceId}`); } }}>Delete outline</button>
        {saved === 'saved' && !dirty && <span className="small muted" role="status">Saved</span>}</div>
    </div>
  );
}
