import { ApiError } from '../api';
import { needsSetup, useProvider } from './store';

/** Shown where an AI action cannot run yet: says why, links straight to Settings, and says what still works. */
export function SetupNotice({ what = 'This' }: { what?: string }) {
  const p = useProvider();
  if (p.ready) return null;
  return (
    <div className="mh-notice" role="status">
      {p.cooling ? 'The site’s shared assistant is resting for a moment. ' : `${what} needs an AI assistant. `}
      {p.byokAllowed ? <><a href="#/settings">Add your own Groq key in Settings</a> to turn it on. </> : 'The assistant is not available on this site right now. '}
      Planning, practice cards and review work without it.
    </div>
  );
}

/** An assistant error, in words, with the Settings link when fixing the setup is the way forward. Your typed text is never cleared by an error. */
export function AiError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError; const wait = typeof e.extra?.retryAfterMs === 'number' && e.extra.retryAfterMs > 0 ? ` Try again in about ${Math.max(1, Math.ceil(e.extra.retryAfterMs / 1000))} seconds.` : '';
  return (
    <div className="mh-notice bad" role="alert">
      {e.message || 'The assistant could not be reached.'}{wait} {needsSetup(e) && <><a href="#/settings">Open Settings</a>. </>}What you typed is still here.
    </div>
  );
}
