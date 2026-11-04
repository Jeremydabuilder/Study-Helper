/** Where a visitor's Groq key can live in the browser, and that removing it clears every place. (A stand-in for localStorage; no real browser here: the browser run is e2e-byok.) */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyProfile } from '../src/core/guest/types';

class Store { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } get length() { return this.m.size; } }
const KEY = 'gsk_' + 'Visitor1234567890'.repeat(3);
let ls: Store; let ss: Store;
async function fresh() { vi.resetModules(); ls = ls ?? new Store(); (globalThis as any).localStorage = ls; (globalThis as any).sessionStorage = ss; return import('../src/web/guest/keystore'); }
beforeEach(() => { ls = new Store(); ss = new Store(); });

describe('key store', () => {
  it('keeps the key in memory only by default, and a reload (new module) forgets it', async () => {
    const k = await fresh(); expect(k.getActive()).toBeNull();
    expect(k.setKey(KEY, 'openai/gpt-oss-120b', false)).toBeNull();
    expect(k.getActive()).toMatchObject({ key: KEY, remembered: false }); expect([...ls.m.values()].join()).not.toContain('Visitor1234567890'); expect(ss.m.size).toBe(0);
    const reloaded = await fresh(); expect(reloaded.getActive()).toBeNull();
  });
  it('remembers only when asked, under one known name, and a later "memory only" choice removes the stored copy', async () => {
    const k = await fresh(); k.setKey(KEY, 'm/m', true);
    expect([...ls.m.keys()]).toEqual(['sh.guest.groqkey.v1']); expect(ls.getItem('sh.guest.groqkey.v1')).toContain(KEY);
    const reloaded = await fresh(); expect(reloaded.getActive()).toMatchObject({ key: KEY, model: 'm/m', remembered: true });
    reloaded.setKey(KEY, 'm/m', false); expect(ls.m.size).toBe(0); expect(reloaded.getActive()!.remembered).toBe(false);
  });
  it('remove clears memory AND storage, and nothing returns after a reload', async () => {
    const k = await fresh(); k.setKey(KEY, 'm/m', true); k.removeKey();
    expect(k.getActive()).toBeNull(); expect(ls.m.size).toBe(0); expect(ss.m.size).toBe(0); expect(k.keyHeaders()).toBeUndefined();
    expect((await fresh()).getActive()).toBeNull();
  });
  it('a damaged or planted stored value is discarded, and blocked storage degrades to memory with a message', async () => {
    ls.setItem('sh.guest.groqkey.v1', JSON.stringify({ key: 'short' })); expect((await fresh()).getActive()).toBeNull(); expect(ls.m.size).toBe(0);
    ls.setItem('sh.guest.groqkey.v1', '{not json'); expect((await fresh()).getActive()).toBeNull();
    const k = await fresh(); (ls as any).setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    expect(k.setKey(KEY, 'm/m', true)).toMatch(/memory for this tab only/); expect(k.getActive()!.remembered).toBe(false);
  });
  it('the key only ever travels as request headers, masked everywhere it is shown', async () => {
    const k = await fresh(); k.setKey(KEY, 'm/m', false);
    expect(k.keyHeaders()).toEqual({ 'x-groq-key': KEY, 'x-groq-model': 'm/m' }); expect(k.maskKey(KEY)).toBe('••••7890'); expect(k.maskKey(KEY)).not.toContain('Visitor');
    expect(k.isValidKey(KEY)).toBe(true); expect(k.isValidKey('nope')).toBe(false);
  });
});

describe('exports and imports carry no credentials', () => {
  it('a Groq-key-shaped string anywhere in a profile is replaced on export', async () => {
    vi.resetModules(); (globalThis as any).localStorage = new Store(); const s = await import('../src/web/guest/store');
    const p = emptyProfile(1); p.notes.push({ id: 'n', title: 'Notes', className: '', addedAt: 1, text: `my key is ${KEY} oops` }); p.goals.push({ id: 'g', text: KEY, origin: 'typed' });
    const out = JSON.stringify(s.exportProfile(p)); expect(out).not.toContain('Visitor1234567890'); expect(out).toContain('[removed key]');
  });
  it('import reads known fields only, drops planted credentials in any field, and keeps real data', async () => {
    vi.resetModules(); (globalThis as any).localStorage = new Store(); const s = await import('../src/web/guest/store');
    const p: any = emptyProfile(1); p.assignments.push({ id: 'a', title: 'Essay', className: 'English', type: 'homework', due: { date: null, certainty: 'none', reason: null, raw: null }, estimateMin: 40, instructions: '', done: false, origin: 'typed', createdAt: 1 });
    p.groqKey = KEY; p.preferences = { sleepHours: 8, apiKey: KEY, authorization: `Bearer ${KEY}` }; p.interview.token = KEY;
    const back = s.parseExport(JSON.stringify({ format: 'study-helper-guest-profile', version: 1, apiKey: KEY, profile: p }));
    expect(JSON.stringify(back)).not.toContain('Visitor1234567890'); expect(back.assignments[0].title).toBe('Essay'); expect(back.preferences).toEqual({ sleepHours: 8 }); expect((back as any).groqKey).toBeUndefined();
    expect(() => s.parseExport('{"version":2}')).toThrow(/not a Study Helper profile/);
  });
});
