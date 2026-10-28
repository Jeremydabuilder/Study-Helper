import { useState } from 'react';
import { ApiError, post } from '../api';
import { Chip, ErrorBox } from '../ui';

/** One recommended action with a short reason and an estimated duration. The student can change the goal, the time and the subject. */
export function RecommendationCard({ t, mins, setMinutes, go, onSample }: { t: any; mins: number; setMinutes: (m: number) => void; go: (p: string) => void; onSample: () => void }) {
  const r = t.recommendation;
  const [changing, setChanging] = useState(false);
  const [goal, setGoal] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const chosen = goal ?? r.goal;
  const opt = r.options.find((o: any) => o.goal === chosen);

  const start = async (abandonExisting = false) => {
    if (!chosen) return;
    setStarting(true); setErr(null);
    try { const x = await post('/sessions', { goal: chosen, minutes: mins, itemId: chosen === r.goal ? r.itemId : null, abandonExisting }); go(`/study/${x.id}`); }
    catch (e) { const ae = e as ApiError; if (ae.code === 'session_active') { if (confirm('You have a session in progress. Start a new one instead? Your answers so far are kept.')) { await start(true); return; } } else setErr(ae); }
    finally { setStarting(false); }
  };

  if (r.kind === 'resume') return (
    <section className="card hero" aria-labelledby="rec-h"><h2 id="rec-h">{r.title}</h2><p className="muted">{r.reason}</p>
      <div className="row"><button className="btn primary big" onClick={() => go(`/study/${r.sessionId}`)}>Resume your session</button>
        <button className="btn" onClick={() => { if (confirm('Start a new session instead? Your answers so far are kept.')) setChanging(true); }}>Start a different one</button></div>
      {changing && <Chooser {...{ r, goal, setGoal, mins, setMinutes, custom, setCustom }} />}
      {changing && <div className="row mt"><button className="btn primary" disabled={!chosen || starting} onClick={() => start(true)}>{starting ? 'Starting…' : `Start · ${mins} min`}</button></div>}
      {err && <ErrorBox error={err} />}
    </section>);

  if (r.kind === 'set_up' || r.kind === 'confirm_concepts') return (
    <section className="card hero" aria-labelledby="rec-h"><h2 id="rec-h">{r.title}</h2><p className="muted">{r.reason}</p>
      <div className="row"><button className="btn primary big" onClick={() => go(r.kind === 'set_up' ? '/start' : '/subjects')}>{r.kind === 'set_up' ? 'Upload or paste material' : 'Go to subjects'}</button><button className="btn" onClick={onSample}>Explore with sample data</button></div></section>);

  if (r.kind === 'annotate') return (
    <section className="card hero" aria-labelledby="rec-h"><p className="small muted" style={{ margin: 0 }}>Recommended for you</p><h2 id="rec-h" style={{ marginTop: '.1rem' }}>{r.title}</h2><p>{r.reason}</p>
      <div className="row mt"><button className="btn primary big" onClick={() => go(`/read/${r.readingId}`)}>Open the reading · about {r.minutes} min</button>
        <button className="btn" onClick={async () => { await post(`/readings/${r.readingId}/skip-today`); window.dispatchEvent(new Event('workspace-changed')); }}>Not today</button></div></section>);

  if (r.kind === 'caught_up') return (
    <section className="card hero" aria-labelledby="rec-h"><h2 id="rec-h">{r.title}</h2><p className="muted">{r.reason}</p>
      <div className="row"><button className="btn primary" onClick={() => go('/start')}>Study new material</button><button className="btn" onClick={() => go('/subjects')}>Practise a topic I choose</button></div></section>);

  return (
    <section className="card hero" aria-labelledby="rec-h">
      <p className="small muted" style={{ margin: 0 }}>Recommended for you</p>
      <h2 id="rec-h" style={{ marginTop: '.1rem' }}>{r.title}</h2>
      <p>{r.reason}</p>
      {r.conceptNames.length > 0 && <p className="small muted">Covers: {r.conceptNames.join(' · ')}{r.subjectName ? ` (${r.subjectName})` : ''}</p>}
      <div className="row mt">
        <button className="btn primary big" disabled={starting} onClick={() => start()}>{starting ? 'Starting…' : `Start · about ${mins === t.minutes ? r.minutes : mins} min`}</button>
        <button className="btn" onClick={() => setChanging(!changing)} aria-expanded={changing}>{changing ? 'Hide options' : 'Change'}</button>
        <button className="btn ghost" onClick={() => go('/start')}>Study new material</button>
        {t.dueReviews > 0 && <span className="muted small">{t.dueReviews} review{t.dueReviews === 1 ? '' : 's'} due</span>}
      </div>
      {changing && <Chooser {...{ r, goal, setGoal, mins, setMinutes, custom, setCustom }} />}
      {opt && changing && !opt.available && <p className="small unknown">Nothing to do for “{opt.label}” yet: {opt.detail}.</p>}
      {t.freeMinutesToday > 0 && <p className="small muted mt-s">About {t.freeMinutesToday} min free today after your calendar, protected time and daily limit.</p>}
      {err && <ErrorBox error={err} onRetry={() => start()} />}
      <p className="small muted mt-s">A session is planned from a time budget (about two minutes a question). It never cuts off an answer: if time runs out you choose to wrap up or keep going.</p>
    </section>
  );
}

function Chooser({ r, goal, setGoal, mins, setMinutes, custom, setCustom }: any) {
  const chosen = goal ?? r.goal;
  return (
    <div className="mt" role="group" aria-label="Change today’s session">
      <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="field-label">What do you want?</legend>
        {r.options.map((o: any) => (
          <label key={o.goal} className="choice" style={{ opacity: o.available ? 1 : 0.55 }}>
            <input type="radio" name="goal" checked={chosen === o.goal} disabled={!o.available} onChange={() => setGoal(o.goal)} /> <span><strong>{o.label}</strong> <span className="muted small">— {o.detail}</span></span>
          </label>))}
      </fieldset>
      <div className="row between mt-s">
        <div className="seg" role="group" aria-label="Time available">
          {[10, 20, 30].map((m) => <button key={m} aria-pressed={mins === m && custom === ''} onClick={() => setMinutes(m)}>{m} min</button>)}
        </div>
        <label className="row gap-s small muted">Other
          <input type="number" min={5} max={120} value={custom} placeholder="min" style={{ width: 80 }} onChange={(e) => { setCustom(e.target.value); const n = Number(e.target.value); if (n >= 5 && n <= 120) setMinutes(n); }} />
        </label>
      </div>
      <p className="small muted mt-s"><Chip>{mins} min budget</Chip> This sizes the plan. It is not a timer.</p>
    </div>
  );
}
