import { useEffect, useRef, useState } from 'react';
import { ApiError, api, post } from '../api';
import { ErrorBox, Field } from '../ui';

const FRIENDLY: Record<string, string> = {
  invite_required: 'That sign-in did not come with a valid invitation, so no account was created. Enter your invitation code first.',
  pilot_closed: 'Study Helper is not accepting new students right now.', pilot_full: 'The pilot is full right now.',
  unable_to_create_user: 'We could not create your account. If you already have one, use “I already have an account”. Otherwise check that your invitation is unused.',
  linking_disabled: 'That email already belongs to an account that signs in a different way.', access_denied: 'Sign-in was cancelled.',
};
const INVITE_PROBLEM: Record<string, string> = { unknown: 'That code was not recognised. Check it and try again.', used: 'That invitation has already been used.', expired: 'That invitation has expired. Ask for a new one.', revoked: 'That invitation is no longer valid.', in_use: 'That invitation is being used right now. Try again in a few minutes.' };

/** Invitation, sign-up and sign-in. Closed by default: a new account needs a valid code. Nothing is assumed from an email address. */
export function Join({ session, onSignedIn }: { session: any; onSignedIn: () => void }) {
  const fromQuery = new URLSearchParams(window.location.search).get('error');
  const hashCode = (window.location.hash.match(/code=([A-Za-z0-9-]+)/) ?? [])[1] ?? '';
  const [mode, setMode] = useState<'join' | 'signin'>(hashCode ? 'join' : 'join');
  const [code, setCode] = useState(hashCode);
  const [checked, setChecked] = useState<null | 'ok' | string>(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(fromQuery ? FRIENDLY[fromQuery] ?? 'Sign-in did not work. Please try again.' : null);
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h1.current?.focus(); }, [mode]);
  const m = session?.methods ?? {};
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.');

  const checkCode = async () => {
    setBusy(true); setErr(null);
    try { const r = await post('/invite/check', { code }); if (r.valid) { await post('/invite/start', { code }); setChecked('ok'); } else { setChecked(null); setErr(INVITE_PROBLEM[r.reason] ?? 'That invitation does not work.'); } }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const google = async () => {
    setBusy(true); setErr(null);
    try { const r = await post('/auth/sign-in/social', { provider: m.oidc.providerId, callbackURL: '/', errorCallbackURL: '/?signin=failed', newUserCallbackURL: '/' }); window.location.href = r.url; }
    catch (e) { fail(e); setBusy(false); }
  };
  const password_ = async (kind: 'up' | 'in') => {
    setBusy(true); setErr(null);
    try { await api('POST', kind === 'up' ? '/auth/sign-up/email' : '/auth/sign-in/email', { email, password, name: 'Student' }); onSignedIn(); }
    catch (e) { setErr(kind === 'in' ? 'That email and password did not match an account.' : e instanceof ApiError && e.message ? e.message : 'Could not create the account.'); } finally { setBusy(false); }
  };
  const staging = session?.environment === 'staging';

  return (
    <div className="narrow join">
      {staging && <div className="notice warn" role="status"><strong>Test site.</strong> This is a staging copy with made-up data. Do not enter real schoolwork.</div>}
      <h1 ref={h1} tabIndex={-1}>{mode === 'join' ? 'Join Study Helper' : 'Sign in'}</h1>
      <p className="muted">A small invite-only pilot. Study Helper turns your own notes and packets into practice, remembers what you find hard, and brings it back later.</p>
      {!session?.pilotOpen && <div className="notice info" role="status">Study Helper is paused right now. Please come back later.</div>}
      <div className="seg mb" role="group" aria-label="Choose"><button aria-pressed={mode === 'join'} onClick={() => { setMode('join'); setErr(null); }}>I have an invitation</button><button aria-pressed={mode === 'signin'} onClick={() => { setMode('signin'); setErr(null); }}>I already have an account</button></div>
      {err && <div className="notice bad" role="alert">{err}</div>}

      {mode === 'join' && (
        <section className="card">
          <h2>1. Your invitation code</h2>
          <form onSubmit={(e) => { e.preventDefault(); void checkCode(); }}>
            <Field label="Invitation code" hint="Looks like ABCD-EFGH-JKLM-NPQR. Each code works once. A school email address is not enough on its own."><input type="text" value={code} onChange={(e) => { setCode(e.target.value); setChecked(null); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} /></Field>
            <div className="row mt-s"><button className="btn primary" disabled={busy || code.trim().length < 16}>{busy && !checked ? 'Checking…' : 'Check code'}</button>{checked === 'ok' && <span role="status" className="chip good">Code accepted</span>}</div>
          </form>
        </section>
      )}
      {(mode === 'signin' || checked === 'ok') && (
        <section className="card">
          <h2>{mode === 'join' ? '2. Create your account' : 'Sign in'}</h2>
          {m.oidc && <div className="mb"><button className="btn primary big" disabled={busy || !session.pilotOpen} onClick={google}>Continue with Google</button><p className="hint">We only receive your email address from Google. We do not read your Google files, email or contacts. Calendar is a separate, optional step later.</p></div>}
          {m.password && (
            <form onSubmit={(e) => { e.preventDefault(); void password_(mode === 'join' ? 'up' : 'in'); }}>
              {m.oidc && <p className="muted small">Or use an email and password:</p>}
              <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
              <Field label="Password" hint={mode === 'join' ? 'At least 10 characters. Use one you do not use anywhere else.' : undefined}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'join' ? 'new-password' : 'current-password'} minLength={mode === 'join' ? 10 : 1} required /></Field>
              <div className="row mt-s"><button className="btn" disabled={busy || !session.pilotOpen}>{busy ? 'Working…' : mode === 'join' ? 'Create account' : 'Sign in'}</button></div>
            </form>
          )}
          {!m.oidc && !m.password && <ErrorBox error="No sign-in method is set up on this server." />}
        </section>
      )}
      <p className="small muted">By continuing you agree to the <a href="#/privacy">privacy notice</a>. You can export or delete everything from Settings → Account at any time.</p>
    </div>
  );
}
