import { useState } from 'react';
import { useHosted } from '../hosted';
import { ApiError, post, upload, useApi } from '../api';
import { Chip, ErrorBox, Field, Spinner } from '../ui';

const GOALS: [string, string, string][] = [
  ['test', 'Prepare for a test', 'Practise everything in the material and finish with fresh questions.'],
  ['understand', 'Understand this material', 'Find out where you stand, then practise the gaps.'],
  ['wrong', 'Review what I keep getting wrong', 'Go back to topics where recent answers were missed. No new material needed.'],
];

/** Upload or select material → choose goal and time → review only what needs a look → start. One path. */
export function StartFlow({ go }: { go: (p: string) => void }) {
  const hosted = useHosted();
  const subjects = useApi<any[]>('/subjects');
  const [goal, setGoal] = useState('understand');
  const [minutes, setMinutes] = useState(20);
  const [how, setHow] = useState<'upload' | 'paste' | 'existing'>('upload');
  const [subjectId, setSubjectId] = useState('');
  const [newName, setNewName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [existing, setExisting] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const sources = useApi<any>(subjectId ? `/subjects/${subjectId}` : null, [subjectId]);

  const subs = subjects.data ?? [];
  const needsMaterial = goal !== 'wrong';
  const hasSubject = !!subjectId || newName.trim().length > 1;
  const ready = !needsMaterial || (hasSubject && ((how === 'upload' && !!file) || (how === 'paste' && text.trim().length >= 20) || (how === 'existing' && !!existing)));
  const q = `goal=${goal}&min=${minutes}`;

  const run = async () => {
    setErr(null);
    try {
      if (goal === 'wrong') { const r = await post('/sessions', { goal: 'wrong', minutes }); go(`/study/${r.id}`); return; }
      let sid = subjectId;
      if (!sid) { setBusy('Creating the subject…'); sid = (await post('/subjects', { name: newName.trim() })).id; setSubjectId(sid); setNewName(''); } // kept, so a retry after a failed upload does not create a second subject
      if (how === 'upload' && file) { setBusy('Reading the file…'); const r = await upload(`/subjects/${sid}/files?title=${encodeURIComponent(title)}`, file); go(`/review/${r.id}?${q}`); return; }
      if (how === 'paste') { setBusy('Saving…'); const r = await post(`/subjects/${sid}/sources`, { title, text, origin: 'pasted' }); go(`/prepare/${r.id}?${q}`); return; }
      go(`/prepare/${existing}?${q}`);
    } catch (e) { setErr(e as ApiError); } finally { setBusy(null); }
  };

  return (
    <div className="narrow">
      <p className="small"><a href="#/">← Today</a></p>
      <h1>Start studying</h1>
      <p className="muted">Pick what you want, add your material, check anything that needs a look, and study. About two minutes of setup.</p>
      {err && <ErrorBox error={err} onRetry={run} />}

      <section className="card" aria-labelledby="g-h"><h2 id="g-h">1 · What do you want to do?</h2>
        {GOALS.map(([g, label, hint]) => <label key={g} className="choice"><input type="radio" name="goal" checked={goal === g} onChange={() => setGoal(g)} /> <span><strong>{label}</strong> <span className="muted small">— {hint}</span></span></label>)}
        <div className="row between mt-s"><div className="seg" role="group" aria-label="Time available">{[10, 20, 30].map((m) => <button key={m} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{m} min</button>)}</div>
          <span className="small muted">A budget for planning, not a timer.</span></div>
      </section>

      {needsMaterial && (
        <section className="card" aria-labelledby="m-h"><h2 id="m-h">2 · Your material</h2>
          <Field label="Subject"><select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); if (e.target.value) setNewName(''); }}>
            <option value="">New subject…</option>{subs.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          {!subjectId && <Field label="New subject name"><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Algebra, U.S. History" maxLength={60} /></Field>}
          <div className="seg mt-s" role="group" aria-label="How to add material">
            <button aria-pressed={how === 'upload'} onClick={() => setHow('upload')}>Upload PDF / screenshot</button>
            <button aria-pressed={how === 'paste'} onClick={() => setHow('paste')}>Paste text</button>
            <button aria-pressed={how === 'existing'} onClick={() => setHow('existing')} disabled={!subjectId}>Use what I added</button>
          </div>
          {how === 'upload' && <div className="mt-s">
            <label className="btn">Choose a PDF, PNG, JPEG or WebP<input type="file" hidden accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '')); }} /></label>
            {file && <span className="small"> {file.name} · {(file.size / 1024).toFixed(0)} KB</span>}
            <p className="small muted mt-s">{hosted ? <><strong>Your files are stored privately in your account.</strong> Text PDFs are read on the server and are not sent to the study assistant just to be read. Scanned pages and screenshots are only read automatically if the site has that turned on, and you approve what is sent each time; otherwise you type them beside the original.</> : <><strong>Files stay on this computer.</strong> Text PDFs are read locally. Scanned pages and screenshots can be read automatically only if you turn that on in Settings; you would see exactly what is sent first. Otherwise you type them beside the original.</>}</p></div>}
          {how === 'paste' && <div className="mt-s"><Field label="Title (optional)"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
            <Field label="Paste text"><textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste your notes, packet, passage, or rubric…" /></Field></div>}
          {how === 'existing' && <div className="mt-s">{sources.loading && !sources.data ? <Spinner /> :
            <Field label="Material"><select value={existing} onChange={(e) => setExisting(e.target.value)}><option value="">Choose…</option>{(sources.data?.sources ?? []).filter((x: any) => x.status !== 'draft').map((x: any) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></Field>}</div>}
        </section>)}

      <div className="row mt">
        <button className="btn primary big" disabled={!ready || !!busy} onClick={run}>{busy ?? (goal === 'wrong' ? `Start · about ${minutes} min` : 'Continue')}</button>
        {goal === 'wrong' && <Chip>No material needed</Chip>}
      </div>
    </div>
  );
}
