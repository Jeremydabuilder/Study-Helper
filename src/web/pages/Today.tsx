import { useState } from 'react';
import { ApiError, post, setWorkspace, useApi } from '../api';
import { Chip, ErrorBox, Modal, Spinner } from '../ui';
import { RecommendationCard } from './Recommendation';

const WEIGHT_LABEL: Record<string, string> = { urgency: 'Deadline pressure', weakness: 'Needs work', overdue: 'Review overdue', prereq: 'Underpins other topics', unassessed: 'Not assessed yet', repair: 'Unresolved mistake' };

export function Today({ go, meta }: { go: (p: string) => void; meta: any }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const today = useApi<any>(`/today${minutes ? `?minutes=${minutes}` : ''}`, [minutes]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState<any>(null);
  const status = useApi<any>('/status');
  const t = today.data;

  if (today.loading && !t) return <div className="narrow"><h1>Today</h1><div className="skeleton" style={{ height: 120 }} /><div className="skeleton" /><div className="skeleton" /></div>;
  if (today.error && !t) return <div className="narrow"><h1>Today</h1><ErrorBox error={today.error} onRetry={today.reload} /></div>;
  if (!t) return null;

  const mins = minutes ?? t.minutes;
  const start = async (abandonExisting = false) => {
    setStarting(true); setErr(null);
    try { const r = await post('/sessions', { mode: 'mixed', minutes: mins, abandonExisting }); go(`/study/${r.id}`); }
    catch (e) { const ae = e as ApiError; if (ae.code === 'session_active') setConflict(ae.extra); else setErr(ae); }
    finally { setStarting(false); }
  };
  const override = async (conceptId: string, action: 'pin' | 'skip') => { await post('/plan/override', { conceptId, action }); today.reload(); };

  return (
    <div className="narrow">
      <p className="muted small" style={{ margin: 0 }}>{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(t.now))}</p>
      <h1>{meta?.profile?.name ? `Hi ${meta.profile.name.replace(/ \(sample\)/, '')} 👋` : 'Today'}</h1>

      {status.data && status.data.workspace === 'real' && (status.data.ai.mode !== 'output_verified' || ['reauth_required', 'error'].includes(status.data.calendar.state)) && (
        <div className="notice info small" role="status">
          {status.data.ai.mode === 'offline' && <>Running in <strong>Offline mode</strong> — math is fully supported; other subjects use basic questions. </>}
          {status.data.ai.mode === 'configured_unverified' && <>AI is configured but <strong>not yet verified</strong>. </>}
          {status.data.ai.mode === 'connection_verified' && <>AI connection works, but <strong>study output has not been verified</strong> yet. </>}
          {status.data.ai.mode === 'output_problem' && <>AI is connected but its <strong>latest output was unusable</strong>. </>}
          {status.data.ai.mode === 'verify_failed' && <>The AI provider <strong>rejected the credentials</strong>. </>}
          {status.data.calendar.state === 'reauth_required' && <>Your calendar needs reconnecting. </>}
          <a href="#/settings">Setup & status</a>
        </div>)}
      {t.welcomeBack && <div className="notice info" role="status">{t.welcomeBack.message}</div>}
      {err && <ErrorBox error={err} onRetry={() => start()} />}

      <RecommendationCard t={t} mins={mins} setMinutes={(m: number) => { setMinutes(m); setCustom(''); }} go={go} onSample={() => setWorkspace('demo')} />

      {!t.empty && t.plan.tasks.length > 0 && (
        <details className="card" style={{ padding: '.9rem 1.1rem' }}>
          <summary><strong>See today’s full plan</strong> <span className="muted small">(topics ranked by deadline, weakness and review dates)</span></summary>
          <ol style={{ listStyle: 'none', padding: 0, margin: '.6rem 0 0' }}>
            {t.plan.tasks.map((k: any, i: number) => (
              <li className="task" key={k.conceptId}>
                <span className="task-num" aria-hidden>{i + 1}</span>
                <div className="grow">
                  <div className="row between top"><div><span className="task-title">{k.verb}: {k.conceptName}</span><div className="muted small">{k.subjectName}</div></div><Chip>{k.minutes} min</Chip></div>
                  <p className="why mb-s">{k.reasons.slice(0, 2).join(' ')}</p>
                  <details>
                    <summary>Why this order? (see the rule inputs)</summary>
                    <div className="bars" role="list" aria-label={`Priority inputs for ${k.conceptName}`}>
                      {Object.entries(k.components).map(([key, v]: any) => (
                        <div key={key} style={{ display: 'contents' }} role="listitem"><span>{WEIGHT_LABEL[key]}</span><div className="bar" aria-hidden><span style={{ width: `${Math.round(v * 100)}%` }} /></div><span>{Math.round(v * 100)}%</span></div>
                      ))}
                    </div>
                    <p className="small muted mt-s">Each input is combined using the weights in Settings → Priorities. The result is an ordering aid, not a prediction.</p>
                  </details>
                  <div className="row gap-s mt-s">
                    <button className="btn small ghost" onClick={() => override(k.conceptId, 'skip')}>Skip today</button>
                    {!k.pinned && i > 0 && <button className="btn small ghost" onClick={() => override(k.conceptId, 'pin')}>Do this first</button>}
                    {k.pinned && <Chip tone="info">Pinned by you</Chip>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {t.plan.deferredNote && <div className="notice info small">{t.plan.deferredNote} <button className="btn small" onClick={async () => { await post('/plan/rebuild'); today.reload(); }}>Spread them out</button></div>}
          {t.plan.skipped.length > 0 && <p className="small muted">Skipped for today: {t.plan.skipped.join(', ')}</p>}
          <p className="small muted mt-s">{t.heuristicNote}</p>
        </details>
      )}

      {t.attention.length > 0 || t.pendingProposals > 0 || t.schedule.changes.some((c: any) => c.kind !== 'added') ? (
        <section className="card" aria-labelledby="att-h">
          <h2 id="att-h">Needs your attention</h2>
          {t.pendingProposals > 0 && <p><a href="#/calendar">{t.pendingProposals} calendar item{t.pendingProposals === 1 ? '' : 's'} to confirm</a> — I only plan around things you confirm.</p>}
          {t.schedule.changes.filter((c: any) => c.kind !== 'added').map((c: any) => <p key={c.id} className="small"><Chip tone="warn">{c.kind}</Chip> {c.title}{c.detail ? ` — ${c.detail}` : ''}</p>)}
          {t.attention.slice(0, 4).map((a: any, i: number) => <p key={i} className="small">{a.message} <a href="#/plan">Open</a></p>)}
        </section>
      ) : null}

      <section className="card" aria-labelledby="up-h">
        <div className="row between"><h2 id="up-h">Coming up</h2><a href="#/plan" className="small">Plan & calendar</a></div>
        {t.upcoming.length === 0 ? <p className="muted">No tests or deadlines yet. <a href="#/plan">Add one</a> or <a href="#/calendar">connect your calendar</a> so I can plan around them.</p> :
          t.upcoming.slice(0, 6).map((u: any) => (
            <div className="upcoming" key={u.id}>
              <div><strong>{u.title}</strong> <Chip>{u.typeLabel}</Chip>{!u.topicsKnown && ['test', 'quiz', 'presentation'].includes(u.type) && <> <Chip tone="warn">topics unknown</Chip></>}
                <div className="small muted">{u.subjectName ?? 'No subject'} · {u.dueLabel}</div></div>
              <div className="days-left">{u.daysLeft === null ? '—' : u.daysLeft === 0 ? 'Today' : u.daysLeft === 1 ? 'Tomorrow' : `${u.daysLeft} days`}</div>
            </div>
          ))}
        {t.schedule.today.length > 0 && (<><hr /><h3>Planned around your day</h3>
          {t.schedule.today.map((b: any, i: number) => <p key={i} className="small" style={{ margin: '.2rem 0' }}><strong>{b.startLabel}</strong> · {b.minutes} min · {b.title} <span className="muted">({b.kind === 'test_prep' ? 'test prep' : b.kind})</span></p>)}</>)}
      </section>

      {conflict && (
        <Modal title="You have a session in progress" onClose={() => setConflict(null)}>
          <p>Pick up where you left off, or start fresh (your answers so far are kept).</p>
          <div className="row"><button className="btn primary" onClick={() => go(`/study/${conflict.sessionId}`)}>Resume</button><button className="btn" onClick={() => { setConflict(null); start(true); }}>Start new</button></div>
        </Modal>
      )}
      {today.loading && <Spinner label="Updating…" />}
    </div>
  );
}
