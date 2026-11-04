import { useState } from 'react';
import { addDaysKey } from '../../core/time';
import { hasBasis, openAssignments } from '../../core/guest/profile';
import { interviewProgress } from '../../core/guest/interview';
import { buildPlan, fmtClock } from '../../core/guest/plan';
import { dueCards } from '../../core/guest/practice';
import { newId } from '../../core/guest/extract';
import { PageTop } from '../myhelper/Shell';
import { useGuest } from './store';

export function AddAssignment({ onAdded }: { onAdded?: () => void }) {
  const { update, today } = useGuest();
  const [title, setTitle] = useState(''); const [cls, setCls] = useState(''); const [date, setDate] = useState(''); const [type, setType] = useState<'homework' | 'test' | 'project' | 'reading'>('homework'); const [min, setMin] = useState(40); const [ins, setIns] = useState('');
  const add = () => { update((p) => ({ ...p, classes: cls.trim() && !p.classes.some((c) => c.name.toLowerCase() === cls.trim().toLowerCase()) ? [...p.classes, { id: newId('k'), name: cls.trim().slice(0, 40), origin: 'typed' }] : p.classes, assignments: [...p.assignments, { id: newId('a'), title: title.trim().slice(0, 120), className: cls.trim().slice(0, 40), type, due: date ? { date, certainty: 'exact', reason: null, raw: null } : { date: null, certainty: 'none', reason: null, raw: null }, estimateMin: min, instructions: ins.trim().slice(0, 4000), done: false, origin: 'typed', createdAt: Date.now() }] })); setTitle(''); setCls(''); setDate(''); setIns(''); onAdded?.(); };
  return (
    <form className="mh-panel" aria-label="Add an assignment by hand" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add(); }}>
      <h3>Add an assignment by hand</h3>
      <div className="mh-row" style={{ marginTop: 10 }}>
        <input aria-label="Assignment title" placeholder="What is it? e.g. Math worksheet 4" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 14rem', width: 'auto' }} />
        <input aria-label="Class" placeholder="Class" value={cls} onChange={(e) => setCls(e.target.value)} style={{ width: '9rem' }} />
        <input aria-label="Due date" type="date" min={addDaysKey(today, -30)} value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value as typeof type)} style={{ width: 'auto' }}><option value="homework">Homework</option><option value="test">Test or quiz</option><option value="project">Project or essay</option><option value="reading">Reading</option></select>
        <input aria-label="Minutes it will take" type="number" min={5} max={600} step={5} value={min} onChange={(e) => setMin(Number(e.target.value) || 0)} style={{ width: '5.5rem' }} /><span className="mh-meta">min</span></div>
      <details style={{ marginTop: 8 }}><summary className="mh-sub" style={{ cursor: 'pointer' }}>Add the instructions (for homework help)</summary><div className="mh-field" style={{ marginTop: 8 }}><label htmlFor="ga-ins">Instructions or questions</label><textarea id="ga-ins" value={ins} onChange={(e) => setIns(e.target.value)} /></div></details>
      <div className="mh-row end" style={{ marginTop: 10 }}><button className="mh-primary" disabled={!title.trim()}>Add</button></div>
    </form>);
}

export function GuestToday({ go }: { go: (p: string) => void }) {
  const { profile, update, today, status } = useGuest();
  const basis = hasBasis(profile);
  const prog = interviewProgress(profile);
  const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const plan = buildPlan(profile, today, nowMin);
  const open = openAssignments(profile);
  const due = dueCards(profile, today).length;
  const finish = (id: string) => update((p) => ({ ...p, assignments: p.assignments.map((a) => (a.id === id ? { ...a, done: true } : a)) }));
  const act = (a: ReturnType<typeof buildPlan>['blocks'][number]['action']) => a.type === 'homework' ? go(`/help?a=${a.assignmentId}`) : a.type === 'quiz' ? go(`/practice${a.assignmentId ? `?a=${a.assignmentId}` : ''}`) : a.type === 'review' ? go('/review') : undefined;
  const label = (a: ReturnType<typeof buildPlan>['blocks'][number]['action']) => a.type === 'homework' ? 'Get a hint' : a.type === 'quiz' ? 'Start practice' : a.type === 'review' ? 'Start review' : '';
  return (<>
    <PageTop eyebrow="Today" title={basis ? 'Your plan for today' : 'Welcome'} />
    {!basis && profile.interview.status !== 'skipped' && <section className="mh-hero" aria-label="Build my study profile"><div><h3>Build my study profile</h3><p>Tell Study Helper what is due and when you are busy, and it plans your day around it. Takes a few minutes, and you can skip any part.</p>
      <div className="mh-row" style={{ marginTop: 14 }}><a className="mh-primary" href="#/build/paste" style={{ textDecoration: 'none' }}>Paste notes</a><a className="mh-primary" href="#/build/interview" style={{ textDecoration: 'none' }}>Answer questions</a><button className="mh-secondary" onClick={() => update((p) => ({ ...p, interview: { ...p.interview, status: 'skipped' } }))}>Skip for now</button></div></div><div className="mh-orb" aria-hidden /></section>}
    {!basis && profile.interview.status === 'skipped' && <section className="mh-panel tint"><h3>No profile yet</h3><p className="mh-sub" style={{ fontSize: 13 }}>That is fine. Add an assignment below to get a plan, use practice and hints on their own, or <a href="#/build">build a profile</a> when you are ready.</p></section>}
    {basis && <>
      <section className="mh-panel" aria-label="Today’s plan">
        <div className="mh-head"><div><h3>{plan.blocks.length ? `${plan.plannedMin} minutes planned` : 'Nothing planned for today'}</h3><div className="mh-sub">About {plan.availableMin} minutes free to study, based on {plan.basis.join(', ')}.</div></div><a className="mh-text-btn" href="#/memory">Edit profile</a></div>
        {plan.blocks.length === 0 ? <div className="mh-empty">{plan.notes[0] ?? 'Add an assignment or some notes and your plan appears here.'}</div> : <div className="mh-list">{plan.blocks.map((b) => (
          <div className="mh-task" key={b.id} style={{ display: 'block' }}>
            <div className="mh-row"><span className="mh-tag dark">{fmtClock(b.start)}–{fmtClock(b.end)}</span><span className="mh-title" style={{ flex: '1 1 12rem' }}>{b.title}<br /><span className="mh-meta">{b.minutes} min · {b.why}</span></span>
              {b.action.type !== 'none' && <button className="mh-link-btn" onClick={() => act(b.action)}>{label(b.action)}</button>}
              {b.assignmentId && <button className="mh-link-btn" onClick={() => finish(b.assignmentId!)} aria-label={`Mark done: ${b.title}`}>Done</button>}</div>
            {b.flags.map((f, i) => <div className="mh-notice" key={i} style={{ marginTop: 6 }}>{f}</div>)}</div>))}</div>}
        {plan.later.length > 0 && <div className="mh-notice bad" role="status"><strong>Doesn’t fit today:</strong> {plan.later.map((l) => `${l.title} — ${l.why}`).join(' ')}</div>}
        {plan.notes.map((n, i) => <div className="mh-notice" key={i}>{n}</div>)}
      </section>
      <div className="mh-grid">
        <section className="mh-panel" aria-label="Coming up"><div className="mh-head"><h3>Coming up</h3></div>{open.length === 0 ? <div className="mh-empty">Nothing open.</div> : <div className="mh-list">{[...open].sort((a, b) => (a.due.date ?? '9999').localeCompare(b.due.date ?? '9999')).slice(0, 8).map((a) => <div className="mh-task" key={a.id}><span className="mh-title">{a.title}<br /><span className="mh-meta">{a.className || 'No class'} · {a.due.date ?? 'no date'}{a.due.certainty === 'uncertain' ? ' (guess)' : ''}</span></span><span className={`mh-tag ${a.type === 'test' ? 'peach' : ''}`}>{a.type}</span></div>)}</div>}</section>
        <section className="mh-panel tint" aria-label="Keep improving your plan"><div className="mh-head"><h3>Make the plan better</h3></div>
          <div className="mh-list"><a className="mh-task" href="#/build/interview" style={{ textDecoration: 'none', color: 'inherit' }}><span className="mh-title">{profile.interview.status === 'finished' && prog.remaining === 0 ? 'Questions finished' : prog.asked > 0 ? `Resume the questions (${prog.asked} done)` : 'Answer a few questions'}</span><span className="mh-link-btn">Open</span></a>
            <a className="mh-task" href="#/build/paste" style={{ textDecoration: 'none', color: 'inherit' }}><span className="mh-title">Paste more notes</span><span className="mh-link-btn">Open</span></a>
            <a className="mh-task" href="#/review" style={{ textDecoration: 'none', color: 'inherit' }}><span className="mh-title">{due ? `${due} card${due === 1 ? '' : 's'} to review` : 'Short retrieval practice'}</span><span className="mh-link-btn">Open</span></a></div></section>
      </div></>}
    <div style={{ marginTop: 18 }}><AddAssignment /></div>
    <p className="mh-meta" style={{ marginTop: 14 }}>{status?.ai.available ? 'The study assistant is on for hints and practice questions.' : 'The study assistant is not available right now. Plans, practice and review work without it.'}</p>
  </>);
}
