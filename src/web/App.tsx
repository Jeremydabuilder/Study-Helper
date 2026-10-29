import { useEffect, useState } from 'react';
import { getWorkspace, post, setWorkspace, useApi, Workspace } from './api';
import { useHashRoute } from './ui';
import { Today } from './pages/Today';
import { Study } from './pages/Study';
import { Subjects, SubjectDetail } from './pages/Subjects';
import { StartFlow } from './pages/StartFlow';
import { Prepare } from './pages/Prepare';
import { ReviewSource } from './pages/ReviewSource';
import { Plan } from './pages/Plan';
import { CalendarPage } from './pages/CalendarPage';
import { Progress } from './pages/Progress';
import { Memory } from './pages/Memory';
import { Settings } from './pages/Settings';
import { ErrorBox } from './ui';
import { Readings, Outline } from './pages/Readings';
import { Reader } from './pages/Reader';
import { Chat } from './pages/Chat';
import { Join } from './pages/Join';
import { Privacy } from './pages/Privacy';
import { ReportProblem } from './pages/Report';

const NAV: [string, string][] = [['/', 'Today'], ['/subjects', 'Subjects'], ['/readings', 'Readings'], ['/chat', 'Chat'], ['/plan', 'Plan'], ['/progress', 'Progress'], ['/memory', 'Memory'], ['/settings', 'Settings']];

/**
 * Local mode has no /api/session and goes straight to the app. Hosted mode asks who is signed in first and shows the invitation / sign-in page otherwise.
 * A session that ends while the page is open sends the student back to sign-in; what they typed is kept by the pages' own drafts.
 */
export function App() {
  const sess = useApi<any>('/session');
  const [ended, setEnded] = useState(false); const [paused, setPaused] = useState(false);
  useEffect(() => { const a = () => setEnded(true), b = () => setPaused(true); window.addEventListener('signed-out', a); window.addEventListener('pilot-paused', b); return () => { window.removeEventListener('signed-out', a); window.removeEventListener('pilot-paused', b); }; }, []);
  const [route] = useHashRoute();
  if (sess.loading && !sess.data && !sess.error) return <div className="narrow" style={{ paddingTop: 80 }}><div className="skeleton" style={{ height: 120 }} /></div>;
  const hosted = !!sess.data && !sess.error;
  if (!hosted && sess.error && sess.error.code !== 'not_found') return <div className="narrow" style={{ paddingTop: 40 }}><ErrorBox error={sess.error} onRetry={sess.reload} /></div>;
  if (!hosted) return <AppShell hosted={null} />;
  if (route.startsWith('/privacy')) return <div className="shell"><main><Privacy session={sess.data} /></main></div>;
  if (paused) return <div className="narrow" style={{ paddingTop: 60 }}><h1>Study Helper is paused</h1><p>Your work is saved. Please come back later.</p><button className="btn" onClick={() => { setPaused(false); sess.reload(); }}>Check again</button></div>;
  if (!sess.data.signedIn || ended) return <div className="shell"><main><Join session={sess.data} onSignedIn={() => { setEnded(false); sess.reload(); }} /></main></div>;
  return <AppShell hosted={sess.data} onSignOut={async () => { try { await post('/auth/sign-out', {}); } catch { /* the cookie may already be gone */ } setEnded(true); sess.reload(); }} />;
}

function AppShell({ hosted, onSignOut }: { hosted: any; onSignOut?: () => void }) {
  const [route, go] = useHashRoute();
  const [ws, setWs] = useState<Workspace>(getWorkspace());
  useEffect(() => { const h = () => setWs(getWorkspace()); window.addEventListener('workspace-changed', h); return () => window.removeEventListener('workspace-changed', h); }, []);
  const meta = useApi<any>('/meta', [ws]);
  const path = route.split('?')[0];

  let page;
  if (path.startsWith('/study/')) page = <Study id={path.split('/')[2]} go={go} />;
  else if (path.startsWith('/read/')) page = <Reader id={path.split('/')[2]} go={go} />;
  else if (path === '/readings') page = <Readings go={go} />;
  else if (path.startsWith('/outline/')) page = <Outline id={path.split('/')[2]} go={go} />;
  else if (path === '/chat') page = <Chat go={go} />;
  else if (path === '/start') page = <StartFlow go={go} />;
  else if (path.startsWith('/prepare/')) page = <Prepare sourceId={path.split('/')[2]} go={go} />;
  else if (path.startsWith('/review/')) page = <ReviewSource id={path.split('/')[2]} go={go} />;
  else if (path.startsWith('/subjects/')) page = <SubjectDetail id={path.split('/')[2]} go={go} />;
  else if (path === '/subjects') page = <Subjects go={go} />;
  else if (path === '/plan') page = <Plan go={go} />;
  else if (path === '/calendar') page = <CalendarPage go={go} query={route.split('?')[1] ?? ''} />;
  else if (path === '/progress') page = <Progress go={go} />;
  else if (path === '/memory') page = <Memory go={go} />;
  else if (path === '/settings') page = <Settings go={go} meta={meta.data} hosted={hosted} onSignOut={onSignOut} />;
  else page = <Today go={go} meta={meta.data} />;

  const studying = path.startsWith('/study/');
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      {ws === 'demo' && (
        <div className="banner" role="status">
          <strong>SAMPLE DATA</strong> — made-up records, stored separately from yours.
          <button className="btn small" onClick={() => { setWorkspace('real'); go('/'); }}>Switch to my data</button>
          <button className="btn small ghost" onClick={async () => { await post('/demo/reset'); window.dispatchEvent(new Event('workspace-changed')); }}>Reset sample</button>
        </div>
      )}
      <header className="topbar">
        <div className="topbar-in">
          <a className="brand" href="#/" aria-label="Study Helper — Today"><span className="brand-mark" aria-hidden>✓</span><span className="name">Study Helper</span></a>
          {hosted && hosted.environment === 'staging' && <span className="chip warn" title="Made-up data only">test site</span>}
          {!studying && (
            <nav className="nav" aria-label="Main">
              {NAV.map(([p, label]) => <a key={p} href={`#${p}`} aria-current={path === p || (p !== '/' && path.startsWith(p + '/')) || (p === '/readings' && (path.startsWith('/read/') || path.startsWith('/outline/'))) || (p === '/plan' && path === '/calendar') ? 'page' : undefined}>{label}</a>)}
            </nav>
          )}
          {hosted && onSignOut && <button className="btn ghost small signout" onClick={onSignOut}>Sign out</button>}
        </div>
      </header>
      <main id="main" tabIndex={-1} className={path.startsWith('/read/') ? 'wide' : undefined}>{page}</main>
      {hosted && <footer className="foot small muted"><a href="#/privacy">Privacy</a> · <ReportProblem /></footer>}
    </div>
  );
}
