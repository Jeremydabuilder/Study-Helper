import { useState } from 'react';
import { ApiError, del, post, useApi } from '../api';
import { PageTop } from './Shell';
import { greeting, toast } from './ctx';
import { openInStudyHelper } from './School';

/** "Turn messy into doable": plain rules, no AI. Splits what you typed into small steps. */
export function makePlan(text: string): string[] {
  const parts = text.split(/\n|;|,|\band then\b|\bthen\b|\band\b/i).map((s) => s.replace(/^[\s\-*•\d.)]+/, '').trim()).filter((s) => s.length > 1);
  const steps = parts.length ? parts : [text.trim()].filter(Boolean);
  return steps.slice(0, 8).map((s, i) => (i === 0 ? `Start small: ${s}` : s));
}

export function MhToday({ go, meta, name }: { go: (p: string) => void; meta: any; name: string }) {
  const st = useApi<any>('/myhelper/state');
  const [title, setTitle] = useState(''); const [cat, setCat] = useState('School'); const [when, setWhen] = useState('Today');
  const [messy, setMessy] = useState(''); const [steps, setSteps] = useState<string[]>([]);
  const d = st.data;
  const rows: any[] = d ? [
    ...d.assignments.filter((a: any) => !a.done).map((a: any) => ({ kind: 'assignment', id: a.id, title: a.title, cat: 'School', meta: a.dueLabel || 'No date', daysLeft: a.daysLeft ?? 99, a })),
    ...d.tasks.filter((t: any) => !t.done).map((t: any) => ({ kind: 'task', id: t.id, title: t.title, cat: t.category, meta: t.when, daysLeft: t.overdue ? -1 : t.when === 'Today' ? 0 : t.when === 'Tomorrow' ? 1 : 5 })),
  ].sort((x, y) => x.daysLeft - y.daysLeft).slice(0, 12) : [];
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong');
  const add = async () => { try { await post('/myhelper/tasks', { title, category: cat, when }); setTitle(''); st.reload(); } catch (e) { fail(e); } };
  const finish = async (r: any) => { try { if (r.kind === 'assignment') await post(`/items/${r.id}/complete`, { done: true }); else await post(`/myhelper/tasks/${r.id}/done`, { done: true }); st.reload(); toast('Nice — done'); } catch (e) { fail(e); } };
  const addSteps = async () => { try { for (const s of steps) await post('/myhelper/tasks', { title: s, category: 'Personal', when: 'Today' }); setSteps([]); setMessy(''); st.reload(); toast('Steps added'); } catch (e) { fail(e); } };
  const left = rows.length;
  return (<>
    <PageTop eyebrow="Today" title={greeting(name)} />
    <section className="mh-hero"><div><h3>{left === 0 ? 'Nothing waiting. Nice.' : `${left} thing${left === 1 ? '' : 's'} on your list`}</h3><p>Pick one, do the first small step, and use Study Helper for the school work.</p></div><div className="mh-orb" aria-hidden /></section>
    <div className="mh-grid">
      <section className="mh-panel" aria-label="Today’s list">
        <div className="mh-head"><div><h3>Your list</h3><div className="mh-sub">School assignments and your own tasks, soonest first.</div></div><a className="mh-text-btn" href="#/school">All assignments</a></div>
        <form className="mh-row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add(); }} style={{ marginBottom: 14 }}>
          <input aria-label="New task" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 10rem', width: 'auto' }} />
          <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 'auto' }}><option>School</option><option>Personal</option><option>Project</option></select>
          <select aria-label="When" value={when} onChange={(e) => setWhen(e.target.value)} style={{ width: 'auto' }}><option>Today</option><option>Tomorrow</option><option>This week</option></select>
          <button className="mh-primary" disabled={!title.trim()}>Add</button>
        </form>
        {st.error && !d ? <div className="mh-notice bad" role="alert">{st.error.message} <button className="mh-link-btn" onClick={st.reload}>Try again</button></div>
          : rows.length === 0 ? <div className="mh-empty">{st.loading ? 'Loading…' : 'Nothing to do right now.'}</div>
          : <div className="mh-list">{rows.map((r) => (
            <div className="mh-task" key={`${r.kind}-${r.id}`}>
              <button className="mh-check" role="checkbox" aria-checked={false} aria-label={`Mark done: ${r.title}`} onClick={() => finish(r)} />
              <span className="mh-title">{r.title}<br /><span className="mh-meta">{r.meta}</span></span>
              <span className={`mh-tag ${r.cat === 'School' ? '' : r.cat === 'Project' ? 'peach' : 'mint'}`}>{r.cat}</span>
              {r.kind === 'assignment' && <button className="mh-link-btn" onClick={async () => { if ((await openInStudyHelper(r.a, go)) === 'needs_instructions') { toast('Add its instructions in School first.'); go('/school'); } }}>Open in Study Helper</button>}
              {r.kind === 'task' && <button className="mh-link-btn mh-danger" aria-label={`Delete ${r.title}`} onClick={async () => { try { await del(`/myhelper/tasks/${r.id}`); st.reload(); } catch (e) { fail(e); } }}>Delete</button>}
            </div>))}</div>}
      </section>
      <div style={{ display: 'grid', gap: 20, alignContent: 'start' }}>
        <section className="mh-panel tint" aria-label="Projects">
          <div className="mh-head"><h3>Project pulse</h3><a className="mh-text-btn" href="#/projects">All projects</a></div>
          {(d?.projects ?? []).length === 0 ? <div className="mh-empty">No projects yet.</div> : (d.projects as any[]).slice(0, 3).map((p) => <a key={p.id} href={`#/projects/${p.id}`} className="mh-project" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}><strong>{p.name}</strong><div className="mh-progress" style={{ margin: '8px 0 4px' }} aria-hidden><span style={{ width: `${(p.stage / 5) * 100}%` }} /></div><span className="mh-meta">{p.nextAction ? `Next: ${p.nextAction}` : `Stage ${p.stage} of 5`}</span></a>)}
        </section>
        <section className="mh-panel" aria-label="Turn messy into doable">
          <div className="mh-head"><h3>Turn messy into doable</h3><span className="mh-tag warn">Rules, not AI</span></div>
          <div className="mh-field"><label htmlFor="messy">What’s on your mind?</label><textarea id="messy" value={messy} onChange={(e) => setMessy(e.target.value)} placeholder="e.g. science lab write-up, then email teacher, and pack bag" /></div>
          <button className="mh-secondary" disabled={!messy.trim()} onClick={() => setSteps(makePlan(messy))}>Break it down</button>
          {steps.length > 0 && <><ol style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol><button className="mh-primary" onClick={addSteps}>Add these to Today</button></>}
        </section>
        <section className="mh-panel" aria-label="Study Helper"><div className="mh-head"><h3>Study Helper</h3></div><p className="mh-sub" style={{ marginTop: 0 }}>{meta?.ai?.live ? 'The study assistant is ready for hints, draft checks and quizzes.' : 'Practice and reviews work; the live assistant is not available right now.'}</p><a className="mh-primary" href="#/helper" style={{ textDecoration: 'none', display: 'inline-block' }}>Open Study Helper</a></section>
      </div>
    </div>
  </>);
}
