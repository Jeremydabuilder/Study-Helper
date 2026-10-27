import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from '../api';
import { Chip, ErrorBox, LevelChip, Spinner } from '../ui';

const SYMBOLS = ['≤', '≥', '≠', '∞', '∪', '−', '|', '√', '²'];
const VERDICT_ICON: Record<string, string> = { correct: '✓', partial: '◐', incorrect: '✗', unsure: '?', ungraded: '!', skipped: '→' };

const newToken = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function Study({ id, go }: { id: string; go: (p: string) => void }) {
  const [view, setView] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>('Loading your session…');
  const [offline, setOffline] = useState(false);

  const load = useCallback(async (useOffline = false) => {
    setBusy(view ? 'Preparing the next question… this can take a few seconds.' : 'Loading your session…'); setError(null);
    try { setView(await get(`/sessions/${id}${useOffline || offline ? '?offline=1' : ''}`)); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(null); }
  }, [id, offline]); // eslint-disable-line
  useEffect(() => { load(); }, [id]); // eslint-disable-line

  const advance = async (useOffline = false) => {
    setBusy('Preparing the next question… this can take a few seconds.'); setError(null);
    try { setView(await post(`/sessions/${id}/next`, { useOffline })); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(null); }
  };

  if (error && !view) return <div className="study"><ErrorBox error={error} onRetry={() => load()}>{error.offlineFallback && <button className="btn" onClick={() => { setOffline(true); load(true); }}>Use a basic offline question</button>}<button className="btn ghost" onClick={() => go('/')}>Back to Today</button></ErrorBox></div>;
  if (!view) return <div className="study"><Spinner label={busy ?? 'Loading…'} /></div>;

  if (view.phase === 'done') return <Summary view={view} go={go} />;
  if (view.phase === 'time_check') return (
    <div className="study card"><h2>You’ve reached about {view.plannedMinutes} minutes</h2>
      <p className="muted">You’ve spent roughly {view.usedMin} minutes (answering and reading feedback). Nothing was cut off. Wrap up now to see what you showed and what to do next, or keep going for a few more questions.</p>
      <div className="row"><button className="btn primary" onClick={async () => setView(await post(`/sessions/${id}/finish`))}>Wrap up and see my summary</button>
        <button className="btn" onClick={async () => { await post(`/sessions/${id}/extend`, { minutes: 10 }); await load(); }}>Keep going (10 more min)</button></div></div>
  );
  if (view.phase === 'ready_to_finish') return (
    <div className="study card"><h2>That’s everything planned</h2><p className="muted">Finish to see what you did and what’s next.</p>
      <button className="btn primary" onClick={async () => setView(await post(`/sessions/${id}/finish`))}>Finish session</button></div>
  );

  const total = view.progress.planned, done = view.progress.answered;
  return (
    <div className="study">
      <div className="row between">
        <div><Chip tone="info">{view.purpose}</Chip> <span className="muted small">{view.concept?.name}</span>{view.holdFeedback && <> <Chip tone="warn">Test mode: feedback at the end</Chip></>}</div>
        <button className="btn small ghost" onClick={() => go('/')}>Pause (resume anytime)</button>
      </div>
      <div className="progress-dots" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${done} of about ${total} questions done`}>
        {Array.from({ length: Math.max(total, 1) }, (_, i) => <span key={i} className={i < done ? 'on' : ''} />)}
      </div>
      {error && <ErrorBox error={error} onRetry={() => (view.phase === 'feedback' ? advance() : load())}>{error.offlineFallback && <button className="btn" onClick={() => { setOffline(true); view.phase === 'feedback' ? advance(true) : load(true); }}>Use a basic offline question</button>}</ErrorBox>}
      {busy && <Spinner label={busy} />}
      {!busy && view.phase === 'question' && view.why && <p className="notice info small" role="note"><strong>Why this question:</strong> {view.why}</p>}
      {!busy && view.phase === 'question' && <QuestionCard key={view.question.id} sid={id} view={view} onAnswered={() => load()} />}
      {!busy && view.phase === 'feedback' && <FeedbackCard key={view.attemptId} sid={id} view={view} onNext={() => advance()} reload={() => load()} last={done >= total} onFinish={async () => setView(await post(`/sessions/${id}/finish`))} />}
    </div>
  );
}

function QuestionCard({ sid, view, onAnswered }: { sid: string; view: any; onAnswered: () => void }) {
  const q = view.question;
  const draftKey = `sh.draft.${q.id}`;
  const read = () => { try { return JSON.parse(sessionStorage.getItem(draftKey) ?? 'null') ?? {}; } catch { return {}; } };
  const init = read();
  const [answer, setAnswer] = useState<string>(init.answer ?? '');
  const [reasoning, setReasoning] = useState<string>(init.reasoning ?? '');
  const [conf, setConf] = useState<number | null>(init.conf ?? null);
  const [hints, setHints] = useState<string[]>(view.hints ?? []);
  const [hintsLeft, setHintsLeft] = useState<number>(q.hintCount - (view.hints?.length ?? 0));
  const [revealed, setRevealed] = useState<any>(view.revealed ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const token = useRef<string>(init.token ?? newToken()); // one token per question: retries and double-clicks are idempotent
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const exam = view.holdFeedback;

  useEffect(() => { try { sessionStorage.setItem(draftKey, JSON.stringify({ answer, reasoning, conf, token: token.current })); } catch { /* ignore */ } }, [answer, reasoning, conf, draftKey]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const send = async (extra: Record<string, unknown> = {}) => {
    if (submitting) return;
    setSubmitting(true); setErr(null); setUnreadable(null);
    try {
      const r = await post(`/sessions/${sid}/answer`, { questionId: q.id, answer, reasoning, confidence: conf, clientToken: token.current, ...extra });
      if (r.unparseable) { setUnreadable(r.message); return; }
      try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ }
      onAnswered();
    } catch (e) { setErr(e as ApiError); } // the typed answer stays in the box
    finally { setSubmitting(false); }
  };
  const hint = async () => { try { const r = await post(`/sessions/${sid}/hint`, { questionId: q.id }); setHints(r.hints); setHintsLeft(r.remaining); } catch (e) { setErr(e as ApiError); } };
  const reveal = async () => { try { setRevealed(await post(`/sessions/${sid}/reveal`, { questionId: q.id })); } catch (e) { setErr(e as ApiError); } };
  const canSubmit = answer.trim().length > 0 && !submitting;
  const isMath = q.answerType?.startsWith('math');
  const insert = (s: string) => { const el = inputRef.current; const pos = el?.selectionStart ?? answer.length; setAnswer(answer.slice(0, pos) + s + answer.slice(pos)); setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + s.length, pos + s.length); }, 0); };

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); if (canSubmit) send(); }} aria-labelledby="qp">
      <p id="qp" className="q-prompt">{q.prompt}</p>
      {q.sourceNote && <p className="small muted"><Chip tone={q.grounding === 'source' ? 'good' : q.grounding === 'weak' ? 'warn' : 'neutral'}>{q.grounding === 'source' ? 'Linked to your material' : q.grounding === 'weak' ? 'Source link unconfirmed' : 'General question'}</Chip> {q.sourceNote}</p>}

      {q.choices ? (
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }} className="choices">
          <legend className="sr-only" style={{ position: 'absolute', left: -9999 }}>Choose one answer</legend>
          {q.choices.map((c: string, i: number) => (
            <label className="choice" key={i}><input type="radio" name="choice" value={i} checked={answer === String(i)} onChange={() => setAnswer(String(i))} autoFocus={i === 0} /> <span>{c}</span></label>
          ))}
        </fieldset>
      ) : isMath ? (
        <div>
          <label className="field-label" htmlFor="ans">Your answer</label>
          <input id="ans" ref={inputRef as any} className="mono" value={answer} onChange={(e) => setAnswer(e.target.value)} autoComplete="off" spellCheck={false} placeholder="e.g. x = 3 or x = -2    ·    x > 4    ·    (-∞, 2]"
            onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) { e.preventDefault(); send(); } }} />
          <div className="mathbar" role="group" aria-label="Math symbols">{SYMBOLS.map((s) => <button key={s} type="button" className="btn small" onClick={() => insert(s)} aria-label={`Insert ${s}`}>{s}</button>)}</div>
          <p className="hint">Typing “&lt;=”, “&gt;=”, “inf”, “U” also works. Equivalent forms are accepted.</p>
        </div>
      ) : (
        <div>
          <label className="field-label" htmlFor="ans">Your answer</label>
          <textarea id="ans" ref={inputRef as any} value={answer} onChange={(e) => setAnswer(e.target.value)} rows={q.kind === 'short_answer' ? 2 : 5} placeholder={q.kind === 'short_answer' ? 'Type your answer' : 'Explain in your own words…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) { e.preventDefault(); send(); } }} />
          <p className="hint">Ctrl/⌘ + Enter to submit.</p>
        </div>
      )}

      {(isMath || q.choices) && (
        <details className="mt-s"><summary>Add my steps / reasoning (optional)</summary>
          <textarea aria-label="Your reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={3} placeholder="Show how you got it — this helps me tell a slip from a misunderstanding." />
        </details>
      )}

      {hints.map((h, i) => <div key={i} className="hint-box" role="note"><strong>Hint {i + 1}:</strong> {h}</div>)}
      {revealed && (
        <div className="hint-box" role="note">
          <strong>Answer:</strong> <span className="mono" style={{ whiteSpace: 'pre-wrap' }}>{revealed.correctAnswer}</span>
          <p className="mt-s" style={{ marginBottom: 0 }}>{revealed.explanation}</p>
          <p className="small" style={{ marginBottom: 0 }}>Because you looked, this won’t count as independent practice. A fresh check comes later.</p>
        </div>
      )}
      {unreadable && <div className="notice warn" role="alert">{unreadable} <span className="small">Nothing was graded or saved — fix it and submit again.</span></div>}
      {err && <ErrorBox error={err} onRetry={() => send()}><span className="small">Your answer is still here.</span></ErrorBox>}

      <fieldset style={{ border: 'none', padding: 0, margin: '.8rem 0 0' }}>
        <legend className="small muted" style={{ padding: 0 }}>How sure are you? (optional)</legend>
        <div className="seg" role="group" aria-label="Confidence">
          {[['Guessing', 1], ['Pretty sure', 2], ['Certain', 3]].map(([l, n]) => <button type="button" key={n as number} aria-pressed={conf === n} onClick={() => setConf(conf === n ? null : (n as number))}>{l}</button>)}
        </div>
      </fieldset>

      <div className="row mt">
        <button className="btn primary" type="submit" disabled={!canSubmit}>{submitting ? 'Checking…' : exam ? 'Save answer' : 'Check my answer'}</button>
        {!exam && <button className="btn" type="button" onClick={hint} disabled={hintsLeft <= 0}>{hintsLeft > 0 ? `Hint (${hintsLeft} left)` : 'No more hints'}</button>}
        <button className="btn ghost" type="button" disabled={submitting} onClick={() => send({ idk: true, answer: '' })}>I don’t know</button>
        {!exam && !revealed && <button className="btn ghost" type="button" onClick={reveal}>Show answer</button>}
        {revealed && <button className="btn" type="button" disabled={submitting} onClick={() => send({ revealedOnly: true, answer: '' })}>Continue without answering</button>}
      </div>
      <p className="small muted mt-s">Response time is never used to penalise you. {q.keyVerified === true ? 'This answer key was checked independently.' : ''}</p>
    </form>
  );
}

function FeedbackCard({ sid, view, onNext, reload, last, onFinish }: { sid: string; view: any; onNext: () => void; reload: () => void; last: boolean; onFinish: () => void }) {
  const f = view.feedback;
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { nextRef.current?.focus(); }, []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); reload(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } };

  if (!f) return (
    <div className="card" role="status">
      <h2>Saved ✓</h2><p className="muted">Test mode holds feedback until the end so it feels like the real thing.</p>
      <div className="row">{!last ? <button ref={nextRef} className="btn primary" onClick={onNext}>Next question</button> : <button ref={nextRef} className="btn primary" onClick={onFinish}>Finish and see results</button>}</div>
    </div>
  );
  return (
    <div className="card" role="region" aria-live="polite" aria-label="Feedback">
      <div className={`verdict ${f.verdict}`}><span aria-hidden>{VERDICT_ICON[f.verdict]}</span> {f.headline}</div>
      <p className="mt-s">{f.message}</p>
      <div className="cmp">
        <div><h4>Your answer</h4><p className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{f.yourAnswer || '(no answer)'}</p></div>
        {f.correctAnswer && <div><h4>Answer / key ideas</h4><p className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{f.correctAnswer}</p></div>}
      </div>
      {f.rubricPoints.length > 0 && <ul className="small">{f.rubricPoints.map((p: any, i: number) => <li key={i}>{p.met ? '✓' : '○'} {p.point}</li>)}</ul>}
      {f.explanation && <p><strong>The idea:</strong> {f.explanation}</p>}
      {f.workedExample && <details open={f.verdict === 'skipped'}><summary>Worked example</summary><p style={{ whiteSpace: 'pre-wrap' }}>{f.workedExample}</p></details>}
      {f.altRepresentation && <p className="small muted">The first explanation didn’t land, so this is a different way to see it rather than the same words again.</p>}
      {f.mistake && f.mistake.kind !== 'unreliable' && (
        <div className="notice info small" role="note">
          <strong>What I noticed in this answer:</strong> {f.mistake.label}. <span className="muted">{f.mistake.why}</span>
          <div className="muted">{f.pattern ? <>This has now shown up on {f.pattern.count} different questions, so it is saved as a <strong>pattern</strong> to work on.</> : 'This is one observation, not a pattern. It is only called a pattern if it happens on a second, different question.'}</div>
        </div>)}
      {f.mistake?.kind === 'unreliable' && <div className="notice warn small">{f.mistake.why}</div>}
      {f.next && <p className="small"><strong>Next:</strong> {f.next.reason}</p>}
      <p className="small muted"><Chip tone={f.gradeStatus === 'graded' ? 'good' : 'warn'}>{f.gradeStatus === 'graded' ? 'Counted' : 'Not counted yet'}</Chip> {f.counts}</p>

      {f.canSelfGrade && (
        <div className="notice warn" role="group" aria-label="Confirm how you did">
          <strong>{f.gradeStatus === 'failed' ? 'Grade this yourself?' : 'How did you do, honestly?'}</strong> Using the key ideas above:
          <div className="row gap-s mt-s">
            {[['Got it', 1], ['Partly', 0.5], ['Missed it', 0]].map(([l, v]) => <button key={v as number} className="btn small" disabled={busy} onClick={() => act(() => post(`/attempts/${view.attemptId}/self-grade`, { correctness: v }))}>{l}</button>)}
            {f.canRetryGrading && <button className="btn small" disabled={busy} onClick={() => act(() => post(`/attempts/${view.attemptId}/regrade`))}>Retry grading</button>}
          </div>
        </div>
      )}
      {err && <ErrorBox error={err} />}
      <Clarify attemptId={view.attemptId} initial={view.clarifications ?? []} onUnclear={reload} />
      <div className="row mt">
        {!last ? <button ref={nextRef} className="btn primary" onClick={onNext}>Next question</button> : <button ref={nextRef} className="btn primary" onClick={onFinish}>Finish session</button>}
        {!last && <button className="btn ghost" onClick={onFinish}>End session here</button>}
      </div>
    </div>
  );
}

function Clarify({ attemptId, initial, onUnclear }: { attemptId: string; initial: any[]; onUnclear: () => void }) {
  const [list, setList] = useState<any[]>(initial);
  const [open, setOpen] = useState(initial.length > 0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const ask = async () => { if (text.trim().length < 3 || busy) return; setBusy(true); setErr(null); try { const r = await post(`/attempts/${attemptId}/clarify`, { text }); setList(r.clarifications); setText(''); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } };
  const unclear = async () => { if (!confirm('Mark this question or its grading as unclear? It will not count and will not be used again.')) return; try { await post(`/attempts/${attemptId}/report-unclear`); onUnclear(); } catch (e) { setErr(e as ApiError); } };
  return (
    <div className="mt-s">
      {!open ? <div className="row gap-s"><button className="btn small ghost" onClick={() => setOpen(true)}>Ask about this feedback</button><button className="btn small ghost" onClick={unclear}>This question or grade seems unclear</button></div> : (
        <div className="notice info small">
          <strong>Ask about this feedback</strong> <span className="muted">— about this question and your answer only.</span>
          {list.map((c) => <div key={c.id} className="mt-s"><div><em>You:</em> {c.ask}</div><div><em>{c.ai ? 'Answer' : 'Note'}:</em> {c.answer}</div></div>)}
          <div className="row gap-s mt-s"><input style={{ flex: 1, minWidth: 180 }} aria-label="Your question about this feedback" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="e.g. Why isn’t my answer partly right?" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } }} /><button className="btn small" disabled={busy || text.trim().length < 3} onClick={ask}>{busy ? 'Asking…' : 'Ask'}</button></div>
          {err && <p className="unknown">{err.message}</p>}
          <button className="btn small ghost mt-s" onClick={unclear}>This question or grade seems unclear</button>
        </div>)}
    </div>
  );
}

function Summary({ view, go }: { view: any; go: (p: string) => void }) {
  const s = view.summary;
  if (!s) return <div className="study card"><h2>Session ended</h2><button className="btn" onClick={() => go('/')}>Back to Today</button></div>;
  return (
    <div className="study">
      <div className="card hero">
        <h1>{s.mode === 'exam' ? 'Test practice results' : 'Nice work — here’s what happened'}</h1>
        <p>{s.answered} question{s.answered === 1 ? '' : 's'} · about {s.minutes} min · {s.independentCorrect}/{s.independentTotal} correct without help{s.helped ? ` · ${s.helped} with hints or shown answers` : ''}</p>
        {s.reflection && <Reflection r={s.reflection} go={go} />}
        {s.notCounted > 0 && <div className="notice warn small">{s.notCounted} answer{s.notCounted === 1 ? '' : 's'} couldn’t be graded with confidence and {s.notCounted === 1 ? 'isn’t' : 'aren’t'} counted yet. Confirm {s.notCounted === 1 ? 'it' : 'them'} in <a href="#/progress">Progress → History</a>.</div>}
        <h3>By concept</h3>
        <div className="scroll-x"><table><thead><tr><th>Concept</th><th>Right</th><th>Partly</th><th>Missed</th><th>With help</th><th>Where it stands</th></tr></thead>
          <tbody>{s.concepts.map((c: any) => <tr key={c.id}><td>{c.name}</td><td>{c.right}</td><td>{c.partial}</td><td>{c.wrong}</td><td>{c.helped}</td><td><LevelChip level={c.level} /></td></tr>)}</tbody></table></div>
        {s.misconceptions.length > 0 && <div className="notice info mt-s"><strong>Mistake patterns found:</strong> {s.misconceptions.join(', ')}</div>}
        {s.exam && (
          <div className="mt">
            <h3>Test mode report</h3>
            <p>{s.exam.score === null ? 'Nothing was graded with confidence.' : <>On these {s.exam.graded} graded questions you earned <strong>{Math.round(s.exam.score * 100)}%</strong>{s.exam.range && <> (plausible range {Math.round(s.exam.range[0] * 100)}–{Math.round(s.exam.range[1] * 100)}%)</>}.</>}</p>
            <p className="small">Coverage: {s.exam.coverage.covered} of {s.exam.coverage.linked || s.exam.coverage.covered} linked topics were sampled.</p>
            <p className="small muted">{s.exam.note}</p>
            {s.exam.recommendation && <p><strong>Best next step:</strong> work on “{s.exam.recommendation}”.</p>}
          </div>
        )}
        {s.nextSteps.length > 0 && <><h3>What’s next</h3><ul>{s.nextSteps.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></>}
        <div className="row mt"><button className="btn primary" onClick={() => go('/')}>Back to Today</button><button className="btn" onClick={() => go('/progress')}>See progress</button></div>
      </div>
    </div>
  );
}

function Reflection({ r, go }: { r: any; go: (p: string) => void }) {
  return (
    <div className="mt">
      <div className="grid2" style={{ alignItems: 'start' }}>
        <section><h3>What you showed on your own</h3>
          {r.demonstrated.length ? <ul>{r.demonstrated.map((d: any) => <li key={d.conceptId}><strong>{d.concept}</strong> — {d.text}</li>)}</ul> : <p className="muted">Nothing yet counts as independent today. That is useful to know, not a failure.</p>}</section>
        <section><h3>What still needs work</h3>
          {r.needsWork.length ? <ul>{r.needsWork.map((d: any) => <li key={d.conceptId}><strong>{d.concept}</strong> — {d.text}{d.pattern && <> <Chip tone="warn">pattern</Chip></>}</li>)}</ul> : <p className="muted">No misses today.</p>}</section>
      </div>
      {r.uncertain.length > 0 && <section><h3>What is still uncertain</h3><ul>{r.uncertain.map((u: string, i: number) => <li key={i}>{u}</li>)}</ul></section>}
      <div className="notice good" role="note"><strong>Do next:</strong> {r.next.text}</div>
      {r.later.length > 0 && <section><h3>What will be checked again</h3><ul>{r.later.map((l: any) => <li key={l.conceptId}><strong>{l.concept}</strong> on {l.when}: {l.what}</li>)}</ul></section>}
      <p className="small muted">{r.notes.join(' ')}</p>
      {r.next.goal && <div className="row"><button className="btn" onClick={() => go('/')}>Plan the next session</button></div>}
    </div>
  );
}
