import { useEffect, useState } from 'react';
import { getWorkspace, useApi } from '../api';
import { HostedContext } from '../hosted';
import { ReportProblem } from '../pages/Report';
import { pageFor } from '../routes';
import { useHashRoute } from '../ui';
import { HelperTab } from './HelperTab';
import { ImportPage } from './ImportPage';
import { Projects } from './Projects';
import { School } from './School';
import { MyHelperShell } from './Shell';
import { MhToday } from './Today';

/** What the signed-in owner sees: My Helper's pages, with Study Helper's own pages (homework, quizzes, review, chat…) opening inside the same frame. */
export function MyHelperApp({ session, onSignOut }: { session: any; onSignOut: () => void }) {
  const [route, go] = useHashRoute();
  const [ws, setWs] = useState(getWorkspace());
  useEffect(() => { const h = () => setWs(getWorkspace()); window.addEventListener('workspace-changed', h); return () => window.removeEventListener('workspace-changed', h); }, []);
  const meta = useApi<any>('/meta', [ws]);
  const path = route.split('?')[0];
  const name = session.ownerName ?? 'there';
  let page;
  if (path === '/') page = <MhToday go={go} meta={meta.data} name={name} />;
  else if (path === '/school') page = <School go={go} />;
  else if (path === '/projects') page = <Projects go={go} />;
  else if (path.startsWith('/projects/')) page = <Projects go={go} id={path.split('/')[2]} />;
  else if (path === '/helper') page = <HelperTab go={go} meta={meta.data} />;
  else if (path === '/import') page = <ImportPage go={go} />;
  else page = pageFor(path, route, go, { meta: meta.data, hosted: session, onSignOut });
  return (
    <HostedContext.Provider value>
      <MyHelperShell path={path} onSignOut={onSignOut} ownerName={name}>
        {page}
        <footer className="small muted" style={{ marginTop: 40 }}><ReportProblem /></footer>
      </MyHelperShell>
    </HostedContext.Provider>
  );
}
