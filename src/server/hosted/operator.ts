import { timingSafeEqual } from 'node:crypto';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { createInvites, listInvites, revokeInvites } from './invites';
import { RateLimiter, spendReport } from './limits';
import { Pool, audit, getSettingPg, setSettingPg } from './pg';
import { HttpError } from '../services/common';

/**
 * The operator's page (#/operator) for hosts that give you a dashboard but no terminal: create and revoke invitation codes and flip the same switches the
 * command-line tool flips. It shows counts and codes, never student content. It is guarded by OPERATOR_TOKEN (sent as a Bearer header from the page;
 * never in a URL), refuses all attempts when no token of at least 24 characters is configured, and slows down guessing per address.
 */
const SWITCHES = { pilot: 'pilot_enabled', signups: 'signups_open', ai: 'ai_enabled' } as const;

export function mountOperator(app: express.Express, o: { pool: Pool; now: () => number; ipOf: (req: Request) => string }) {
  const guesses = new RateLimiter(10, 60_000, o.now);
  const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const guard = (req: Request, res: Response, next: express.NextFunction) => {
    const token = process.env.OPERATOR_TOKEN ?? '';
    if (token.length < 24) return res.status(404).end(); // not configured: the page does not exist
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!given || !same(given, token)) {
      const r = guesses.check(o.ipOf(req));
      return res.status(r.ok ? 401 : 429).json({ error: { code: r.ok ? 'bad_token' : 'rate_limited', message: r.ok ? 'That operator key is not right.' : 'Too many attempts. Wait a minute.' } });
    }
    res.setHeader('Cache-Control', 'no-store'); next();
  };
  const wrap = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: express.NextFunction) => { try { res.json(await fn(req)); } catch (e) { next(e); } };
  const r = express.Router(); r.use(express.json({ limit: '10kb' }), guard);

  r.get('/status', wrap(async () => {
    const [pilot, signups, ai, max] = await Promise.all([getSettingPg<boolean>(o.pool, 'pilot_enabled', false), getSettingPg<boolean>(o.pool, 'signups_open', true), getSettingPg<boolean>(o.pool, 'ai_enabled', true), getSettingPg<number>(o.pool, 'pilot_max_users', 30)]);
    const users = (await o.pool.query('SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE "isAnonymous")::int guests FROM "user"')).rows[0];
    const spend = await spendReport(o.pool, o.now());
    return { switches: { pilot, signups, ai }, maxUsers: max, people: users.n, guests: users.guests, last24h: { assistantRequests: spend.last24h.n }, invites: await listInvites(o.pool, o.now()) };
  }));
  r.post('/invites', wrap(async (req) => {
    const b = z.object({ count: z.number().int().min(1).max(20), label: z.string().max(60).optional(), days: z.number().int().min(1).max(60).optional() }).parse(req.body);
    return { codes: await createInvites(o.pool, { count: b.count, label: b.label, ttlDays: b.days, now: o.now() }) }; // shown once; only hashes are kept
  }));
  r.post('/invites/revoke', wrap(async (req) => {
    const b = z.object({ idPrefix: z.string().max(36).optional(), label: z.string().max(60).optional() }).refine((x) => x.idPrefix || x.label).parse(req.body);
    return { revoked: await revokeInvites(o.pool, b) };
  }));
  r.post('/switch', wrap(async (req) => {
    const b = z.object({ name: z.enum(['pilot', 'signups', 'ai']), on: z.boolean() }).parse(req.body);
    await setSettingPg(o.pool, SWITCHES[b.name], b.on); await audit(o.pool, `switch_${SWITCHES[b.name]}`, null, { value: b.on, via: 'operator_page' });
    return { ok: true };
  }));
  r.post('/max-users', wrap(async (req) => {
    const n = z.object({ n: z.number().int().min(1).max(500) }).parse(req.body).n;
    await setSettingPg(o.pool, 'pilot_max_users', n); await audit(o.pool, 'max_users', null, { n, via: 'operator_page' });
    return { ok: true };
  }));
  app.use('/internal/operator', r);
  void HttpError;
}
