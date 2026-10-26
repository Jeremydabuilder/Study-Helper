import { useEffect, useState } from 'react';
import { ApiError, post, put, setWorkspace, useApi, getWorkspace } from '../api';
import { Chip, ErrorBox, Field, Spinner, Toggle, download } from '../ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WLABEL: Record<string, string> = { urgency: 'Deadline pressure', weakness: 'Needs work', overdue: 'Review overdue', prereq: 'Underpins other topics', unassessed: 'Not assessed yet', repair: 'Unresolved mistake' };

export function Settings({ go, meta }: { go: (p: string) => void; meta: any }) {
  const [tab, setTab] = useState<'profile' | 'priorities' | 'availability' | 'ai' | 'data'>('profile');
  return (
    <div className="narrow">
      <h1>Settings</h1>
      <div className="tabs" role="tablist">
        {([['profile', 'Profile'], ['priorities', 'Priorities'], ['availability', 'Availability'], ['ai', 'AI & limits'], ['data', 'Data']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'profile' && <Profile meta={meta} />}
      {tab === 'priorities' && <Priorities />}
      {tab === 'availability' && <Availability />}
      {tab === 'ai' && <AiTab />}
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
        {num('heavyDayBusyMin', 'A “busy day” has at least… (min of events)')}
        {num('heavyDayLimitMin', 'Study limit on busy days (min)', 'Tournament or long match days get less.')}
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

function AiTab() {
  const st = useApi<any>('/settings');
  const [lim, setLim] = useState<number | null>(null);
  const s = useSave();
  useEffect(() => { if (st.data) setLim(st.data.aiDailyLimit); }, [st.data]);
  if (!st.data || lim === null) return <Spinner />;
  const ai = st.data.ai;
  return (
    <section className="card"><h2>AI & usage limits</h2>
      <p><Chip tone={ai.live ? 'good' : 'warn'}>{ai.label}</Chip></p>
      {ai.live ? <p className="muted small">Questions are generated and open answers are graded by the model. The API key lives only on the server. Grades are treated as fallible: low-confidence ones don’t count until you confirm them.</p>
        : <p className="muted small">No API key is configured, so the app runs in <strong>Offline mode</strong>: math questions are generated and checked exactly by built-in tools; other subjects use basic template questions, and open answers are only keyword-checked (never counted without your confirmation). Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart for richer questions and grading.</p>}
      <p className="small">Model calls in the last 24 hours: <strong>{ai.callsToday}</strong> of {ai.dailyLimit}. Math practice never uses a model call.</p>
      <Field label="Daily model-call limit" hint="A cap to control cost. Set 0 to turn AI off entirely."><input type="number" min={0} max={5000} value={lim} onChange={(e) => setLim(Number(e.target.value))} /></Field>
      {s.err && <ErrorBox error={s.err} />}
      <div className="row mt"><button className="btn primary" onClick={() => s.run(async () => { await put('/settings', { aiDailyLimit: lim }); st.reload(); })}>{s.state === 'saved' ? 'Saved ✓' : 'Save limit'}</button></div>
    </section>
  );
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
