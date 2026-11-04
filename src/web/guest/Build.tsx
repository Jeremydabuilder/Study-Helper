import { useState } from 'react';
import { ApiError } from '../api';
import { AiExtraction, candidatesFromAi } from '../../core/guest/aiSchema';
import { extractLocal, mergeCandidates, newId } from '../../core/guest/extract';
import { finishInterview, interviewProgress, markAsked, MAX_QUESTIONS, nextQuestion, resumeInterview, questionById } from '../../core/guest/interview';
import { applyCandidates, markDuplicates } from '../../core/guest/profile';
import { cardsFromNotes } from '../../core/guest/practice';
import { Candidates } from '../../core/guest/types';
import { PageTop } from '../myhelper/Shell';
import { aiExtract, chunkText, useGuest } from './store';
import { Preview } from './Preview';

/** The entry point: three honest choices. */
export function Build({ go, mode }: { go: (p: string) => void; mode: 'entry' | 'paste' | 'interview' }) {
  const { profile, update } = useGuest();
  if (mode === 'paste') return <PasteFlow go={go} />;
  if (mode === 'interview') return <Interview go={go} />;
  const st = profile.interview.status, prog = interviewProgress(profile);
  return (<>
    <PageTop eyebrow="Get set up" title="Build my study profile" />
    <section className="mh-panel tint"><p style={{ marginTop: 0 }}>A study profile lets Study Helper plan your day around your deadlines, your commitments and the time you really have. It is saved <strong>only in this browser</strong>, you check everything before it is saved, and you can skip any part.</p>
      <div className="mh-helpers" style={{ marginTop: 14 }}>
        <a className="mh-helper" href="#/build/paste" style={{ textDecoration: 'none' }}><span className="em" aria-hidden>📋</span><strong>Paste notes</strong><small>Paste a syllabus, a list of assignments, a message from a teacher or your own notes. We find assignments, dates, commitments and goals and show them to you to edit.</small></a>
        <a className="mh-helper" href="#/build/interview" style={{ textDecoration: 'none' }}><span className="em" aria-hidden>💬</span><strong>{st === 'in_progress' && prog.asked > 0 ? 'Resume the questions' : 'Answer questions'}</strong><small>{st === 'in_progress' && prog.asked > 0 ? `${profile.interview.asked.length} answered or skipped so far. Pick up where you stopped.` : 'Five short questions to start (skip any). A few more only if they would improve your plan, up to about 20 in all. Stop whenever you like.'}</small></a>
        <button className="mh-helper" onClick={() => { update((p) => ({ ...p, interview: { ...p.interview, status: p.interview.status === 'not_started' ? 'skipped' : p.interview.status } })); go('/'); }}><span className="em" aria-hidden>⏭️</span><strong>Skip for now</strong><small>Go straight to the app. You can add assignments by hand and come back to this any time.</small></button>
      </div></section>
    <section className="mh-panel" style={{ marginTop: 16 }} aria-label="What happens to your text"><h3>What happens to what you type or paste</h3>
      <ul style={{ fontSize: 13, lineHeight: 1.7, paddingLeft: 20 }}>
        <li>Your profile and notes are saved in <strong>this browser only</strong>. This site keeps no copy and has no account for you.</li>
        <li>Pasted notes are read <strong>in your browser</strong> first. You choose whether the assistant also reads them. If you do, your pasted text is sent in pieces to this site’s server and on to the AI provider (Groq) to find assignments and dates, and is not stored.</li>
        <li>Later assistant help (a hint, practice questions) sends only the question and the few relevant passages from your notes, never your whole profile.</li>
        <li>You can view, edit, export or clear everything in <a href="#/memory">My profile</a>. Clearing browser data, or switching browser or device, removes it from that browser. Export a copy to keep it.</li>
      </ul></section>
  </>);
}

function usePasteLimits() { const { status } = useGuest(); return { max: status?.limits.maxPasteChars ?? 200_000, chunk: status?.limits.aiChunkChars ?? 6000, chunks: status?.limits.aiMaxChunks ?? 6 }; }

function PasteFlow({ go }: { go: (p: string) => void }) {
  const { profile, update, today, status } = useGuest();
  const lim = usePasteLimits();
  const [text, setText] = useState(''); const [title, setTitle] = useState('My notes'); const [keep, setKeep] = useState(true); const [cands, setCands] = useState<Candidates | null>(null);
  const [useAi, setUseAi] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const over = text.length > lim.max;
  const aiOk = !!status?.ai.available;
  const analyse = async () => {
    setMsg(null); setBusy('Reading your notes…');
    const body = over ? text.slice(0, lim.max) : text;
    let c = extractLocal(body, today, { maxChars: lim.max }); if (over) c.truncated = true;
    if (useAi && aiOk) {
      const { chunks, covered } = chunkText(body, lim.chunk, lim.chunks);
      let failed: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        setBusy(`Asking the assistant… (part ${i + 1} of ${chunks.length})`);
        try { const r = await aiExtract(chunks[i]); const parsed = AiExtraction.safeParse(r.result); if (parsed.success) c = mergeCandidates(c, candidatesFromAi(parsed.data, today)); else failed = 'The assistant gave an answer that could not be used.'; }
        catch (e) { failed = e instanceof ApiError ? e.message : 'The assistant could not be reached.'; break; }
      }
      const rest = body.length - covered;
      setMsg(failed ? `${failed} The results below come from the rules in your browser${chunks.length ? ' plus any parts the assistant finished' : ''}.` : rest > 0 ? `The assistant read the first ${covered.toLocaleString()} characters. The remaining ${rest.toLocaleString()} were read only by the rules in your browser.` : null);
    }
    setCands(markDuplicates(profile, c)); setBusy(null);
  };
  const save = () => {
    if (!cands) return;
    update((p) => {
      const r = applyCandidates(p, cands, Date.now(), 'pasted'); let next = r.profile;
      if (keep && text.trim()) { const note = { id: newId('n'), title: title.trim() || 'My notes', text: text.slice(0, lim.max), className: '', addedAt: Date.now() }; next = { ...next, notes: [...next.notes, note], cards: [...next.cards, ...cardsFromNotes(note, today)] }; }
      return { ...next, confirmedAt: Date.now() };
    });
    go('/');
  };
  if (cands) return (<><PageTop eyebrow="Paste notes" title="Check what was found" />{msg && <div className="mh-notice" role="status" style={{ marginBottom: 12 }}>{msg}</div>}<Preview value={cands} onChange={setCands} onSave={save} onCancel={() => setCands(null)} saveLabel="Save the ticked items" /></>);
  return (<>
    <PageTop eyebrow="Build my study profile" title="Paste notes" />
    <section className="mh-panel">
      <div className="mh-field"><label htmlFor="paste-text">Paste anything: a syllabus, assignment list, planner entries, a teacher’s email, or notes about yourself</label><textarea id="paste-text" style={{ minHeight: 220 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Math: worksheet 4 due Friday\nBiology test Nov 12\nSoccer practice Mon/Wed 4-6pm\nI sleep about 8 hours'} /></div>
      <div className={`mh-meta`} role="status" style={over ? { color: '#962b2b' } : undefined}>{text.length.toLocaleString()} of {lim.max.toLocaleString()} characters{over ? ' — only the first part will be read. Paste the rest in a second go.' : ''}</div>
      <div className="mh-field" style={{ marginTop: 12 }}><label htmlFor="paste-title">Keep these notes in this browser for hints and practice? Give them a name</label><div className="mh-row"><input type="checkbox" style={{ width: 'auto' }} checked={keep} onChange={(e) => setKeep(e.target.checked)} aria-label="Keep these notes in this browser" /><input id="paste-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!keep} style={{ flex: 1, width: 'auto' }} /></div></div>
      <fieldset className="mh-notice" style={{ border: 0 }}><legend className="mh-eyebrow">Who reads your text?</legend>
        <label className="mh-row"><input type="radio" style={{ width: 'auto' }} name="reader" checked={!useAi} onChange={() => setUseAi(false)} /><span><strong>Only this browser</strong>: simple rules find dates, assignments, times and goals. Nothing is sent anywhere.</span></label>
        <label className="mh-row" style={{ marginTop: 6 }}><input type="radio" style={{ width: 'auto' }} name="reader" checked={useAi} disabled={!aiOk} onChange={() => setUseAi(true)} /><span><strong>This browser and the assistant</strong>: also sends your pasted text to this site’s server and on to the AI provider (Groq) to find more. It is sent in up to {lim.chunks} parts of about {lim.chunk.toLocaleString()} characters, is not stored, and counts against a shared daily limit{status ? ` (${status.limits.perDay} assistant requests a day from this connection)` : ''}. {aiOk ? '' : status?.ai.cooling ? 'The assistant is resting for a moment.' : 'The assistant is not available right now.'}</span></label></fieldset>
      {busy && <div className="mh-notice" role="status">{busy}</div>}
      <div className="mh-row end" style={{ marginTop: 14 }}><a className="mh-secondary" href="#/build" style={{ textDecoration: 'none' }}>Back</a><button className="mh-primary" disabled={!text.trim() || !!busy} onClick={analyse}>{useAi ? 'Find items with the assistant' : 'Find items'}</button></div>
    </section>
  </>);
}

function Interview({ go }: { go: (p: string) => void }) {
  const { profile, update, replace, today } = useGuest();
  const [answer, setAnswer] = useState(''); const [cands, setCands] = useState<Candidates | null>(null); const [pendingId, setPendingId] = useState<string | null>(null);
  const q = nextQuestion(profile); const prog = interviewProgress(profile);
  const done = profile.interview.status === 'finished' || profile.interview.status === 'skipped' || !q;
  const advance = (id: string, ans: string | null) => { update((p) => markAsked(resumeIfNeeded(p), id, ans)); setAnswer(''); };
  const resumeIfNeeded = (p: typeof profile) => (p.interview.status === 'finished' || p.interview.status === 'skipped' ? resumeInterview(p) : p);
  const submit = () => {
    if (!q) return; const a = answer.trim(); if (!a) return;
    const r = q.apply(profile, a, today);
    if (r.candidates && (r.candidates.assignments.length || r.candidates.commitments.length || r.candidates.preferences.length || r.candidates.goals.length || r.candidates.classes.length)) { setCands(markDuplicates(profile, r.candidates)); setPendingId(q.id); return; }
    update((p) => markAsked(q.apply(resumeIfNeeded(p), a, today).profile, q.id, a)); setAnswer('');
  };
  if (cands && pendingId) return (<><PageTop eyebrow={`Question ${profile.interview.asked.length + 1}`} title="Check what I understood" />
    <Preview value={cands} onChange={setCands} saveLabel="Save and continue" onCancel={() => { setCands(null); setPendingId(null); }}
      onSave={() => { update((p) => markAsked(applyCandidates(resumeIfNeeded(p), cands, Date.now(), 'answer').profile, pendingId, answer.trim())); setCands(null); setPendingId(null); setAnswer(''); }} /></>);
  if (done) return (<><PageTop eyebrow="Questions" title={profile.interview.asked.length ? 'That’s enough for now' : 'No questions needed'} />
    <section className="mh-panel"><p style={{ marginTop: 0 }}>{profile.interview.asked.length ? `You answered or skipped ${profile.interview.asked.length} question${profile.interview.asked.length === 1 ? '' : 's'}. ` : 'Your profile already holds what the questions would ask. '}{q ? 'You can answer more later; each one makes the plan a little better.' : 'There is nothing more to ask right now.'}</p>
      <div className="mh-row end">{q && <button className="mh-secondary" onClick={() => replace(resumeInterview(profile))}>Keep going</button>}<button className="mh-primary" onClick={() => go('/')}>See my plan</button></div></section></>);
  const total = Math.min(MAX_QUESTIONS, prog.asked + prog.remaining);
  return (<>
    <PageTop eyebrow={`Question ${prog.asked + 1} of up to ${total}`} title="Answer questions" />
    <section className="mh-panel" aria-live="polite">
      <div className="mh-progress" aria-hidden><span style={{ width: `${Math.min(100, (prog.asked / Math.max(1, total)) * 100)}%` }} /></div>
      <h3 style={{ marginTop: 16 }} id="q-text">{q.text}</h3>{q.help && <p className="mh-sub" style={{ fontSize: 13 }}>{q.help}</p>}
      {q.kind === 'choice' ? <div className="mh-row" role="group" aria-labelledby="q-text" style={{ marginTop: 10 }}>{q.choices!.map((c) => <button key={c} className={answer === c ? 'mh-primary' : 'mh-secondary'} aria-pressed={answer === c} onClick={() => setAnswer(c)}>{c}</button>)}</div>
        : q.kind === 'number' ? <div className="mh-field" style={{ marginTop: 10 }}><input aria-labelledby="q-text" inputMode="decimal" value={answer} placeholder={q.placeholder} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} style={{ maxWidth: 200 }} /></div>
        : <div className="mh-field" style={{ marginTop: 10 }}><textarea aria-labelledby="q-text" value={answer} placeholder={q.placeholder} onChange={(e) => setAnswer(e.target.value)} /></div>}
      <div className="mh-row end" style={{ marginTop: 14 }}>
        <button className="mh-text-btn" onClick={() => { update((p) => finishInterview(p)); }}>Finish for now</button>
        <button className="mh-secondary" onClick={() => advance(q.id, null)}>Skip this one</button>
        <button className="mh-primary" disabled={!answer.trim()} onClick={submit}>Next</button></div>
      <p className="mh-meta" style={{ marginTop: 10 }}>Your answers are saved in this browser as you go. You can stop any time and resume from “Build my study profile”.</p>
    </section></>);
}
