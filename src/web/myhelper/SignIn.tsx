import { useState } from 'react';
import { ApiError, api } from '../api';

/** The only door of the owner-only site: one email, one password. There is no sign-up, guest entry or invitation here. */
export function OwnerSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', '/auth/sign-in/email', { email, password }); onSignedIn(); }
    catch (x) { setErr(x instanceof ApiError && x.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : x instanceof ApiError && x.code === 'network' ? x.message : 'That email and password did not match.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="mh" style={{ display: 'block' }}>
      <main className="mh-main" style={{ maxWidth: 460, paddingTop: 80 }}>
        <div className="mh-brand" style={{ paddingLeft: 0 }}><div className="mh-mark">M</div><div><h1>My Helper</h1><span>Private</span></div></div>
        <form className="mh-panel" onSubmit={submit} aria-labelledby="mh-signin">
          <h3 id="mh-signin">Sign in</h3>
          <p className="mh-sub">This is a private site. Only the owner can sign in.</p>
          <div className="mh-field" style={{ marginTop: 16 }}><label htmlFor="mh-email">Email</label><input id="mh-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="mh-field"><label htmlFor="mh-pw">Password</label><input id="mh-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <div className="mh-notice bad" role="alert">{err}</div>}
          <div className="mh-row end" style={{ marginTop: 14 }}><button className="mh-primary" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
        </form>
      </main>
    </div>
  );
}
