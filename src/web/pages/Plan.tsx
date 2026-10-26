import { useState } from 'react';
import { ApiError, del, patch, post, useApi } from '../api';
import { Chip, Empty, ErrorBox, Modal, Spinner } from '../ui';
import { ItemEditor } from './ItemEditor';

const KIND_LABEL: Record<string, string> = { test_prep: 'Test prep', homework: 'Homework', project: 'Project work' };

export function Plan({ go }: { go: (p: string) => void }) {
  const items = useApi<any[]>('/items?status=confirmed');
  const sched = useApi<any>('/schedule');
  const subjects = useApi<any[]>('/subjects');
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const reloadAll = () => { items.reload(); sched.reload(); };
  const attention = useApi<any>('/today');
  const act = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); reloadAll(); attention.reload(); } catch (e) { setErr(e as ApiError); } };

  const list = items.data ?? [];
  const open = list.filter((i) => !i.completed);
  const done = list.filter((i) => i.completed);
  const byDay = new Map<string, any[]>();
  for (const b of sched.data?.blocks ?? []) byDay.set(b.dateKey, [...(byDay.get(b.dateKey) ?? []), b]);
  const days = (sched.data?.days ?? []) as any[];
  const startExam = (it: any) => act(async () => { const r = await post('/sessions', { mode: 'exam', minutes: Math.max(10, Math.min(45, it.estimateMin ?? 20)), itemId: it.id, abandonExisting: false }); go(`/study/${r.id}`); });

  return (
    <div className="narrow">
      <div className="row between"><h1>Plan</h1><div className="row gap-s"><a className="btn" href="#/calendar">Calendar</a><button className="btn primary" onClick={() => setEditing('new')}>+ Add item</button></div></div>
      <p className="muted">Tests, quizzes, homework and projects — from your calendar or entered by hand. Your study time is fitted around them, and re-fitted whenever something changes.</p>
      {err && <ErrorBox error={err} />}

      {(attention.data?.attention?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="att"><h2 id="att">Needs your attention</h2>
          {attention.data.attention.map((a: any, i: number) => (
            <div key={i} className="upcoming"><span className="small">{a.message}</span>
              <div className="row gap-s">
                {(a.kind === 'cancelled' || a.kind === 'missing') && <><button className="btn small" onClick={() => act(() => post(`/items/${a.itemId}/ack`, { action: 'keep_manual' }))}>Keep as manual</button><button className="btn small danger" onClick={() => act(() => post(`/items/${a.itemId}/ack`, { action: 'remove' }))}>Remove</button></>}
                {a.kind === 'changed' && <button className="btn small" onClick={() => act(() => post(`/items/${a.itemId}/ack`, { action: 'accept' }))}>Got it</button>}
                {(a.kind === 'no_due' || a.kind === 'no_topics') && <button className="btn small" onClick={() => setEditing(list.find((x) => x.id === a.itemId))}>Fill in</button>}
              </div></div>))}
        </section>
      )}

      <section className="card" aria-labelledby="items-h"><h2 id="items-h">Tests, homework & projects</h2>
        {items.loading && !items.data && <Spinner />}{items.error && <ErrorBox error={items.error} onRetry={items.reload} />}
        {items.data && open.length === 0 && <Empty title="Nothing added yet" action={<button className="btn primary" onClick={() => setEditing('new')}>Add a test or assignment</button>}>Add one by hand, or <a href="#/calendar">connect your calendar</a>. Assignments that only live in Google Classroom or a school portal need to be added by hand.</Empty>}
        {open.map((i) => (
          <div className="upcoming" key={i.id}>
            <div>
              <strong>{i.title}</strong> <Chip>{i.typeLabel}</Chip>{i.source === 'calendar' && <> <Chip tone="info">from calendar</Chip></>}
              {i.syncState === 'source_cancelled' && <> <Chip tone="bad">event cancelled</Chip></>}{i.syncState === 'source_changed' && <> <Chip tone="warn">event changed</Chip></>}
              <div className="small muted">{i.subjectName ?? <span className="unknown">subject unknown</span>} · {i.dueKind === 'unknown' ? <span className="unknown">no due date</span> : i.dueLabel}{i.estimateMin ? ` · ~${i.estimateMin} min` : ''}</div>
              {['test', 'quiz', 'presentation'].includes(i.type) && <div className="small">{i.concepts.length ? <>Covers: {i.concepts.map((c: any) => c.name).join(', ')}</> : <span className="unknown">Coverage unknown{i.topicsText ? ` (event says “${i.topicsText}”)` : ''}</span>}</div>}
              {i.syncNote && <div className="small muted">{i.syncNote}</div>}
            </div>
            <div className="row gap-s" style={{ flexShrink: 0 }}>
              {i.daysLeft !== null && <span className="days-left">{i.daysLeft < 0 ? 'Past' : i.daysLeft === 0 ? 'Today' : i.daysLeft === 1 ? 'Tomorrow' : `${i.daysLeft} days`}</span>}
              {['test', 'quiz', 'presentation'].includes(i.type) && i.conceptIds.length > 0 && <button className="btn small" onClick={() => startExam(i)} title="Mixed questions on the linked topics, with feedback held until the end">Practice test</button>}
              {!['test', 'quiz', 'presentation'].includes(i.type) && <button className="btn small" onClick={() => act(() => post(`/items/${i.id}/complete`, { done: true }))}>Mark done</button>}
              <button className="btn small ghost" onClick={() => setEditing(i)}>Edit</button>
            </div>
          </div>
        ))}
        {done.length > 0 && <details><summary>{done.length} completed</summary>{done.map((i) => <div key={i.id} className="upcoming"><span className="small">✓ {i.title}</span><button className="btn small ghost" onClick={() => act(() => post(`/items/${i.id}/complete`, { done: false }))}>Undo</button></div>)}</details>}
        <p className="small muted mt-s">“Done” is your own call — a date passing never marks anything complete, and finishing homework doesn’t change what the app thinks you’ve learned.</p>
      </section>

      <section className="card" aria-labelledby="sched-h">
        <h2 id="sched-h">Study schedule</h2>
        <p className="small muted">Fitted around your calendar events, protected time, bedtime, buffers and daily limits (Settings → Availability). Busy time is subtracted — but that doesn’t mean every other minute is free. This schedule lives in the app; nothing is written to Google Calendar.</p>
        {sched.loading && !sched.data && <Spinner />}{sched.error && <ErrorBox error={sched.error} onRetry={sched.reload} />}
        {(sched.data?.shortfalls ?? []).map((s: any) => <div key={s.itemId} className="notice warn small"><strong>{s.title}:</strong> {s.missingMin} min can’t be fitted. {s.reason} Options: raise a daily limit, shorten the estimate, or start earlier.</div>)}
        {byDay.size === 0 && !sched.loading && <p className="muted">Nothing to schedule yet — confirm items with due dates to see a plan.</p>}
        {days.slice(0, 10).filter((d) => byDay.has(d.dateKey)).map((d) => (
          <div key={d.dateKey}>
            <div className="day-head"><span>{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.dateKey}T12:00:00Z`))}</span>
              <span className="small muted">{d.heavy ? 'Busy day · ' : ''}limit {d.capMin} min</span></div>
            {d.why.map((w: string, i: number) => <p key={i} className="small muted" style={{ margin: 0 }}>{w}</p>)}
            {byDay.get(d.dateKey)!.map((b: any, i: number) => <p key={i} style={{ margin: '.25rem 0' }}><strong>{b.startLabel}</strong> · {b.minutes} min · {b.title} <Chip>{KIND_LABEL[b.kind]}</Chip></p>)}
          </div>
        ))}
      </section>

      {editing && (
        <Modal title={editing === 'new' ? 'Add a test, assignment or project' : 'Edit item'} onClose={() => setEditing(null)}>
          <ItemEditor initial={editing === 'new' ? {} : editing} subjects={subjects.data ?? []} saveLabel={editing === 'new' ? 'Add' : 'Save'}
            onSave={async (v) => { if (editing === 'new') await post('/items', v); else await patch(`/items/${editing.id}`, v); setEditing(null); reloadAll(); attention.reload(); }}
            extra={editing !== 'new' ? <div className="row mt-s"><button type="button" className="btn small danger" onClick={async () => { if (confirm('Delete this item?')) { await del(`/items/${editing.id}`); setEditing(null); reloadAll(); } }}>Delete item</button></div> : null} />
        </Modal>
      )}
    </div>
  );
}
