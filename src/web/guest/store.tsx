import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Profile, emptyProfile } from '../../core/guest/types';
import { localDateKey } from '../../core/time';

/**
 * The guest profile lives ONLY in this browser (localStorage). The server never receives it as a whole; later assistant calls carry just the excerpt or fields they need.
 * Each browser (and each browser profile, and each private window) has its own, and they never meet.
 */
export const KEY = 'sh.guest.profile.v1';
let memoryOnly: string | null = null; let storageBroken = false;
const read = (): string | null => { try { return localStorage.getItem(KEY); } catch { storageBroken = true; return memoryOnly; } };
const write = (v: string): string | null => { try { localStorage.setItem(KEY, v); memoryOnly = null; return null; } catch (e) { storageBroken = true; memoryOnly = v; return e instanceof DOMException && e.name === 'QuotaExceededError' ? 'This browser has no room left to save more. Export a copy, then remove old notes.' : 'This browser would not save your profile (private mode or blocked storage). It will be lost when you close the tab. Export a copy to keep it.'; } };
export function loadProfile(): Profile {
  const raw = read(); if (!raw) return emptyProfile();
  try { const p = JSON.parse(raw); if (p && p.version === 1 && Array.isArray(p.assignments)) return { ...emptyProfile(), ...p, preferences: p.preferences ?? {}, interview: { ...emptyProfile().interview, ...(p.interview ?? {}) } }; } catch { /* damaged: start again, but keep the damaged text under another key */ try { localStorage.setItem(KEY + '.damaged', raw); } catch { /* ignore */ } }
  return emptyProfile();
}
export const clearProfile = () => { try { localStorage.removeItem(KEY); localStorage.removeItem(KEY + '.damaged'); } catch { /* ignore */ } memoryOnly = null; };
export const exportProfile = (p: Profile) => ({ format: 'study-helper-guest-profile', version: 1, exportedAt: new Date().toISOString(), profile: p });
export function parseExport(text: string): Profile {
  const j = JSON.parse(text); const p = j?.format === 'study-helper-guest-profile' ? j.profile : j;
  if (!p || p.version !== 1 || !Array.isArray(p.assignments) || !Array.isArray(p.classes)) throw new Error('That is not a Study Helper profile export.');
  return { ...emptyProfile(), ...p, preferences: p.preferences ?? {}, interview: { ...emptyProfile().interview, ...(p.interview ?? {}) } };
}

export interface PublicStatus { enabled: boolean; ai: { available: boolean; cooling: boolean; waitMs: number }; limits: { maxPasteChars: number; aiChunkChars: number; aiMaxChunks: number; perDay: number } }
interface Ctx { profile: Profile; update(fn: (p: Profile) => Profile): void; replace(p: Profile): void; reset(): void; today: string; status: PublicStatus | null; refreshStatus(): void; saveError: string | null; storageBroken: boolean }
const GuestCtx = createContext<Ctx | null>(null);
export const useGuest = () => { const c = useContext(GuestCtx); if (!c) throw new Error('GuestProvider missing'); return c; };
export const todayKey = () => localDateKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

export function GuestProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [status, setStatus] = useState<PublicStatus | null>(null); const [saveError, setSaveError] = useState<string | null>(null);
  const [today, setToday] = useState(todayKey());
  const ref = useRef(profile); ref.current = profile;
  const persist = useCallback((p: Profile) => { setSaveError(write(JSON.stringify(p))); }, []);
  const update = useCallback((fn: (p: Profile) => Profile) => { const next = { ...fn(ref.current), updatedAt: Date.now() }; ref.current = next; setProfile(next); persist(next); }, [persist]);
  const replace = useCallback((p: Profile) => { ref.current = p; setProfile(p); persist(p); }, [persist]);
  const reset = useCallback(() => { clearProfile(); const e = emptyProfile(); ref.current = e; setProfile(e); setSaveError(null); }, []);
  const refreshStatus = useCallback(() => { api<PublicStatus>('GET', '/public/status').then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(() => { refreshStatus(); const t = setInterval(() => { setToday(todayKey()); }, 60_000); return () => clearInterval(t); }, [refreshStatus]);
  // another tab of the same browser changed it
  useEffect(() => { const h = (e: StorageEvent) => { if (e.key === KEY) { const p = loadProfile(); ref.current = p; setProfile(p); } }; window.addEventListener('storage', h); return () => window.removeEventListener('storage', h); }, []);
  const value = useMemo(() => ({ profile, update, replace, reset, today, status, refreshStatus, saveError, storageBroken }), [profile, update, replace, reset, today, status, refreshStatus, saveError]);
  return <GuestCtx.Provider value={value}>{children}</GuestCtx.Provider>;
}

/* ---- the assistant calls (each sends only what it needs) ---- */
export const aiExtract = (text: string) => api<{ result: unknown }>('POST', '/public/extract', { text });
export const aiHint = (b: unknown) => api<{ hint: string; level: string }>('POST', '/public/hint', b);
export const aiQuiz = (b: unknown) => api<{ questions: { prompt: string; answer: string; hint: string }[] }>('POST', '/public/quiz', b);
export const aiCheck = (b: unknown) => api<{ verdict: 'correct' | 'partly' | 'incorrect' | 'unsure'; feedback: string }>('POST', '/public/check', b);
export const chunkText = (text: string, size: number, maxChunks: number): { chunks: string[]; covered: number } => {
  const chunks: string[] = []; let i = 0;
  while (i < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) { const cut = text.lastIndexOf('\n', end); if (cut > i + size * 0.5) end = cut; }
    chunks.push(text.slice(i, end)); i = end;
  }
  return { chunks, covered: i };
};
