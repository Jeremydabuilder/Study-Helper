import { describe, expect, it } from 'vitest';
import { Metrics, makeLogger, routeTemplate } from '../src/server/hosted/ops';

describe('operations logging and metrics cannot leak student content', () => {
  it('log lines keep only whitelisted scalar fields (no bodies, emails, ids or free text beyond a short detail)', () => {
    const lines: string[] = []; const log = makeLogger({ write: (l) => lines.push(l) }, () => 0);
    log.error('request_failed', { route: '/api/subjects/:id', status: 500, ms: 12, answer: 'my secret answer', email: 'kid@example.test', body: { text: 'reading' }, cookie: 'sh.session_token=abc', userId: 'u1', errorClass: 'TypeError' } as never);
    const out = lines.join('\n'); expect(out).toContain('request_failed'); expect(out).toContain('TypeError');
    for (const s of ['my secret answer', 'kid@example.test', 'reading', 'session_token', 'u1']) expect(out).not.toContain(s);
  });
  it('route templates replace identifiers so metrics and logs never carry them', () => {
    const t = (path: string, route?: string) => routeTemplate({ path, baseUrl: '', route: route ? { path: route } : undefined } as never);
    expect(t('/api/subjects/6b0e1c52-1111-2222-3333-444455556666/files', '/api/subjects/:id/files')).toBe('/api/subjects/:id/files');
    expect(t('/api/files/6b0e1c52-1111-2222-3333-444455556666')).toBe('/api/files/:id');
  });
  it('metrics report counts, error rates and percentiles per route template only', () => {
    const m = new Metrics(); for (let i = 0; i < 20; i++) m.record('GET /api/today', i === 0 ? 500 : 200, 10 + i); m.record('POST /api/x', 429, 3);
    const s = m.snapshot(); expect(s.requests).toBe(21); expect(s.serverErrorRate).toBeCloseTo(1 / 21, 3);
    expect(s.routes[0]).toMatchObject({ route: 'GET /api/today', requests: 20, serverErrors: 1 }); expect(JSON.stringify(s)).not.toMatch(/@|token/i);
  });
});
