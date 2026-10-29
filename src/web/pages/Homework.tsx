import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, del, get, patch, post, put, upload, useApi } from '../api';
import { Chip, Empty, ErrorBox, Field, Modal, Spinner, Toggle } from '../ui';

const STATUS: [string, string][] = [['not_started', 'Not started'], ['working', 'Working'], ['stuck', 'Stuck'], ['completed', 'Completed']];
const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'good'> = { not_started: 'neutral', working: 'info', stuck: 'warn', completed: 'good' };
const VERDICT: Record<string, { text: string; tone: 'good' | 'warn' | 'neutral' | 'bad' }> = { correct: { text: 'Looks correct', tone: 'good' }, needs_revision: { text: 'Needs revision', tone: 'warn' }, uncertain: { text: 'Not certain', tone: 'neutral' }, unchecked: { text: 'Not checked', tone: 'neutral' } };
const STEP_TONE: Record<string, 'good' | 'bad' | 'neutral' | 'info'> = { ok: 'good', incorrect: 'bad', unchecked: 'neutral', note: 'info' };
const STEP_TEXT: Record<string, string> = { ok: 'follows', incorrect: 'does not follow', unchecked: 'not checked', note: 'note' };
const BASIS: Record<string, string> = { source: 'From your materials', general: 'General background', mixed: 'Mixed: your materials and general background', none: 'Not based on any material', rubric: 'From the rubric', student_work: 'About your wording' };
const ACTION_LABEL: Record<string, string> = { explain_instructions: 'Explain the question', start: 'Help me start', hint: 'Hint', concept: 'Explain the idea', worked_solution: 'Worked solution', draft_help: 'Help with wording' };
const draftKey = (qid: string) => `sh.hw.work.${qid}`;
const readLocal = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLocal = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable: the text stays on the page */ } };

/* ------------------------------ list ------------------------------ */

export function HomeworkList({ go }: { go: (p: string) => void }) {
  const list = useApi<any>('/homework');
  const next = useApi<any>('/homework/next');
  if (list.loading && !list.data) return <div className="narrow"><h1>Homework</h1><Spinner /></div>;
  if (list.error && !list.data) return <div className="narrow"><h1>Homework</h1><ErrorBox error={list.error} onRetry={list.reload} /></div>;
  const all: any[] = list.data.homework;
  const drafts = all.filter((h) => h.state === 'draft'), open = all.filter((h) => h.state === 'active' && h.status !== 'completed'), done = all.filter((h) => h.status === 'completed');
  const row = (h: any) => (
    <li key={h.id} className="card" style={{ listStyle: 'none' }}>
      <div className="row between">
        <div><a href={`#/homework/${h.id}`}><strong>{h.title}</strong></a><div className="small muted">{h.subject ?? 'No subject'}{h.dueLabel ? ` · due ${h.dueLabel}` : ''}</div></div>
        <div className="row">{h.state === 'draft' ? <Chip tone="warn">Check what I found</Chip> : <Chip tone={STATUS_TONE[h.status]}>{STATUS.find((s) => s[0] === h.status)![1]}</Chip>}{h.state === 'active' && <span className="small muted">{h.done}/{h.questions} done{h.stuck ? ` · ${h.stuck} stuck` : ''}</span>}{h.assessment && <Chip tone="info">test mode</Chip>}</div>
      </div>
    </li>
  );
  return (
    <div className="narrow">
      <div className="row between"><h1>Homework</h1><button className="btn primary" onClick={() => go('/homework/new')}>Add homework</button></div>
      <p className="muted small">Add an assignment sheet, work on it with help, check your answers, and save your progress. Nothing is submitted for you.</p>
      {next.data?.task && <NextCard next={next.data} go={go} onChange={() => { next.reload(); list.reload(); }} />}
      {!all.length && <Empty title="No homework yet" action={<button className="btn primary" onClick={() => go('/homework/new')}>Add your first assignment</button>}>Paste the instructions or upload a photo or PDF of the sheet.</Empty>}
      {drafts.length > 0 && <><h2>Waiting for you to check</h2><ul className="stack" style={{ padding: 0 }}>{drafts.map(row)}</ul></>}
      {open.length > 0 && <><h2>In progress</h2><ul className="stack" style={{ padding: 0 }}>{open.map(row)}</ul></>}
      {done.length > 0 && <details><summary><h2 style={{ display: 'inline' }}>Done ({done.length})</h2></summary><ul className="stack" style={{ padding: 0 }}>{done.map(row)}</ul></details>}
    </div>
  );
}

export function NextCard({ next, go, onChange }: { next: any; go: (p: string) => void; onChange?: () => void }) {
  const t = next.task;
  return (
    <section className="card hero" aria-labelledby="hw-next">
      <h2 id="hw-next">Homework next</h2>
      <p style={{ margin: '.2rem 0' }}><strong>{t.title}</strong>, question {t.label} · about {t.minutes} min{t.dueLabel ? ` · due ${t.dueLabel}` : ''}</p>
      <p className="small muted" style={{ margin: 0 }}>{t.reason}{t.split ? ` ${t.split}` : ''} About {t.remainingMin} min of this homework are left.</p>
      {next.conflicts?.length > 0 && <div className="notice warn small" role="status"><strong>This may not all fit before the deadlines.</strong> {next.conflicts.map((c: any) => `${c.title} is about ${c.missingMin} min short`).join('; ')}. You decide what comes first{next.others?.length ? '' : ''}.</div>}
      <div className="row"><button className="btn primary" onClick={() => go(`/homework/${t.homeworkId}?q=${t.questionId}`)}>Work on it</button>
        {next.others?.length > 0 && <details className="small"><summary>Other homework</summary>{next.others.map((o: any) => <div key={o.homeworkId} className="row"><a href={`#/homework/${o.homeworkId}`}>{o.title}</a><span className="muted">{o.dueLabel ?? ''}</span><button className="btn small" onClick={async () => { await patch(`/homework/${o.homeworkId}`, { prioritize: true }); onChange?.(); }}>Do this one first</button></div>)}</details>}
      </div>
    </section>
  );
}

/* ------------------------------ new ------------------------------ */

export function NewHomework({ go }: { go: (p: string) => void }) {
  const subjects = useApi<any[]>('/subjects');
  const [subjectId, setSubjectId] = useState(''); const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [title, setTitle] = useState(''); const [text, setText] = useState(() => readLocal('sh.hw.new.text') ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  const created = useRef<string | null>(null);
  useEffect(() => { writeLocal('sh.hw.new.text', text || null); }, [text]);
  const subs = subjects.data ?? [];
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let sid = subjectId;
      if (!sid) {
        if (!newName.trim()) throw new ApiError(400, 'invalid', 'Choose a subject, or name a new one.');
        if (!created.current) created.current = (await post('/subjects', { name: newName.trim() })).id; // kept, so a retry never makes a second subject
        sid = created.current!;
      }
      if (mode === 'paste') {
        if (text.trim().length < 20) throw new ApiError(400, 'too_short', 'Paste the instructions or questions (at least a sentence).');
        const heading = title.trim() || text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 60) || 'Homework';
        const src = await post(`/subjects/${sid}/sources`, { title: heading, kind: 'teacher_instructions', text });
        const hw = await post('/homework', { sourceId: src.id, title: heading });
        writeLocal('sh.hw.new.text', null); go(`/homework/${hw.id}`);
      } else {
        if (!file) throw new ApiError(400, 'invalid', 'Choose a PDF or an image.');
        const up = await upload(`/subjects/${sid}/files?kind=teacher_instructions${title.trim() ? `&title=${encodeURIComponent(title.trim())}` : ''}`, file);
        go(`/review/${up.id}?hw=1`);
      }
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <div className="narrow">
      <h1>Add homework</h1>
      <p className="muted small">You will check what was read before anything is saved to your plan. Uploaded text is treated as the assignment’s words, never as instructions to the app.</p>
      <Field label="Subject">
        <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} aria-label="Subject"><option value="">New subject…</option>{subs.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </Field>
      {!subjectId && <Field label="New subject name"><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="For example: Algebra 1" /></Field>}
      <Field label="Title (optional)"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Worksheet 4" /></Field>
      <div className="seg" role="group" aria-label="How to add it"><button aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>Paste the instructions</button><button aria-pressed={mode === 'file'} onClick={() => setMode('file')}>Upload a PDF or photo</button></div>
      {mode === 'paste'
        ? <Field label="Instructions and questions"><textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'1. Solve for x: 2x + 3 = 11\n2. …'} /></Field>
        : <Field label="PDF or image of the assignment" hint="You will see what was read, next to the original, and fix it before continuing."><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />{file && <div className="small">Selected: {file.name}</div>}</Field>}
      {err && <ErrorBox error={err} />}
      <div className="row"><button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Working…' : 'Continue'}</button><button className="btn ghost" onClick={() => go('/homework')}>Cancel</button></div>
    </div>
  );
}

/** After a reviewed upload: turn the confirmed text into a draft assignment. */
export function HomeworkFrom({ sourceId, go }: { sourceId: string; go: (p: string) => void }) {
  const [err, setErr] = useState<ApiError | null>(null);
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; post('/homework', { sourceId }).then((r) => go(`/homework/${r.id}`), (e) => setErr(e)); }, [sourceId, go]);
  return <div className="narrow">{err ? <ErrorBox error={err} /> : <Spinner label="Finding the questions…" />}</div>;
}

/* ------------------------------ detail ------------------------------ */

export function HomeworkDetail({ id, go }: { id: string; go: (p: string) => void }) {
  const q = useApi<any>(`/homework/${id}`);
  if (q.loading && !q.data) return <div className="narrow"><Spinner /></div>;
  if (q.error && !q.data) return <div className="narrow"><ErrorBox error={q.error} onRetry={q.reload}><a href="#/homework">Back to homework</a></ErrorBox></div>;
  const hw = q.data;
  return hw.state === 'draft' ? <Review hw={hw} reload={q.reload} go={go} /> : <Workspace hw={hw} reload={q.reload} go={go} />;
}

function Review({ hw, reload, go }: { hw: any; reload: () => void; go: (p: string) => void }) {
  const subjects = useApi<any[]>('/subjects');
  const [title, setTitle] = useState(hw.title); const [kind, setKind] = useState(hw.kind);
  const [qs, setQs] = useState<{ id?: string; label: string; prompt: string; remove?: boolean }[]>(hw.questions.map((x: any) => ({ id: x.id, label: x.label, prompt: x.prompt })));
  const [due, setDue] = useState(''); const [est, setEst] = useState<string>(String(hw.estimate.minutes));
  const [plan, setPlan] = useState<string>(''); const [ackSplit, setAckSplit] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null); const [matches, setMatches] = useState<any[]>(hw.matches ?? []); const [busy, setBusy] = useState(false);
  const orig = useApi<any>(hw.original?.fileId ? `/sources/${hw.original.sourceId}/review` : null);
  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      await post(`/homework/${hw.id}/confirm`, { title, subjectId: hw.subject?.id, kind, dueDate: due || null, estMin: Number(est) || null, plan: plan || undefined, acknowledgeUnsplit: ackSplit || undefined, questions: qs.map((x) => ({ id: x.id, label: x.label, prompt: x.prompt, remove: x.remove })) });
      reload();
    } catch (e) { const a = e as ApiError; if (a.code === 'plan_match') setMatches(a.extra?.matches ?? []); setErr(a); } finally { setBusy(false); }
  };
  const visible = qs.map((x, i) => ({ x, i })).filter(({ x }) => !x.remove);
  const unreadable = (p: string) => /\[(unreadable|illegible|unclear|\?+|diagram|figure|graph|image|picture)[^\]]*\]|\[\?\]/i.test(p);
  return (
    <div className="wide-page">
      <h1>Check what I found</h1>
      <p className="muted small">I split the sheet only where it has numbers or letters. Nothing is saved to your plan until you press the button at the bottom.</p>
      <div className="grid2" style={{ alignItems: 'start' }}>
        <section className="card" aria-label="Original"><h2 style={{ marginTop: 0 }}>Original</h2>
          {hw.original?.readFromScan && <div className="notice info small">This text was read from an image or scan and can contain mistakes. Compare it with the original.</div>}
          {orig.data?.file && (orig.data.file.kind === 'pdf' ? <iframe title="Original file" src={orig.data.file.url} style={{ width: '100%', height: '40vh', border: '1px solid var(--line)', borderRadius: 6 }} /> : <img alt={`Original ${orig.data.file.name}`} src={orig.data.file.url} style={{ maxWidth: '100%', borderRadius: 6 }} />)}
          <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' }}>{hw.instructions}</pre>
        </section>
        <section className="card" aria-label="What I found">
          <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <div className="row"><span className="small muted">Subject: <strong>{hw.subject?.name}</strong></span>
            <label className="small">Kind of work <select value={kind} onChange={(e) => setKind(e.target.value)}>{['math', 'science', 'history', 'english', 'other'].map((k) => <option key={k}>{k}</option>)}</select></label></div>
          {hw.split === 'none' && <div className="notice warn small" role="status"><strong>I could not find numbered questions,</strong> so the whole text is one question. Edit it, add the questions yourself, or confirm that it is a single question.<label className="row"><input type="checkbox" checked={ackSplit} onChange={(e) => setAckSplit(e.target.checked)} /> It is a single question</label></div>}
          <h2>Questions</h2>
          {visible.map(({ x, i }) => (
            <div key={x.id ?? `n${i}`} className="stack">
              <div className="row"><label className="small">Label <input aria-label={`Label of question ${x.label}`} style={{ width: '4rem' }} value={x.label} onChange={(e) => setQs(qs.map((y, j) => j === i ? { ...y, label: e.target.value } : y))} /></label>
                <button className="btn small ghost danger" onClick={() => setQs(qs.map((y, j) => j === i ? { ...y, remove: true } : y))}>Remove</button>
                {unreadable(x.prompt) && <Chip tone="warn">Part could not be read: fix it or check the original</Chip>}</div>
              <textarea rows={Math.min(8, Math.max(2, x.prompt.split('\n').length + 1))} aria-label={`Text of question ${x.label}`} value={x.prompt} onChange={(e) => setQs(qs.map((y, j) => j === i ? { ...y, prompt: e.target.value } : y))} />
            </div>))}
          <button className="btn small" onClick={() => setQs([...qs, { label: String(visible.length + 1), prompt: '' }])}>Add a question</button>
          <h2>Due date</h2>
          {hw.dueHints.length > 0 && <div className="notice info small">{hw.dueHints.map((d: any, i: number) => <div key={i}>The sheet says “{d.quote}”. {d.date ? <><button className="btn small" onClick={() => setDue(d.date)}>Use {d.date}</button> {d.note}</> : d.note}</div>)}</div>}
          <Field label="Due date (leave empty if you do not know)"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Time you expect to need (minutes)" hint={hw.estimate.basis}><input type="number" min={1} max={1200} value={est} onChange={(e) => setEst(e.target.value)} /></Field>
          {matches.length > 0 && <fieldset className="notice warn"><legend>Is this already in your Plan?</legend>
            {matches.map((m: any) => <label key={m.id} className="row"><input type="radio" name="plan" checked={plan === m.id} onChange={() => setPlan(m.id)} /> Attach to “{m.title}” ({m.dueLabel})</label>)}
            <label className="row"><input type="radio" name="plan" checked={plan === 'new'} onChange={() => setPlan('new')} /> No, add it as a separate entry</label></fieldset>}
          {err && <ErrorBox error={err} />}
          <div className="row"><button className="btn primary big" disabled={busy || !visible.length} onClick={confirm}>{busy ? 'Saving…' : 'Looks right: start this homework'}</button>
            <button className="btn ghost danger" onClick={async () => { await del(`/homework/${hw.id}`); go('/homework'); }}>Discard</button></div>
        </section>
      </div>
    </div>
  );
}

/** Minutes of real activity: only while the page is visible and the student typed, clicked or scrolled in the last minute. */
function useActiveTime(hwId: string, qid: string | null) {
  const last = useRef(Date.now()); const acc = useRef(0); const qref = useRef(qid); qref.current = qid;
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    const evs = ['keydown', 'pointerdown', 'scroll', 'input'] as const; evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const tick = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - last.current < 60_000) acc.current += 1; }, 1000);
    const flush = () => { if (acc.current >= 20) { const m = acc.current / 60; acc.current = 0; void post(`/homework/${hwId}/time`, { minutes: m, questionId: qref.current ?? undefined }).catch(() => { /* time is only a convenience */ }); } };
    const f = setInterval(flush, 60_000); document.addEventListener('visibilitychange', flush);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(tick); clearInterval(f); document.removeEventListener('visibilitychange', flush); flush(); };
  }, [hwId]);
}

function Workspace({ hw, reload, go }: { hw: any; reload: () => void; go: (p: string) => void }) {
  const focus = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q');
  const [open, setOpen] = useState<string | null>(focus ?? hw.questions.find((x: any) => x.status !== 'completed')?.id ?? hw.questions[0]?.id ?? null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [finish, setFinish] = useState<any>(null);
  const orig = useApi<any>(hw.original?.fileId ? `/sources/${hw.original.sourceId}/review` : null);
  useActiveTime(hw.id, open);
  const s = hw.summary;
  return (
    <div className="wide-page">
      <div className="row between"><div><h1 style={{ marginBottom: 0 }}>{hw.title}</h1><div className="small muted">{hw.subject?.name}{hw.plan?.dueLabel ? ` · due ${hw.plan.dueLabel}` : ' · no due date set'} · about {hw.estMin ?? '?'} min · {hw.activeMinutes} min of active work so far</div></div>
        <div className="row"><Chip tone={STATUS_TONE[hw.status]}>{STATUS.find((x) => x[0] === hw.status)![1]}</Chip>
          {hw.status === 'completed' ? <button className="btn small" onClick={async () => { await post(`/homework/${hw.id}/reopen`); reload(); }}>Reopen</button> : <button className="btn small" onClick={async () => { try { await post(`/homework/${hw.id}/complete`, {}); reload(); } catch (e) { if ((e as ApiError).code === 'unfinished') setFinish((e as ApiError).extra.open); else setErr(e as ApiError); } }}>I’m done with this homework</button>}</div></div>
      <div className="notice info small" role="status"><strong>{s.text}</strong> {s.note} Marking something completed is your own decision; it does not mean it was found correct, and it is not saved as something you know.</div>
      <Toggle checked={hw.assessment} onChange={async (v) => { await post(`/homework/${hw.id}/assessment`, { on: v }); reload(); }} label="This is a test or quiz in progress" hint="While on, I only explain general concepts. I will not look at the questions or your answers." />
      {hw.assessment && <div className="notice warn small" role="status">Test mode is on: hints, solutions and checking are off. Ask about a concept only.</div>}
      {err && <ErrorBox error={err} />}
      {finish && <Modal title="Some questions are not completed" onClose={() => setFinish(null)}><p>Question{finish.length === 1 ? '' : 's'} {finish.join(', ')} {finish.length === 1 ? 'is' : 'are'} not marked completed. Finish {finish.length === 1 ? 'it' : 'them'}, or mark the homework done anyway.</p>
        <div className="row"><button className="btn primary" onClick={async () => { await post(`/homework/${hw.id}/complete`, { force: true }); setFinish(null); reload(); }}>Mark done anyway</button><button className="btn" onClick={() => setFinish(null)}>Keep working</button></div></Modal>}
      <div className="grid2" style={{ alignItems: 'start' }}>
        <aside className="card" aria-label="Original assignment" style={{ position: 'sticky', top: '.5rem', maxHeight: '88vh', overflow: 'auto' }}>
          <h2 style={{ marginTop: 0 }}>Original assignment</h2>
          {orig.data?.file && (orig.data.file.kind === 'pdf' ? <iframe title="Original file" src={orig.data.file.url} style={{ width: '100%', height: '45vh', border: '1px solid var(--line)', borderRadius: 6 }} /> : <img alt={`Original ${orig.data.file.name}`} src={orig.data.file.url} style={{ maxWidth: '100%', borderRadius: 6 }} />)}
          <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{hw.instructions}</pre>
          <Rubric hw={hw} reload={reload} />
        </aside>
        <div className="stack">
          {hw.questions.map((x: any) => <QuestionCard key={x.id} hw={hw} q={x} open={open === x.id} onOpen={() => setOpen(open === x.id ? null : x.id)} reload={reload} go={go} />)}
          <details className="small"><summary>More</summary><div className="row"><label>Time estimate (minutes) <input type="number" min={1} max={1200} defaultValue={hw.estMin ?? ''} onBlur={async (e) => { const v = Number(e.target.value); if (v > 0 && v !== hw.estMin) { await patch(`/homework/${hw.id}`, { estMin: v }); reload(); } }} style={{ width: '6rem' }} /></label>
            <button className="btn small" onClick={async () => { await patch(`/homework/${hw.id}`, { prioritize: true }); reload(); }}>Do this one first</button>
            <button className="btn small danger" onClick={async () => { if (window.confirm('Delete this homework, your working and the help history? The Plan entry stays.')) { await del(`/homework/${hw.id}`); go('/homework'); } }}>Delete homework</button></div>
            <p className="muted">{hw.estimate.basis}</p></details>
        </div>
      </div>
    </div>
  );
}

function Rubric({ hw, reload }: { hw: any; reload: () => void }) {
  const subjectSources = useApi<any>(`/subjects/${hw.subject?.id}`);
  const rubrics = (subjectSources.data?.sources ?? []).filter((s: any) => s.kind === 'rubric');
  if (!rubrics.length && !hw.rubric) return <p className="small muted">A rubric or the teacher’s grading guide can be used for feedback: add it to this subject as a “rubric” material, then pick it here.</p>;
  return <Field label="Rubric to use for feedback"><select value={hw.rubric?.sourceId ?? ''} onChange={async (e) => { await put(`/homework/${hw.id}/rubric`, { sourceId: e.target.value || null }); reload(); }}><option value="">None</option>{rubrics.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field>;
}

function QuestionCard({ hw, q, open, onOpen, reload, go }: { hw: any; q: any; open: boolean; onOpen: () => void; reload: () => void; go: (p: string) => void }) {
  const a = q.assistance;
  const v = q.lastCheck ? VERDICT[q.lastCheck.verdict] : null;
  return (
    <section className="card" aria-label={`Question ${q.label}`}>
      <button className="btn ghost" style={{ width: '100%', textAlign: 'left' }} aria-expanded={open} onClick={onOpen}>
        <span className="row between"><strong>Question {q.label}</strong>
          <span className="row"><Chip tone={STATUS_TONE[q.status]}>{STATUS.find((x) => x[0] === q.status)![1]}</Chip>
            {v && <Chip tone={v.tone} title={q.lastCheck.forCurrentWork ? 'From a check of your current working' : 'Your working changed since this check'}>{v.text}{q.lastCheck.forCurrentWork ? '' : ' (old)'}</Chip>}
            {!a.independent && <Chip tone="neutral">{a.label}</Chip>}</span></span>
        {!open && <span className="small muted" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{q.prompt.slice(0, 140)}{q.prompt.length > 140 ? '…' : ''}</span>}
      </button>
      {open && <QuestionBody hw={hw} q={q} reload={reload} go={go} />}
    </section>
  );
}

function QuestionBody({ hw, q, reload, go }: { hw: any; q: any; reload: () => void; go: (p: string) => void }) {
  const [text, setText] = useState<string>(() => { const d = readLocal(draftKey(q.id)); return d !== null && d !== (q.work?.text ?? '') ? d : q.work?.text ?? ''; });
  const restored = useRef(readLocal(draftKey(q.id)) !== null && readLocal(draftKey(q.id)) !== (q.work?.text ?? ''));
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved' | 'conflict'>(restored.current ? 'unsaved' : 'saved');
  const [version, setVersion] = useState<number | undefined>(q.work?.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(text); latest.current = text;
  const [log, setLog] = useState<any[]>([]); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<ApiError | null>(null);
  const [chk, setChk] = useState<any>(null); const [ask, setAsk] = useState(''); const [confirmWorked, setConfirmWorked] = useState(false);
  const [challenge, setChallenge] = useState<any>(null); const [stuckNote, setStuckNote] = useState<string | null>(null);
  const histories = useApi<any>(`/homework/questions/${q.id}/help`, [q.id]);
  const checks = useApi<any>(`/homework/questions/${q.id}/checks`, [q.id]);
  useEffect(() => { if (histories.data) setLog(histories.data.help); }, [histories.data]);
  useEffect(() => { if (checks.data && !chk) setChk(checks.data.checks[0] ?? null); }, [checks.data, chk]);

  const save = useCallback(async () => {
    const t = latest.current; setSaveState('saving');
    try { const r = await put(`/homework/questions/${q.id}/work`, { text: t, baseVersion: version }); setVersion(r.saved ? r.version : r.version || undefined); writeLocal(draftKey(q.id), null); setSaveState(latest.current === t ? 'saved' : 'unsaved'); if (r.saved) reload(); }
    catch (e) { setSaveState((e as ApiError).code === 'conflict' ? 'conflict' : 'unsaved'); if ((e as ApiError).code !== 'conflict') setErr(e as ApiError); }
  }, [q.id, version, reload]);
  const onChange = (t: string) => { setText(t); writeLocal(draftKey(q.id), t); setSaveState('unsaved'); clearTimeout(timer.current); timer.current = setTimeout(save, 1200); };
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = async () => { clearTimeout(timer.current); if (saveState === 'unsaved') await save(); };

  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(null); try { await flush(); await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(null); } };
  const help = (action: string, extra: object = {}) => run(ACTION_LABEL[action], async () => { const r = await post(`/homework/questions/${q.id}/help`, { action, ask: ask.trim() || undefined, ...extra }); setLog((l) => [...l, { ...r, at: Date.now() }]); reload(); });
  const doCheck = (recheck = false) => run('Checking', async () => { const r = await post(`/homework/questions/${q.id}/check`, { recheck }); if (r.unavailable) setErr(new ApiError(409, 'unavailable', r.message)); else { setChk(r); checks.reload(); reload(); } });
  const setStatus = async (status: string, note?: string) => { await post(`/homework/questions/${q.id}/status`, { status, note }); setStuckNote(null); reload(); };
  const hintCount = log.filter((l) => l.action === 'hint').length;
  const blocked = q.blockedUntilLooked;

  return (
    <div className="stack">
      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{q.prompt}</pre>
      {q.masked && <div className="notice info small">Part of this question looked like an instruction to the app, so it is left out of what the assistant sees.</div>}
      {q.unreadable && <div className="notice warn small" role="status"><strong>Part of this question could not be read{/diagram|figure|graph|image|picture/i.test(q.prompt) ? ' (it has a diagram or picture)' : ''}.</strong> Compare with the original on the left. {q.acknowledged ? 'You said you looked at it.' : <>Fix the text above, or <button className="btn small" onClick={async () => { await patch(`/homework/questions/${q.id}`, { acknowledge: true }); reload(); }}>I have looked at the original and the text is complete</button></>}</div>}
      <div className="seg" role="group" aria-label={`Status of question ${q.label}`}>{STATUS.map(([k, label]) => <button key={k} aria-pressed={q.status === k} onClick={() => k === 'stuck' ? setStuckNote('') : setStatus(k)}>{label}</button>)}</div>
      {stuckNote !== null && <div className="row"><input aria-label="What are you stuck on? (optional)" placeholder="What are you stuck on? (optional)" value={stuckNote} onChange={(e) => setStuckNote(e.target.value)} /><button className="btn small primary" onClick={() => setStatus('stuck', stuckNote)}>Mark stuck</button></div>}
      <Field label={`Your working for question ${q.label}`} hint={hw.kind === 'math' || q.kind === 'math' ? 'Write one step per line. The app checks each line against the one before.' : undefined}>
        <textarea rows={7} value={text} onChange={(e) => onChange(e.target.value)} onBlur={flush} disabled={hw.assessment} />
      </Field>
      <div className="row small muted save-status" role="status" aria-live="polite">
        {saveState === 'saved' && <span>Saved{q.work ? ` (version ${q.work.version}${q.work.origin === 'photo' ? ', from a photo you reviewed' : ''})` : ''}</span>}
        {saveState === 'saving' && <span>Saving…</span>}
        {saveState === 'unsaved' && <span>{restored.current ? 'Restored text that was not saved yet. ' : ''}Not saved yet <button className="btn small" onClick={save}>Save now</button></span>}
        {saveState === 'conflict' && <span className="notice warn">This question changed in another window. Your text is kept below; reload to see the newer version. <button className="btn small" onClick={reload}>Reload</button></span>}
      </div>
      <div><button className="btn small ghost" onClick={() => go(`/homework/photo/${hw.id}/${q.id}`)}>Add working from a photo</button></div>
      {err && <ErrorBox error={err} />}
      {blocked && <div className="notice warn small">Help and checking start once you have looked at the unreadable part.</div>}
      <div className="row" role="group" aria-label="Help">
        <button className="btn" disabled={!!busy || hw.assessment} onClick={() => help('explain_instructions')}>Explain the question</button>
        <button className="btn" disabled={!!busy || blocked || hw.assessment} onClick={() => help('start')}>Help me start</button>
        <button className="btn" disabled={!!busy || blocked || hw.assessment} onClick={() => help('hint')}>{hintCount ? 'A stronger hint' : 'Give me a hint'}</button>
        <button className="btn" disabled={!!busy || blocked || hw.assessment || !text.trim()} onClick={() => doCheck(false)}>Check my work</button>
        <button className="btn" disabled={!!busy || blocked || hw.assessment} onClick={() => setConfirmWorked(true)}>Show the worked solution</button>
        {hw.kind === 'english' && <button className="btn" disabled={!!busy || blocked || hw.assessment || !text.trim()} onClick={() => help('draft_help')}>Help with my wording</button>}
      </div>
      <div className="row"><input style={{ flex: '1 1 14rem' }} aria-label={hw.assessment ? 'Which concept do you want explained?' : 'Which idea do you want explained? (optional)'} placeholder={hw.assessment ? 'Which concept do you want explained?' : 'Which idea do you want explained? (optional)'} value={ask} onChange={(e) => setAsk(e.target.value)} />
        <button className="btn" disabled={!!busy || (hw.assessment && ask.trim().length < 3)} onClick={() => help('concept')}>Explain the idea</button></div>
      {busy && <Spinner label={`${busy}…`} />}
      {confirmWorked && <Modal title="Show the full worked solution?" onClose={() => setConfirmWorked(false)}>
        <p>This shows the whole answer. I will record that you saw it, and it will <strong>not</strong> count as showing you can do it yourself. You can try a similar question later.</p>
        <div className="row"><button className="btn primary" onClick={() => { setConfirmWorked(false); void help('worked_solution', { confirm: true }); }}>Yes, show it</button><button className="btn" onClick={() => setConfirmWorked(false)}>Not yet</button></div></Modal>}

      {log.length > 0 && <section aria-label="Help so far"><h3>Help so far</h3>
        {log.map((l, i) => <div key={l.id ?? i} className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="row small"><strong>{ACTION_LABEL[l.action]}{l.action === 'hint' || l.action === 'start' ? ` (level ${l.level})` : ''}</strong>{l.basis && l.basis !== 'none' && <Chip tone="info">{BASIS[l.basis]}</Chip>}<Chip tone={l.ai ? 'neutral' : 'good'}>{l.ai ? 'AI-written: can be wrong' : 'Not AI-written'}</Chip></div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{l.text}</div>
          {l.uncertain && <div className="small muted">Not sure about: {l.uncertain}</div>}
          {l.used?.length > 0 && <details className="small"><summary>What from your materials was used</summary><ul>{l.used.map((u: any, j: number) => <li key={j}>{u.label}</li>)}</ul></details>}
          {l.verification && <div className="small">{l.verification.verified === true ? 'The final answer was verified by the app.' : l.verification.verified === false ? 'The assistant’s steps did not reach the app’s answer, so they were not shown.' : 'The final answer could not be verified by the app.'}</div>}
          {l.action === 'worked_solution' && <div className="small">You saw this solution. <button className="btn small" onClick={async () => { try { await post(`/homework/questions/${q.id}/fresh-check`); setErr(new ApiError(200, 'ok', 'Added. A new question on this topic will be offered in Study from tomorrow.')); } catch (e) { setErr(e as ApiError); } }}>Add a later check on this topic (optional)</button></div>}
        </div>)}</section>}

      {chk && <CheckPanel chk={chk} onChallenge={() => setChallenge(chk)} />}
      {checks.data?.checks?.length > 1 && <details className="small"><summary>Earlier checks ({checks.data.checks.length - 1})</summary>{checks.data.checks.slice(1).map((c: any) => <div key={c.id}>{new Date(c.at).toLocaleString()}: {VERDICT[c.verdict].text}{c.challenge ? ' (you disputed this)' : ''}</div>)}</details>}
      {challenge && <Challenge chk={challenge} onClose={() => setChallenge(null)} onDone={(c: any) => { setChallenge(null); setChk(c); checks.reload(); reload(); }} />}
      <Topics q={q} hw={hw} reload={reload} />
    </div>
  );
}

function CheckPanel({ chk, onChallenge }: { chk: any; onChallenge: () => void }) {
  const v = VERDICT[chk.verdict];
  return (
    <section className="card" aria-label="Check result" style={{ borderColor: chk.verdict === 'correct' ? 'var(--good)' : undefined }}>
      <div className="row between"><h3 style={{ margin: 0 }}><Chip tone={v.tone}>{v.text}</Chip> {chk.forCurrentWork ? '' : <span className="small muted">for an older version of your working</span>}</h3><button className="btn small ghost" onClick={onChallenge}>I disagree</button></div>
      {chk.challenge && <div className="notice warn small">You disputed this check ({chk.challenge.reason.replace(/_/g, ' ')}){chk.challenge.note ? `: “${chk.challenge.note}”` : ''}. Treat it as uncertain. The original check is kept.</div>}
      <p style={{ margin: '.4rem 0' }}>{chk.summary}</p>
      {chk.exact && <div><h4>Line by line (exact)</h4><ol style={{ paddingLeft: '1.2rem' }}>{chk.exact.steps.map((s: any) => <li key={s.index} value={s.index}><code>{s.text}</code> <Chip tone={STEP_TONE[s.status]}>{STEP_TEXT[s.status]}</Chip> <span className="small">{s.why}</span></li>)}</ol>
        <p className="small">Final answer: {chk.exact.final.verdict === 'unverified' ? 'not verified' : chk.exact.final.verdict}. {chk.exact.final.why}</p>{chk.exact.notes.map((n: string, i: number) => <p key={i} className="small muted">{n}</p>)}</div>}
      {chk.assistant?.parts?.length > 0 && <div><h4>Comments by the assistant (an opinion; can be wrong)</h4>{chk.assistant.parts.map((p: any, i: number) => <div key={i} className="stack" style={{ marginBottom: '.6rem' }}>
        <div>“{p.excerpt}” <Chip tone={VERDICT[p.verdict]?.tone ?? 'neutral'}>{VERDICT[p.verdict]?.text ?? p.verdict}</Chip> <Chip tone="info">{BASIS[p.basis]}</Chip> {p.kind !== 'other' && <Chip tone="neutral">{p.kind}</Chip>}</div>
        <div className="small">{p.why}{p.next_action ? ` Next: ${p.next_action}` : ''}</div>{p.evidence_quote && <blockquote className="small" style={{ margin: 0 }}>From your material: “{p.evidence_quote}”</blockquote>}</div>)}
        {chk.assistant.overall && <p className="small">{chk.assistant.overall}</p>}</div>}
      {chk.quotations?.length > 0 && <div><h4>Quotations</h4><ul>{chk.quotations.map((x: any, i: number) => <li key={i}>“{x.quote}” {x.inSource === null ? 'no source to compare with' : x.inSource ? 'found word for word in your source' : <strong>not found word for word in your source</strong>}</li>)}</ul></div>}
      {chk.assistant?.suggestedEdits?.length > 0 && <div><h4>Suggested wording changes (yours stays as you wrote it)</h4><ul>{chk.assistant.suggestedEdits.map((e: any, i: number) => <li key={i}>“{e.original}” → “{e.suggestion}” <span className="small muted">{e.reason}</span></li>)}</ul></div>}
      {chk.coverage?.notChecked?.length > 0 && <div><h4>Not checked</h4><ul>{chk.coverage.notChecked.map((n: string, i: number) => <li key={i} className="small">{n}</li>)}</ul></div>}
      <p><strong>Next:</strong> {chk.nextAction}</p>
      <p className="small muted">{chk.basis} This is not your teacher’s grade.</p>
    </section>
  );
}

function Challenge({ chk, onClose, onDone }: { chk: any; onClose: () => void; onDone: (c: any) => void }) {
  const [reason, setReason] = useState('my_answer_is_right'); const [note, setNote] = useState(''); const [err, setErr] = useState<ApiError | null>(null);
  return <Modal title="Tell me what is wrong" onClose={onClose}>
    <p className="small">Your answer and this check are kept exactly as they are; your note is added to the check.</p>
    <div className="stack" role="radiogroup" aria-label="What is wrong">
      {[['my_answer_is_right', 'My answer is right'], ['the_key_is_wrong', 'The problem or answer key is wrong'], ['misread_my_work', 'You misread my work']].map(([k, l]) => <label key={k} className="row"><input type="radio" name="why" checked={reason === k} onChange={() => setReason(k)} /> {l}</label>)}
    </div>
    <Field label="Say more (optional)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    {err && <ErrorBox error={err} />}
    <div className="row"><button className="btn primary" onClick={async () => { try { onDone(await post(`/homework/checks/${chk.id}/challenge`, { reason, note })); } catch (e) { setErr(e as ApiError); } }}>Save</button><button className="btn" onClick={onClose}>Cancel</button></div>
  </Modal>;
}

function Topics({ q, hw, reload }: { q: any; hw: any; reload: () => void }) {
  const sug = useApi<any>(`/homework/questions/${q.id}/topics`, [q.id, q.concepts.length]);
  const concepts = useApi<any>(hw.subject ? `/subjects/${hw.subject.id}` : null);
  const [name, setName] = useState('');
  const mine = new Set(q.concepts.map((c: any) => c.id));
  const choices = (concepts.data?.concepts ?? []).filter((c: any) => c.status === 'confirmed');
  return (
    <details className="small"><summary>Topics this question uses {q.concepts.length ? `(${q.concepts.map((c: any) => c.name).join(', ')})` : ''}</summary>
      <p className="muted">Linking a topic lets Study ask a new question on it later. Suggestions are based on matching words only, so you decide.</p>
      <div className="row">{choices.map((c: any) => <label key={c.id} className="row"><input type="checkbox" checked={mine.has(c.id)} onChange={async (e) => { const ids = e.target.checked ? [...mine, c.id] : [...mine].filter((x) => x !== c.id); await put(`/homework/questions/${q.id}/topics`, { conceptIds: ids }); reload(); }} /> {c.name}{sug.data?.suggestions?.some((s: any) => s.id === c.id) ? ' (suggested)' : ''}</label>)}</div>
      <div className="row"><input aria-label="New topic name" placeholder="Add a topic, for example: two-step equations" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn small" disabled={name.trim().length < 2} onClick={async () => { await put(`/homework/questions/${q.id}/topics`, { newTopic: name }); setName(''); concepts.reload(); reload(); }}>Add topic</button></div>
    </details>
  );
}

/** Add working from a photo: upload, review what was read, then it becomes this question’s working. */
export function WorkPhoto({ hwId, qid, go }: { hwId: string; qid: string; go: (p: string) => void }) {
  const hw = useApi<any>(`/homework/${hwId}`);
  const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  if (!hw.data) return <div className="narrow">{hw.error ? <ErrorBox error={hw.error} /> : <Spinner />}</div>;
  return (
    <div className="narrow"><h1>Add working from a photo</h1>
      <p className="muted small">The photo is read, you correct what was read, and only then is it used as your working for question {hw.data.questions.find((x: any) => x.id === qid)?.label}. Handwriting and math can be misread: check every line.</p>
      <Field label="Photo or PDF of your working"><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      {err && <ErrorBox error={err} />}
      <div className="row"><button className="btn primary" disabled={!file || busy} onClick={async () => { setBusy(true); setErr(null); try { const up = await upload(`/subjects/${hw.data.subject.id}/files?kind=student_work&title=${encodeURIComponent(`My working for ${hw.data.title}`)}`, file!); go(`/review/${up.id}?work=${qid}&hwid=${hwId}`); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }}>{busy ? 'Uploading…' : 'Continue'}</button><button className="btn ghost" onClick={() => go(`/homework/${hwId}`)}>Cancel</button></div>
    </div>
  );
}
void get;
