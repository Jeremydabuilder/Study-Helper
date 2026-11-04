import { useState } from 'react';
import { ApiError } from '../api';
import { selectExcerpts } from '../../core/guest/practice';
import { PageTop } from '../myhelper/Shell';
import { aiHint, useGuest } from './store';

/** What to try when the assistant is off: plain, general, and labelled as such. */
const SCAFFOLD = ['Read the instructions once and underline what is being asked.', 'Write down what you already know that connects to it.', 'Do just the first small step, even if you are not sure it is right.', 'Check that step against your notes or an example from class.', 'If you are stuck on one part, skip it, finish the rest, and come back.'];

/** Homework help: pick an assignment, get a hint. Sends only the question, your attempt and a few relevant passages of your notes, and shows you exactly what. */
export function Help({ query }: { query: string }) {
  const { profile, status } = useGuest();
  const q = new URLSearchParams(query); const id = q.get('a');
  const open = profile.assignments.filter((a) => !a.done);
  const [aid, setAid] = useState(id && profile.assignments.some((a) => a.id === id) ? id : open[0]?.id ?? '');
  const a = profile.assignments.find((x) => x.id === aid) ?? null;
  const [question, setQuestion] = useState(a?.instructions ?? ''); const [attempt, setAttempt] = useState('');
  const [hint, setHint] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null); const [showScaffold, setShowScaffold] = useState(false);
  const pick = (v: string) => { setAid(v); setQuestion(profile.assignments.find((x) => x.id === v)?.instructions ?? ''); setHint(null); setErr(null); };
  const qText = question.slice(0, 2000);
  const ex = selectExcerpts(profile.notes, `${qText} ${attempt}`, { n: 3 });
  const goal = profile.goals[0]?.text;
  const payload = { question: qText, attempt: attempt.trim() ? attempt.slice(0, 2000) : undefined, excerpts: ex, profile: { className: a?.className || undefined, goal, trouble: profile.preferences.trouble } };
  const ask = async () => { setBusy(true); setErr(null); setHint(null); try { setHint((await aiHint(payload)).hint); } catch (e) { setErr(e as ApiError); setShowScaffold(true); } finally { setBusy(false); } };
  return (<>
    <PageTop eyebrow="Homework" title="Get a hint" />
    <section className="mh-panel">
      {open.length > 0 && <div className="mh-field"><label htmlFor="hw-a">Assignment</label><select id="hw-a" value={aid} onChange={(e) => pick(e.target.value)}>{open.map((x) => <option key={x.id} value={x.id}>{x.title}{x.className ? ` — ${x.className}` : ''}</option>)}<option value="">(none: just paste a question)</option></select></div>}
      <div className="mh-field"><label htmlFor="hw-q">The question or instructions</label><textarea id="hw-q" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Paste one question, for example: Solve 2x + 3 = 11" /></div>
      <div className="mh-field"><label htmlFor="hw-t">Your attempt so far (optional, but the hint is better with it)</label><textarea id="hw-t" value={attempt} onChange={(e) => setAttempt(e.target.value)} /></div>
      <details className="mh-sub" style={{ marginBottom: 10 }}><summary style={{ cursor: 'pointer' }}>What will be sent to the assistant</summary><div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>Only: the question ({qText.length} characters){attempt.trim() ? `, your attempt (${Math.min(attempt.length, 2000)} characters)` : ''}, {ex.length} short passage{ex.length === 1 ? '' : 's'} picked from your notes because they match the question{ex.length ? ` (${ex.map((e) => e.label).join(', ')})` : ''}, and {[a?.className && 'the class name', goal && 'your first goal', profile.preferences.trouble && 'what usually goes wrong'].filter(Boolean).join(', ') || 'no profile details'}. Not your other notes, assignments, commitments or the rest of your profile.</div></details>
      <div className="mh-row end">
        <button className="mh-secondary" onClick={() => setShowScaffold(!showScaffold)}>No assistant: steps to try</button>
        <button className="mh-primary" disabled={busy || question.trim().length < 3 || !status?.ai.available} onClick={ask}>{busy ? 'Thinking…' : 'Get a hint'}</button></div>
      {!status?.ai.available && <div className="mh-notice" role="status">{status?.ai.cooling ? 'The assistant is resting for a moment. Try again shortly.' : 'The assistant is not available right now.'} The steps below work without it.</div>}
      {err && <div className="mh-notice bad" role="alert">{err.message}{err.extra?.retryAfterMs ? ` (about ${Math.ceil(err.extra.retryAfterMs / 1000)} seconds)` : ''} Your question and attempt are still here, and the steps below work without the assistant.</div>}
      {hint && <div className="mh-panel tint" style={{ marginTop: 14 }} role="status"><span className="mh-tag">Hint from the assistant</span><p style={{ marginBottom: 0 }}>{hint}</p><p className="mh-meta">Hints can be wrong. Check them against your notes.</p></div>}
      {showScaffold && <div className="mh-panel" style={{ marginTop: 14 }}><span className="mh-tag warn">Not from the assistant: general steps</span><ol style={{ fontSize: 13, lineHeight: 1.7 }}>{SCAFFOLD.map((s) => <li key={s}>{s}</li>)}</ol></div>}
    </section>
  </>);
}
