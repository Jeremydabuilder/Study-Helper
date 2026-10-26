import { useEffect, useState } from 'react';
import { getWorkspace, post, setWorkspace, useApi, Workspace } from './api';
import { useHashRoute } from './ui';
import { Today } from './pages/Today';
import { Study } from './pages/Study';
import { Subjects, SubjectDetail } from './pages/Subjects';
import { Plan } from './pages/Plan';
import { CalendarPage } from './pages/CalendarPage';
import { Progress } from './pages/Progress';
import { Memory } from './pages/Memory';
import { Settings } from './pages/Settings';

const NAV: [string, string][] = [['/', 'Today'], ['/subjects', 'Subjects'], ['/plan', 'Plan'], ['/progress', 'Progress'], ['/memory', 'Memory'], ['/settings', 'Settings']];

export function App() {
  const [route, go] = useHashRoute();
  const [ws, setWs] = useState<Workspace>(getWorkspace());
  useEffect(() => { const h = () => setWs(getWorkspace()); window.addEventListener('workspace-changed', h); return () => window.removeEventListener('workspace-changed', h); }, []);
  const meta = useApi<any>('/meta', [ws]);
  const path = route.split('?')[0];

  let page;
  if (path.startsWith('/study/')) page = <Study id={path.split('/')[2]} go={go} />;
  else if (path.startsWith('/subjects/')) page = <SubjectDetail id={path.split('/')[2]} go={go} />;
  else if (path === '/subjects') page = <Subjects go={go} />;
  else if (path === '/plan') page = <Plan go={go} />;
  else if (path === '/calendar') page = <CalendarPage go={go} query={route.split('?')[1] ?? ''} />;
  else if (path === '/progress') page = <Progress go={go} />;
  else if (path === '/memory') page = <Memory go={go} />;
  else if (path === '/settings') page = <Settings go={go} meta={meta.data} />;
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
          {!studying && (
            <nav className="nav" aria-label="Main">
              {NAV.map(([p, label]) => <a key={p} href={`#${p}`} aria-current={path === p || (p !== '/' && path.startsWith(p + '/')) || (p === '/plan' && path === '/calendar') ? 'page' : undefined}>{label}</a>)}
            </nav>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1}>{page}</main>
    </div>
  );
}
