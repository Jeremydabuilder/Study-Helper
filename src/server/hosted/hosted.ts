import { hkdfSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { z } from 'zod';
import { AIProvider } from '../../ai/provider';
import { OfflineProvider } from '../../ai/offline';
import { createApp } from '../app';
import { WorkspaceName } from '../db';
import { seedDemo, demoCalendarEvents } from '../demoSeed';
import { AppConfig, Ctx, HttpError, metered } from '../services/common';
import { CalendarGateway, CalendarError, GoogleGateway, MemoryGateway, UnconfiguredGateway } from '../services/calendarGoogle';
import * as cal from '../services/calendar';
import * as port from '../services/portability';
import { Auth, INVITE_COOKIE, createAuth, migrateAuth, readCookie } from './auth';
import { HostedConfig } from './config';
import { checkInvite, looksLikeCode, normalizeCode } from './invites';
import { Gate, PgLedger, RateLimiter, assistantState, consumeQuota, refundQuota } from './limits';
import { Logger, Metrics, makeLogger, requestObserver } from './ops';
import { Pool, audit, createPool, getSettingPg, migrateControl } from './pg';
import { Tenants } from './tenants';
import { exportAccount } from './account';
import { deleteAccount } from './account';
import { submitReport } from './reports';

export interface HostedApp {
  app: express.Express; pool: Pool; auth: Auth; tenants: Tenants; metrics: Metrics;
  close(): Promise<void>;
}
export interface HostedDeps {
  cfg: AppConfig; hcfg: HostedConfig; dataDir: string;
  llm?: AIProvider | null; gateway?: CalendarGateway; now?: () => number; pool?: Pool; logger?: Logger;
}

type Student = { id: string; email: string };
const MB = 1024 * 1024;

/** A per-student secret for encrypting that student's Calendar tokens: one student's key cannot decrypt another's, and the master secret never encrypts directly. */
export const deriveUserSecret = (master: string, userId: string) => Buffer.from(hkdfSync('sha256', master, 'study-helper-user', `calendar-tokens:${userId}`, 32)).toString('hex');

export async function createHostedApp(d: HostedDeps): Promise<HostedApp> {
  const { cfg, hcfg } = d;
  const now = d.now ?? Date.now;
  const logger = d.logger ?? makeLogger(undefined, now);
  const metrics = new Metrics();
  const pool = d.pool ?? createPool(hcfg.databaseUrl, { ssl: /sslmode=require/.test(hcfg.databaseUrl) });
  await migrateControl(pool);
  const auth = createAuth(pool, hcfg, now);
  await migrateAuth(auth);
  await bindEnvironment(pool, hcfg, d.dataDir);

  const tenants = new Tenants(d.dataDir, { now });
  const offline = new OfflineProvider();
  const googleGw: CalendarGateway = d.gateway ?? (cfg.google ? new GoogleGateway(cfg.google) : new UnconfiguredGateway());
  const demoGws = new Map<string, MemoryGateway>();
  const demoReady = new Map<string, Promise<void>>();
  const extractGate = new Gate(hcfg.limits.globalConcurrentExtractions, hcfg.limits.userConcurrentExtractions, 'Another file is being processed. Wait a moment and try again.');
  const apiLimiter = new RateLimiter(hcfg.rate.apiPerMin, 60_000, now), inviteLimiter = new RateLimiter(hcfg.rate.invitePerMin, 60_000, now), authLimiter = new RateLimiter(hcfg.rate.authPerMin, 60_000, now);
  const secureCookie = hcfg.publicUrl.startsWith('https://');
  const studentOf = (req: Request): Student => { const s = (req as any).student as Student | undefined; if (!s) throw new HttpError(401, 'signed_out', 'Please sign in.'); return s; };
  const wsOf = (req: Request): WorkspaceName => (req.headers['x-workspace'] === 'demo' ? 'demo' : 'real');
  const ipOf = (req: Request) => req.ip ?? 'unknown';

  async function ensureDemo(userId: string, db: import('../db').Db) {
    const gw = demoGws.get(userId) ?? new MemoryGateway(); demoGws.set(userId, gw);
    let p = demoReady.get(userId);
    if (!p) {
      p = (async () => {
        if (!db.get("SELECT 1 FROM settings WHERE key = 'demo_seeded'")) await seedDemo(db, { cfg, now, offline, demoGw: gw });
        else demoCalendarEvents(db, gw, now());
      })();
      demoReady.set(userId, p);
      p.catch(() => demoReady.delete(userId));
    }
    await p;
    return gw;
  }

  const hooks = {
    mountFirst(app: express.Express) {
      app.set('trust proxy', hcfg.trustProxy ? 1 : false);
      app.use(requestObserver(metrics, logger));
      app.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
        res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
        next();
      });
      app.get('/healthz', (_req, res) => res.json({ ok: true })); // liveness: the process is up (no dependencies, no data)
      app.get('/readyz', async (_req, res) => { // readiness: can serve students (database reachable and migrated, data directory writable)
        try {
          await pool.query('SELECT 1');
          const probe = join(d.dataDir, '.ready'); writeFileSync(probe, String(now()));
          res.json({ ok: true, environment: hcfg.environment });
        } catch { res.status(503).json({ ok: false }); }
      });
      app.get('/internal/metrics', async (req, res) => { // operator only: totals and latencies, never content
        const token = process.env.OPERATOR_TOKEN;
        if (!token || token.length < 24 || req.headers.authorization !== `Bearer ${token}`) return res.status(404).end();
        const { spendReport } = await import('./limits');
        res.json({ ...metrics.snapshot(), spend: await spendReport(pool, now()), openDatabases: tenants.openCount });
      });
      // Browsers always send Origin on cross-site POSTs. Refuse state-changing authentication requests from any origin but this site, regardless of the library's own check.
      const siteOrigin = new URL(hcfg.publicUrl).origin;
      app.use('/api/auth', (req, res, next) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== siteOrigin) return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Cross-site requests are not allowed.' } }); next(); });
      // Better Auth endpoints (sign in/out, callbacks), rate limited per address
      app.all('/api/auth/*', (req, res, next) => { const r = authLimiter.check(ipOf(req)); if (!r.ok) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } }); next(); }, toNodeHandler(auth));
    },

    mountGuards(app: express.Express) {
      // ---- signed-out endpoints: who am I, and invitation codes ----
      app.get('/api/session', async (req, res, next) => {
        try {
          const s = await sessionOf(req);
          const open = await getSettingPg<boolean>(pool, 'pilot_enabled', false);
          res.json({ signedIn: !!s, email: s?.email ?? null, pilotOpen: open, environment: hcfg.environment, operator: hcfg.operator, retentionDays: { audit: 180, reports: 90 }, methods: { oidc: hcfg.oidc ? { providerId: hcfg.oidc.providerId } : null, password: hcfg.passwordSignIn } });
        } catch (e) { next(e); }
      });
      app.post('/api/invite/check', async (req, res, next) => {
        try {
          const r = inviteLimiter.check(ipOf(req)); if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
          const code = z.object({ code: z.string().max(64) }).parse(req.body).code;
          res.json(await checkInvite(pool, code, now()));
        } catch (e) { next(e); }
      });
      // The code is kept in a short-lived HttpOnly cookie so the sign-up that follows (including the redirect back from Google) can prove it. Nothing is claimed yet.
      app.post('/api/invite/start', async (req, res, next) => {
        try {
          const r = inviteLimiter.check(ipOf(req)); if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
          const code = z.object({ code: z.string().max(64) }).parse(req.body).code;
          const chk = await checkInvite(pool, code, now());
          if (!chk.valid) throw new HttpError(400, 'invite_invalid', inviteMessage(chk.reason));
          res.cookie(INVITE_COOKIE, normalizeCode(code), { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 15 * 60_000, path: '/' });
          res.json({ ok: true });
        } catch (e) { next(e); }
      });

      // ---- everything else under /api needs a signed-in student ----
      app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
        try {
          if (req.path === '/session' || req.path.startsWith('/invite/') || req.path.startsWith('/auth/')) return next();
          if (!(await getSettingPg<boolean>(pool, 'pilot_enabled', false))) throw new HttpError(503, 'pilot_paused', 'Study Helper is paused right now. Your work is safe. Please try again later.');
          const s = await sessionOf(req);
          if (!s) throw new HttpError(401, 'signed_out', 'Please sign in to continue.');
          (req as any).student = s;
          const rl = apiLimiter.check(s.id); if (!rl.ok) throw new HttpError(429, 'rate_limited', 'You are going a bit fast. Wait a few seconds and try again.', { retryable: true, retryAfterMs: rl.retryAfterMs });
          await routeGuard(req, res, s);
          next();
        } catch (e) { next(e); }
      });

      // ---- account: export, delete, assistant state, problem reports ----
      app.get('/api/account', (req, res) => { const s = studentOf(req); res.json({ email: s.email, environment: hcfg.environment, storageMb: Math.round((tenants.usageBytes(s.id) / MB) * 10) / 10, storageLimitMb: hcfg.limits.userStorageMb }); });
      app.get('/api/account/assistant', async (req, res, next) => { try { res.json(await assistantState(pool, studentOf(req).id, hcfg.limits, now())); } catch (e) { next(e); } });
      app.get('/api/account/export', async (req, res, next) => {
        try {
          const s = studentOf(req);
          await audit(pool, 'export_requested', s.id, {});
          const body = await withCtx(req, 'real', (ctx) => exportAccount(ctx, { email: s.email, withFiles: req.query.files === '1' }));
          res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', 'attachment; filename="study-helper-export.json"'); res.setHeader('Cache-Control', 'no-store');
          res.send(JSON.stringify(body));
        } catch (e) { next(e); }
      });
      app.post('/api/account/delete', async (req, res, next) => {
        try {
          const s = studentOf(req);
          const b = z.object({ confirm: z.string() }).parse(req.body);
          if (b.confirm !== 'DELETE MY ACCOUNT') throw new HttpError(400, 'confirm_required', 'Type DELETE MY ACCOUNT to confirm.');
          await deleteAccount({ pool, tenants, userId: s.id, now });
          demoGws.delete(s.id); demoReady.delete(s.id);
          res.clearCookie(`${secureCookie ? '__Secure-' : ''}sh.session_token`);
          res.json({ deleted: true });
        } catch (e) { next(e); }
      });
      app.post('/api/report', async (req, res, next) => {
        try { const s = studentOf(req); const b = z.object({ message: z.string().max(2000), include: z.array(z.string()).max(5).optional(), attach: z.object({ kind: z.string().max(30), text: z.string().max(4000) }).optional(), previewOnly: z.boolean().optional(), confirmed: z.boolean().optional() }).parse(req.body); res.json(await submitReport(pool, s.id, b, now())); } catch (e) { next(e); }
      });
    },

    async ctxFor(req: Request, ws: WorkspaceName) { return buildCtx(studentOf(req), ws); },

    async calendarCallback(req: Request, res: Response) {
      const go = (q: string) => res.redirect(`/#/calendar?${q}`);
      try {
        const s = studentOf(req);
        const { code, state, error } = req.query as Record<string, string>;
        const st = state ? cal.consumeState(state) : null;
        if (error) return go(`error=${error === 'access_denied' ? 'denied' : 'org_blocked'}`);
        // the state must have been issued to THIS signed-in student: a callback cannot attach a calendar to someone else's account
        if (!st || !code || st.userId !== s.id) return go('error=denied');
        const lease = await buildCtx(s, st.workspace as WorkspaceName);
        try { await cal.finishConnect(lease.ctx, code, st.verifier); } finally { lease.release(); }
        go('connected=1');
      } catch (e) { go(`error=${e instanceof CalendarError ? e.code : 'unavailable'}`); }
    },
    async resetDemo(req: Request) { const s = studentOf(req); tenants.dropDemo(s.id); demoGws.delete(s.id); demoReady.delete(s.id); },
    meta(req: Request) { const s = (req as any).student as Student | undefined; return { student: s ? { email: s.email } : null, environment: hcfg.environment }; },
    onError(err: unknown, req: Request) { logger.error('unhandled_error', { errorClass: err instanceof Error ? err.constructor.name : typeof err, route: req.path.replace(/\/[0-9a-f-]{8,}/gi, '/:id'), method: req.method }); },
  };

  async function sessionOf(req: Request): Promise<Student | null> {
    const r = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return r?.user ? { id: r.user.id, email: r.user.email } : null;
  }

  async function buildCtx(s: Student, ws: WorkspaceName): Promise<{ ctx: Ctx; release(): void }> {
    const lease = tenants.lease(s.id, ws);
    try {
      const userCfg: AppConfig = { ...cfg, appSecret: deriveUserSecret(cfg.appSecret ?? hcfg.authSecret, s.id) };
      if (ws === 'demo') {
        const gw = await ensureDemo(s.id, lease.db);
        return { ctx: { db: lease.db, workspace: 'demo', now, ai: offline, offline, cfg: userCfg, calendar: gw, userId: s.id, hosted: true }, release: lease.release };
      }
      const base: Ctx = { db: lease.db, workspace: 'real', now, ai: offline, offline, cfg: userCfg, calendar: googleGw, userId: s.id, hosted: true };
      const ledger = new PgLedger(pool, s.id, hcfg.limits, now, cfg.aiPriceOverride);
      return { ctx: { ...base, ai: d.llm ? metered(base, d.llm, ledger) : offline }, release: lease.release };
    } catch (e) { lease.release(); throw e; }
  }
  async function withCtx<T>(req: Request, ws: WorkspaceName, fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
    const l = await buildCtx(studentOf(req), ws);
    try { return await fn(l.ctx); } finally { l.release(); }
  }

  /** Per-route protections that need the student, the database or the clock: upload and extraction limits, chat allowance, import size. */
  async function routeGuard(req: Request, res: Response, s: Student) {
    const m = req.method, p = req.path;
    const upload = m === 'POST' && (/^\/subjects\/[^/]+\/files$/.test(p) || /^\/sources\/[^/]+\/replace$/.test(p));
    const heavy = upload || (m === 'POST' && (/^\/sources\/[^/]+\/ocr$/.test(p) || /^\/sources\/[^/]+\/extract$/.test(p)));
    const L = hcfg.limits;
    if (upload) {
      const len = Number(req.headers['content-length']);
      if (!Number.isFinite(len) || len <= 0) throw new HttpError(411, 'length_required', 'The file size could not be determined. Try again.');
      if (tenants.usageBytes(s.id) + len > L.userStorageMb * MB) throw new HttpError(413, 'storage_full', `Your storage is full (${L.userStorageMb} MB). Delete a material you no longer need, then try again.`);
      await consumeQuota(pool, s.id, 'upload', { limit: L.userDailyUploads, bytes: len, bytesLimit: L.userDailyUploadMb * MB, now: now(), message: `You have reached today’s upload limit (${L.userDailyUploads} files, ${L.userDailyUploadMb} MB). It resets within 24 hours; you can still paste text.` });
      let finished = false;
      res.on('finish', () => { finished = true; if (res.statusCode >= 400) void refundQuota(pool, s.id, 'upload', { bytes: len, now: now() }).catch(() => {}); });
      res.on('close', () => { if (!finished) void refundQuota(pool, s.id, 'upload', { bytes: len, now: now() }).catch(() => {}); }); // an interrupted upload does not burn the allowance
    }
    if (heavy) {
      await consumeQuota(pool, s.id, 'extract', { limit: L.userDailyExtractions, now: now(), message: 'You have reached today’s limit for processing files. It resets within 24 hours.' }).catch((e) => { if (upload) void refundQuota(pool, s.id, 'upload', { bytes: Number(req.headers['content-length']) || 0, now: now() }).catch(() => {}); throw e; });
      const release = extractGate.enter(s.id); res.on('close', release);
    }
    if (m === 'POST' && /^\/conversations\/[^/]+\/messages$/.test(p)) await consumeQuota(pool, s.id, 'chat', { limit: L.userDailyChat, now: now(), message: 'You have reached today’s chat limit. It resets within 24 hours.' });
    if (m === 'POST' && p.startsWith('/import/')) { const len = Number(req.headers['content-length']); if (len > 12 * MB) throw new HttpError(413, 'too_large', 'That import file is too large (limit 12 MB).'); }
  }

  const app = createApp({ cfg, now, llm: d.llm ?? null, offline, ctx: () => { throw new Error('hosted mode never uses the shared runtime context'); }, ensureDemo: async () => {}, resetDemo: async () => {}, workspaces: undefined as never, googleGw, demoGw: new MemoryGateway() } as never, hooks);
  return { app, pool, auth, tenants, metrics, async close() { tenants.closeAll(); if (!d.pool) await pool.end(); } };
}

const inviteMessage = (r: string) => ({ unknown: 'That invitation code was not recognised. Check it and try again.', used: 'That invitation has already been used.', expired: 'That invitation has expired. Ask for a new one.', revoked: 'That invitation is no longer valid.', in_use: 'That invitation is being used right now. Try again in a few minutes.' } as Record<string, string>)[r] ?? 'That invitation does not work.';

/**
 * A server and its data must agree on what they are (production, staging, test). A staging server pointed at the production database or data folder refuses to start,
 * so fictional-data experiments can never read or write real student data, and the reverse.
 */
async function bindEnvironment(pool: Pool, hcfg: HostedConfig, dataDir: string) {
  const dbLabel = (await pool.query("SELECT value FROM app_settings WHERE key = 'data_label'")).rows[0]?.value as string | undefined;
  if (dbLabel === undefined) await pool.query("INSERT INTO app_settings (key, value) VALUES ('data_label', $1::jsonb) ON CONFLICT (key) DO NOTHING", [JSON.stringify(hcfg.dataLabel)]);
  else if (dbLabel !== hcfg.dataLabel) throw new Error(`This database belongs to "${dbLabel}" but this server is configured as "${hcfg.dataLabel}". Refusing to start so environments cannot share student data.`);
  mkdirSync(dataDir, { recursive: true });
  const f = join(dataDir, 'DATA_LABEL');
  if (existsSync(f)) { const l = readFileSync(f, 'utf8').trim(); if (l !== hcfg.dataLabel) throw new Error(`The data folder belongs to "${l}" but this server is configured as "${hcfg.dataLabel}". Refusing to start.`); }
  else writeFileSync(f, hcfg.dataLabel);
}
