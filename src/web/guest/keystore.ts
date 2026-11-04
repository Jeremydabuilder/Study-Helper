import { useSyncExternalStore } from 'react';

/**
 * The visitor's own Groq key. Where it can live, and nowhere else:
 *  1. memory (this variable): the default. Gone when the tab is reloaded or closed.
 *  2. localStorage, key `sh.guest.groqkey.v1`: only if "Remember on this device" was ticked.
 * It is never put in the study profile, the export, the URL, sessionStorage, cookies or any server. `removeKey()` clears every location above.
 * Anything stored in the browser can be read by scripts running on this site's address and by anyone who can use this browser profile: the Settings page says so.
 */
export const KEY_STORAGE = 'sh.guest.groqkey.v1';
export const KEY_SHAPE = /^[A-Za-z0-9_-]{20,256}$/;
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
interface Active { key: string; model: string; remembered: boolean }
let active: Active | null = null; let loaded = false; let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((l) => l()); };

function load() {
  if (loaded) return; loaded = true;
  try { const raw = localStorage.getItem(KEY_STORAGE); if (raw) { const j = JSON.parse(raw); if (typeof j?.key === 'string' && KEY_SHAPE.test(j.key)) active = { key: j.key, model: typeof j.model === 'string' && j.model ? j.model : DEFAULT_MODEL, remembered: true }; else localStorage.removeItem(KEY_STORAGE); } } catch { /* storage blocked: memory only */ }
}
export function getActive(): Active | null { load(); return active; }
export const isValidKey = (k: string) => KEY_SHAPE.test(k.trim());
export const maskKey = (k: string) => `••••${k.slice(-4)}`;

/** Start using a key. `remember` false (the default) keeps it in memory only and removes any copy left in storage. Returns an error text when storage was asked for but is not available. */
export function setKey(key: string, model: string, remember: boolean): string | null {
  load(); const k = key.trim(); const m = model.trim() || DEFAULT_MODEL;
  active = { key: k, model: m, remembered: false }; let err: string | null = null;
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  if (remember) { try { localStorage.setItem(KEY_STORAGE, JSON.stringify({ key: k, model: m })); active.remembered = true; } catch { err = 'This browser would not save the key, so it is kept in memory for this tab only.'; } }
  emit(); return err;
}
export function setModel(model: string) { load(); if (!active) return; active = { ...active, model: model.trim() || DEFAULT_MODEL }; if (active.remembered) { try { localStorage.setItem(KEY_STORAGE, JSON.stringify({ key: active.key, model: active.model })); } catch { /* ignore */ } } emit(); }
/** Forget the key everywhere this app put it. */
export function removeKey() {
  load(); active = null;
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  emit();
}
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Re-render when the key changes. Returns only what the screen needs to show (never the key itself). */
export function useKeyState(): { has: boolean; last4: string; model: string; remembered: boolean } {
  useSyncExternalStore(subscribe, () => { load(); return version; });
  const a = getActive();
  return { has: !!a, last4: a ? a.key.slice(-4) : '', model: a?.model ?? DEFAULT_MODEL, remembered: !!a?.remembered };
}
/** The headers that carry the key on one request. Header only: never a URL, never the body. */
export function keyHeaders(): Record<string, string> | undefined { const a = getActive(); return a ? { 'x-groq-key': a.key, 'x-groq-model': a.model } : undefined; }
