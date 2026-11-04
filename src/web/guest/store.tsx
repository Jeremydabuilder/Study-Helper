import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { clearDrafts } from './drafts';
import { keyHeaders, removeKey, useKeyState } from './keystore';
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
/** A Groq-key-shaped string anywhere in a profile (a pasted note, a planted field) is replaced, so an export or an import can never carry a credential. */
const KEY_LIKE = /\bgsk_[A-Za-z0-9_-]{16,}/g;
export function scrubCredentials<T>(v: T): T {
  if (typeof v === 'string') return v.replace(KEY_LIKE, '[removed key]') as unknown as T;
  if (Array.isArray(v)) return v.map(scrubCredentials) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubCredentials(x)])) as T;
  return v;
}
export const exportProfile = (p: Profile) => ({ format: 'study-helper-guest-profile', version: 1, exportedAt: new Date().toISOString(), profile: scrubCredentials(p) });
/** Only known profile fields are read from a file: anything else in it (a stray key, a credential) is dropped, never stored. */
const PREF_KEYS = ['sleepHours', 'bedtime', 'sessionMinutes', 'bestTime', 'weekdayStudyMinutes', 'weekendStudyMinutes', 'trouble', 'hardestClass', 'materials', 'method'] as const;
const PROFILE_FIELDS = ['createdAt', 'updatedAt', 'classes', 'assignments', 'commitments', 'preferences', 'goals', 'notes', 'cards', 'confirmedAt'] as const;
export function parseExport(text: string): Profile {
  const j = JSON.parse(text); const p = j?.format === 'study-helper-guest-profile' ? j.profile : j;
  if (!p || p.version !== 1 || !Array.isArray(p.assignments) || !Array.isArray(p.classes)) throw new Error('That is not a Study Helper profile export.');
  const base = emptyProfile(); const out: Record<string, unknown> = { ...base };
  for (const f of PROFILE_FIELDS) if (p[f] !== undefined) out[f] = p[f];
  const prefs: Record<string, unknown> = {}; for (const k of PREF_KEYS) if (p.preferences?.[k] !== undefined) prefs[k] = p.preferences[k]; out.preferences = prefs;
  const i = p.interview ?? {};
  out.interview = { status: ['not_started', 'in_progress', 'finished', 'skipped'].includes(i.status) ? i.status : 'not_started', answers: typeof i.answers === 'object' && i.answers ? i.answers : {}, asked: Array.isArray(i.asked) ? i.asked : [], startedAt: i.startedAt };
  return scrubCredentials(out) as unknown as Profile;
}

export interface PublicStatus { enabled: boolean; operatorAi: boolean; byok: { defaultModel: string; models: string[] } | null; ai: { available: boolean; cooling: boolean; waitMs: number }; limits: { maxPasteChars: number; aiChunkChars: number; aiMaxChunks: number; perDay: number } }
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
  const reset = useCallback(() => { clearProfile(); clearDrafts(); removeKey(); const e = emptyProfile(); ref.current = e; setProfile(e); setSaveError(null); }, []);
  const refreshStatus = useCallback(() => { api<PublicStatus>('GET', '/public/status').then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(() => { refreshStatus(); const t = setInterval(() => { setToday(todayKey()); }, 60_000); return () => clearInterval(t); }, [refreshStatus]);
  // another tab of the same browser changed it
  useEffect(() => { const h = (e: StorageEvent) => { if (e.key === KEY) { const p = loadProfile(); ref.current = p; setProfile(p); } }; window.addEventListener('storage', h); return () => window.removeEventListener('storage', h); }, []);
  const value = useMemo(() => ({ profile, update, replace, reset, today, status, refreshStatus, saveError, storageBroken }), [profile, update, replace, reset, today, status, refreshStatus, saveError]);
  return <GuestCtx.Provider value={value}>{children}</GuestCtx.Provider>;
}

/* ---- which assistant answers: the visitor's own key, else the site's shared assistant if the operator allows it, else none ---- */
export type ProviderMode = 'visitor' | 'operator' | 'none';
export function useProvider(): { mode: ProviderMode; ready: boolean; cooling: boolean; label: string; byokAllowed: boolean } {
  const { status } = useGuest(); const k = useKeyState();
  const byokAllowed = !!status?.byok;
  if (k.has && byokAllowed) return { mode: 'visitor', ready: true, cooling: false, label: `Your Groq key (••••${k.last4})`, byokAllowed };
  if (status?.operatorAi && status.ai.available) return { mode: 'operator', ready: true, cooling: false, label: 'The site’s shared assistant (limited)', byokAllowed };
  return { mode: 'none', ready: false, cooling: !!status?.operatorAi && status.ai.cooling, label: 'No assistant set up', byokAllowed };
}
/** Errors that mean "fix the assistant setup": the page offers a link to Settings. */
export const needsSetup = (e: unknown) => e instanceof ApiError && (e.extra?.setup === true || ['ai_not_configured', 'byok_bad_key', 'byok_bad_model'].includes(e.code) || e.code === 'ai_rejected');

/* ---- the assistant calls (each sends only what it needs; the visitor's key, if any, travels in a header for this one request) ---- */
const post = <T,>(path: string, body: unknown) => api<T>('POST', path, body, keyHeaders());
export const aiExtract = (text: string) => post<{ result: unknown }>('/public/extract', { text });
export const aiHint = (b: unknown) => post<{ hint: string; level: string }>('/public/hint', b);
export const aiQuiz = (b: unknown) => post<{ questions: { prompt: string; answer: string; hint: string }[] }>('/public/quiz', b);
export const aiCheck = (b: unknown) => post<{ verdict: 'correct' | 'partly' | 'incorrect' | 'unsure'; feedback: string }>('/public/check', b);
export const aiChat = (b: unknown) => post<{ reply: string }>('/public/chat', b);
export interface KeyTest { ok: boolean; kind: string; message: string; retryAfterMs?: number; latencyMs?: number; model: string }
/** Tests the key written in the Settings box (not necessarily the active one) with one small real request. */
export const testKey = (key: string, model: string) => api<KeyTest>('POST', '/public/byok/test', {}, { 'x-groq-key': key.trim(), 'x-groq-model': model });
export const chunkText = (text: string, size: number, maxChunks: number): { chunks: string[]; covered: number } => {
  const chunks: string[] = []; let i = 0;
  while (i < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) { const cut = text.lastIndexOf('\n', end); if (cut > i + size * 0.5) end = cut; }
    chunks.push(text.slice(i, end)); i = end;
  }
  return { chunks, covered: i };
};
