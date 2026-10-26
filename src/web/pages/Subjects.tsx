import { useState } from 'react';
import { ApiError, del, patch, post, put, useApi, fmtDate } from '../api';
import { Chip, Empty, ErrorBox, Field, LevelChip, Modal, Spinner, SUPPORT_TEXT } from '../ui';

const SUGGESTIONS = ['Math', 'History', 'English', 'Science'];

export function Subjects({ go }: { go: (p: string) => void }) {
  const list = useApi<any[]>('/subjects');
  const [name, setName] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const add = async (n: string) => {
    setErr(null);
    try { const r = await post('/subjects', { name: n }); setName(''); go(`/subjects/${r.id}`); } catch (e) { setErr(e as ApiError); }
  };
  return (
    <div className="narrow">
      <h1>Subjects</h1>
      <p className="muted">Anything you study — start with these or add your own. You can rename or add subjects any time.</p>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Spinner />}
      {list.data?.length === 0 && <Empty title="No subjects yet">Create one below, then paste in your notes.</Empty>}
      {list.data?.map((s) => (
        <a key={s.id} href={`#/subjects/${s.id}`} className="card block" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="row between"><h2 style={{ margin: 0 }}>{s.name}</h2><span className="small muted">{s.sourceCount} material{s.sourceCount === 1 ? '' : 's'} · {s.conceptCount} concept{s.conceptCount === 1 ? '' : 's'}{s.proposedCount ? ` · ${s.proposedCount} to review` : ''}</span></div>
        </a>
      ))}
      <form className="card" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add(name.trim()); }}>
        <h2>Add a subject</h2>
        <div className="row gap-s mb-s">{SUGGESTIONS.filter((x) => !list.data?.some((s) => s.name === x)).map((x) => <button type="button" key={x} className="btn small" onClick={() => add(x)}>+ {x}</button>)}</div>
        <Field label="Or type your own"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spanish, Computer Science" maxLength={60} /></Field>
        {err && <ErrorBox error={err} />}
        <div className="row mt-s"><button className="btn primary" disabled={!name.trim()}>Add subject</button></div>
      </form>
    </div>
  );
}

const KINDS: [string, string][] = [['notes', 'Class notes'], ['review_packet', 'Review packet'], ['passage', 'Reading passage'], ['rubric', 'Rubric / grading criteria'], ['teacher_instructions', 'Teacher instructions'], ['textbook', 'Textbook excerpt'], ['other', 'Other']];

export function SubjectDetail({ id, go }: { id: string; go: (p: string) => void }) {
  const ov = useApi<any>(`/subjects/${id}`);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [viewSrc, setViewSrc] = useState<string | null>(null);
  const [newConcept, setNewConcept] = useState('');
  const d = ov.data;

  if (ov.loading && !d) return <div className="narrow"><Spinner /></div>;
  if (ov.error && !d) return <div className="narrow"><ErrorBox error={ov.error} onRetry={ov.reload} /></div>;
  if (!d) return null;
  const proposed = d.concepts.filter((c: any) => c.status === 'proposed');
  const confirmed = d.concepts.filter((c: any) => c.status === 'confirmed');
  const unassessed = confirmed.filter((c: any) => c.level === 'not_assessed');

  const run = async (label: string, fn: () => Promise<any>) => { setBusy(label); setErr(null); setMsg(null); try { return await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(null); } };
  const extract = (sid: string, useOffline = false, force = false) => run('Reading your material and finding concepts…', async () => {
    const r = await post(`/sources/${sid}/extract`, { useOffline, force });
    if (r.reused) { setMsg('Concepts were already found in this material, so nothing was re-run (that avoids paying for the same extraction twice). Use “Find again” to force it.'); return; }
    setMsg(`Found ${r.created} new concept${r.created === 1 ? '' : 's'}${r.skippedExisting ? ` (${r.skippedExisting} you already had)` : ''}${r.discardedQuotes ? `. ${r.discardedQuotes} quote${r.discardedQuotes === 1 ? '' : 's'} could not be found in your text and ${r.discardedQuotes === 1 ? 'was' : 'were'} discarded` : ''}${r.truncated ? '. Only the first part of a long text was read' : ''}${r.excludedPassages ? `. ${r.excludedPassages} passage${r.excludedPassages === 1 ? '' : 's'} that read like orders to an AI ${r.excludedPassages === 1 ? 'was' : 'were'} left out of what the AI saw (your original is unchanged — open the material to review or restore ${r.excludedPassages === 1 ? 'it' : 'them'})` : ''}${r.droppedSuspiciousConcepts ? `. ${r.droppedSuspiciousConcepts} suggested concept${r.droppedSuspiciousConcepts === 1 ? '' : 's'} that looked like an injected command ${r.droppedSuspiciousConcepts === 1 ? 'was' : 'were'} dropped` : ''}. Review them below.`);
    await ov.reload();
  });
  const bulk = (status: 'confirmed' | 'rejected') => run('Saving…', async () => { await post('/concepts/bulk', { ids: [...sel], status }); setSel(new Set()); await ov.reload(); });
  const startSession = (mode: string, conceptIds?: string[]) => run('Starting…', async () => {
    try { const r = await post('/sessions', { mode, subjectId: id, minutes: mode === 'diagnostic' ? 12 : 15, conceptIds }); go(`/study/${r.id}`); }
    catch (e) { if ((e as ApiError).code === 'session_active') { if (confirm('You have a session in progress. Resume it?')) go(`/study/${(e as ApiError).extra.sessionId}`); } else throw e; }
  });

  return (
    <div className="narrow">
      <p className="small"><a href="#/subjects">← Subjects</a></p>
      <div className="row between"><h1>{d.subject.name}</h1><button className="btn small danger" onClick={async () => { if (confirm(`Delete “${d.subject.name}” and everything in it (materials, concepts, attempts)? This cannot be undone.`)) { await del(`/subjects/${id}`); go('/subjects'); } }}>Delete subject</button></div>
      {err && <ErrorBox error={err}>{err.offlineFallback && d.sources.length > 0 && <button className="btn" onClick={() => extract(d.sources[d.sources.length - 1].id, true)}>Use basic offline extraction</button>}</ErrorBox>}
      {msg && <div className="notice good" role="status">{msg}</div>}
      {busy && <Spinner label={busy} />}

      <section className="card" aria-labelledby="mat-h">
        <div className="row between"><h2 id="mat-h">Your material</h2><button className="btn primary small" onClick={() => setAdding(true)}>+ Add material</button></div>
        {d.sources.length === 0 ? <p className="muted">Paste class notes, a review packet, a passage, or a rubric. I only use what you give me — I won’t invent what your teacher expects.</p> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {d.sources.map((s: any) => (
              <li key={s.id} className="upcoming">
                <div><strong>{s.title}</strong> <Chip>{KINDS.find((k) => k[0] === s.kind)?.[1] ?? s.kind}</Chip>{s.origin === 'sample' && <> <Chip tone="warn">sample</Chip></>}
                  <div className="small muted">{s.chars.toLocaleString()} characters · {s.chunks} passages · added {fmtDate(s.created_at)}{s.uncertain_chunks ? ` · ${s.uncertain_chunks} passages with uncertain text` : ''}</div></div>
                <div className="row gap-s"><button className="btn small" onClick={() => setViewSrc(s.id)}>View</button><button className="btn small" disabled={!!busy} onClick={() => extract(s.id)}>Find concepts</button><button className="btn small ghost" disabled={!!busy} title="Run extraction again even if concepts exist" onClick={() => extract(s.id, false, true)}>Find again</button></div>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted mt-s">PDF and image uploads (with OCR and page references) are <strong>not available yet</strong>. You can upload .txt/.md files or paste text.</p>
      </section>

      {proposed.length > 0 && (
        <section className="card" aria-labelledby="prop-h">
          <h2 id="prop-h">Check these concepts <Chip tone="warn">{proposed.length} to review</Chip></h2>
          <p className="muted small">Proposed from your material. Nothing is practised until you confirm. Edit names and summaries so they match how <em>you</em> think about the topic.</p>
          {proposed.map((c: any) => <ConceptRow key={c.id} c={c} all={d.concepts} selectable sel={sel} setSel={setSel} reload={ov.reload} />)}
          <div className="row mt-s">
            <button className="btn small" onClick={() => setSel(new Set(proposed.map((c: any) => c.id)))}>Select all</button>
            <button className="btn primary" disabled={!sel.size || !!busy} onClick={() => bulk('confirmed')}>Confirm {sel.size || ''} selected</button>
            <button className="btn" disabled={!sel.size || !!busy} onClick={() => bulk('rejected')}>Reject selected</button>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="conc-h">
        <div className="row between"><h2 id="conc-h">Concepts you’re learning</h2>
          {unassessed.length > 0 && <button className="btn primary" onClick={() => startSession('diagnostic')}>Take a short check ({Math.min(unassessed.length, 6)} Qs)</button>}</div>
        {confirmed.length === 0 ? <p className="muted">No confirmed concepts yet.{proposed.length ? ' Confirm the ones above.' : ' Add material, or add a concept by hand.'}</p> :
          confirmed.map((c: any) => <ConceptRow key={c.id} c={c} all={d.concepts} reload={ov.reload} onPractice={() => startSession('practice', [c.id])} />)}
        <form className="row mt-s" onSubmit={async (e) => { e.preventDefault(); if (!newConcept.trim()) return; await run('Adding…', async () => { await post(`/subjects/${id}/concepts`, { name: newConcept.trim() }); setNewConcept(''); await ov.reload(); }); }}>
          <input style={{ flex: 1, minWidth: 180 }} aria-label="Add a concept by hand" placeholder="Add a concept by hand (not linked to a source)" value={newConcept} onChange={(e) => setNewConcept(e.target.value)} />
          <button className="btn" disabled={!newConcept.trim()}>Add</button>
        </form>
      </section>

      {adding && <AddMaterial subjectId={id} onClose={() => setAdding(false)} onAdded={async (sid, dup) => { setAdding(false); await ov.reload(); if (dup) setMsg('You already added that exact text.'); else await extract(sid); }} />}
      {viewSrc && <SourceViewer id={viewSrc} onClose={() => setViewSrc(null)} />}
    </div>
  );
}

function ConceptRow({ c, all, selectable, sel, setSel, reload, onPractice }: any) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(c.name), [summary, setSummary] = useState(c.summary);
  const [open, setOpen] = useState(false);
  const sup = SUPPORT_TEXT[c.support];
  const save = async () => { await patch(`/concepts/${c.id}`, { name, summary }); setEdit(false); reload(); };
  return (
    <div className="task" style={{ alignItems: 'flex-start' }}>
      {selectable && <input type="checkbox" aria-label={`Select ${c.name}`} checked={sel.has(c.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(c.id) : n.delete(c.id); setSel(n); }} style={{ marginTop: 6 }} />}
      <div className="grow">
        {edit ? (
          <div className="stack"><input aria-label="Concept name" value={name} onChange={(e) => setName(e.target.value)} /><textarea aria-label="Summary" value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
            <div className="row gap-s"><button className="btn small primary" onClick={save}>Save</button><button className="btn small" onClick={() => setEdit(false)}>Cancel</button></div></div>
        ) : (
          <>
            <div className="row gap-s"><span className="task-title">{c.name}</span>{sup && <Chip tone={sup.tone} title={c.supportNote}>{sup.text}</Chip>}{c.status === 'confirmed' && <LevelChip level={c.level} />}
              {c.activeMisconceptions > 0 && <Chip tone="warn">{c.activeMisconceptions} mistake pattern{c.activeMisconceptions > 1 ? 's' : ''}</Chip>}{c.skillTag && <Chip title="Answers are checked by a deterministic math checker">math-checked</Chip>}</div>
            {c.summary && <p className="why" style={{ margin: '.2rem 0' }}>{c.summary}</p>}
            <p className="small muted" style={{ margin: '.1rem 0' }}>{c.supportNote}</p>
            {c.refs.length > 0 && <>
              <button className="btn small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'} source ({c.refs.length})</button>
              {open && c.refs.map((r: any, i: number) => <div className="quote" key={i}>“{r.quote}” <span className="muted small">— {r.label}</span></div>)}</>}
            {c.prereqIds.length > 0 && <p className="small muted" style={{ margin: '.1rem 0' }}>Builds on: {c.prereqIds.map((p: string) => all.find((x: any) => x.id === p)?.name).filter(Boolean).join(', ')}</p>}
            {c.status === 'confirmed' && c.dueAt && <p className="small muted" style={{ margin: '.1rem 0' }}>Next review: {fmtDate(c.dueAt)}{c.state && <> · {c.state.independentSuccesses} independent success{c.state.independentSuccesses === 1 ? '' : 'es'}</>}</p>}
            <div className="row gap-s">
              <button className="btn small ghost" onClick={() => setEdit(true)}>Edit</button>
              {onPractice && <button className="btn small" onClick={onPractice}>Practise this</button>}
              {c.status === 'proposed' ? <button className="btn small ghost" onClick={async () => { await patch(`/concepts/${c.id}`, { status: 'rejected' }); reload(); }}>Reject</button> : <button className="btn small ghost danger" onClick={async () => { if (confirm(`Remove “${c.name}” and its practice history?`)) { await del(`/concepts/${c.id}`); reload(); } }}>Remove</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AddMaterial({ subjectId, onClose, onAdded }: { subjectId: string; onClose: () => void; onAdded: (sourceId: string, dup: boolean) => void }) {
  const [title, setTitle] = useState(''), [kind, setKind] = useState('notes'), [text, setText] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const onFile = async (f?: File) => {
    if (!f) return;
    if (!/\.(txt|md|markdown)$/i.test(f.name) && !f.type.startsWith('text/')) { setErr(new ApiError(0, 'unsupported', 'Only .txt and .md files can be read for now. PDFs and images are not available yet — paste the text instead.')); return; }
    if (f.size > 1_000_000) { setErr(new ApiError(0, 'big', 'That file is over 1 MB. Split it into parts.')); return; }
    setText(await f.text()); if (!title) setTitle(f.name.replace(/\.[^.]+$/, '')); setErr(null);
  };
  const submit = async () => {
    setSaving(true); setErr(null);
    try { const r = await post(`/subjects/${subjectId}/sources`, { title, kind, text, origin: 'pasted' }); onAdded(r.id, r.duplicate); } catch (e) { setErr(e as ApiError); } finally { setSaving(false); }
  };
  return (
    <Modal title="Add material" onClose={onClose}>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Unit 3 review packet" maxLength={120} /></Field>
      <Field label="What is it?"><select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Paste text" hint="Tip: lines like “Term: definition”, headings, and “Page 2” markers help me find concepts and keep page references."><textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder="Paste your notes, packet, passage, or rubric here…" /></Field>
      <div className="row gap-s mt-s"><label className="btn small">Choose a .txt / .md file<input type="file" accept=".txt,.md,.markdown,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} /></label>
        <button className="btn small unavailable" disabled title="Not available yet">PDF / image upload — coming later</button></div>
      <p className="small muted mt-s">Text you add is treated as <em>content</em>, never as instructions to this app. Only the passages needed for a task are sent to an AI model, and only if you have configured one.</p>
      {err && <ErrorBox error={err} />}
      <div className="row mt"><button className="btn primary" disabled={saving || text.trim().length < 20} onClick={submit}>{saving ? 'Saving…' : 'Add and find concepts'}</button><button className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function SourceViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useApi<any>(`/sources/${id}`);
  const [err, setErr] = useState<ApiError | null>(null);
  const decide = async (flagId: string, decision: 'include' | 'exclude' | null) => { setErr(null); try { await put(`/sources/${id}/flags/${flagId}`, { decision }); await s.reload(); } catch (e) { setErr(e as ApiError); } };
  const d = s.data;
  const parts: { text: string; flag?: any }[] = [];
  if (d) { let pos = 0; for (const f of d.flags) { if (f.start < pos) continue; if (f.start > pos) parts.push({ text: d.text.slice(pos, f.start) }); parts.push({ text: d.text.slice(f.start, f.end), flag: f }); pos = f.end; } parts.push({ text: d.text.slice(pos) }); }
  return (
    <Modal title={d?.title ?? 'Material'} onClose={onClose}>
      {s.loading && !d && <Spinner />}{s.error && <ErrorBox error={s.error} onRetry={s.reload} />}{err && <ErrorBox error={err} />}
      {d && <>
        {d.flags.length > 0 && <div className="notice info small" role="status">
          <strong>{d.flags.length} passage{d.flags.length === 1 ? '' : 's'} flagged.</strong> Wording like this is sometimes an attempt to give orders to an AI, and sometimes ordinary text (a story, a lesson about AI). The check is a guess, not proof. Your original text is never changed; this only decides what an AI model is shown.
          <ul>{d.flags.map((f: any) => <li key={f.id} className="mt-s"><Chip tone={f.excludedFromAi ? 'warn' : 'neutral'}>{f.excludedFromAi ? 'left out of AI view' : 'shown to AI'}</Chip> <span className="muted">{f.label || 'text'} · {f.severity === 'strong' ? 'reads like an order to an AI' : 'contains a phrase to watch'}</span>
            <div className="quote">“{f.excerpt.length > 240 ? f.excerpt.slice(0, 240) + '…' : f.excerpt}”</div>
            <div className="row gap-s">{f.excludedFromAi ? <button className="btn small" onClick={() => decide(f.id, 'include')}>Show this to the AI</button> : <button className="btn small" onClick={() => decide(f.id, 'exclude')}>Leave this out of the AI view</button>}{f.decision && <button className="btn small ghost" onClick={() => decide(f.id, null)}>Reset to default</button>}</div></li>)}</ul>
          <p className="muted">Changes apply to future AI requests; concepts and questions already made are not rewritten.</p>
        </div>}
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '.92rem', margin: 0 }}>{parts.map((p, i) => p.flag ? <mark key={i} style={{ background: p.flag.excludedFromAi ? 'var(--warn-bg, #fde9c8)' : 'var(--info-bg, #e3eefc)' }}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</pre>
      </>}
    </Modal>
  );
}
