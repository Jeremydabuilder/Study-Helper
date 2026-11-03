import { ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, del, post, useApi } from '../api';
import { greeting, toast, useToast } from './ctx';
import './mh.css';

const NAV: [string, string, string][] = [['/', '☀️', 'Today'], ['/school', '🎒', 'School'], ['/projects', '🚀', 'Projects'], ['/helper', '🧠', 'Study Helper']];
const isHere = (path: string, p: string) => p === '/' ? path === '/' : p === '/helper' ? !(['/', '/school', '/import'].includes(path) || path.startsWith('/projects')) : path === p || path.startsWith(p + '/');

/** My Helper's frame: sidebar (Today, School, Projects, Study Helper), mobile bar, memory drawer. Study Helper's own pages render inside it. */
export function MyHelperShell({ path, children, onSignOut, ownerName }: { path: string; children: ReactNode; onSignOut: () => void; ownerName: string }) {
  const [drawer, setDrawer] = useState(false);
  const text = useToast();
  const main = useRef<HTMLElement>(null);
  useEffect(() => { main.current?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, [path]);
  const nav = () => NAV.map(([p, ico, label]) => <a key={p} href={`#${p}`} aria-current={isHere(path, p) ? 'page' : undefined}><span className="ico" aria-hidden>{ico}</span>{label}</a>);
  return (
    <div className="mh">
      <a className="skip" href="#mh-main">Skip to content</a>
      <aside className="mh-side">
        <div className="mh-brand"><div className="mh-mark" aria-hidden>M</div><div><h1>My Helper</h1><span>Private · {ownerName}</span></div></div>
        <nav className="mh-nav" aria-label="Main">{nav()}</nav>
        <div className="mh-side-foot">
          <div className="mh-note">Your tasks, projects and assignments are saved on the server and open on any device you sign in from.</div>
          <div className="mh-side-links">
            <button onClick={() => setDrawer(true)}>Memory</button>
            <a href="#/import">Import old data</a>
            <a href="#/settings">Settings</a>
            <a href="#/privacy">Privacy</a>
            <button onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </aside>
      <main id="mh-main" ref={main} tabIndex={-1} className="mh-main" style={{ outline: 'none' }}>{children}</main>
      <nav className="mh-mobile-nav" aria-label="Main (mobile)">{nav()}<a href="#/import" aria-current={path === '/import' ? 'page' : undefined}><span aria-hidden>⋯</span>More</a></nav>
      {drawer && <MemoryDrawer onClose={() => setDrawer(false)} />}
      {text && <div className="mh-toast" role="status">{text}</div>}
    </div>
  );
}

export function PageTop({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return <div className="mh-top"><div><div className="mh-eyebrow">{eyebrow}</div><h2>{title}</h2></div>{right ?? <div className="mh-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>}</div>;
}
export { greeting };

/** The original "memory" drawer: short notes that Study Helper may use. It is Study Helper's real memory, not a second copy. */
function MemoryDrawer({ onClose }: { onClose: () => void }) {
  const mem = useApi<any>('/memory');
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  const list = (mem.data?.memories ?? []).filter((m: any) => !m.dismissed);
  const add = async () => { setBusy(true); try { await post('/memory', { text }); setText(''); mem.reload(); toast('Remembered'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save'); } finally { setBusy(false); } };
  const remove = async (id: string) => { try { await del(`/memory/${id}`); mem.reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete'); } };
  return (<>
    <div className="mh-drawer-bg" onClick={onClose} />
    <aside className="mh-drawer" role="dialog" aria-modal="true" aria-label="Memory">
      <div className="mh-drawer-head"><div><h3>Memory</h3><p>Short notes about how you like to work. Study Helper can use them when it helps you. <a href="#/memory" onClick={onClose}>See how they are used</a></p></div><button className="mh-text-btn" onClick={onClose} aria-label="Close memory">✕</button></div>
      <div className="mh-drawer-body">
        {mem.loading && !mem.data ? <p className="mh-sub">Loading…</p> : list.length === 0 ? <div className="mh-empty">Nothing remembered yet.</div> : list.map((m: any) => <div className="mh-mem" key={m.id}><span>{m.text}</span><button onClick={() => remove(m.id)} aria-label={`Delete note: ${m.text}`}>×</button></div>)}
      </div>
      <div className="mh-drawer-add"><textarea aria-label="New memory note" placeholder="e.g. I focus best in 20-minute blocks" value={text} onChange={(e) => setText(e.target.value)} /><button className="mh-primary" disabled={busy || text.trim().length < 3} onClick={add}>Remember this</button></div>
    </aside>
  </>);
}
