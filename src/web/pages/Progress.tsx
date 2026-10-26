import { useState } from 'react';
import { ApiError, fmtDateTime, fmtDate, pct, post, useApi } from '../api';
import { Chip, Empty, ErrorBox, LevelChip, Spinner } from '../ui';

function Rate({ r }: { r: { rate: number | null; low: number | null; high: number | null; n: number } }) {
  if (r.n === 0) return <><div className="metric">—</div><p className="small muted">No data yet</p></>;
  return <><div className="metric">{pct(r.rate)}</div><p className="small muted">{r.n} {r.n === 1 ? 'question' : 'questions'} · plausible range {pct(r.low)}–{pct(r.high)}{r.n < 8 ? ' (small sample — treat loosely)' : ''}</p></>;
}

export function Progress({ go }: { go: (p: string) => void }) {
  const p = useApi<any>('/progress');
  const h = useApi<any[]>('/history');
  const [tab, setTab] = useState<'overview' | 'history'>('overview');
  const [err, setErr] = useState<ApiError | null>(null);
  const d = p.data;
  if (p.loading && !d) return <div className="narrow"><h1>Progress</h1><Spinner /></div>;
  if (p.error && !d) return <div className="narrow"><h1>Progress</h1><ErrorBox error={p.error} onRetry={p.reload} /></div>;
  if (!d) return null;
  const maxM = Math.max(1, ...d.minutes.byDay.map((x: any) => x.minutes));
  return (
    <div className="narrow">
      <h1>Progress</h1>
      <p className="muted">What’s actually sticking — measured on unaided answers to questions you haven’t seen, not on streaks or time spent.</p>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>Overview</button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>History & corrections</button>
      </div>
      {tab === 'overview' ? (<>
        <div className="metrics">
          <div className="card"><h3>Delayed, unaided recall</h3><Rate r={d.delayedRecall} /><p className="small muted">Correct with no hints, at least ~20 hours after you last saw the idea.</p></div>
          <div className="card"><h3>New (held-out) questions</h3><Rate r={d.heldoutAccuracy} /><p className="small muted">Questions kept hidden until a check — tells learning from memorising one question. Practice questions: {d.practiceAccuracy.n ? pct(d.practiceAccuracy.rate) : '—'} ({d.practiceAccuracy.n}).</p></div>
          <div className="card"><h3>Repeated mistake patterns</h3><div className="metric">{d.misconceptions.repeated.length}</div><p className="small muted">{d.misconceptions.active} active · {d.misconceptions.repaired} repaired{d.misconceptions.repeated[0] ? ` · most frequent: “${d.misconceptions.repeated[0].label}” (${d.misconceptions.repeated[0].count}×)` : ''}</p></div>
          <div className="card"><h3>Study minutes</h3><div className="metric">{d.minutes.last7}<span className="small muted"> min / 7 days</span></div>
            <div className="spark" role="img" aria-label={`Minutes per day, last 14 days: ${d.minutes.byDay.map((x: any) => x.minutes).join(', ')}`}>{d.minutes.byDay.map((x: any) => <span key={x.date} title={`${x.date}: ${x.minutes} min`} style={{ height: `${Math.max(4, (x.minutes / maxM) * 100)}%` }} />)}</div>
            <p className="small muted">{d.minutes.last30} min in 30 days. Measured from answering time — a rough proxy.</p></div>
        </div>

        <section className="card" aria-labelledby="cov"><h2 id="cov">Coverage for upcoming tests</h2>
          {d.coverage.length === 0 ? <p className="muted">No upcoming tests yet. <a href="#/plan">Add one</a>.</p> : d.coverage.map((c: any) => (
            <div className="upcoming" key={c.itemId}><div><strong>{c.title}</strong> <span className="small muted">{c.dueLabel}</span>
              <div className="small">{!c.topicsKnown ? <span className="unknown">Topics unknown — I can’t report coverage until you say what it covers.</span> : <>{c.assessed} of {c.linked} topics checked at least once · {c.solid} holding up · {c.needRepair} need repair · {c.linked - c.assessed} not assessed</>}</div></div></div>))}
          <p className="small muted">Coverage and uncertainty only — no “you’ll get 95%”. A topic you haven’t been checked on is <em>not assessed</em>, which is different from weak.</p>
        </section>

        <section className="card" aria-labelledby="cn"><h2 id="cn">Concepts</h2>
          {d.concepts.length === 0 ? <Empty title="No concepts yet">Confirm concepts in Subjects first.</Empty> : (
            <div className="scroll-x"><table><thead><tr><th>Concept</th><th>Where it stands</th><th>Counted</th><th>Independent ✓</th><th>Next review</th></tr></thead>
              <tbody>{d.concepts.map((c: any) => <tr key={c.id}><td>{c.name}<div className="small muted">{c.subject}</div></td><td><LevelChip level={c.level} />{c.activeMisconceptions > 0 && <> <Chip tone="warn">pattern</Chip></>}</td>
                <td>{c.counted}{c.ignored ? <span className="small muted"> (+{c.ignored} not counted)</span> : null}</td><td>{c.independentSuccesses}/{c.independentAttempts}</td><td>{c.dueAt ? fmtDate(c.dueAt) : '—'}</td></tr>)}</tbody></table></div>)}
          <ul className="small muted">{d.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>
        </section>
      </>) : (
        <section className="card"><h2>Recent answers</h2>
          <p className="small muted">If a grade looks wrong, correct it — your correction replaces the automatic grade (counted a little lower than an automatic one) and the review schedule is recomputed.</p>
          {err && <ErrorBox error={err} />}
          {h.loading && !h.data && <Spinner />}
          {h.data?.length === 0 && <Empty title="No answers yet">Start a session from Today.</Empty>}
          {h.data?.map((a: any) => (
            <div key={a.id} className="upcoming" style={{ display: 'block' }}>
              <div className="row between top"><div className="grow"><strong className="small">{a.concept}</strong> <span className="small muted">{fmtDateTime(a.at)}</span>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.prompt.slice(0, 160)}</div>
                {a.answer && <div className="small muted">You: {a.answer.slice(0, 160)}</div>}</div>
                <div>{a.gradeStatus === 'graded' ? <Chip tone={a.correctness >= 0.8 ? 'good' : a.correctness >= 0.4 ? 'warn' : 'bad'}>{a.correctness >= 0.8 ? 'Correct' : a.correctness >= 0.4 ? 'Partly' : 'Missed'}{a.gradeSource === 'student' ? ' (your grade)' : ''}</Chip> : <Chip tone="warn">{a.gradeStatus === 'failed' ? 'Not graded' : 'Uncertain — not counted'}</Chip>}
                  {(a.hints > 0 || a.sawAnswer || a.idk) && <> <Chip>{a.idk ? 'I didn’t know' : a.sawAnswer ? 'saw answer' : 'hint used'}</Chip></>}</div></div>
              <div className="row gap-s mt-s"><span className="small muted">Correct this grade:</span>
                {[['Got it', 1], ['Partly', 0.5], ['Missed', 0]].map(([l, v]) => <button key={v as number} className="btn small" onClick={async () => { try { await post(`/attempts/${a.id}/self-grade`, { correctness: v }); h.reload(); p.reload(); } catch (e) { setErr(e as ApiError); } }}>{l}</button>)}</div>
            </div>))}
        </section>
      )}
    </div>
  );
}
