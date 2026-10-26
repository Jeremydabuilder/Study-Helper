import express, { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { AIError } from '../ai/provider';
import { MATH_SKILLS } from '../core/mathgen';
import { DEFAULT_WEIGHTS, WEIGHT_HELP } from '../core/priority';
import { DEFAULT_AVAILABILITY } from '../core/schedule';
import { isValidTimeZone } from '../core/time';
import { WorkspaceName } from './db';
import { Runtime } from './context';
import { setFlagDecision } from './services/sourceSafety';
import { Ctx, HttpError, aiInfo, budgetUsd, callLimit, getAvailability, getProfile, getSetting, getWeights, setSetting, usageReport } from './services/common';
import * as content from './services/content';
import * as practice from './services/practice';
import * as plan from './services/plan';
import * as mem from './services/memory';
import * as port from './services/portability';
import * as items from './services/items';
import * as cal from './services/calendar';
import { CalendarError } from './services/calendarGoogle';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const AvailabilitySchema = z.object({
  dailyLimitMin: z.array(z.number().int().min(0).max(600)).length(7),
  preferredStart: hhmm, preferredEnd: hhmm, bedtime: hhmm, windDownMin: z.number().int().min(0).max(180),
  bufferBeforeMin: z.number().int().min(0).max(120), bufferAfterMin: z.number().int().min(0).max(120),
  protected: z.array(z.object({ label: z.string().max(40), days: z.array(z.number().int().min(0).max(6)).max(7), start: hhmm, end: hhmm })).max(12),
  minBlockMin: z.number().int().min(5).max(60), maxBlockMin: z.number().int().min(10).max(120), breakMin: z.number().int().min(0).max(30),
  heavyDayBusyMin: z.number().int().min(30).max(1000), heavyDayLimitMin: z.number().int().min(0).max(300),
  testPrepDays: z.number().int().min(1).max(21), defaultTestPrepMin: z.number().int().min(10).max(1200), defaultHomeworkMin: z.number().int().min(5).max(600), homeworkBufferDays: z.number().int().min(0).max(7),
});
const WeightsSchema = z.object(Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, z.number().min(0).max(10)])) as Record<keyof typeof DEFAULT_WEIGHTS, z.ZodNumber>);

export function createApp(rt: Runtime) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  // The server stores a student's records. Refuse cross-site writes and DNS-rebinding style requests.
  app.use((req, res, next) => {
    const origin = req.headers.origin, host = req.headers.host;
    if (origin && host) { try { if (new URL(origin).host !== host) return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Cross-origin requests are not allowed.' } }); } catch { return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Bad origin.' } }); } }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.is('application/json') === false) return res.status(415).json({ error: { code: 'unsupported', message: 'JSON only.' } });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const wsOf = (req: Request): WorkspaceName => (req.headers['x-workspace'] === 'demo' ? 'demo' : 'real');
  const ctxOf = (req: Request): Ctx => rt.ctx(wsOf(req));
  const h = (fn: (ctx: Ctx, req: Request, res: Response) => unknown | Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try { if (wsOf(req) === 'demo') await rt.ensureDemo(); const out = await fn(ctxOf(req), req, res); if (!res.headersSent) res.json(out ?? { ok: true }); } catch (e) { next(e); }
  };
  const bool = (v: unknown) => v === true || v === 'true';

  /* ---------------- meta / profile / settings ---------------- */
  app.get('/api/meta', h((ctx) => ({
    workspace: ctx.workspace, ai: aiInfo(ctx), profile: getProfile(ctx.db), mathSkills: MATH_SKILLS, version: '0.1.0',
    calendar: { kind: ctx.calendar.kind, available: ctx.calendar.configured() },
    demoNote: ctx.workspace === 'demo' ? 'Sample data. Nothing here is your real study history, and it is stored separately.' : null,
  })));
  app.post('/api/demo/reset', async (_req, res, next) => { try { await rt.resetDemo(); res.json({ ok: true }); } catch (e) { next(e); } });
  app.get('/api/profile', h((ctx) => getProfile(ctx.db)));
  app.put('/api/profile', h((ctx, req) => {
    const b = z.object({ name: z.string().max(60).optional(), grade: z.string().max(30).optional(), timezone: z.string().refine(isValidTimeZone, 'Unknown time zone').optional(), defaultMinutes: z.number().optional(), about: z.string().max(600).optional() }).parse(req.body);
    mem.updateProfile(ctx, b); return getProfile(ctx.db);
  }));
  app.get('/api/settings', h((ctx) => ({
    weights: getWeights(ctx.db), defaultWeights: DEFAULT_WEIGHTS, weightHelp: WEIGHT_HELP, availability: getAvailability(ctx.db), defaultAvailability: DEFAULT_AVAILABILITY,
    aiDailyLimit: callLimit(ctx), aiDailyBudgetUsd: budgetUsd(ctx), ai: aiInfo(ctx),
  })));
  app.put('/api/settings', h((ctx, req) => {
    const b = z.object({ weights: WeightsSchema.optional(), availability: AvailabilitySchema.optional(), aiDailyLimit: z.number().int().min(0).max(5000).optional(), aiDailyBudgetUsd: z.number().min(0).max(1000).optional() }).parse(req.body);
    if (b.aiDailyBudgetUsd !== undefined) setSetting(ctx.db, 'ai_daily_budget_usd', b.aiDailyBudgetUsd, ctx.now());
    if (b.weights) setSetting(ctx.db, 'priority_weights', b.weights, ctx.now());
    if (b.availability) setSetting(ctx.db, 'availability', b.availability, ctx.now());
    if (b.aiDailyLimit !== undefined) setSetting(ctx.db, 'ai_daily_limit', b.aiDailyLimit, ctx.now());
    return { ok: true };
  }));

  /* ---------------- subjects / sources / concepts ---------------- */
  app.get('/api/subjects', h((ctx) => content.listSubjects(ctx)));
  app.post('/api/subjects', h((ctx, req) => content.createSubject(ctx, z.object({ name: z.string(), description: z.string().optional(), aliases: z.array(z.string()).optional() }).parse(req.body))));
  app.get('/api/subjects/:id', h((ctx, req) => content.subjectOverview(ctx, req.params.id)));
  app.patch('/api/subjects/:id', h((ctx, req) => content.updateSubject(ctx, req.params.id, z.object({ name: z.string().optional(), description: z.string().optional(), aliases: z.array(z.string()).optional(), archived: z.boolean().optional() }).parse(req.body))));
  app.delete('/api/subjects/:id', h((ctx, req) => content.deleteSubject(ctx, req.params.id)));
  app.post('/api/subjects/:id/sources', h((ctx, req) => content.addSource(ctx, req.params.id, z.object({ title: z.string().optional(), kind: z.string().optional(), text: z.string(), origin: z.string().optional() }).parse(req.body))));
  app.get('/api/sources/:id', h((ctx, req) => content.getSource(ctx, req.params.id)));
  app.put('/api/sources/:id/flags/:flagId', h((ctx, req) => setFlagDecision(ctx, req.params.id, req.params.flagId, z.object({ decision: z.enum(['include', 'exclude']).nullable() }).parse(req.body).decision)));
  app.delete('/api/sources/:id', h((ctx, req) => content.deleteSource(ctx, req.params.id)));
  app.post('/api/sources/:id/extract', h((ctx, req) => content.extractConcepts(ctx, req.params.id, { useOffline: bool(req.body?.useOffline), force: bool(req.body?.force) })));
  app.post('/api/subjects/:id/concepts', h((ctx, req) => content.addConcept(ctx, req.params.id, z.object({ name: z.string(), summary: z.string().optional(), skillTag: z.string().nullable().optional() }).parse(req.body))));
  app.patch('/api/concepts/:id', h((ctx, req) => content.updateConcept(ctx, req.params.id, z.object({ name: z.string().optional(), summary: z.string().optional(), status: z.string().optional(), skillTag: z.string().nullable().optional(), prereqIds: z.array(z.string()).optional() }).parse(req.body))));
  app.post('/api/concepts/bulk', h((ctx, req) => { const b = z.object({ ids: z.array(z.string()), status: z.enum(['confirmed', 'rejected']) }).parse(req.body); content.bulkConceptStatus(ctx, b.ids, b.status); }));
  app.delete('/api/concepts/:id', h((ctx, req) => content.deleteConcept(ctx, req.params.id)));

  /* ---------------- today / plan ---------------- */
  app.get('/api/today', h((ctx, req) => plan.getToday(ctx, { minutes: req.query.minutes ? Number(req.query.minutes) : undefined })));
  app.post('/api/plan/override', h((ctx, req) => { const b = z.object({ conceptId: z.string(), action: z.enum(['pin', 'skip']).nullable() }).parse(req.body); plan.setOverride(ctx, b.conceptId, b.action); }));
  app.post('/api/plan/rebuild', h((ctx) => plan.rebuildOverdue(ctx)));
  app.get('/api/progress', h((ctx) => plan.getProgress(ctx)));
  app.get('/api/history', h((ctx) => practice.history(ctx)));

  /* ---------------- sessions / practice ---------------- */
  const Start = z.object({ mode: z.enum(['diagnostic', 'practice', 'review', 'exam', 'mixed']), subjectId: z.string().nullable().optional(), minutes: z.number(), conceptIds: z.array(z.string()).optional(), itemId: z.string().nullable().optional(), abandonExisting: z.boolean().optional() });
  app.post('/api/sessions', h(async (ctx, req) => { const { id } = practice.startSession(ctx, Start.parse(req.body)); return { id }; }));
  app.get('/api/sessions/active', h((ctx) => { const s = practice.activeSession(ctx); return { active: s ? { id: s.id, mode: s.mode, startedAt: s.started_at } : null }; }));
  app.get('/api/sessions/:id', h((ctx, req) => practice.sessionView(ctx, req.params.id, { useOffline: req.query.offline === '1' })));
  app.post('/api/sessions/:id/hint', h((ctx, req) => practice.requestHint(ctx, req.params.id, z.object({ questionId: z.string() }).parse(req.body).questionId)));
  app.post('/api/sessions/:id/reveal', h((ctx, req) => practice.revealAnswer(ctx, req.params.id, z.object({ questionId: z.string() }).parse(req.body).questionId)));
  app.post('/api/sessions/:id/answer', h((ctx, req) => practice.submitAnswer(ctx, req.params.id, z.object({
    questionId: z.string(), answer: z.string().max(5000).default(''), reasoning: z.string().max(5000).optional(), confidence: z.number().nullable().optional(), clientToken: z.string().min(8).max(80), idk: z.boolean().optional(), revealedOnly: z.boolean().optional(),
  }).parse(req.body))));
  app.post('/api/sessions/:id/next', h((ctx, req) => practice.nextQuestion(ctx, req.params.id, { useOffline: bool(req.body?.useOffline) })));
  app.post('/api/sessions/:id/finish', h((ctx, req) => practice.finishSession(ctx, req.params.id)));
  app.post('/api/sessions/:id/abandon', h((ctx, req) => practice.abandonSession(ctx, req.params.id)));
  app.post('/api/attempts/:id/self-grade', h((ctx, req) => practice.selfGrade(ctx, req.params.id, z.object({ correctness: z.number(), note: z.string().max(300).optional() }).parse(req.body))));
  app.post('/api/attempts/:id/regrade', h((ctx, req) => practice.regrade(ctx, req.params.id)));

  /* ---------------- memory / misconceptions / import-export ---------------- */
  app.get('/api/memory', h((ctx) => mem.listMemory(ctx)));
  app.post('/api/memory', h((ctx, req) => mem.addMemory(ctx, z.object({ text: z.string(), subjectId: z.string().nullable().optional(), conceptId: z.string().nullable().optional() }).parse(req.body))));
  app.patch('/api/memory/:id', h((ctx, req) => mem.updateMemory(ctx, req.params.id, z.object({ text: z.string() }).parse(req.body))));
  app.delete('/api/memory/:id', h((ctx, req) => mem.deleteMemory(ctx, req.params.id)));
  app.patch('/api/misconceptions/:id', h((ctx, req) => mem.setMisconceptionStatus(ctx, req.params.id, z.object({ status: z.enum(['active', 'dismissed', 'repaired']) }).parse(req.body).status)));
  app.delete('/api/misconceptions/:id', h((ctx, req) => mem.deleteMisconception(ctx, req.params.id)));
  app.post('/api/export', h((ctx, req) => port.exportData(ctx, z.object({ sections: z.array(z.string()), includeSourceText: z.boolean().optional() }).parse(req.body))));
  app.post('/api/import/preview', h((ctx, req) => port.previewImport(ctx, req.body?.file)));
  app.post('/api/import/commit', h((ctx, req) => {
    if (ctx.workspace === 'demo') throw new HttpError(409, 'demo_workspace', 'Importing into the sample workspace is disabled so sample and real records stay separate.');
    return port.commitImport(ctx, req.body?.file, z.object({ profile: z.boolean().optional(), settings: z.boolean().optional(), memoryIds: z.array(z.string()).optional(), subjectIds: z.array(z.string()).optional(), itemIds: z.array(z.string()).optional() }).parse(req.body?.selection ?? {}));
  }));

  /* ---------------- academic items & schedule ---------------- */
  const ItemBody = z.object({
    title: z.string().optional(), type: z.string().optional(), subjectId: z.string().nullable().optional(), dueDate: z.string().nullable().optional(), dueTime: z.string().nullable().optional(),
    topicsText: z.string().nullable().optional(), conceptIds: z.array(z.string()).optional(), format: z.string().optional(), estimateMin: z.number().int().min(0).max(6000).nullable().optional(), notes: z.string().optional(),
  });
  app.get('/api/items', h((ctx, req) => items.listItems(ctx, (['proposed', 'confirmed', 'dismissed'].includes(String(req.query.status)) ? req.query.status : 'confirmed') as 'confirmed')));
  app.post('/api/items', h((ctx, req) => items.createItem(ctx, ItemBody.parse(req.body))));
  app.patch('/api/items/:id', h((ctx, req) => items.updateItem(ctx, req.params.id, ItemBody.parse(req.body))));
  app.delete('/api/items/:id', h((ctx, req) => items.deleteItem(ctx, req.params.id)));
  app.post('/api/items/:id/complete', h((ctx, req) => items.setCompleted(ctx, req.params.id, z.object({ done: z.boolean() }).parse(req.body).done)));
  app.post('/api/items/:id/work', h((ctx, req) => items.logWork(ctx, req.params.id, z.object({ minutes: z.number() }).parse(req.body).minutes)));
  app.post('/api/items/:id/confirm', h((ctx, req) => items.confirmProposal(ctx, req.params.id, ItemBody.parse(req.body ?? {}))));
  app.post('/api/items/:id/dismiss', h((ctx, req) => items.dismissProposal(ctx, req.params.id)));
  app.post('/api/items/:id/ack', h((ctx, req) => cal.acknowledgeSync(ctx, req.params.id, z.object({ action: z.enum(['accept', 'keep_manual', 'remove']) }).parse(req.body).action)));
  app.post('/api/items/bulk', h((ctx, req) => {
    const b = z.object({ ids: z.array(z.string()).max(200), action: z.enum(['confirm', 'dismiss']) }).parse(req.body);
    ctx.db.tx(() => { for (const id of b.ids) { if (b.action === 'confirm') items.confirmProposal(ctx, id); else items.dismissProposal(ctx, id); } });
  }));
  app.get('/api/schedule', h((ctx) => items.computeSchedule(ctx)));

  /* ---------------- calendar ---------------- */
  app.get('/api/calendar', h((ctx) => cal.connectionStatus(ctx)));
  app.post('/api/calendar/connect', h((ctx) => {
    if (ctx.calendar.kind === 'memory') return cal.connectMemory(ctx).then((r) => ({ connected: true, ...r }));
    return cal.startConnect(ctx);
  }));
  app.get('/api/calendar/oauth/callback', async (req, res) => {
    const go = (q: string) => res.redirect(`/#/calendar?${q}`);
    try {
      const { code, state, error } = req.query as Record<string, string>;
      const st = state ? cal.consumeState(state) : null;
      if (error) return go(`error=${error === 'access_denied' ? 'denied' : 'org_blocked'}`);
      if (!st || !code) return go('error=denied');
      const ctx = rt.ctx(st.workspace as WorkspaceName);
      await cal.finishConnect(ctx, code, st.verifier);
      go('connected=1');
    } catch (e) { go(`error=${e instanceof CalendarError ? e.code : 'unavailable'}`); }
  });
  app.put('/api/calendar/calendars', h((ctx, req) => cal.setCalendars(ctx, z.object({ calendars: z.array(z.object({ id: z.string(), selected: z.boolean().optional(), label: z.string().optional(), detectAcademic: z.boolean().optional(), countsBusy: z.boolean().optional(), allDayBusy: z.boolean().optional() })) }).parse(req.body).calendars)));
  app.post('/api/calendar/sync', h((ctx) => cal.syncNow(ctx)));
  app.post('/api/calendar/disconnect', h((ctx, req) => cal.disconnect(ctx, z.object({ deleteImported: z.boolean(), keepItems: z.boolean().default(true) }).parse(req.body))));
  app.post('/api/calendar/changes/seen', h((ctx) => items.markChangesSeen(ctx)));

  /* ---------------- setup status / AI verification / usage ---------------- */
  app.get('/api/status', h((ctx) => {
    const c = cal.connectionStatus(ctx);
    const missing = ctx.cfg.google ? [] : (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_SECRET'] as const).filter((k) => !process.env[k]);
    const calState = ctx.calendar.kind === 'memory' ? (c.status === 'disconnected' ? 'disconnected' : c.status) : !c.available ? 'not_configured' : c.status;
    return {
      workspace: ctx.workspace, ai: aiInfo(ctx),
      calendar: { state: calState, demo: c.demo, missingEnv: ctx.calendar.kind === 'memory' ? [] : missing, partialConfig: ctx.cfg.googlePartial, redirectUri: ctx.cfg.googleRedirectUri, lastSyncOkAt: c.lastSyncOkAt, lastError: c.lastError },
      boundary: 'Local single-user app with no login. Do not expose this server to a network until authentication and per-user data isolation exist.',
    };
  }));
  app.get('/api/ai/usage', h((ctx) => usageReport(ctx)));
  app.post('/api/ai/verify', h(async (ctx, req) => {
    if (ctx.workspace === 'demo') throw new HttpError(409, 'demo_workspace', 'The sample workspace never calls a paid AI model.');
    if (!ctx.ai.live || !ctx.ai.verify) throw new HttpError(409, 'no_ai', 'No AI provider is configured, so there is nothing to verify. See the setup steps in Settings.');
    const level = (req.body as { level?: string } | undefined)?.level === 'output' ? 'output' : 'connection';
    const results: { task?: string; model: string; ok: boolean; latencyMs?: number; error?: string }[] = [];
    if (level === 'connection') {
      // Proves only that an authenticated HTTP round trip works. It says nothing about study output quality or schema validity.
      for (const m of [...new Set((['extract', 'generate', 'grade'] as const).map((t) => ctx.ai.modelFor!(t)))]) {
        try { const r = await ctx.ai.verify(undefined, m); results.push({ model: m, ok: true, latencyMs: r.latencyMs }); }
        catch (e) { results.push({ model: m, ok: false, error: e instanceof AIError ? e.message : 'failed' }); }
      }
    } else {
      // Runs one tiny real task per model role and requires schema-valid output; invalid output is reported as a failure.
      const probes: Record<'extract' | 'generate' | 'grade', () => Promise<unknown>> = {
        extract: () => ctx.ai.extractConcepts({ subjectName: 'Verification', maxConcepts: 3, chunks: [{ id: '0', label: 'Probe p.1', text: 'The absolute value of a number is its distance from zero. For example |-4| = 4 and |4| = 4. To solve |x| < 3, write -3 < x < 3.' }] }, {}),
        generate: () => ctx.ai.generateQuestions({ subjectName: 'Verification', concept: { name: 'Absolute value', summary: 'Distance from zero.', skillTag: null }, excerpts: [{ label: 'Probe p.1', text: 'The absolute value of a number is its distance from zero. |-4| = 4.' }], otherConcepts: [], misconceptions: [], studentNotes: [], practice: 1, heldout: 0, avoidPrompts: [], seed: 1 }, {}),
        grade: () => ctx.ai.gradeAnswer({ question: { prompt: 'What is the absolute value of -4, and why?', kind: 'short_answer', rubric: [{ point: 'States 4', keywords: ['4', 'four'] }, { point: 'Distance from zero', keywords: ['distance', 'zero'] }] }, answer: '4, because it is the distance from zero.', reasoning: '', excerpts: [{ label: 'Probe p.1', text: 'The absolute value of a number is its distance from zero. |-4| = 4.' }] }, {}),
      };
      for (const task of ['extract', 'generate', 'grade'] as const) {
        const t0 = Date.now();
        try { await probes[task](); results.push({ task, model: ctx.ai.modelFor!(task), ok: true, latencyMs: Date.now() - t0 }); }
        catch (e) { results.push({ task, model: ctx.ai.modelFor!(task), ok: false, error: e instanceof AIError ? e.message : 'failed' }); }
      }
    }
    return { level, results, ai: aiInfo(ctx) };

  }));

  /* ---------------- static client ---------------- */
  const dist = resolve(process.cwd(), 'dist');
  if (existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist, { setHeaders: (r) => r.setHeader('Cache-Control', 'no-cache') }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint.' } }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err instanceof AIError) {
      const status = err.code === 'rate_limited' || err.code === 'limit_reached' || err.code === 'budget_reached' ? 429 : err.code === 'timeout' ? 504 : err.code === 'not_configured' ? 503 : 502;
      return res.status(status).json({ error: { code: `ai_${err.code}`, message: err.message, retryable: err.retryable, retryAfterMs: err.retryAfterMs ?? null, offlineFallback: true } });
    }
    if (err instanceof CalendarError) return res.status(err.code === 'reauth_required' ? 401 : err.code === 'rate_limited' ? 429 : err.code === 'org_blocked' || err.code === 'denied' ? 403 : err.code === 'not_configured' ? 503 : 502).json({ error: { code: `calendar_${err.code}`, message: err.message } });
    if (err instanceof ZodError) return res.status(400).json({ error: { code: 'invalid', message: `Invalid request: ${err.issues[0]?.path.join('.') || 'body'} ${err.issues[0]?.message ?? ''}`.trim() } });
    if (err instanceof SyntaxError) return res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON.' } });
    console.error('[server error]', err instanceof Error ? err.message : err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on the server. Your data was not changed by this request.' } });
  });
  return app;
}
