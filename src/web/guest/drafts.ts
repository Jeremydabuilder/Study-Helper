import { useCallback, useState } from 'react';

/** Text a visitor is typing (homework question, attempt, chat message) is kept while they leave for Settings and come back, or while a connection fails. Same-tab sessionStorage + memory. */
export const DRAFT_STORAGE = 'sh.guest.drafts.v1';
const mem = new Map<string, string>(); let loaded = false;
const load = () => { if (loaded) return; loaded = true; try { const j = JSON.parse(sessionStorage.getItem(DRAFT_STORAGE) ?? '{}'); for (const [k, v] of Object.entries(j)) if (typeof v === 'string') mem.set(k, v); } catch { /* none */ } };
const save = () => { try { const o: Record<string, string> = {}; mem.forEach((v, k) => { if (v) o[k] = v.slice(0, 6000); }); if (Object.keys(o).length) sessionStorage.setItem(DRAFT_STORAGE, JSON.stringify(o)); else sessionStorage.removeItem(DRAFT_STORAGE); } catch { /* memory only */ } };
export const getDraft = (k: string) => { load(); return mem.get(k) ?? ''; };
export const setDraft = (k: string, v: string) => { load(); if (v) mem.set(k, v); else mem.delete(k); save(); };
export const clearDrafts = () => { mem.clear(); loaded = true; try { sessionStorage.removeItem(DRAFT_STORAGE); } catch { /* ignore */ } };
export function useDraft(k: string, initial = ''): [string, (v: string) => void] {
  const [v, set] = useState(() => getDraft(k) || initial);
  const update = useCallback((x: string) => { set(x); setDraft(k, x); }, [k]);
  return [v, update];
}
