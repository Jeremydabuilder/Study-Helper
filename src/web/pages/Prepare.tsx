import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../api';
import { Chip, ErrorBox, Spinner } from '../ui';

const parseQ = () => new URLSearchParams((window.location.hash.split('?')[1] ?? ''));

/** The last step before studying: confirm which concepts were found in THIS material (all ticked), then start. */
export function Prepare({ sourceId, go }: { sourceId: string; go: (p: string) => void }) {
  const q = parseQ(); const goal = q.get('goal') ?? 'understand'; const minutes = Number(q.get('min')) || 20;
  const [state, setState] = useState<{ subjectId: string; concepts: any[]; title: string; confirmed: number } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>('Finding the concepts in your material…');
  const [err, setErr] = useState<ApiError | null>(null);

  const load = async () => {
    setErr(null);
    try {
      const src = await get(`/sources/${sourceId}`);
      let ov = await get(`/subjects/${src.subjectId}`);
      let mine = ov.concepts.filter((c: any) => c.sourceId === sourceId);
      if (!mine.length) { setBusy('Finding the concepts in your material…'); await post(`/sources/${sourceId}/extract`, {}); ov = await get(`/subjects/${src.subjectId}`); mine = ov.concepts.filter((c: any) => c.sourceId === sourceId); }
      const proposed = mine.filter((c: any) => c.status === 'proposed');
      setState({ subjectId: src.subjectId, concepts: proposed, title: src.title, confirmed: mine.filter((c: any) => c.status === 'confirmed').length });
      setSel(new Set(proposed.map((c: any) => c.id)));
      if (!proposed.length && mine.some((c: any) => c.status === 'confirmed')) await begin(src.subjectId, []); // nothing left to confirm: go straight to studying
    } catch (e) { setErr(e as ApiError); } finally { setBusy(null); }
  };
  useEffect(() => { load(); }, [sourceId]); // eslint-disable-line

  const begin = async (subjectId: string, rejected: string[]) => {
    setBusy('Starting your session…'); setErr(null);
    try {
      if (rejected.length) await post('/concepts/bulk', { ids: rejected, status: 'rejected' });
      const body = { goal, minutes, subjectId, sourceId: goal === 'understand' ? sourceId : null };
      let r;
      try { r = await post('/sessions', body); }
      catch (e) { if ((e as ApiError).code === 'session_active' && confirm('You have a session in progress. Start this one instead? Your answers so far are kept.')) r = await post('/sessions', { ...body, abandonExisting: true }); else throw e; }
      go(`/study/${r.id}`);
    } catch (e) { setErr(e as ApiError); setBusy(null); }
  };
  const start = async () => {
    if (!state) return;
    setBusy('Saving your choices…');
    try {
      const keep = [...sel]; if (keep.length) await post('/concepts/bulk', { ids: keep, status: 'confirmed' });
      await begin(state.subjectId, state.concepts.filter((c) => !sel.has(c.id)).map((c) => c.id));
    } catch (e) { setErr(e as ApiError); setBusy(null); }
  };

  if (busy && !state) return <div className="narrow"><Spinner label={busy} /></div>;
  if (err && !state) return <div className="narrow"><ErrorBox error={err} onRetry={load}><a className="btn" href="#/subjects">Open subjects</a></ErrorBox></div>;
  if (!state) return null;
  return (
    <div className="narrow">
      <p className="small"><a href={`#/subjects/${state.subjectId}`}>← {state.title}</a></p>
      <h1>Check what you’ll study</h1>
      <p className="muted">These concepts were found in “{state.title}”. Untick anything that isn’t a real topic. Nothing is practised until you confirm.</p>
      {err && <ErrorBox error={err} />}
      <section className="card">
        {state.concepts.length === 0 ? <p className="muted">No new concepts were found. You can add one by hand from the subject page.</p> : state.concepts.map((c) => (
          <label key={c.id} className="choice"><input type="checkbox" checked={sel.has(c.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
            <span><strong>{c.name}</strong> {c.refs?.[0] && <Chip tone="good">{c.refs[0].label}</Chip>}{c.skillTag && <> <Chip>math-checked</Chip></>}<br /><span className="small muted">{c.summary}</span></span></label>))}
      </section>
      <div className="row mt">
        <button className="btn primary big" disabled={!!busy || (!sel.size && !state.confirmed)} onClick={start}>{busy ?? `Confirm ${sel.size || ''} and start · about ${minutes} min`}</button>
        <a className="btn" href={`#/subjects/${state.subjectId}`}>Edit in the subject page</a>
      </div>
    </div>
  );
}
