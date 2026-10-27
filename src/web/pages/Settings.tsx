import { useEffect, useState } from 'react';
import { ApiError, post, put, setWorkspace, useApi, getWorkspace } from '../api';
import { Chip, ErrorBox, Field, Spinner, Toggle, download } from '../ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WLABEL: Record<string, string> = { urgency: 'Deadline pressure', weakness: 'Needs work', overdue: 'Review overdue', prereq: 'Underpins other topics', unassessed: 'Not assessed yet', repair: 'Unresolved mistake' };

export function Settings({ go, meta }: { go: (p: string) => void; meta: any }) {
  const [tab, setTab] = useState<'setup' | 'profile' | 'priorities' | 'availability' | 'data'>(() => (window.location.hash.includes('tab=') ? (window.location.hash.split('tab=')[1] as never) : 'setup'));
  return (
    <div className="narrow">
      <h1>Settings</h1>
      <div className="tabs" role="tablist">
        {([['setup', 'Setup & usage'], ['profile', 'Profile'], ['priorities', 'Priorities'], ['availability', 'Availability'], ['data', 'Data']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'setup' && <SetupTab />}
      {tab === 'profile' && <Profile meta={meta} />}
      {tab === 'priorities' && <Priorities />}
      {tab === 'availability' && <Availability />}
      {tab === 'data' && <DataTab go={go} />}
    </div>
  );
}

function useSave() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<any>) => { setState('saving'); setErr(null); try { await fn(); setState('saved'); setTimeout(() => setState('idle'), 2000); } catch (e) { setErr(e as ApiError); setState('idle'); } };
  return { state, err, run };
}

function Profile({ meta }: { meta: any }) {
  const p = useApi<any>('/profile');
  const [v, setV] = useState<any>(null);
  const s = useSave();
  useEffect(() => { if (p.data) setV({ name: p.data.name, grade: p.data.grade, timezone: p.data.timezone, defaultMinutes: p.data.default_minutes, about: p.data.about }); }, [p.data]);
  if (!v) return <Spinner />;
  const tzs = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') as string[] : [v.timezone];
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); s.run(() => put('/profile', { ...v, defaultMinutes: Number(v.defaultMinutes) })); }}>
      <h2>Your profile</h2><p className="muted small">Nothing here is assumed permanent — edit it any time. Subjects are added on the Subjects page, for any grade.</p>
      <div className="grid2"><Field label="Name"><input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Grade / level"><input value={v.grade} onChange={(e) => setV({ ...v, grade: e.target.value })} placeholder="e.g. 8" /></Field>
        <Field label="Time zone" hint="Used for “today”, due dates and calendar times."><select value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>{[...new Set([v.timezone, ...tzs])].map((z) => <option key={z}>{z}</option>)}</select></Field>
        <Field label="Usual study time (minutes)"><input type="number" min={5} max={120} value={v.defaultMinutes} onChange={(e) => setV({ ...v, defaultMinutes: e.target.value })} /></Field></div>
      <Field label="About how you study (optional)" hint="Shown only to you. Specific preferences are better saved as notes on the Memory page."><textarea value={v.about} onChange={(e) => setV({ ...v, about: e.target.value })} rows={3} maxLength={600} /></Field>
      {s.err && <ErrorBox error={s.err} />}
      <div className="row mt"><button className="btn primary" disabled={s.state === 'saving'}>{s.state === 'saved' ? 'Saved ✓' : 'Save profile'}</button></div>
    </form>
  );
}

function Priorities() {
  const st = useApi<any>('/settings');
  const [w, setW] = useState<any>(null);
  const s = useSave();
  useEffect(() => { if (st.data) setW(st.data.weights); }, [st.data]);
  if (!w || !st.data) return <Spinner />;
  return (
    <section className="card"><h2>How “what to study next” is decided</h2>
      <p className="muted small">The Today list is ordered by a weighted sum of these inputs. Turn a weight up or down to match how you work — set to 0 to ignore it. The result is an <strong>ordering heuristic</strong>, not a prediction of any grade.</p>
      {Object.keys(w).map((k) => (
        <div key={k} className="mb-s">
          <label className="field-label" htmlFor={`w-${k}`}>{WLABEL[k]} <span className="muted">· {w[k]}</span></label>
          <input id={`w-${k}`} type="range" min={0} max={5} step={0.5} value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
          <span className="hint">{st.data.weightHelp[k]}</span>
        </div>))}
      <details><summary>The rules in plain words</summary><ul className="small">
        <li>A concept never checked is <em>not assessed</em> (a quick check comes first) — not “weak”.</li>
        <li>A repeated hint or miss makes it “needs repair”; one correct answer never makes it “mastered”.</li>
        <li>Reviews come back at growing gaps only after unaided, delayed success. Hinted or just-explained successes get a next-day re-check.</li>
        <li>Solid topics aren’t drilled again until a review is due or a test is close.</li>
        <li>At most 5 tasks and 6 reviews a day, so a missed day never turns into an intimidating backlog.</li></ul></details>
      {s.err && <ErrorBox error={s.err} />}
      <div className="row mt"><button className="btn primary" onClick={() => s.run(() => put('/settings', { weights: w }))}>{s.state === 'saved' ? 'Saved ✓' : 'Save priorities'}</button>
        <button className="btn" onClick={() => setW(st.data.defaultWeights)}>Reset to defaults</button></div>
    </section>
  );
}

function Availability() {
  const st = useApi<any>('/settings');
  const [a, setA] = useState<any>(null);
  const s = useSave();
  useEffect(() => { if (st.data) setA(st.data.availability); }, [st.data]);
  if (!a || !st.data) return <Spinner />;
  const set = (k: string, v: any) => setA({ ...a, [k]: v });
  const num = (k: string, label: string, hint?: string) => <Field label={label} hint={hint}><input type="number" value={a[k]} onChange={(e) => set(k, Number(e.target.value))} /></Field>;
  return (
    <section className="card"><h2>Availability</h2>
      <p className="muted small">Calendar busy time is subtracted, but that doesn’t make every other minute free. These limits decide how much study I’ll ever schedule.</p>
      <h3>Daily study limit (minutes)</h3>
      <div className="row gap-s">{DAYS.map((d, i) => <label key={d} className="small" style={{ width: 70 }}>{d}<input type="number" min={0} max={600} value={a.dailyLimitMin[i]} onChange={(e) => set('dailyLimitMin', a.dailyLimitMin.map((x: number, j: number) => (j === i ? Number(e.target.value) : x)))} /></label>)}</div>
      <div className="grid2 mt-s">
        <Field label="Preferred study window starts"><input type="time" value={a.preferredStart} onChange={(e) => set('preferredStart', e.target.value)} /></Field>
        <Field label="…and ends"><input type="time" value={a.preferredEnd} onChange={(e) => set('preferredEnd', e.target.value)} /></Field>
        <Field label="Bedtime"><input type="time" value={a.bedtime} onChange={(e) => set('bedtime', e.target.value)} /></Field>
        {num('windDownMin', 'Wind-down before bed (min)', 'No study scheduled in this window.')}
        {num('bufferBeforeMin', 'Buffer before busy events (min)', 'Travel / getting ready.')}
        {num('bufferAfterMin', 'Buffer after busy events (min)', 'Cool-down, snack, travel home.')}
        {num('heavyDayBusyMin', 'A “heavy day” has at least… (min of non-school events)', 'Class time on a calendar labelled “School” never counts.')}
        {num('heavyDayLimitMin', 'Study limit on heavy days (min)', 'Tournament or long match days get less.')}
        {num('minBlockMin', 'Shortest study block (min)')}{num('maxBlockMin', 'Longest study block (min)')}
        {num('testPrepDays', 'Start test prep this many days ahead')}{num('defaultTestPrepMin', 'Default total prep for a test (min)', 'Used when you haven’t said how much you need.')}
        {num('defaultHomeworkMin', 'Default time for homework (min)')}{num('homeworkBufferDays', 'Finish homework this many days early', '0 = work up to the due day.')}
      </div>
      <h3 className="mt">Protected time</h3><p className="small muted">Never scheduled over — meals, family, free time.</p>
      {a.protected.map((p: any, i: number) => (
        <div key={i} className="row gap-s mb-s">
          <input aria-label="Label" value={p.label} style={{ width: 170 }} onChange={(e) => set('protected', a.protected.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <input type="time" aria-label="From" value={p.start} style={{ width: 110 }} onChange={(e) => set('protected', a.protected.map((x: any, j: number) => (j === i ? { ...x, start: e.target.value } : x)))} />–
          <input type="time" aria-label="To" value={p.end} style={{ width: 110 }} onChange={(e) => set('protected', a.protected.map((x: any, j: number) => (j === i ? { ...x, end: e.target.value } : x)))} />
          <span className="small muted">{p.days.length === 7 ? 'every day' : p.days.map((d: number) => DAYS[d]).join(' ')}</span>
          <button className="btn small ghost danger" onClick={() => set('protected', a.protected.filter((_: any, j: number) => j !== i))}>Remove</button>
        </div>))}
      <button className="btn small" onClick={() => set('protected', [...a.protected, { label: 'Free time', days: [0, 1, 2, 3, 4, 5, 6], start: '17:00', end: '18:00' }])}>+ Add protected time</button>
      {s.err && <ErrorBox error={s.err} />}
      <div className="row mt"><button className="btn primary" onClick={() => s.run(() => put('/settings', { availability: a }))}>{s.state === 'saved' ? 'Saved — plan updated ✓' : 'Save availability'}</button><button className="btn" onClick={() => setA(st.data.defaultAvailability)}>Reset to defaults</button></div>
    </section>
  );
}

const AI_MODE: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  offline: { tone: 'neutral', text: 'Offline mode' }, configured_unverified: { tone: 'warn', text: 'AI configured — not yet verified' },
  connection_verified: { tone: 'warn', text: 'Connection works — study output not verified yet' }, output_verified: { tone: 'good', text: 'Study output verified' },
  output_problem: { tone: 'bad', text: 'Connected, but recent study output was unusable' }, verify_failed: { tone: 'bad', text: 'AI credentials rejected' },
};
const CAL_STATE: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  not_configured: { tone: 'neutral', text: 'Google Calendar not set up on this server' }, disconnected: { tone: 'neutral', text: 'Calendar disconnected' },
  connected: { tone: 'good', text: 'Calendar connected (read-only)' }, reauth_required: { tone: 'bad', text: 'Calendar needs reconnecting' }, error: { tone: 'warn', text: 'Calendar sync problem' },
};
const usd = (x: number) => `$${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)}`;

function SetupTab() {
  const st = useApi<any>('/status');
  const us = useApi<any>('/ai/usage');
  const cfg = useApi<any>('/settings');
  const [budget, setBudget] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [vres, setVres] = useState<any>(null);
  const s = useSave();
  useEffect(() => { if (cfg.data) { setBudget(cfg.data.aiDailyBudgetUsd); setLimit(cfg.data.aiDailyLimit); } }, [cfg.data]);
  if (!st.data || !us.data || budget === null || limit === null) return <Spinner />;
  const ai = st.data.ai, cal = st.data.calendar, u = us.data;
  const m = AI_MODE[ai.mode], c = CAL_STATE[cal.state];
  const verify = async (level: 'connection' | 'output') => { setVerifying(true); setVres(null); try { setVres(await post('/ai/verify', { level })); } catch (e) { setVres({ error: (e as ApiError).message }); } finally { setVerifying(false); st.reload(); us.reload(); } };
  const pctSpent = Math.min(100, (u.spentUsd / Math.max(u.budgetUsd, 0.0001)) * 100);
  return (<>
    <section className="card" aria-labelledby="ai-h"><h2 id="ai-h">AI</h2>
      <p><Chip tone={m.tone}>{m.text}</Chip> <span className="muted small">{ai.label}</span></p>
      <p className="small muted">{ai.detail}</p>
      {!ai.live ? (
        <details open={ai.mode === 'offline'}><summary>How to turn on AI</summary>
          <ol className="small"><li>Create an API key in the Anthropic Console.</li><li>Copy <code>.env.example</code> to <code>.env</code> and set <code>ANTHROPIC_API_KEY=…</code> (the key stays on the server and is never shown here).</li><li>Restart the app, then come back and press <strong>Verify connection</strong>.</li></ol></details>
      ) : (<>
        <div className="scroll-x"><table><thead><tr><th>Task</th><th>Model</th><th>Max output</th><th>Effort</th></tr></thead><tbody>
          {ai.tasks.map((t: any) => <tr key={t.task}><td>{t.task === 'extract' ? 'Find concepts' : t.task === 'generate' ? 'Write questions' : 'Grade open answers'}</td><td className="mono">{t.model}</td><td>{t.maxOutputTokens} tokens</td><td>{t.effort ?? 'default'}</td></tr>)}</tbody></table></div>
        <p className="small muted mt-s"><strong>Privacy:</strong> while AI is on, the passages of your material needed for a task, your answers to open questions, and a few relevant memory notes are sent to <strong>{ai.providerName === 'anthropic' ? 'Anthropic' : ai.providerName === 'groq' ? 'Groq' : ai.providerName}</strong> only. Nothing is sent to any other provider, and math practice never calls a model. Models are set in <code>.env</code> (see README).</p>
        <div className="row"><button className="btn" onClick={() => verify('connection')} disabled={verifying}>{verifying ? 'Checking…' : 'Verify connection'}</button> <button className="btn primary" onClick={() => verify('output')} disabled={verifying}>{verifying ? 'Checking…' : 'Verify study output'}</button></div>
        <p className="small muted">“Connection” only proves the key and network work (one tiny request per model). “Study output” runs one tiny real task per role — find concepts, write a question, grade an answer — and passes only if the reply is valid. Both cost a fraction of a cent.</p>
        {ai.verification?.length > 0 && <div className="scroll-x"><table><thead><tr><th>Task</th><th>Model</th><th>Status</th></tr></thead><tbody>{ai.verification.map((v: any) => <tr key={v.task}><td>{v.task}</td><td className="mono small">{v.model}</td><td>{({ unverified: 'not verified', connection_verified: 'connection only', output_verified: 'valid output seen', output_invalid: 'last output was unusable', auth_failed: 'credentials rejected' } as Record<string, string>)[v.status]}</td></tr>)}</tbody></table></div>}
        {vres?.error && <ErrorBox error={vres.error} />}
        {vres?.results?.map((r: any) => <p key={`${r.task}${r.model}`} className={`small ${r.ok ? '' : 'unknown'}`}>{r.ok ? '✓' : '✗'} {r.task ? `${r.task} · ` : ''}<span className="mono">{r.model}</span> — {r.ok ? `ok (${r.latencyMs} ms)` : r.error}</p>)}
      </>)}
    </section>

    <section className="card" aria-labelledby="ocr-h"><h2 id="ocr-h">Reading scans and screenshots</h2>
      <p><Chip tone={st.data.ocr?.available ? 'good' : 'neutral'}>{st.data.ocr?.available ? 'Available (Anthropic)' : 'Off'}</Chip> <span className="small muted">Live reading has not been verified in this build; fixtures only until you try it.</span></p>
      {st.data.ocr?.available
        ? <p className="small muted">When you ask to read a scanned page or screenshot you will see the provider, model and exactly which pages are sent, with a worst-case cost, and must approve it. Usage counts in the budget below. The reader only transcribes; math, diagrams and anything unclear are flagged for you to check.</p>
        : <><p className="small muted">{st.data.ocr?.reason} Without it you can always type a scanned page beside the original.</p>{st.data.ocr?.steps?.length > 0 && <ol className="small">{st.data.ocr.steps.map((x: string, i: number) => <li key={i}>{x}</li>)}</ol>}</>}
    </section>

    {ai.live && (
      <section className="card" aria-labelledby="use-h"><h2 id="use-h">Usage & budget (last 24 hours)</h2>
        <p className="metric" style={{ fontSize: '1.5rem' }}>{usd(u.spentUsd)} <span className="small muted">spent (estimated) of {usd(u.budgetUsd)} budget{u.heldUsd > 0 && <> · <strong>{usd(u.heldUsd)}</strong> held</>}</span></p>
        <div className="bar" role="img" aria-label={`${Math.round(pctSpent)} percent of the daily budget`}><span style={{ width: `${pctSpent}%`, background: pctSpent > 85 ? 'var(--bad)' : undefined }} /></div>
        <p className="small muted mt-s">{u.requests} request{u.requests === 1 ? '' : 's'} ({u.billableRequests} billable) · limit {u.requestLimit} · latency p50 {u.latencyMs.p50 ?? '—'} ms, p95 {u.latencyMs.p95 ?? '—'} ms</p>
        {u.byPurpose.length > 0 && <div className="scroll-x"><table><thead><tr><th>Purpose</th><th>Requests</th><th>Retries</th><th>Failed</th><th>Tokens in / out</th><th>Est. cost</th></tr></thead><tbody>
          {u.byPurpose.map((r: any) => <tr key={r.key}><td>{r.key}</td><td>{r.requests}</td><td>{r.retries}</td><td>{r.failures}</td><td>{r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</td><td>{usd(r.usd)}</td></tr>)}</tbody></table></div>}
        {(u.inFlight > 0 || u.unknownBilling.requests > 0) && <p className="small muted">{u.inFlight > 0 && <>{u.inFlight} request(s) in flight. </>}{u.unknownBilling.requests > 0 && <>{u.unknownBilling.requests} request(s) have <strong>unknown billing</strong> (e.g. a timeout — the provider may still have charged); {usd(u.unknownBilling.heldUsd)} stays held against the budget for 24 h.</>}</p>}
        <div className="notice info small">{u.policy} Prices as of {u.pricingAsOf}.{u.estimatedUsageRequests ? ` ${u.estimatedUsageRequests} request(s) had no provider token counts and are estimated.` : ''}{u.unknownPriceRequests ? ` ${u.unknownPriceRequests} request(s) used a model with no known price (a conservative fallback is applied) — set AI_PRICE_IN_PER_MTOK / AI_PRICE_OUT_PER_MTOK.` : ''}</div>
        <div className="grid2">
          <Field label="Daily budget (USD, estimated)" hint="Checked on the server before every request (including retries) against spend plus held amounts. A guardrail from list-price estimates, not a guaranteed ceiling. 0 turns AI off."><input type="number" min={0} step={0.25} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></Field>
          <Field label="Daily request limit"><input type="number" min={0} max={5000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></Field>
        </div>
        {s.err && <ErrorBox error={s.err} />}
        <div className="row mt-s"><button className="btn primary" onClick={() => s.run(async () => { await put('/settings', { aiDailyBudgetUsd: budget, aiDailyLimit: limit }); st.reload(); us.reload(); })}>{s.state === 'saved' ? 'Saved ✓' : 'Save limits'}</button></div>
        {u.recent.length > 0 && <details className="mt-s"><summary>Recent requests</summary><div className="scroll-x"><table><thead><tr><th>When</th><th>Purpose</th><th>Model</th><th>Try</th><th>Result</th><th>Tokens</th><th>ms</th><th>Billing</th><th>Cost</th></tr></thead><tbody>
          {u.recent.map((r: any, i: number) => <tr key={i}><td>{new Date(r.at).toLocaleTimeString()}</td><td>{r.purpose}</td><td className="mono small">{r.model}</td><td>{r.attempt}</td><td>{r.outcome}</td><td>{r.inputTokens ?? '—'}/{r.outputTokens ?? '—'}</td><td>{r.latencyMs}</td><td>{r.billing?.replace('_', ' ')}</td><td>{usd(r.usd)}{r.heldUsd > 0 && <span className="muted"> (+{usd(r.heldUsd)} held)</span>}</td></tr>)}</tbody></table></div></details>}
      </section>)}

    <section className="card" aria-labelledby="cal-h"><h2 id="cal-h">Google Calendar</h2>
      <p><Chip tone={c.tone}>{c.text}</Chip>{cal.demo && <> <Chip tone="warn">sample calendar</Chip></>}</p>
      {cal.state === 'not_configured' && !cal.demo && <>
        <p className="small muted">{cal.partialConfig ? 'Setup is incomplete: ' : 'To enable it, set '}{cal.missingEnv.length ? <>missing <code>{cal.missingEnv.join(', ')}</code> in <code>.env</code>.</> : 'the Google variables in .env.'} Manual entry works without it.</p>
        <p className="small">Register exactly this <strong>Authorized redirect URI</strong> in Google Cloud Console: <code>{cal.redirectUri}</code></p></>}
      {cal.state === 'reauth_required' && <p className="small">{cal.lastError} <a href="#/calendar">Reconnect</a></p>}
      <p className="small"><a href="#/calendar">Open calendar settings</a>. Step-by-step Google Cloud setup is in <code>docs/GOOGLE_SETUP.md</code>. Only the read-only calendar permission is requested.</p>
    </section>

    <section className="card"><h2>Security boundary</h2><p className="small">{st.data.boundary} Secrets (API keys, Google tokens) stay on the server and are never sent to your browser or written to logs; Google tokens are stored encrypted.</p></section>
  </>);
}

function DataTab({ go }: { go: (p: string) => void }) {
  const ws = getWorkspace();
  const [secs, setSecs] = useState<Record<string, boolean>>({ profile: true, settings: true, memories: true, learning: true, items: true });
  const [withText, setWithText] = useState(true);
  const [file, setFile] = useState<any>(null);
  const [prev, setPrev] = useState<any>(null);
  const [sel, setSel] = useState<any>({ profile: false, settings: false, memoryIds: [], subjectIds: [], itemIds: [] });
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);

  const doExport = async () => { setErr(null); try { const d = await post('/export', { sections: Object.keys(secs).filter((k) => secs[k]), includeSourceText: withText }); download(`study-helper-export-${new Date().toISOString().slice(0, 10)}.json`, d); } catch (e) { setErr(e as ApiError); } };
  const onFile = async (f?: File) => {
    setPrev(null); setDone(null); setFileErr(null); if (!f) return;
    try { const j = JSON.parse(await f.text()); setFile(j); const p = await post('/import/preview', { file: j }); setPrev(p); setSel({ profile: false, settings: false, memoryIds: [], subjectIds: [], itemIds: [] }); }
    catch (e) { setFile(null); setFileErr(e instanceof ApiError ? e.message : 'That file isn’t valid JSON.'); }
  };
  const commit = async () => { setErr(null); try { const r = await post('/import/commit', { file, selection: sel }); setDone(`Imported: ${Object.entries(r.imported).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'nothing selected'}.`); setPrev(null); } catch (e) { setErr(e as ApiError); } };
  const toggleIn = (key: string, id: string) => setSel({ ...sel, [key]: sel[key].includes(id) ? sel[key].filter((x: string) => x !== id) : [...sel[key], id] });

  return (<>
    <section className="card"><h2>Which data are you using?</h2>
      <p>{ws === 'demo' ? <><Chip tone="warn">Sample data</Chip> You’re looking at made-up records.</> : <><Chip tone="good">Your data</Chip> Stored in the <code>data/</code> folder on this computer.</>}</p>
      <div className="row"><button className="btn" onClick={() => { setWorkspace(ws === 'demo' ? 'real' : 'demo'); go('/'); }}>{ws === 'demo' ? 'Switch to my data' : 'Explore with sample data'}</button>
        {ws === 'demo' && <button className="btn" onClick={async () => { await post('/demo/reset'); window.dispatchEvent(new Event('workspace-changed')); }}>Reset sample data</button>}</div>
      <p className="small muted mt-s">Sample and real records live in separate database files and never mix.</p></section>

    <section className="card"><h2>Export</h2>
      <p className="muted small">A JSON file you choose the contents of. Import it later (or on another computer) to restore a study profile or learning history.</p>
      {[['profile', 'Profile'], ['settings', 'Priorities & availability'], ['memories', 'Memory notes'], ['learning', 'Subjects, concepts, questions & attempts'], ['items', 'Manually entered tests & homework']].map(([k, l]) => <Toggle key={k} checked={secs[k]} onChange={(v) => setSecs({ ...secs, [k]: v })} label={l} />)}
      {secs.learning && <Toggle checked={withText} onChange={setWithText} label="Include the full text of my materials" hint="Untick to export only titles and concepts." />}
      {err && <ErrorBox error={err} />}
      <div className="row mt"><button className="btn primary" onClick={doExport}>Download export</button></div>
    </section>

    <section className="card"><h2>Import (with preview)</h2>
      <p className="muted small">Choosing a file shows what’s inside and changes nothing. You then pick exactly what to bring in. Imports go only into <em>your</em> data.</p>
      <input type="file" accept="application/json,.json" aria-label="Choose an export file" onChange={(e) => onFile(e.target.files?.[0])} />
      {fileErr && <div className="notice bad" role="alert">{fileErr}</div>}
      {done && <div className="notice good" role="status">{done}</div>}
      {prev && (<div className="mt">
        {prev.warnings.map((w: string, i: number) => <div key={i} className="notice warn small">{w}</div>)}
        <p className="small muted">Exported {new Date(prev.file.exportedAt).toLocaleString()} · format v{prev.file.version}</p>
        {prev.profile.present && <Toggle checked={sel.profile} onChange={(v) => setSel({ ...sel, profile: v })} label={`Profile: ${prev.profile.name || '(no name)'}, grade ${prev.profile.grade || '—'}, ${prev.profile.timezone}`} hint={prev.profile.differsFromCurrent ? 'Replaces your current profile.' : 'Same as your current profile.'} />}
        {prev.settings.present && <Toggle checked={sel.settings} onChange={(v) => setSel({ ...sel, settings: v })} label={`Settings: ${prev.settings.keys.join(', ')}`} />}
        {prev.memories.length > 0 && <><h3 className="mt-s">Memory notes</h3>{prev.memories.map((m: any) => <Toggle key={m.id} checked={sel.memoryIds.includes(m.id)} onChange={() => toggleIn('memoryIds', m.id)} label={`“${m.text}”`} hint={`${m.kind.replace('_', ' ')}${m.isNew ? '' : ' · already here'}`} />)}</>}
        {prev.subjects.length > 0 && <><h3 className="mt-s">Subjects & history</h3>{prev.subjects.map((s: any) => <Toggle key={s.id} checked={sel.subjectIds.includes(s.id)} onChange={() => toggleIn('subjectIds', s.id)} label={s.name} hint={`${s.sources} materials · ${s.concepts} concepts · ${s.attempts} attempts${s.isNew ? '' : ' · already here (will merge)'}`} />)}</>}
        {prev.items.length > 0 && <><h3 className="mt-s">Tests & homework</h3>{prev.items.map((s: any) => <Toggle key={s.id} checked={sel.itemIds.includes(s.id)} onChange={() => toggleIn('itemIds', s.id)} label={`${s.title} (${s.type}${s.due ? `, ${s.due}` : ''})`} />)}</>}
        {ws === 'demo' && <div className="notice warn small">You’re in the sample workspace. Switch to your data to import.</div>}
        <div className="row mt"><button className="btn primary" disabled={ws === 'demo'} onClick={commit}>Import selected</button><button className="btn" onClick={() => { setPrev(null); setFile(null); }}>Cancel</button></div>
      </div>)}
    </section>
  </>);
}
