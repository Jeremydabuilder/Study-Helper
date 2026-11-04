import { useMemo, useState } from 'react';
import { ApiError } from '../api';
import { cardsFromNotes, dueCards, gradeCard, selectExcerpts } from '../../core/guest/practice';
import { newId } from '../../core/guest/extract';
import { PracticeCard } from '../../core/guest/types';
import { PageTop } from '../myhelper/Shell';
import { aiCheck, aiQuiz, useGuest } from './store';

type Verdict = { verdict: string; feedback: string } | null;

/** One run through a few cards: try to remember, reveal, say how it went. Misses come back sooner. Works with no assistant. */
function Runner({ cards, onDone, title }: { cards: PracticeCard[]; onDone: () => void; title: string }) {
  const { update, today, status } = useGuest();
  const [i, setI] = useState(0); const [shown, setShown] = useState(false); const [typed, setTyped] = useState(''); const [v, setV] = useState<Verdict>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [right, setRight] = useState(0);
  if (i >= cards.length) return (<section className="mh-panel" role="status"><h3>Done: {right} of {cards.length} remembered</h3><p className="mh-sub" style={{ fontSize: 13 }}>Cards you missed come back tomorrow; ones you knew come back later.</p><div className="mh-row end"><button className="mh-primary" onClick={onDone}>Finish</button></div></section>);
  const c = cards[i];
  const grade = (ok: boolean) => { update((p) => ({ ...p, cards: p.cards.map((x) => (x.id === c.id ? gradeCard(x, ok, today) : x)) })); if (ok) setRight((n) => n + 1); setI(i + 1); setShown(false); setTyped(''); setV(null); setErr(null); };
  const check = async () => { setBusy(true); setErr(null); try { setV(await aiCheck({ question: c.prompt, reference: c.answer, answer: typed })); setShown(true); } catch (e) { setErr(e instanceof ApiError ? e.message : 'The assistant could not check that.'); setShown(true); } finally { setBusy(false); } };
  return (
    <section className="mh-panel" aria-label={title}>
      <div className="mh-progress" aria-hidden><span style={{ width: `${(i / cards.length) * 100}%` }} /></div>
      <p className="mh-meta" style={{ marginTop: 10 }}>{title} · card {i + 1} of {cards.length}</p>
      <h3 id="card-q" style={{ fontSize: 19 }}>{c.prompt}</h3>
      <div className="mh-field"><label htmlFor="card-a">Your answer (try before you look)</label><textarea id="card-a" style={{ minHeight: 70 }} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={shown} /></div>
      {!shown ? <div className="mh-row end">
        {status?.ai.available && <button className="mh-secondary" disabled={!typed.trim() || busy} onClick={check}>{busy ? 'Checking…' : 'Check with the assistant'}</button>}
        <button className="mh-primary" onClick={() => setShown(true)}>Show answer</button></div>
        : <><div className="mh-notice good" role="status"><strong>Answer:</strong> {c.answer}</div>
          {v && <div className="mh-notice" role="status"><span className="mh-tag">Assistant says: {v.verdict}</span> {v.feedback}</div>}
          {err && <div className="mh-notice bad" role="alert">{err} You can mark it yourself.</div>}
          <div className="mh-row end" style={{ marginTop: 12 }}><span className="mh-meta">How did it go?</span><button className="mh-secondary" onClick={() => grade(false)}>Not yet</button><button className="mh-primary" onClick={() => grade(true)}>I remembered it</button></div></>}
    </section>);
}

export function Practice({ query, go }: { query: string; go: (p: string) => void }) {
  const { profile, update, today, status } = useGuest();
  const aid = new URLSearchParams(query).get('a'); const a = profile.assignments.find((x) => x.id === aid) ?? null;
  const [noteId, setNoteId] = useState(profile.notes.find((n) => a && n.className && n.className.toLowerCase() === a.className.toLowerCase())?.id ?? profile.notes[0]?.id ?? '');
  const [run, setRun] = useState<PracticeCard[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const note = profile.notes.find((n) => n.id === noteId) ?? null;
  const own = useMemo(() => profile.cards.filter((c) => c.noteId === noteId), [profile.cards, noteId]);
  const start = () => {
    let cards = own.slice().sort((x, y) => x.box - y.box || x.seen - y.seen).slice(0, 8);
    if (!cards.length && note) { const made = cardsFromNotes(note, today); update((p) => ({ ...p, cards: [...p.cards, ...made] })); cards = made.slice(0, 8); }
    if (cards.length) setRun(cards); else setErr('No questions could be made from those notes with simple rules. Try the assistant, or add notes with definitions or full sentences.');
  };
  const withAssistant = async () => {
    if (!note) return; setBusy(true); setErr(null);
    try {
      const topic = a?.title ?? note.title; const ex = selectExcerpts([note], topic + ' ' + note.text.slice(0, 200), { n: 3, maxChars: 1000 });
      const picked = ex.length ? ex : [{ label: note.title, text: note.text.slice(0, 1000) }];
      const r = await aiQuiz({ topic, excerpts: picked, count: 4, profile: { className: a?.className || undefined, goal: profile.goals[0]?.text } });
      const made: PracticeCard[] = r.questions.map((x) => ({ id: newId('p'), noteId: note.id, prompt: x.prompt, answer: x.answer, box: 1, due: today, lastResult: null, seen: 0 }));
      update((p) => ({ ...p, cards: [...p.cards, ...made] })); setRun(made);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'The assistant could not write questions.'); } finally { setBusy(false); }
  };
  if (run) return (<><PageTop eyebrow="Practice" title="Retrieval practice" /><Runner cards={run} title={note?.title ?? 'Practice'} onDone={() => { setRun(null); go('/'); }} /></>);
  return (<>
    <PageTop eyebrow="Quiz" title="Practice from your notes" />
    <section className="mh-panel">
      {a && <div className="mh-notice good">For: <strong>{a.title}</strong>{a.due.date ? ` (due ${a.due.date})` : ''}</div>}
      {profile.notes.length === 0 ? <div className="mh-empty">No notes saved in this browser yet. <a href="#/build/paste">Paste some notes</a> and tick “keep these notes”, then come back.</div> : <>
        <div className="mh-field"><label htmlFor="pr-n">Notes</label><select id="pr-n" value={noteId} onChange={(e) => setNoteId(e.target.value)}>{profile.notes.map((n) => <option key={n.id} value={n.id}>{n.title} ({own.length || profile.cards.filter((c) => c.noteId === n.id).length} cards)</option>)}</select></div>
        <p className="mh-sub" style={{ fontSize: 13 }}>Try to remember before you look. It takes about 5 minutes and works without the assistant. Questions are made from your notes by simple rules, or by the assistant, which sends it only the few passages it needs.</p>
        {err && <div className="mh-notice bad" role="alert">{err}</div>}
        <div className="mh-row end"><button className="mh-secondary" disabled={busy || !status?.ai.available} onClick={withAssistant}>{busy ? 'Writing questions…' : 'Ask the assistant for questions'}</button><button className="mh-primary" disabled={busy} onClick={start}>Start a short practice</button></div>
        {!status?.ai.available && <div className="mh-notice" role="status">The assistant is not available right now; practice from your notes still works.</div>}</>}
    </section></>);
}

export function Review({ go }: { go: (p: string) => void }) {
  const { profile, today } = useGuest();
  const [run, setRun] = useState<PracticeCard[] | null>(null);
  const due = dueCards(profile, today);
  if (run) return (<><PageTop eyebrow="Review" title="Review" /><Runner cards={run} title="Review" onDone={() => { setRun(null); go('/'); }} /></>);
  return (<>
    <PageTop eyebrow="Remember it" title="Review" />
    <section className="mh-panel">{due.length === 0 ? <div className="mh-empty">Nothing is due. {profile.cards.length ? 'Come back tomorrow, or practise more.' : 'Practise from your notes first; what you miss comes back here.'}<br /><br /><a className="mh-primary" href="#/practice" style={{ textDecoration: 'none' }}>Go to practice</a></div> : <>
      <h3>{due.length} card{due.length === 1 ? '' : 's'} due</h3><p className="mh-sub" style={{ fontSize: 13 }}>Cards you missed come back soon; cards you knew come back after longer gaps. This works without the assistant.</p>
      <div className="mh-row end"><button className="mh-primary" onClick={() => setRun(due.slice(0, 10))}>Start review ({Math.min(10, due.length)})</button></div></>}</section></>);
}
