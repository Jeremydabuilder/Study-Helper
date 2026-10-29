/**
 * Operations: a logger that cannot leak student content, and redacted metrics.
 * Log lines contain only: time, level, event name, route TEMPLATE (never a URL with ids or query), status, duration, an opaque request id, and error class names.
 * They never contain request or response bodies, headers, cookies, user ids, emails, file names, answers, readings, conversations or calendar data.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type Level = 'info' | 'warn' | 'error';
const ALLOWED_KEYS = new Set(['event', 'route', 'method', 'status', 'ms', 'reqId', 'errorClass', 'code', 'count', 'detail']);
export interface LogSink { write(line: string): void }
export const stdoutSink: LogSink = { write: (l) => process.stdout.write(l + '\n') };

export function makeLogger(sink: LogSink = stdoutSink, now: () => number = Date.now) {
  const log = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    const safe: Record<string, unknown> = { t: new Date(now()).toISOString(), level, event };
    for (const [k, v] of Object.entries(fields)) if (ALLOWED_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) safe[k] = typeof v === 'string' ? v.slice(0, 120) : v;
    sink.write(JSON.stringify(safe));
  };
  return { info: (e: string, f?: Record<string, unknown>) => log('info', e, f), warn: (e: string, f?: Record<string, unknown>) => log('warn', e, f), error: (e: string, f?: Record<string, unknown>) => log('error', e, f) };
}
export type Logger = ReturnType<typeof makeLogger>;

/** Counters and latency buckets per route template. No identifiers, no content. */
export class Metrics {
  private routes = new Map<string, { n: number; err4: number; err5: number; ms: number[] }>();
  private started = Date.now();
  ai = { requests: 0, refused: 0, failed: 0 };
  record(route: string, status: number, ms: number) {
    const r = this.routes.get(route) ?? { n: 0, err4: 0, err5: 0, ms: [] };
    r.n++; if (status >= 500) r.err5++; else if (status >= 400) r.err4++;
    r.ms.push(ms); if (r.ms.length > 500) r.ms.shift();
    this.routes.set(route, r);
  }
  snapshot() {
    const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
    const routes = [...this.routes.entries()].map(([route, r]) => ({ route, requests: r.n, clientErrors: r.err4, serverErrors: r.err5, p50ms: pct(r.ms, 0.5), p95ms: pct(r.ms, 0.95) })).sort((a, b) => b.requests - a.requests);
    const total = routes.reduce((a, r) => a + r.requests, 0), e5 = routes.reduce((a, r) => a + r.serverErrors, 0);
    return { uptimeSec: Math.round((Date.now() - this.started) / 1000), requests: total, serverErrorRate: total ? e5 / total : 0, routes: routes.slice(0, 40), ai: this.ai };
  }
}

/** Turns /api/subjects/abc123/files into /api/subjects/:id/files so metrics and logs never carry identifiers. */
export function routeTemplate(req: Request): string {
  const r = (req.route?.path as string | undefined);
  if (r) return `${req.baseUrl}${r}`;
  return req.path.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id').replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:id').slice(0, 80);
}

export function requestObserver(metrics: Metrics, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const t0 = Date.now(); const reqId = randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', reqId);
    res.on('finish', () => {
      if (!req.path.startsWith('/api')) return;
      const ms = Date.now() - t0, route = routeTemplate(req);
      metrics.record(`${req.method} ${route}`, res.statusCode, ms);
      if (res.statusCode >= 500) logger.error('request_failed', { route, method: req.method, status: res.statusCode, ms, reqId });
    });
    next();
  };
}
