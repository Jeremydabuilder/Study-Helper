import { useCallback, useEffect, useState } from 'react';

/** The operator's page: invitation codes and the pilot switches, for hosts without a terminal. It is not part of the student app and is not linked from it. */
const call = async (token: string, path: string, body?: unknown) => {
  const r = await fetch(`/internal/operator${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message ?? (r.status === 404 ? 'The operator page is not switched on (OPERATOR_TOKEN is not set).' : `Request failed (${r.status}).`));
  return j;
};
const KEY = 'sh.operator.key';
const read = () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };

export function Operator() {
  const [token, setToken] = useState(read()); const [entered, setEntered] = useState(!!read());
  const [st, setSt] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [codes, setCodes] = useState<string[]>([]);
  const [count, setCount] = useState(3); const [label, setLabel] = useState(''); const [days, setDays] = useState(7); const [max, setMax] = useState(10);
  const load = useCallback(async () => { try { const s = await call(token, '/status'); setSt(s); setMax(s.maxUsers); setErr(null); } catch (e) { setErr((e as Error).message); setSt(null); } }, [token]);
  useEffect(() => { if (entered) void load(); }, [entered, load]);
  const act = async (fn: () => Promise<void>) => { try { await fn(); setErr(null); await load(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="narrow">
      <h1>Operator</h1>
      <p className="muted small">This page is for the person who runs the site. It shows counts and invitation codes, never anyone’s work. Do not share the key.</p>
      {!entered || !st ? (
        <form onSubmit={(e) => { e.preventDefault(); try { sessionStorage.setItem(KEY, token); } catch { /* the key is simply asked for again after a reload */ } setEntered(true); void load(); }}>
          <label className="field"><span className="field-label">Operator key</span><input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
          {err && <div className="notice bad" role="alert">{err}</div>}
          <button className="btn primary mt-s" disabled={token.length < 8}>Open</button>
        </form>
      ) : (<>
        {err && <div className="notice bad" role="alert">{err}</div>}
        <section className="card"><h2>Switches</h2>
          <p className="small muted">{st.people} workspace{st.people === 1 ? '' : 's'} ({st.guests} guest) of {st.maxUsers} allowed · {st.last24h.assistantRequests} assistant request{st.last24h.assistantRequests === 1 ? '' : 's'} in the last 24 hours</p>
          {([['pilot', 'The whole site is open (off: everyone sees a pause message; nothing is lost)'], ['signups', 'New workspaces can be created (off: invitations are refused, existing people are unaffected)'], ['ai', 'The study assistant is on (off: practice, notes and reviews still work)']] as const).map(([k, text]) => (
            <label key={k} className="row"><input type="checkbox" checked={!!st.switches[k]} onChange={(e) => act(() => call(token, '/switch', { name: k, on: e.target.checked }))} /> {text}</label>))}
          <div className="row mt-s"><label className="small">People allowed <input type="number" min={1} max={500} value={max} onChange={(e) => setMax(Number(e.target.value))} style={{ width: '5rem' }} /></label><button className="btn small" onClick={() => act(() => call(token, '/max-users', { n: max }))}>Save</button></div>
        </section>
        <section className="card"><h2>Invitation codes</h2>
          <p className="small muted">Each code opens one private workspace, once. Codes are shown only now; the server keeps a one-way hash. Send each one yourself to one person.</p>
          <div className="row"><label className="small">How many <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: '4rem' }} /></label>
            <label className="small">Label <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="friends" /></label>
            <label className="small">Valid days <input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: '4rem' }} /></label>
            <button className="btn primary" onClick={() => act(async () => { setCodes((await call(token, '/invites', { count, label, days })).codes); })}>Create codes</button></div>
          {codes.length > 0 && <div className="notice good mt-s" role="status"><strong>Copy these now.</strong><pre style={{ margin: '.4rem 0' }}>{codes.join('\n')}</pre><button className="btn small" onClick={() => setCodes([])}>I have copied them</button></div>}
          <table className="small mt-s"><thead><tr><th>Label</th><th>Status</th><th>Expires</th><th /></tr></thead><tbody>
            {st.invites.slice(0, 40).map((i: any) => <tr key={i.id}><td>{i.label || '—'}</td><td>{i.status}</td><td>{new Date(i.expiresAt).toLocaleDateString()}</td><td>{i.status === 'open' && <button className="btn small ghost danger" onClick={() => act(() => call(token, '/invites/revoke', { idPrefix: i.id }))}>Revoke</button>}</td></tr>)}
          </tbody></table>
        </section>
        <button className="btn ghost" onClick={() => { try { sessionStorage.removeItem(KEY); } catch { /* nothing to remove */ } setToken(''); setEntered(false); setSt(null); }}>Lock this page</button>
      </>)}
    </div>
  );
}
