import { useState } from 'react';
import { download } from '../ui';
import { PageTop } from '../myhelper/Shell';
import { dayNames, newId } from '../../core/guest/extract';
import { Preferences } from '../../core/guest/types';
import { AddAssignment } from './Today';
import { exportProfile, parseExport, useGuest } from './store';

const PREF_LABEL: Record<keyof Preferences, string> = { sleepHours: 'Hours of sleep', bedtime: 'Bedtime (24h)', sessionMinutes: 'Study session (minutes)', bestTime: 'Best time to focus', weekdayStudyMinutes: 'School-day study minutes', weekendStudyMinutes: 'Weekend study minutes', trouble: 'What usually goes wrong', hardestClass: 'Hardest class', materials: 'Study materials', method: 'How I study for tests' };

/** Everything this browser holds about you, in one place: view it, change it, take a copy, or erase it. */
export function Memory({ go }: { go: (p: string) => void }) {
  const { profile, update, replace, reset, saveError, storageBroken } = useGuest();
  const [confirm, setConfirm] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [newGoal, setNewGoal] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const counts = `${profile.classes.length} classes, ${profile.assignments.length} assignments, ${profile.commitments.length} commitments, ${profile.goals.length} goals, ${profile.notes.length} notes, ${profile.cards.length} practice cards`;
  const importFile = async (f: File | undefined) => { if (!f) return; try { const p = parseExport(await f.text()); if (!window.confirm('Replace everything in this browser with the file’s profile?')) return; replace(p); setMsg('Imported.'); } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not read that file.'); } };
  const setPref = (k: keyof Preferences, v: string) => update((p) => { const next = { ...p.preferences } as Record<string, unknown>; if (!v.trim()) delete next[k]; else next[k] = ['sleepHours', 'sessionMinutes', 'weekdayStudyMinutes', 'weekendStudyMinutes'].includes(k) ? Number(v) || undefined : v; return { ...p, preferences: next as Preferences }; });
  return (<>
    <PageTop eyebrow="Saved in this browser only" title="My profile and memory" />
    {(saveError || storageBroken) && <div className="mh-notice bad" role="alert">{saveError ?? 'This browser is not saving your profile. Export a copy before you leave.'}</div>}
    <section className="mh-panel tint"><p style={{ marginTop: 0 }}>This browser holds: {counts}. <strong>No account, and no copy on the server.</strong> Exports never include your Groq key. A different browser or device has its own, empty profile. Clearing site data removes this one, so export a copy if you want to keep it.</p>
      <div className="mh-row"><button className="mh-primary" onClick={() => download('study-helper-profile.json', exportProfile(profile))}>Export a copy</button>
        <label className="mh-secondary" style={{ cursor: 'pointer' }}>Import a copy<input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => importFile(e.target.files?.[0])} aria-label="Import a profile file" /></label>
        {!confirm ? <button className="mh-secondary mh-danger" onClick={() => setConfirm(true)}>Clear everything…</button> : <span className="mh-row"><span role="alert">Erase it all from this browser, including drafts and any saved Groq key?</span><button className="mh-primary" style={{ background: '#a33', boxShadow: '0 5px 0 #722' }} onClick={() => { reset(); setConfirm(false); setMsg('Everything was erased from this browser.'); go('/'); }}>Yes, erase it</button><button className="mh-secondary" onClick={() => setConfirm(false)}>Keep it</button></span>}</div>
      {msg && <div className="mh-notice good" role="status">{msg}</div>}</section>

    <section className="mh-panel" style={{ marginTop: 16 }} aria-label="Assignments"><div className="mh-head"><h3>Assignments, tests and projects</h3></div>
      {profile.assignments.length === 0 ? <div className="mh-empty">None yet.</div> : <div className="mh-list">{profile.assignments.map((a) => (
        <div className="mh-task" key={a.id} style={{ display: 'block' }}>
          <div className="mh-row"><input type="checkbox" style={{ width: 'auto' }} checked={a.done} aria-label={`Done: ${a.title}`} onChange={(e) => update((p) => ({ ...p, assignments: p.assignments.map((x) => (x.id === a.id ? { ...x, done: e.target.checked } : x)) }))} />
            <input aria-label="Title" value={a.title} onChange={(e) => update((p) => ({ ...p, assignments: p.assignments.map((x) => (x.id === a.id ? { ...x, title: e.target.value } : x)) }))} style={{ flex: '1 1 12rem', width: 'auto' }} />
            <input aria-label="Class" value={a.className} placeholder="Class" onChange={(e) => update((p) => ({ ...p, assignments: p.assignments.map((x) => (x.id === a.id ? { ...x, className: e.target.value } : x)) }))} style={{ width: '9rem' }} />
            <input aria-label="Due date" type="date" value={a.due.date ?? ''} onChange={(e) => update((p) => ({ ...p, assignments: p.assignments.map((x) => (x.id === a.id ? { ...x, due: e.target.value ? { date: e.target.value, certainty: 'exact', reason: null, raw: x.due.raw } : { date: null, certainty: 'none', reason: null, raw: null } } : x)) }))} style={{ width: 'auto' }} />
            {a.due.certainty === 'uncertain' && <span className="mh-tag warn" title={a.due.reason ?? ''}>Date is a guess: set it to confirm</span>}
            <button className="mh-link-btn" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>Instructions</button>
            <button className="mh-link-btn mh-danger" aria-label={`Delete ${a.title}`} onClick={() => update((p) => ({ ...p, assignments: p.assignments.filter((x) => x.id !== a.id) }))}>Delete</button></div>
          {open === a.id && <div className="mh-field" style={{ marginTop: 8 }}><label htmlFor={`ins-${a.id}`}>Instructions (used to fill in homework help)</label><textarea id={`ins-${a.id}`} value={a.instructions} onChange={(e) => update((p) => ({ ...p, assignments: p.assignments.map((x) => (x.id === a.id ? { ...x, instructions: e.target.value.slice(0, 4000) } : x)) }))} /></div>}
        </div>))}</div>}</section>
    <div style={{ marginTop: 16 }}><AddAssignment /></div>

    <section className="mh-panel" style={{ marginTop: 16 }} aria-label="Classes and commitments"><div className="mh-head"><h3>Classes and commitments</h3></div>
      <div className="mh-row">{profile.classes.map((c) => <span className="mh-tag" key={c.id}>{c.name} <button className="mh-text-btn" aria-label={`Remove class ${c.name}`} onClick={() => update((p) => ({ ...p, classes: p.classes.filter((x) => x.id !== c.id) }))}>×</button></span>)}{profile.classes.length === 0 && <span className="mh-meta">No classes.</span>}</div>
      <div className="mh-list" style={{ marginTop: 12 }}>{profile.commitments.map((c) => <div className="mh-task" key={c.id}><span className="mh-title">{c.title}<br /><span className="mh-meta">{dayNames(c.days)} · {c.start}–{c.end}</span></span><button className="mh-link-btn mh-danger" aria-label={`Delete ${c.title}`} onClick={() => update((p) => ({ ...p, commitments: p.commitments.filter((x) => x.id !== c.id) }))}>Delete</button></div>)}</div></section>

    <section className="mh-panel" style={{ marginTop: 16 }} aria-label="Preferences and goals"><div className="mh-head"><h3>Preferences and goals</h3></div>
      <div className="mh-grid one" style={{ marginTop: 0 }}>{(Object.keys(PREF_LABEL) as (keyof Preferences)[]).map((k) => <div className="mh-field" key={k}><label htmlFor={`pf-${k}`}>{PREF_LABEL[k]}</label><input id={`pf-${k}`} value={profile.preferences[k] ?? ''} onChange={(e) => setPref(k, e.target.value)} placeholder="Not set" /></div>)}</div>
      <h3 style={{ marginTop: 14 }}>Goals</h3>{profile.goals.map((g) => <div className="mh-task" key={g.id} style={{ marginTop: 8 }}><span className="mh-title">{g.text}</span><span className="mh-tag">{g.origin}</span><button className="mh-link-btn mh-danger" aria-label={`Delete goal ${g.text}`} onClick={() => update((p) => ({ ...p, goals: p.goals.filter((x) => x.id !== g.id) }))}>Delete</button></div>)}
      <form className="mh-row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); if (newGoal.trim()) { update((p) => ({ ...p, goals: [...p.goals, { id: newId('g'), text: newGoal.trim().slice(0, 160), origin: 'typed' }] })); setNewGoal(''); } }}><input aria-label="New goal" placeholder="Add a goal" value={newGoal} onChange={(e) => setNewGoal(e.target.value)} style={{ flex: 1, width: 'auto' }} /><button className="mh-secondary" disabled={!newGoal.trim()}>Add</button></form></section>

    <section className="mh-panel" style={{ marginTop: 16 }} aria-label="Notes and practice"><div className="mh-head"><h3>Notes kept for hints and practice</h3></div>
      {profile.notes.length === 0 ? <div className="mh-empty">No notes saved. When you paste notes you can choose to keep them here.</div> : <div className="mh-list">{profile.notes.map((n) => <div className="mh-task" key={n.id}><span className="mh-title">{n.title}<br /><span className="mh-meta">{n.text.length.toLocaleString()} characters · {profile.cards.filter((c) => c.noteId === n.id).length} practice cards</span></span><button className="mh-link-btn mh-danger" aria-label={`Delete notes ${n.title}`} onClick={() => update((p) => ({ ...p, notes: p.notes.filter((x) => x.id !== n.id), cards: p.cards.filter((c) => c.noteId !== n.id) }))}>Delete</button></div>)}</div>}</section>
    <section className="mh-panel" style={{ marginTop: 16 }} aria-label="Interview answers"><div className="mh-head"><h3>Your answers to the questions</h3><a className="mh-text-btn" href="#/build/interview">{profile.interview.status === 'in_progress' ? 'Resume' : 'Answer more'}</a></div><div className="mh-sub">{Object.keys(profile.interview.answers).length === 0 ? 'None yet.' : `${Object.values(profile.interview.answers).filter((v) => v !== null).length} answered, ${Object.values(profile.interview.answers).filter((v) => v === null).length} skipped.`}</div></section>
  </>);
}
