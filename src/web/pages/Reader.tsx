import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, del, patch, post, put, useApi } from '../api';
import { Chip, Empty, ErrorBox, Field, Spinner } from '../ui';

export const CATEGORIES: [string, string][] = [['none', 'Uncategorised'], ['theme', 'Theme'], ['characterization', 'Characterization'], ['imagery', 'Imagery'], ['argument', 'Argument'], ['evidence', 'Evidence'], ['question', 'Question'], ['vocabulary', 'Vocabulary'], ['other', 'Other']];
const CAT_LABEL = Object.fromEntries(CATEGORIES);
const STANCE: Record<string, { tone: 'good' | 'warn' | 'info' | 'neutral'; text: string }> = {
  restates: { tone: 'warn', text: 'Mostly restates the passage' }, interprets: { tone: 'info', text: 'Interprets the passage' }, develops: { tone: 'good', text: 'Develops its own reasoning' }, not_assessed: { tone: 'neutral', text: 'Reasoning not assessed (basic check)' },
};
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const draftKey = (id: string) => `sh.draft.${id}`;
const loadDraft = (id: string) => { try { return sessionStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } };
const saveDraft = (id: string, v: string) => { try { v ? sessionStorage.setItem(draftKey(id), v) : sessionStorage.removeItem(draftKey(id)); } catch { /* private mode */ } };

function segments(text: string, anns: any[]) {
  const cuts = new Set<number>([0, text.length]);
  for (const a of anns) { cuts.add(a.start); cuts.add(a.end); }
  const pts = [...cuts].sort((x, y) => x - y);
  const out: { from: number; to: number; ids: string[]; cat: string }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i], to = pts[i + 1];
    const cover = anns.filter((a) => a.start <= from && a.end >= to);
    out.push({ from, to, ids: cover.map((a) => a.id), cat: cover[0]?.category ?? '' });
  }
  return out;
}

export function Reader({ id, go }: { id: string; go: (p: string) => void }) {
  const r = useApi<any>(`/readings/${id}`);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pane, setPane] = useState<'text' | 'notes'>('text');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const textRef = useRef<HTMLDivElement>(null);
  const data = r.data;

  // Selection → character offsets in the stored text. Each span carries its own offset, so the position is exact; the server copies the quote itself.
  useEffect(() => {
    const pos = (node: Node, off: number): number | null => {
      if (node.nodeType === 3) { const el = node.parentElement?.closest('[data-o]'); return el ? Number(el.getAttribute('data-o')) + off : null; }
      const el = node as Element;
      const child = el.childNodes[off] as Element | undefined;
      if (child?.getAttribute?.('data-o')) return Number(child.getAttribute('data-o'));
      const prev = el.childNodes[off - 1] as Element | undefined;
      if (prev?.getAttribute?.('data-o')) return Number(prev.getAttribute('data-o')) + (prev.textContent?.length ?? 0);
      return null;
    };
    const h = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount || !textRef.current) return;
      const rg = s.getRangeAt(0);
      if (!textRef.current.contains(rg.commonAncestorContainer)) return;
      const a = pos(rg.startContainer, rg.startOffset), b = pos(rg.endContainer, rg.endOffset);
      if (a == null || b == null || a === b) return;
      setSel({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    document.addEventListener('selectionchange', h);
    return () => document.removeEventListener('selectionchange', h);
  }, []);

  const anns: any[] = data?.annotations ?? [];
  const live = useMemo(() => anns.filter((a) => !a.orphaned), [anns]);
  const segs = useMemo(() => (data ? segments(data.reading.text, live) : []), [data, live]);

  if (r.loading && !data) return <div><h1>Reading</h1><Spinner /></div>;
  if (r.error && !data) return <div className="narrow"><h1>Reading</h1><ErrorBox error={r.error} onRetry={r.reload}><button className="btn" onClick={() => go('/readings')}>Back to readings</button></ErrorBox></div>;
  if (!data) return null;
  const rd = data.reading, confirmed = rd.status === 'confirmed';
  const togglePick = (aid: string) => setPicked((p) => { const n = new Set(p); n.has(aid) ? n.delete(aid) : n.add(aid); return n; });
  const open = (aid: string) => { setActive(aid); setPane('notes'); setTimeout(() => document.getElementById(`ann-${aid}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50); };

  return (
    <div className="reader-wrap">
      <div className="row between"><div><p className="small muted" style={{ margin: 0 }}><a href="#/readings">Readings</a> · {rd.subject}</p><h1 style={{ marginBottom: '.1rem' }}>{rd.title}</h1></div>
        <button className="btn ghost small" onClick={r.reload}>Refresh</button></div>
      {data.warnings.map((w: string) => <div key={w} className="notice warn small" role="status">{w}</div>)}
      <div className="seg reader-seg mb-s" role="group" aria-label="Show">
        <button aria-pressed={pane === 'text'} onClick={() => setPane('text')}>Reading</button>
        <button aria-pressed={pane === 'notes'} onClick={() => setPane('notes')}>Annotations ({anns.length})</button>
      </div>
      <div className="reader">
        <section className={`reader-text card ${pane === 'text' ? '' : 'hide-sm'}`} aria-label="Reading text">
          {confirmed ? <p className="small muted">Select text to highlight it (on a phone, press and hold a word, drag the handles, then tap “Add a note”). Tap or click a highlight to see your note. Page numbers appear only where the text has reliable page markers.</p> : null}
          {sel && confirmed && pane === 'text' && (
            <div className="sel-bar" role="region" aria-label="Selected text">
              <span className="small grow">{Math.min(99999, sel.end - sel.start)} characters selected</span>
              <button className="btn primary small" onClick={() => setPane('notes')}>Add a note</button>
              <button className="btn small" onClick={() => { setSel(null); window.getSelection()?.removeAllRanges(); }}>Clear</button>
            </div>
          )}
          <div className="reading-text" ref={textRef} tabIndex={0} aria-label={`Text of ${rd.title}`}>
            {segs.map((sg) => <span key={sg.from} data-o={sg.from} className={sg.ids.length ? `hl hl-${sg.cat || 'none'} ${sg.ids.includes(active ?? '') ? 'on' : ''}` : undefined} onClick={sg.ids.length ? () => { if (window.getSelection()?.isCollapsed) open(sg.ids[0]); } : undefined}>{rd.text.slice(sg.from, sg.to)}</span>)}
          </div>
        </section>
        <aside className={`reader-side ${pane === 'notes' ? '' : 'hide-sm'}`} aria-label="Annotations">
          {sel && confirmed && <NewHighlight key={`${sel.start}-${sel.end}`} readingId={id} text={rd.text} sel={sel} onDone={() => { setSel(null); window.getSelection()?.removeAllRanges(); r.reload(); }} onCancel={() => setSel(null)} />}
          {!sel && confirmed && anns.length === 0 && <Empty title="No highlights yet">Select a sentence in the reading, choose a category, and write what you notice. Your own words come first; help is optional.</Empty>}
          <PromptBox readingId={id} prompt={data.prompt} onChange={r.reload} />
          {anns.map((a) => <AnnotationCard key={a.id} a={a} readingId={id} ai={data.ai} active={active === a.id} picked={picked.has(a.id)} onPick={() => togglePick(a.id)} onActive={() => setActive(a.id)} onChange={r.reload} prompt={!!data.prompt} />)}
          {anns.length > 0 && <StudyPanel readingId={id} anns={anns} picked={picked} setPicked={setPicked} data={data} go={go} onChange={r.reload} />}
        </aside>
      </div>
    </div>
  );
}

function NewHighlight({ readingId, text, sel, onDone, onCancel }: { readingId: string; text: string; sel: { start: number; end: number }; onDone: () => void; onCancel: () => void }) {
  const [cat, setCat] = useState('theme');
  const [note, setNote] = useState(() => loadDraft(readingId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const quote = text.slice(sel.start, sel.end).trim();
  const save = async () => {
    setBusy(true); setErr(null);
    try { await post(`/readings/${readingId}/annotations`, { start: sel.start, end: sel.end, category: cat, note }); saveDraft(readingId, ''); onDone(); }
    catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <section className="card hero new-hl" aria-label="New highlight">
      <h2>New highlight</h2>
      <blockquote className="quote">{quote.length > 300 ? `${quote.slice(0, 300)}…` : quote}</blockquote>
      <Field label="Category"><select value={cat} onChange={(e) => setCat(e.target.value)}>{CATEGORIES.filter(([k]) => k !== 'none').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="What do you notice? (your own words)" hint="Write your reading first. You can ask for help or feedback afterwards.">
        <textarea value={note} onChange={(e) => { setNote(e.target.value); saveDraft(readingId, e.target.value); }} rows={3} maxLength={2000} />
      </Field>
      {err && <ErrorBox error={err} />}
      <div className="row mt-s"><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save highlight'}</button><button className="btn" onClick={onCancel}>Cancel</button></div>
    </section>
  );
}

function PromptBox({ readingId, prompt, onChange }: { readingId: string; prompt: any; onChange: () => void }) {
  const [text, setText] = useState(prompt?.text ?? '');
  const [kind, setKind] = useState<'prompt' | 'rubric'>(prompt?.kind ?? 'prompt');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const save = async () => { setBusy(true); setErr(null); try { text.trim() ? await put(`/readings/${readingId}/prompt`, { kind, text }) : await del(`/readings/${readingId}/prompt`); onChange(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } };
  return (
    <details className="card" open={!!prompt}>
      <summary><strong>Teacher’s prompt or rubric</strong> {prompt ? <Chip tone="info">attached</Chip> : <span className="muted small">(optional)</span>}</summary>
      <p className="small muted mt-s">Paste it exactly as written. It is used as context for feedback and chat, never as instructions to the app. The app does not guess what a teacher wants beyond this text.</p>
      <div className="row gap-s"><select value={kind} onChange={(e) => setKind(e.target.value as any)} aria-label="Type" style={{ width: 'auto' }}><option value="prompt">Assignment prompt</option><option value="rubric">Rubric</option></select></div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={6000} aria-label="Prompt or rubric text" className="mt-s" />
      {err && <ErrorBox error={err} />}
      <div className="row mt-s"><button className="btn" disabled={busy || (text === (prompt?.text ?? '') && kind === (prompt?.kind ?? 'prompt'))} onClick={save}>{text.trim() ? 'Save' : 'Remove'}</button></div>
    </details>
  );
}

function AnnotationCard({ a, readingId, ai, active, picked, onPick, onActive, onChange, prompt }: { a: any; readingId: string; ai: any; active: boolean; picked: boolean; onPick: () => void; onActive: () => void; onChange: () => void; prompt: boolean }) {
  const [note, setNote] = useState<string>(a.note);
  const [cat, setCat] = useState<string>(a.category);
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { setNote(a.note); setCat(a.category); }, [a.note, a.category]);
  const dirty = note !== a.note || cat !== a.category;
  const base = `/readings/${readingId}/annotations/${a.id}`;
  const run = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(null); try { await fn(); onChange(); } catch (e) { setErr(e as ApiError); } finally { setBusy(null); } };
  const helps = a.assists.filter((x: any) => x.kind !== 'feedback');
  const fbs = a.assists.filter((x: any) => x.kind === 'feedback');
  const fb = fbs[fbs.length - 1];
  const canFeedback = words(a.note) >= 4 && !dirty;
  return (
    <article id={`ann-${a.id}`} className={`card ann ${active ? 'on' : ''}`} onClick={onActive} aria-label={`Annotation: ${CAT_LABEL[a.category]}`}>
      <div className="row between">
        <label className="row gap-s"><input type="checkbox" checked={picked} onChange={onPick} aria-label="Select for study items or outline" /><Chip tone="info">{CAT_LABEL[a.category]}</Chip><span className="small muted">{a.location}</span></label>
        <button className="btn ghost small danger" onClick={() => { if (confirm('Delete this highlight and its note? Flashcards made from it will stop being used (your past answers are kept).')) run('del', () => del(base)); }}>Delete</button>
      </div>
      {a.orphaned ? <div className="notice warn small">This passage can no longer be found in the current text, so it is not highlighted. Your note is kept.</div> : null}
      <blockquote className="quote">{a.quote.length > 280 ? `${a.quote.slice(0, 280)}…` : a.quote}</blockquote>
      <Field label="Your note"><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="What does this passage do or mean? Why did you mark it?" /></Field>
      <div className="row gap-s mt-s">
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category" style={{ width: 'auto' }}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {dirty && <button className="btn small primary" disabled={!!busy} onClick={() => run('save', () => patch(base, { note, category: cat }))}>Save changes</button>}
        {dirty && <button className="btn small" onClick={() => { setNote(a.note); setCat(a.category); }}>Undo</button>}
      </div>

      <div className="help-bar mt-s" role="group" aria-label="Optional help">
        <p className="small muted" style={{ margin: '0 0 .3rem' }}>Optional help{!ai.available ? ' — explanations, definitions and AI feedback need an AI provider (Settings → Setup)' : ''}</p>
        <div className="row gap-s">
          <button className="btn small" disabled={!!busy || !ai.available || a.orphaned} onClick={() => run('explain', () => post(`${base}/assist`, { kind: 'explain' }))}>{busy === 'explain' ? 'Asking…' : 'Explain this passage'}</button>
          <button className="btn small" disabled={!!busy || a.orphaned} onClick={() => run('question', () => post(`${base}/assist`, { kind: 'question' }))}>{busy === 'question' ? 'Asking…' : 'Ask me a question'}</button>
        </div>
        <div className="row gap-s mt-s"><input type="text" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="A word in this passage" aria-label="Word to define" style={{ maxWidth: 220 }} /><button className="btn small" disabled={!!busy || !term.trim() || !ai.available} onClick={() => run('define', () => post(`${base}/assist`, { kind: 'define', term }).then(() => setTerm('')))}>Define in context</button></div>
        <div className="row gap-s mt-s">
          <button className="btn small primary" disabled={!!busy || !canFeedback} title={canFeedback ? '' : 'Write your own interpretation first (a sentence), save it, then ask'} onClick={() => run('feedback', () => post(`${base}/feedback`))}>{busy === 'feedback' ? 'Reading your note…' : 'Give me feedback on my note'}</button>
          {!canFeedback && <span className="small muted">{dirty ? 'Save your changes first.' : 'Write your own interpretation first.'}</span>}
        </div>
      </div>
      {err && <ErrorBox error={err} onRetry={() => setErr(null)} />}

      {helps.map((h: any) => (
        <div key={h.id} className="assist">
          <div className="row between"><strong className="small">{({ explain: 'Explanation', define: `Meaning of “${h.term}”`, question: 'Questions to think about' } as Record<string, string>)[h.kind]}</strong><button className="btn ghost small" onClick={() => run('rm', () => del(`${base}/assists/${h.id}`))} aria-label="Remove">✕</button></div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '.2rem 0' }}>{h.payload.text}</p>
          <p className="small muted">{h.payload.note}{h.payload.removedQuotes ? ` ${h.payload.removedQuotes} quotation${h.payload.removedQuotes > 1 ? 's were' : ' was'} removed because it could not be found in the text.` : ''}</p>
        </div>
      ))}
      {fb && (
        <div className="assist feedback">
          <div className="row between"><strong className="small">Feedback on your note</strong><div className="row gap-s">{fb.stale && <Chip tone="warn">about an earlier version of your note</Chip>}<Chip tone={STANCE[fb.payload.stance]?.tone ?? 'neutral'}>{STANCE[fb.payload.stance]?.text ?? fb.payload.stance}</Chip></div></div>
          <p>{fb.payload.observation}</p>
          {fb.payload.strengths ? <p><strong>Working well:</strong> {fb.payload.strengths}</p> : null}
          {fb.payload.nextSteps?.length ? <><p className="small" style={{ margin: 0 }}><strong>Ways to go further (optional):</strong></p><ul>{fb.payload.nextSteps.map((x: string) => <li key={x}>{x}</li>)}</ul></> : null}
          {fb.payload.questions?.length ? <><p className="small" style={{ margin: 0 }}><strong>Questions to ask the text:</strong></p><ul>{fb.payload.questions.map((x: string) => <li key={x}>{x}</li>)}</ul></> : null}
          {fb.payload.promptLink ? <p className="small"><strong>Your {prompt ? 'prompt/rubric' : 'prompt'}:</strong> {fb.payload.promptLink}</p> : null}
          <p className="small muted">{fb.payload.ai ? 'Written by an AI model, which can be wrong. ' : `Basic check (${fb.payload.basis}), not an AI. `}Your note was not changed; revise it in your own words if you like, then ask again.</p>
        </div>
      )}
      {(a.items?.length ?? 0) > 0 && <p className="small muted mt-s">Made into: {a.items.filter((i: any) => i.active).map((i: any) => ({ flashcard: 'flashcard', short_answer: 'evidence exercise', practice: 'fill-in question' } as Record<string, string>)[i.kind]).join(', ') || 'nothing active (retired)'}</p>}
    </article>
  );
}

function StudyPanel({ readingId, anns, picked, setPicked, data, go, onChange }: { readingId: string; anns: any[]; picked: Set<string>; setPicked: (s: Set<string>) => void; data: any; go: (p: string) => void; onChange: () => void }) {
  const [kinds, setKinds] = useState<Set<string>>(new Set(['flashcard']));
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const ids = [...picked];
  const toggleKind = (k: string) => setKinds((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const run = async (name: string, fn: () => Promise<any>) => { setBusy(name); setErr(null); try { await fn(); } catch (e) { setErr(e as ApiError); } finally { setBusy(null); } };
  const lbl = (k: string, t: string, hint: string) => <label className="toggle"><input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} /><span><span className="toggle-label">{t}</span><span className="hint block">{hint}</span></span></label>;
  return (
    <section className="card" aria-labelledby="study-h">
      <h2 id="study-h">Use your annotations to study</h2>
      <p className="small muted">Tick annotations above ({ids.length} selected). <button className="btn ghost small" onClick={() => setPicked(new Set(anns.filter((a) => !a.orphaned).map((a) => a.id)))}>Select all</button><button className="btn ghost small" onClick={() => setPicked(new Set())}>Clear</button></p>
      {lbl('flashcard', 'Flashcards', 'Shows the passage; you recall what it shows. Checked against your own note.')}
      {lbl('short_answer', 'Short-answer exercises', 'Which words in the reading support your note, and how? Scheduled for a later check.')}
      {lbl('practice', 'Practice questions', data.ai.available ? 'Written by your AI provider from the passages, then checked against your reading.' : 'Fill-in-the-blank cut from the highlighted sentence (no AI set up).')}
      <div className="row mt-s">
        <button className="btn primary" disabled={!ids.length || !kinds.size || !!busy} onClick={() => run('make', async () => { const r = await post(`/readings/${readingId}/study`, { annotationIds: ids, kinds: [...kinds] }); setRes(r); onChange(); })}>{busy === 'make' ? 'Making…' : 'Make study items'}</button>
        <button className="btn" disabled={!ids.length || !!busy} onClick={() => run('outline', async () => { const r = await post(`/readings/${readingId}/outlines`, { annotationIds: ids }); go(`/outline/${r.id}`); })}>Build essay outline</button>
        {data.studyItems > 0 && <button className="btn" disabled={!!busy} onClick={() => run('start', async () => { try { const r = await post(`/readings/${readingId}/study/start`, { minutes: 10 }); go(`/study/${r.id}`); } catch (e) { const ae = e as ApiError; if (ae.code === 'session_active') { if (confirm('You have a session in progress. Start this one instead? Your answers so far are kept.')) { const r = await post(`/readings/${readingId}/study/start`, { minutes: 10, abandonExisting: true }); go(`/study/${r.id}`); } } else throw e; } })}>Study these now ({data.studyItems})</button>}
      </div>
      {err && <ErrorBox error={err} />}
      {res && (
        <div className={`notice ${res.total ? 'good' : 'info'} small`} role="status">
          {res.total ? `Made ${res.made.flashcard} flashcard${res.made.flashcard === 1 ? '' : 's'}, ${res.made.short_answer} exercise${res.made.short_answer === 1 ? '' : 's'}, ${res.made.practice} practice question${res.made.practice === 1 ? '' : 's'}. They are in your normal study sessions (topic “Reading: ${data.reading.title}”), answers are checked before explanations are shown, and later reviews are scheduled as usual.` : 'Nothing new was made.'}
          {res.skipped.length > 0 && <ul>{[...new Set(res.skipped.map((x: any) => x.reason))].map((x) => <li key={x as string}>{x as string}</li>)}</ul>}
        </div>
      )}
      {data.outlines.length > 0 && <div className="mt"><h3>Your outlines</h3><ul>{data.outlines.map((o: any) => <li key={o.id}><a href={`#/outline/${o.id}`}>{o.title}</a></li>)}</ul></div>}
    </section>
  );
}
