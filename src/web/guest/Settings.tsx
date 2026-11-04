import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { PageTop } from '../myhelper/Shell';
import { DEFAULT_MODEL, isValidKey, removeKey, setKey, setModel, useKeyState } from './keystore';
import { KeyTest, testKey, useGuest, useProvider } from './store';

/** Settings: where a visitor brings their own Groq key. Everything else in the app works before (and without) this. */
export function Settings() {
  const { status } = useGuest(); const prov = useProvider(); const k = useKeyState();
  const [draft, setDraft] = useState(''); const [show, setShow] = useState(false); const [remember, setRemember] = useState(false);
  const [model, setModelState] = useState(k.model); const [custom, setCustom] = useState('');
  const [testing, setTesting] = useState(false); const [result, setResult] = useState<KeyTest | null>(null); const [problem, setProblem] = useState<string | null>(null); const [note, setNote] = useState<string | null>(null);
  const [wait, setWait] = useState(0); const busy = useRef(false);
  const models = status?.byok?.models ?? [DEFAULT_MODEL];
  const chosenModel = (model === '__custom' ? custom : model).trim() || DEFAULT_MODEL;
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);
  useEffect(() => { if (k.has) setModelState(k.model); }, [k.has, k.model]);

  const test = async () => {
    if (busy.current) return; busy.current = true; setTesting(true); setResult(null); setProblem(null);
    try {
      const r = await testKey(draft, chosenModel); setResult(r);
      if (r.kind === 'rate_limited' && r.retryAfterMs) setWait(Math.min(120, Math.ceil(r.retryAfterMs / 1000)));
    } catch (e) { setProblem(e instanceof ApiError ? (e.code === 'network' ? 'Could not reach this site. Check your connection and try again.' : e.message) : 'The test could not be run.'); }
    finally { busy.current = false; setTesting(false); }
  };
  const use = () => {
    const err = setKey(draft, chosenModel, remember); setDraft(''); setShow(false); setNote(err ?? (remember ? 'Using your key. It is remembered on this device.' : 'Using your key for this tab. It is kept in memory only and is forgotten when you reload or close the tab.'));
  };
  const remove = () => { removeKey(); setDraft(''); setShow(false); setResult(null); setProblem(null); setRemember(false); setModelState(DEFAULT_MODEL); setNote('Your key was removed from this browser: from memory and from storage. AI actions are off until you add a key again.'); };
  const changeModel = (m: string) => { setModelState(m); if (k.has && m !== '__custom') setModel(m); };
  const ok = isValidKey(draft);

  return (<>
    <PageTop eyebrow="Study assistant" title="Settings" />
    <section className="mh-panel" aria-labelledby="ai-h">
      <h3 id="ai-h">Bring your own Groq key</h3>
      <p className="mh-sub" style={{ fontSize: 13 }}>AI requests use <strong>your</strong> Groq account and its usage limits. The site never uses its own key for you while yours is set. Planning, practice cards and review work without any key.</p>
      <div className="mh-notice good" role="status" aria-live="polite">Assistant: <strong>{prov.label}</strong>{k.has ? (k.remembered ? ' · remembered on this device' : ' · memory only, this tab') : ''}</div>
      {!prov.byokAllowed && status && <div className="mh-notice">This site has switched off bringing your own key.</div>}
      {prov.byokAllowed && <>
        <div className="mh-field" style={{ marginTop: 14 }}><label htmlFor="gk">Groq API key</label>
          <div className="mh-row" style={{ flexWrap: 'nowrap' }}>
            <input id="gk" type={show ? 'text' : 'password'} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} name="groq-api-key" placeholder={k.has ? `Using a key ending ${k.last4}. Paste a new one to replace it` : 'gsk_…'} value={draft} onChange={(e) => { setDraft(e.target.value); setResult(null); setProblem(null); setNote(null); }} style={{ flex: 1, width: 'auto', fontFamily: 'ui-monospace, monospace' }} />
            <button type="button" className="mh-secondary" aria-pressed={show} aria-label={show ? 'Hide key' : 'Show key'} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button></div>
          {draft && !ok && <span className="mh-meta" role="status">That does not look like a Groq key yet (letters, numbers, - and _, at least 20 characters).</span>}</div>
        <div className="mh-field"><label htmlFor="gm">Model</label>
          <select id="gm" value={model === '__custom' || models.includes(model) ? model : '__custom'} onChange={(e) => changeModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}{m === DEFAULT_MODEL ? ' (default)' : ''}</option>)}<option value="__custom">Other…</option></select>
          {(model === '__custom' || !models.includes(model)) && <input aria-label="Model name" placeholder="model name from your Groq account" value={model === '__custom' ? custom : model} onChange={(e) => { setModelState('__custom'); setCustom(e.target.value); }} style={{ marginTop: 6 }} />}
          <span className="mh-meta">Model names change. If a test says the model is unavailable, pick another from your Groq account.</span></div>
        <label className="mh-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span><strong>Remember on this device</strong> (off by default)<br /><span className="mh-meta">Saves the key in this browser’s storage so you do not have to paste it again. Anyone who can use this browser profile can read it, and so can any script running on this site’s address. Do not use this on a shared or public computer. Without this, the key stays in memory for this tab only and is gone after a reload. “Remove key” deletes it from both.</span></span></label>
        <div className="mh-row end" style={{ marginTop: 14 }}>
          <button className="mh-secondary mh-danger" onClick={remove} disabled={!k.has && !draft}>Remove key</button>
          <button className="mh-secondary" onClick={test} disabled={!ok || testing || wait > 0}>{testing ? 'Testing…' : wait > 0 ? `Try again in ${wait}s` : 'Test connection'}</button>
          <button className="mh-primary" onClick={use} disabled={!ok || testing}>Use key</button></div>
        <div aria-live="polite">
          {testing && <div className="mh-notice" role="status">Sending one small request to Groq through this site’s server…</div>}
          {result && <div className={`mh-notice ${result.ok ? 'good' : 'bad'}`} role={result.ok ? 'status' : 'alert'}><strong>{{ ok: 'Connected', invalid_key: 'Invalid key', forbidden: 'Access refused', model_unavailable: 'Model unavailable', rate_limited: 'Rate limit', network: 'Network error', timeout: 'No answer in time', service: 'Groq problem', rejected: 'Rejected' }[result.kind] ?? 'Result'}.</strong> {result.message}{result.ok && result.latencyMs ? ` (${Math.round(result.latencyMs)} ms, model ${result.model})` : ''}</div>}
          {problem && <div className="mh-notice bad" role="alert">{problem}</div>}
          {note && <div className="mh-notice good" role="status">{note}</div>}</div>
        <details style={{ marginTop: 14 }}><summary className="mh-sub" style={{ cursor: 'pointer' }}>How your key is handled</summary>
          <ul style={{ fontSize: 12, lineHeight: 1.7, paddingLeft: 18 }}>
            <li>With each AI request your browser sends the key to this site’s server, which forwards it only to Groq’s API address and then forgets it. It is not stored, logged or sent anywhere else.</li>
            <li>The key is kept apart from your study profile. Exporting your profile never includes it.</li>
            <li>Your profile and notes stay in this browser. Only the question and a few relevant passages are sent with each request.</li>
            <li>Your key can be used for anything Groq allows until you delete it in your Groq account. If you think it leaked, delete it there.</li>
          </ul></details></>}
      {status?.operatorAi && <p className="mh-meta" style={{ marginTop: 12 }}>This site also offers a shared assistant with small daily limits. It is used only while you have no key of your own set.</p>}
    </section>
  </>);
}
