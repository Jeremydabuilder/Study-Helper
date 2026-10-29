/**
 * Real PostgreSQL for hosted-mode tests (no mocks of the database). Point TEST_DATABASE_URL at any Postgres you may create databases in, for example
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/postgres
 * Each test file gets its own throw-away database. CI sets REQUIRE_PG=1 so a missing database fails the run instead of skipping the isolation tests.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, migrateControl, Pool } from '../src/server/hosted/pg';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5544/postgres';

async function probe(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
export const PG_AVAILABLE = await probe();
if (!PG_AVAILABLE && process.env.REQUIRE_PG === '1') throw new Error(`REQUIRE_PG=1 but PostgreSQL is not reachable at TEST_DATABASE_URL`);
if (!PG_AVAILABLE) console.warn('[tests] PostgreSQL not reachable: hosted-mode tests are SKIPPED. Set TEST_DATABASE_URL (see tests/pgHarness.ts).');

export interface TestDb { url: string; pool: Pool; drop(): Promise<void> }
export async function createTestDb(o: { migrate?: boolean } = {}): Promise<TestDb> {
  const name = `sh_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const u = new URL(ADMIN_URL); u.pathname = `/${name}`;
  const url = u.toString();
  const pool = createPool(url, { max: 12 });
  if (o.migrate !== false) await migrateControl(pool);
  return {
    url, pool,
    async drop() {
      await pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
    },
  };
}
