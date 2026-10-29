import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
const here = dirname(fileURLToPath(import.meta.url));

// NUMERIC and BIGINT come back as strings by default; the ledger does arithmetic on them as numbers (cents-scale values, safe in a double).
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url: string, o: { max?: number; ssl?: boolean } = {}): Pool {
  const pool = new pg.Pool({ connectionString: url, max: o.max ?? 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, ssl: o.ssl ? { rejectUnauthorized: true } : undefined });
  pool.on('error', () => { /* an idle client failed; the pool replaces it. Never log connection strings. */ });
  return pool;
}

/** Runs `fn` in one transaction on one connection. */
export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; }
  finally { c.release(); }
}

/** Numbered SQL files applied once each, in order, under an advisory lock so two starting instances never race. Additive and forward-only. */
export async function migrateControl(pool: Pool): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query('CREATE TABLE IF NOT EXISTS control_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT version FROM control_migrations')).rows.map((r) => r.version as number));
    const dir = join(here, '..', 'control-migrations');
    for (const f of readdirSync(dir).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      const version = parseInt(f, 10);
      if (done.has(version)) continue;
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(dir, f), 'utf8')); await c.query('INSERT INTO control_migrations (version, name) VALUES ($1,$2)', [version, f]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; }
      applied.push(f);
    }
  } finally { try { await c.query('SELECT pg_advisory_unlock(727001)'); } catch { /* ignore */ } c.release(); }
  return applied;
}

export async function audit(pool: Pool, event: string, userId: string | null, detail: Record<string, unknown> = {}) {
  await pool.query('INSERT INTO audit_log (event, user_id, detail) VALUES ($1,$2,$3)', [event, userId, JSON.stringify(detail)]);
}

export async function getSettingPg<T>(pool: Pool, key: string, fallback: T): Promise<T> {
  const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r.rows.length ? (r.rows[0].value as T) : fallback;
}
export async function setSettingPg(pool: Pool, key: string, value: unknown) {
  await pool.query('INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, JSON.stringify(value)]);
}
