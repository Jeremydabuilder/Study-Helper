import { useState } from 'react';
import { ApiError, del, patch, post, useApi } from '../api';
import { PageTop } from './Shell';
import { STAGES, toast } from './ctx';

export function Projects({ go, id }: { go: (p: string) => void; id?: string }) {
  const st = useApi<any>('/myhelper/state');
  const [name, setName] = useState(''); const [desc, setDesc] = useState('');
  const list: any[] = st.data?.projects ?? [];
  const add = async () => { try { const r = await post('/myhelper/projects', { name, description: desc }); setName(''); setDesc(''); st.reload(); go(`/projects/${r.id}`); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add'); } };
  const cur = id ? list.find((p) => p.id === id) : null;
  if (id && cur) return <Detail p={cur} go={go} reload={st.reload} />;
  return (<>
    <PageTop eyebrow="Make something" title="Projects" />
    <div className="mh-grid">
      <section className="mh-panel" aria-label="Your projects">
        <div className="mh-head"><h3>Your projects</h3></div>
        {id && !st.loading && <div className="mh-notice">That project was not found.</div>}
        {list.length === 0 ? <div className="mh-empty">{st.loading ? 'Loading…' : 'No projects yet.'}</div> : list.map((p) => (
          <a key={p.id} className="mh-project" href={`#/projects/${p.id}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
            <div className="mh-row" style={{ justifyContent: 'space-between' }}><strong>{p.name}</strong><span className="mh-tag">{STAGES[p.stage - 1]}</span></div>
            {p.description && <div className="mh-sub">{p.description}</div>}
            <div className="mh-progress" style={{ marginTop: 10 }} aria-hidden><span style={{ width: `${(p.stage / 5) * 100}%` }} /></div>
            {p.nextAction && <div className="mh-meta" style={{ marginTop: 8 }}>Next: {p.nextAction}</div>}
          </a>))}
      </section>
      <section className="mh-panel tint" aria-label="New project">
        <div className="mh-head"><h3>New project</h3></div>
        <div className="mh-field"><label htmlFor="pj-n">Name</label><input id="pj-n" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="mh-field"><label htmlFor="pj-d">What is it?</label><textarea id="pj-d" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
        <button className="mh-primary" disabled={!name.trim()} onClick={add}>Add project</button>
      </section>
    </div>
  </>);
}

function Detail({ p, go, reload }: { p: any; go: (p: string) => void; reload: () => void }) {
  const [notes, setNotes] = useState(p.notes); const [next, setNext] = useState(p.nextAction);
  const save = async (b: object, msg = 'Saved') => { try { await patch(`/myhelper/projects/${p.id}`, b); reload(); toast(msg); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save'); } };
  const remove = async () => { if (!window.confirm(`Delete “${p.name}”?`)) return; try { await del(`/myhelper/projects/${p.id}`); go('/projects'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete'); } };
  return (<>
    <PageTop eyebrow="Project" title={p.name} right={<a className="mh-secondary" href="#/projects" style={{ textDecoration: 'none' }}>← All projects</a>} />
    <section className="mh-panel" aria-label="Stage">
      <div className="mh-head"><div><h3>Where it is</h3><div className="mh-sub">{p.description || 'No description yet.'}</div></div></div>
      <div className="mh-stages" role="group" aria-label="Project stage">{STAGES.map((s, i) => <button key={s} className={`mh-stage ${i + 1 < p.stage ? 'done' : i + 1 === p.stage ? 'current' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} aria-pressed={i + 1 === p.stage} onClick={() => save({ stage: i + 1 }, `Moved to ${s}`)}><span className="dot">{i + 1 < p.stage ? '✓' : i + 1}</span>{s}</button>)}</div>
      <div className="mh-row end"><button className="mh-secondary" onClick={() => save({ advance: true })}>Next stage →</button></div>
    </section>
    <div className="mh-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <section className="mh-panel"><div className="mh-field"><label htmlFor="pj-next">Next action</label><input id="pj-next" value={next} onChange={(e) => setNext(e.target.value)} placeholder="The very next small step" /></div><button className="mh-secondary" onClick={() => save({ nextAction: next })}>Save next action</button></section>
      <section className="mh-panel"><div className="mh-field"><label htmlFor="pj-notes">Notes</label><textarea id="pj-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div><button className="mh-secondary" onClick={() => save({ notes })}>Save notes</button></section>
    </div>
    <p style={{ marginTop: 18 }}><button className="mh-text-btn mh-danger" onClick={remove}>Delete this project</button></p>
  </>);
}
