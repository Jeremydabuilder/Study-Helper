import { useCallback, useEffect, useRef, useState } from 'react';

export type Workspace = 'real' | 'demo';
export const getWorkspace = (): Workspace => { try { return localStorage.getItem('sh.workspace') === 'demo' ? 'demo' : 'real'; } catch { return 'real'; } };
export const setWorkspace = (w: Workspace) => { try { localStorage.setItem('sh.workspace', w); } catch { /* private mode */ } window.dispatchEvent(new Event('workspace-changed')); };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, any> = {}) { super(message); }
  get retryable() { return this.extra.retryable === true || this.status >= 500 || this.status === 0 || this.status === 429; }
  get offlineFallback() { return this.extra.offlineFallback === true; }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-workspace': getWorkspace() }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError(0, 'network', 'Could not reach the Study Helper server. Check that it is running, then try again.'); }
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) { const e = data?.error ?? {}; throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status}).`, e); }
  return data as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try { const d = await get<T>(path); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError(e as ApiError); }
    finally { if (my === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { load(); const h = () => load(); window.addEventListener('workspace-changed', h); return () => window.removeEventListener('workspace-changed', h); }, [load, ...deps]);
  return { data, error, loading, reload: load, setData };
}

export const fmtDate = (ms: number | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => (ms ? new Intl.DateTimeFormat(undefined, opts).format(new Date(ms)) : '—');
export const fmtDateTime = (ms: number | null | undefined) => fmtDate(ms, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function relTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const d = Math.round((now - ms) / 60000);
  if (d < 1) return 'just now';
  if (d < 60) return `${d} min ago`;
  if (d < 1440) return `${Math.round(d / 60)} h ago`;
  return `${Math.round(d / 1440)} d ago`;
}
export const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
