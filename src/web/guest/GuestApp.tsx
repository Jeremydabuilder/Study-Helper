import { useEffect, useRef } from 'react';
import { HostedContext } from '../hosted';
import { useHashRoute } from '../ui';
import { Build } from './Build';
import { Help } from './Help';
import { Memory } from './Memory';
import { Practice, Review } from './Practice';
import { GuestProvider, useGuest, useProvider } from './store';
import { GuestChat } from './Chat';
import { Settings } from './Settings';
import { GuestToday } from './Today';
import '../myhelper/mh.css';

const NAV: [string, string, string][] = [['/', '☀️', 'Today'], ['/build', '🧭', 'Build profile'], ['/help', '📝', 'Homework'], ['/practice', '🧪', 'Quiz'], ['/review', '🔁', 'Review'], ['/chat', '💬', 'Chat'], ['/memory', '🧠', 'My profile'], ['/settings', '⚙️', 'Settings']];
const isHere = (path: string, p: string) => p === '/' ? path === '/' : path === p || path.startsWith(p + '/');

/** What anyone sees without an account (when the owner has switched public mode on): the study profile, plan, hints, practice and review, all kept in THIS browser. */
export function GuestApp({ onOwner }: { onOwner: () => void }) {
  return <GuestProvider><HostedContext.Provider value><Frame onOwner={onOwner} /></HostedContext.Provider></GuestProvider>;
}
function Frame({ onOwner }: { onOwner: () => void }) {
  const [route, go] = useHashRoute(); const { profile } = useGuest(); const prov = useProvider();
  const [path, query = ''] = route.split('?');
  const main = useRef<HTMLElement>(null);
  useEffect(() => { main.current?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, [path]);
  let page;
  if (path === '/build') page = <Build go={go} mode="entry" />;
  else if (path === '/build/paste') page = <Build go={go} mode="paste" />;
  else if (path === '/build/interview') page = <Build go={go} mode="interview" />;
  else if (path === '/help') page = <Help query={query} />;
  else if (path === '/practice') page = <Practice query={query} go={go} />;
  else if (path === '/review') page = <Review go={go} />;
  else if (path === '/memory') page = <Memory go={go} />;
  else if (path === '/chat') page = <GuestChat />;
  else if (path === '/settings') page = <Settings />;
  else page = <GuestToday go={go} />;
  const nav = NAV.map(([p, ico, label]) => <a key={p} href={`#${p}`} aria-current={isHere(path, p) ? 'page' : undefined}><span className="ico" aria-hidden>{ico}</span>{label}</a>);
  return (
    <div className="mh">
      <a className="skip" href="#guest-main">Skip to content</a>
      <aside className="mh-side">
        <div className="mh-brand"><div className="mh-mark" aria-hidden>S</div><div><h1>Study Helper</h1><span>No account · saved in this browser</span></div></div>
        <nav className="mh-nav" aria-label="Main">{nav}</nav>
        <div className="mh-side-foot"><div className="mh-note">{profile.assignments.length + profile.notes.length + profile.commitments.length === 0 ? 'Nothing is stored yet. Your profile stays in this browser; this site keeps no copy.' : 'Your profile is saved in this browser only. Export a copy from My profile to keep it.'}</div>
          <div className="mh-side-links"><a href="#/memory">Export or clear</a><button onClick={onOwner}>Owner sign-in</button></div></div>
      </aside>
      <main id="guest-main" ref={main} tabIndex={-1} className="mh-main" style={{ outline: 'none' }}>
        {!prov.ready && path !== '/settings' && <div className="mh-notice" role="status" style={{ marginTop: 0, marginBottom: 16 }}>{prov.cooling ? 'The shared assistant is resting for a moment. ' : 'AI help is off until you add a Groq key. '}{prov.byokAllowed && <a href="#/settings">Open Settings</a>} Your profile, plan, practice and review work without it.</div>}
        {page}
      </main>
      <nav className="mh-mobile-nav" aria-label="Main (mobile)">{NAV.filter((n) => n[0] !== '/build').map(([p, ico, label]) => <a key={p} href={`#${p}`} aria-current={isHere(path, p) ? 'page' : undefined}><span aria-hidden>{ico}</span>{label === 'My profile' ? 'Profile' : label}</a>)}</nav>
    </div>
  );
}
