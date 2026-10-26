import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recoverOrphans } from './services/ledger';

// node:sqlite is loaded via createRequire so bundlers/test runners that don't know the builtin still work.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Param = string | number | bigint | null | Uint8Array;
export const uid = () => randomUUID();

export class Db {
  private inTx = 0;
  constructor(public readonly raw: InstanceType<typeof DatabaseSync>, public readonly path: string) {}
  all<T = Record<string, any>>(sql: string, ...p: unknown[]): T[] { return this.raw.prepare(sql).all(...(clean(p) as Param[])) as T[]; }
  get<T = Record<string, any>>(sql: string, ...p: unknown[]): T | undefined { return this.raw.prepare(sql).get(...(clean(p) as Param[])) as T | undefined; }
  run(sql: string, ...p: unknown[]) { return this.raw.prepare(sql).run(...(clean(p) as Param[])); }
  exec(sql: string) { this.raw.exec(sql); }
  /** Atomic block; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx++;
    try { const r = fn(); this.raw.exec('COMMIT'); return r; }
    catch (e) { this.raw.exec('ROLLBACK'); throw e; }
    finally { this.inTx--; }
  }
  close() { this.raw.close(); }
}
const clean = (p: unknown[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

const here = dirname(fileURLToPath(import.meta.url));

export function migrate(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const done = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const files = readdirSync(join(here, 'migrations')).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    const version = parseInt(f, 10);
    if (done.has(version)) continue;
    const sql = readFileSync(join(here, 'migrations', f), 'utf8');
    db.tx(() => { db.exec(sql); db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)', version, f, Date.now()); });
    applied.push(f);
  }
  return applied;
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  const db = new Db(raw, path);
  migrate(db);
  const now = Date.now();
  db.run('INSERT OR IGNORE INTO profile (id, updated_at) VALUES (1, ?)', now);
  return db;
}

export type WorkspaceName = 'real' | 'demo';
/** Two physically separate databases: real records and sample data never share a file. */
export class Workspaces {
  private dbs = new Map<WorkspaceName, Db>();
  constructor(private dir: string | ':memory:') {}
  get(name: WorkspaceName): Db {
    let db = this.dbs.get(name);
    if (!db) {
      db = openDb(this.dir === ':memory:' ? ':memory:' : join(this.dir, name === 'demo' ? 'demo.db' : 'study.db'));
      recoverOrphans(db); // reservations left by a process that died mid-request stay held as unknown billing
      this.dbs.set(name, db);
    }
    return db;
  }
  /** Delete the sample database file(s); the next get('demo') starts empty. Never touches real data. */
  dropDemo() {
    const old = this.dbs.get('demo');
    if (old) { old.close(); this.dbs.delete('demo'); }
    if (this.dir !== ':memory:') for (const sfx of ['', '-wal', '-shm']) { try { unlinkSync(join(this.dir, 'demo.db') + sfx); } catch { /* absent */ } }
  }
}
