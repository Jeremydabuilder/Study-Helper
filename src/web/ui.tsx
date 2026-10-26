import { ReactNode, useEffect, useId, useRef } from 'react';
import { ApiError } from './api';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner-row" role="status" aria-live="polite"><span className="spinner" aria-hidden /> <span>{label}</span></div>;
}

export function ErrorBox({ error, onRetry, children }: { error: ApiError | Error | string; onRetry?: () => void; children?: ReactNode }) {
  const msg = typeof error === 'string' ? error : error.message;
  return (
    <div className="notice bad" role="alert">
      <strong>That didn’t work.</strong> <span>{msg}</span>
      <div className="row gap-s mt-s">{onRetry && <button className="btn" onClick={onRetry}>Try again</button>}{children}</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children && <p className="muted">{children}</p>}{action}</div>;
}

export function Chip({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`chip ${tone}`} title={title}>{children}</span>;
}

export const LEVEL_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = { not_assessed: 'neutral', learning: 'info', shaky: 'warn', solid: 'good' };
export const LEVEL_TEXT: Record<string, string> = { not_assessed: 'Not assessed yet', learning: 'Building', shaky: 'Needs repair', solid: 'Holding up' };
export const LevelChip = ({ level }: { level: string }) => <Chip tone={LEVEL_TONE[level] ?? 'neutral'}>{LEVEL_TEXT[level] ?? level}</Chip>;

export const SUPPORT_TEXT: Record<string, { tone: 'good' | 'info' | 'warn'; text: string }> = {
  source: { tone: 'good', text: 'From your material' },
  ai: { tone: 'info', text: 'Added by AI — verify' },
  unverified: { tone: 'warn', text: 'Needs verification' },
};

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div className="row between"><h2 id={id}>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>;
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="toggle-label">{label}</span>{hint && <span className="hint block">{hint}</span>}</span>
    </label>
  );
}

export function useHashRoute(): [string, (p: string) => void] {
  const read = () => (window.location.hash.replace(/^#/, '') || '/');
  const [route, setRoute] = useHash(read);
  return [route, (p) => { window.location.hash = p; setRoute(p); }];
}
import { useState } from 'react';
function useHash(read: () => string): [string, (s: string) => void] {
  const [r, setR] = useState(read);
  useEffect(() => { const h = () => setR(read()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  return [r, setR];
}

export function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
