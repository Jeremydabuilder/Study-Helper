import { useState } from 'react';
import { ApiError, del, patch, post, useApi } from '../api';
import { PageTop } from './Shell';
import { toast } from './ctx';

/** Open in Study Helper: the assignment's instructions become a homework workspace linked to the SAME assignment (one copy). */
export async function openInStudyHelper(a: { id: string; hasInstructions: boolean; homework: { id: string } | null }, go: (p: string) => void): Promise<'opened' | 'needs_instructions'> {
  if (!a.homework && !a.hasInstructions) return 'needs_instructions';
  try {
    const r = await post('/homework/from-item', { itemId: a.id });
    if (r.needsInstructions) return 'needs_instructions';
    go(`/homework/${r.homeworkId}`); return 'opened';
  } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open it in Study Helper.'); return 'opened'; }
}

export function School({ go }: { go: (p: string) => void }) {
  const st = useApi<any>('/myhelper/state');
  const [title, setTitle] = useState(''); const [when, setWhen] = useState('Today');
  const [edit, setEdit] = useState<any>(null); const [showDone, setShowDone] = useState(false);
  const all: any[] = st.data?.assignments ?? [];
  const open = all.filter((a) => !a.done), done = all.filter((a) => a.done);
  const add = async () => { try { await post('/myhelper/tasks', { title, category: 'School', when }); setTitle(''); st.reload(); toast('Assignment added'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add'); } };
  const toggle = async (a: any) => { try { await post(`/items/${a.id}/complete`, { done: !a.done }); st.reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update'); } };
  const openIt = async (a: any) => { if ((await openInStudyHelper(a, go)) === 'needs_instructions') setEdit({ ...a, needs: true }); };
  return (<>
    <PageTop eyebrow="Organize" title="School" />
    <section className="mh-panel" aria-label="Add an assignment">
      <form className="mh-row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add(); }}>
        <input aria-label="New assignment" placeholder="Add an assignment…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 14rem', width: 'auto' }} />
        <select aria-label="When" value={when} onChange={(e) => setWhen(e.target.value)} style={{ width: 'auto' }}><option>Today</option><option>Tomorrow</option><option>This week</option></select>
        <button className="mh-primary" disabled={!title.trim()}>Add</button>
        <button type="button" className="mh-secondary" onClick={() => setEdit({ id: null, title, dueDate: '', instructions: '' })}>Add with instructions…</button>
      </form>
    </section>
    <section className="mh-panel" style={{ marginTop: 18 }} aria-label="Assignments">
      <div className="mh-head"><div><h3>Assignments</h3><div className="mh-sub">Add the teacher’s instructions to an assignment, then open it in Study Helper to work on it.</div></div></div>
      {st.error && !st.data ? <div className="mh-notice bad" role="alert">{st.error.message} <button className="mh-link-btn" onClick={st.reload}>Try again</button></div>
        : open.length === 0 ? <div className="mh-empty">{st.loading ? 'Loading…' : 'No open assignments. Add one above.'}</div>
        : <div className="mh-list">{open.map((a) => <Row key={a.id} a={a} onToggle={() => toggle(a)} onOpen={() => openIt(a)} onEdit={() => setEdit(a)} />)}</div>}
      {done.length > 0 && <p><button className="mh-text-btn" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {done.length} finished</button></p>}
      {showDone && <div className="mh-list">{done.map((a) => <Row key={a.id} a={a} onToggle={() => toggle(a)} onOpen={() => openIt(a)} onEdit={() => setEdit(a)} />)}</div>}
    </section>
    {edit && <Editor a={edit} onClose={() => setEdit(null)} onSaved={(opened) => { setEdit(null); st.reload(); if (opened) toast('Saved'); }} go={go} />}
  </>);
}

function Row({ a, onToggle, onOpen, onEdit }: { a: any; onToggle: () => void; onOpen: () => void; onEdit: () => void }) {
  const hw = a.homework;
  return (
    <div className={`mh-task ${a.done ? 'done' : ''}`}>
      <button className="mh-check" role="checkbox" aria-checked={a.done} aria-label={`${a.done ? 'Mark not done' : 'Mark done'}: ${a.title}`} onClick={onToggle}>{a.done ? '✓' : ''}</button>
      <span className="mh-title">{a.title}<br /><span className="mh-meta">{a.dueLabel || 'No date'}{a.subjectName ? ` · ${a.subjectName}` : ''}</span></span>
      {a.daysLeft !== null && a.daysLeft < 0 && !a.done && <span className="mh-tag peach">Overdue</span>}
      {hw ? <span className="mh-tag mint">In Study Helper</span> : a.hasInstructions ? <span className="mh-tag">Instructions saved</span> : <span className="mh-tag warn">No instructions yet</span>}
      <button className="mh-link-btn" onClick={onOpen}>{hw ? 'Continue in Study Helper' : 'Open in Study Helper'}</button>
      <button className="mh-link-btn" onClick={onEdit} aria-label={`Edit ${a.title}`}>Edit</button>
    </div>
  );
}

function Editor({ a, onClose, onSaved, go }: { a: any; onClose: () => void; onSaved: (opened: boolean) => void; go: (p: string) => void }) {
  const [title, setTitle] = useState(a.title ?? ''); const [date, setDate] = useState(a.dueDate ?? ''); const [ins, setIns] = useState(a.instructions ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const body = () => ({ title, dueDate: date || null, instructions: ins, type: 'homework' });
  const save = async (andOpen: boolean) => {
    setBusy(true); setErr(null);
    try {
      let id = a.id;
      if (id) await patch(`/items/${id}`, body()); else id = (await post('/items', body())).id;
      if (andOpen) { const r = await openInStudyHelper({ id, hasInstructions: ins.trim().length >= 20, homework: a.homework ?? null }, go); if (r === 'needs_instructions') { setErr('Add the assignment’s instructions (a sentence or more) to open it in Study Helper.'); onSaved(false); return; } onSaved(true); return; }
      onSaved(true);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  const remove = async () => { if (!window.confirm('Delete this assignment? Its Study Helper homework stays.')) return; try { await del(`/items/${a.id}`); onSaved(true); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not delete.'); } };
  return (
    <div className="mh-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mh-modal" role="dialog" aria-modal="true" aria-label={a.id ? 'Edit assignment' : 'New assignment'}>
        <h3>{a.id ? 'Edit assignment' : 'New assignment'}</h3>
        <p className="lead">{a.needs ? 'This assignment has no instructions yet. Paste them, then open it in Study Helper.' : 'Instructions are copied into Study Helper when you open it there.'}</p>
        <div className="mh-field"><label htmlFor="as-t">Title</label><input id="as-t" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="mh-field"><label htmlFor="as-d">Due date</label><input id="as-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="mh-field"><label htmlFor="as-i">Instructions / questions</label><textarea id="as-i" style={{ minHeight: 160 }} value={ins} onChange={(e) => setIns(e.target.value)} placeholder="Paste the worksheet or teacher’s instructions here." /></div>
        {a.homework && ins !== a.instructions && <div className="mh-notice">Study Helper already has a homework workspace for this assignment. Changing the text here does not rewrite it.</div>}
        {err && <div className="mh-notice bad" role="alert">{err}</div>}
        <div className="mh-row end" style={{ marginTop: 14 }}>
          {a.id && <button className="mh-secondary mh-danger" onClick={remove} disabled={busy}>Delete</button>}
          <button className="mh-secondary" onClick={onClose}>Cancel</button>
          <button className="mh-secondary" onClick={() => save(false)} disabled={busy || !title.trim()}>Save</button>
          <button className="mh-primary" onClick={() => save(true)} disabled={busy || !title.trim()}>Save &amp; open in Study Helper</button>
        </div>
      </div>
    </div>
  );
}
