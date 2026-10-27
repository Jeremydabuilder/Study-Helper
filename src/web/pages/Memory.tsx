import { useState } from 'react';
import { ApiError, del, fmtDate, patch, post, useApi } from '../api';
import { Chip, Empty, ErrorBox, Field, Spinner } from '../ui';

const KIND: Record<string, { label: string; tone: 'good' | 'info' | 'warn'; help: string }> = {
  student_stated: { label: 'You told me', tone: 'good', help: 'Facts and preferences you entered.' },
  observed: { label: 'Observed once', tone: 'info', help: 'Seen in one of your actual answers. One answer can be a slip.' },
  ai_inferred: { label: 'Inferred from several answers', tone: 'warn', help: 'The same mistake showed up on different questions. Still an inference: correct or dismiss it if it is wrong.' },
};

export function Memory({ go }: { go: (p: string) => void }) {
  const m = useApi<any>('/memory');
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const d = m.data;
  const act = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); await m.reload(); } catch (e) { setErr(e as ApiError); } };
  if (m.loading && !d) return <div className="narrow"><h1>Memory</h1><Spinner /></div>;
  if (m.error && !d) return <div className="narrow"><h1>Memory</h1><ErrorBox error={m.error} onRetry={m.reload} /></div>;
  if (!d) return null;

  return (
    <div className="narrow">
      <h1>What I remember</h1>
      <p className="muted">This is the app’s own memory — it doesn’t read any chat-account memory. Everything is labelled by where it came from, and you can fix or delete any of it. Only the few items relevant to a task are sent to an AI model, never this whole page.</p>
      {err && <ErrorBox error={err} />}

      <section className="card" aria-labelledby="mine"><h2 id="mine">Notes you gave me</h2>
        {d.memories.filter((x: any) => x.kind === 'student_stated').length === 0 && <p className="muted">Nothing yet. Add things like “I have tennis most afternoons” or “I like worked examples first”.</p>}
        {d.memories.filter((x: any) => x.kind === 'student_stated').map((x: any) => <MemRow key={x.id} x={x} edit={edit} setEdit={setEdit} act={act} />)}
        <form className="mt-s" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) act(async () => { await post('/memory', { text }); setText(''); }); }}>
          <Field label="Add a note"><input value={text} onChange={(e) => setText(e.target.value)} maxLength={400} placeholder="Something I should remember about how you study" /></Field>
          <div className="mt-s"><button className="btn primary" disabled={text.trim().length < 3}>Save note</button></div>
        </form>
      </section>

      {d.memories.some((x: any) => x.kind !== 'student_stated') && (
        <section className="card" aria-labelledby="inf"><h2 id="inf">What I noticed in your answers</h2>
          <p className="small muted">These describe specific mistakes on specific topics, never you as a person. Each lists the answers behind it and what it changes. Dismiss any that are wrong: dismissed notes stop affecting your questions.</p>
          {d.memories.filter((x: any) => x.kind !== 'student_stated').map((x: any) => <MemRow key={x.id} x={x} edit={edit} setEdit={setEdit} act={act} />)}</section>
      )}

      <section className="card" aria-labelledby="mis"><h2 id="mis">Mistake patterns <Chip tone="info">observed</Chip></h2>
        <p className="small muted">Saved only when your answers showed them — each links to the answers that support it. One slip isn’t a pattern.</p>
        {d.misconceptions.length === 0 && <Empty title="None yet">Patterns appear after a mistake that points to a misunderstanding.</Empty>}
        {d.misconceptions.map((x: any) => (
          <div key={x.id} className="upcoming" style={{ display: 'block' }}>
            <div className="row between top"><div className="grow"><strong>{x.label}</strong> <span className="small muted">in {x.concept}</span> <Chip tone={x.status === 'active' ? 'warn' : 'good'}>{x.status === 'active' ? 'active' : 'repaired'}</Chip> <Chip tone={x.kind === 'ai_inferred' ? 'warn' : 'info'}>{x.kind === 'ai_inferred' ? 'AI-inferred' : 'observed'}</Chip>
              <p className="small" style={{ margin: '.2rem 0' }}>{x.description}</p>
              <p className="small muted" style={{ margin: 0 }}>Seen {x.count}× · first {fmtDate(x.firstSeenAt)} · latest {fmtDate(x.lastSeenAt)}{x.repairedAt ? ` · repaired ${fmtDate(x.repairedAt)}` : ''}</p>
              <details><summary>Evidence ({x.evidence.length} answer{x.evidence.length === 1 ? '' : 's'})</summary>{x.evidence.map((e: any) => <div key={e.attemptId} className="quote small">{fmtDate(e.at)} — {e.prompt.slice(0, 120)}<br /><span className="muted">You answered: {e.answer || '(no answer)'}{e.confidence === 3 ? ' · you were certain' : ''}</span></div>)}</details></div>
              <div className="row gap-s">
                {x.status === 'active' && <button className="btn small" onClick={() => act(() => patch(`/misconceptions/${x.id}`, { status: 'repaired' }))}>I’ve got this now</button>}
                <button className="btn small ghost" onClick={() => act(() => patch(`/misconceptions/${x.id}`, { status: 'dismissed' }))}>Not a real pattern</button>
                <button className="btn small ghost danger" onClick={() => { if (confirm('Delete this record?')) act(() => del(`/misconceptions/${x.id}`)); }}>Delete</button></div></div>
          </div>))}
      </section>

      <section className="card" aria-labelledby="sum"><h2 id="sum">Recent sessions</h2>
        {d.summaries.length === 0 ? <p className="muted">No finished sessions yet.</p> : d.summaries.map((s: any) => <p key={s.id} className="small"><strong>{fmtDate(s.at)}</strong> · {s.mode} — {s.text}</p>)}</section>
      <p className="small muted">Want to bring in or take out your study profile? Use <a href="#/settings?tab=data">Settings → Data</a>. Imports are previewed first.</p>
    </div>
  );
}

function MemRow({ x, edit, setEdit, act }: any) {
  const k = KIND[x.kind];
  const editing = edit?.id === x.id;
  return (
    <div className="upcoming" style={{ display: 'block' }}>
      <div className="row between top">
        <div className="grow">
          {editing ? <input aria-label="Edit note" value={edit.text} onChange={(e) => setEdit({ id: x.id, text: e.target.value })} maxLength={400} /> : <span>{x.text}</span>}
          {x.appMade && <AppMemoryDetail x={x} act={act} />}
          <div className="small muted"><Chip tone={k.tone} title={k.help}>{k.label}</Chip> {x.provenance?.correctedByStudent ? 'corrected by you · ' : ''}{x.provenance?.origin === 'import' ? 'imported · ' : ''}added {fmtDate(x.createdAt)}{x.updatedAt !== x.createdAt ? ` · edited ${fmtDate(x.updatedAt)}` : ''}</div>
        </div>
        <div className="row gap-s">
          {editing ? <><button className="btn small primary" onClick={() => act(async () => { await patch(`/memory/${x.id}`, { text: edit.text }); setEdit(null); })}>Save</button><button className="btn small" onClick={() => setEdit(null)}>Cancel</button></>
            : <><button className="btn small ghost" onClick={() => setEdit({ id: x.id, text: x.text })}>{x.kind === 'student_stated' ? 'Edit' : 'Correct'}</button><button className="btn small ghost danger" onClick={() => act(() => del(`/memory/${x.id}`))}>Delete</button></>}
        </div>
      </div>
    </div>
  );
}

const CHECK_TEXT: Record<string, { tone: 'good' | 'warn' | 'info'; text: string }> = {
  unchecked: { tone: 'info', text: 'Not re-checked yet' },
  improved: { tone: 'good', text: 'A later independent check suggests improvement' },
  not_improved: { tone: 'warn', text: 'It came back after an earlier good check' },
};
function AppMemoryDetail({ x, act }: { x: any; act: (fn: () => Promise<any>) => Promise<void> }) {
  const c = x.check ? CHECK_TEXT[x.check.state] : null;
  return (
    <div className="small" style={{ margin: '.3rem 0' }}>
      {x.dismissed && <p className="unknown">Dismissed by you — this no longer affects your questions.</p>}
      <div className="row gap-s">{c && <Chip tone={c.tone}>{c.text}{x.check.at ? ` · ${fmtDate(x.check.at)}` : ''}</Chip>}{x.check?.state === 'improved' && <span className="muted">That is one good answer, not proof it is learned; the later review still runs.</span>}</div>
      {x.effect && <p className="muted" style={{ margin: '.2rem 0' }}>What this changes: {x.effect}</p>}
      <details><summary>The answers behind this ({x.evidence.length})</summary>{x.evidence.map((e: any) => <div key={e.attemptId} className="quote small">{fmtDate(e.at)} — {e.prompt.slice(0, 120)}<br /><span className="muted">You answered: {e.answer || '(no answer)'}</span></div>)}</details>
      <div className="row gap-s mt-s">{x.dismissed ? <button className="btn small" onClick={() => act(() => post(`/memory/${x.id}/status`, { status: 'active' }))}>Undo dismiss</button> : <button className="btn small ghost" onClick={() => act(() => post(`/memory/${x.id}/status`, { status: 'dismissed' }))}>This isn’t right — dismiss</button>}</div>
    </div>
  );
}
