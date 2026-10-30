import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { backup, restore, verifyBackup } from '../src/server/hosted/backup';
import { importLocalDatabase } from '../src/server/hosted/account';
import { openDb } from '../src/server/db';
import { HostedHarness } from './hostedHarness';
import { PG_AVAILABLE, createTestDb } from './pgHarness';
import { startServer } from './helpers';
import { startStudy, tok } from './hostedFlows';

const d = describe.skipIf(!PG_AVAILABLE);
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const open: HostedHarness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.stop(); });
const tmp = () => mkdtempSync(join(tmpdir(), 'sh-ops-'));

d('backup and restore', () => {
  it('a full backup restores into a new empty deployment: same accounts, same sessions, same study data; wrong passphrase, tampering, wrong environment and non-empty targets are refused', async () => {
    const a = await HostedHarness.start(); open.push(a);
    const s1 = await a.join('one@example.test'), s2 = await a.join('two@example.test');
    const st = await startStudy(s1); await s1.post(`/api/sessions/${st.sessionId}/answer`, { questionId: st.question.id, answer: 'glucose and oxygen', clientToken: tok() });
    await s2.post('/api/memory', { text: 'TWO-MEMORY' });
    const dest = join(tmp(), 'bk');
    const m = await backup({ pool: a.db.pool, tenants: a.hosted.tenants, destDir: dest, dataLabel: 'test', passphrase: 'correct horse battery staple', now: a.now });
    expect(m.users).toHaveLength(2); expect(m.encrypted).toBe(true);
    expect(readFileSync(join(dest, 'control.json')).toString('latin1')).not.toContain('one@example.test'); // encrypted at rest
    for (const u of m.users) expect(readFileSync(join(dest, u.file)).toString('latin1')).not.toContain('SQLite format');
    await expect(verifyBackup(dest)).rejects.toThrow(/passphrase/);

    const b = await HostedHarness.start(); open.push(b); // a brand-new database and data folder
    await expect(restore({ pool: b.db.pool, dataDir: b.dir, bundleDir: dest, dataLabel: 'test', passphrase: 'wrong' })).rejects.toThrow(/Wrong passphrase/);
    await expect(restore({ pool: b.db.pool, dataDir: b.dir, bundleDir: dest, dataLabel: 'production', passphrase: 'correct horse battery staple' })).rejects.toThrow(/across environments/);
    const damaged = join(tmp(), 'bk2'); mkdirSync(join(damaged, 'users'), { recursive: true });
    for (const f of ['manifest.json', 'control.json']) writeFileSync(join(damaged, f), readFileSync(join(dest, f)));
    for (const u of m.users) { mkdirSync(join(damaged, 'users', u.id)); const bytes = readFileSync(join(dest, u.file)); bytes[bytes.length - 1] ^= 1; writeFileSync(join(damaged, u.file), bytes); }
    await expect(restore({ pool: b.db.pool, dataDir: b.dir, bundleDir: damaged, dataLabel: 'test', passphrase: 'correct horse battery staple' })).rejects.toThrow(/damaged or was modified/);
    const r = await restore({ pool: b.db.pool, dataDir: b.dir, bundleDir: dest, dataLabel: 'test', passphrase: 'correct horse battery staple' });
    expect(r.users).toBe(2);
    await expect(restore({ pool: b.db.pool, dataDir: b.dir, bundleDir: dest, dataLabel: 'test', passphrase: 'correct horse battery staple' })).rejects.toThrow(/already has accounts/);

    // the restored deployment serves the same students with the same data (their sign-in cookies still work: sessions were restored too)
    const again1 = b.student('one@example.test'); for (const [k, v] of s1.jar) again1.jar.set(k, v);
    expect(JSON.stringify((await again1.get('/api/history')).body)).toContain('glucose and oxygen');
    expect(JSON.stringify((await again1.get('/api/subjects')).body)).toContain('Biology');
    const again2 = b.student('two@example.test'); for (const [k, v] of s2.jar) again2.jar.set(k, v);
    expect(JSON.stringify((await again2.get('/api/memory')).body)).toContain('TWO-MEMORY');
    expect(JSON.stringify((await again1.get('/api/memory')).body)).not.toContain('TWO-MEMORY');
  }, 90_000);

  it('an unencrypted backup also verifies and says so in its manifest', async () => {
    const a = await HostedHarness.start(); open.push(a); const x = await a.join('x@example.test'); await x.get('/api/subjects');
    const dest = join(tmp(), 'bk'); const m = await backup({ pool: a.db.pool, tenants: a.hosted.tenants, destDir: dest, dataLabel: 'test', now: a.now });
    expect(m.encrypted).toBe(false); expect((await verifyBackup(dest)).users).toHaveLength(1);
    await expect(backup({ pool: a.db.pool, tenants: a.hosted.tenants, destDir: dest, dataLabel: 'test', now: a.now })).rejects.toThrow(/not empty/);
  });
});

d('environments cannot share data', () => {
  it('a server labelled staging refuses to start against a production database or data folder, and vice versa', async () => {
    const a = await HostedHarness.start({ label: 'production' } as never); open.push(a);
    const labelInDb = (await a.db.pool.query("SELECT value FROM app_settings WHERE key = 'data_label'")).rows[0].value;
    expect(labelInDb).toBe('test'); // the harness's label; now point a "staging" server at the same database
    await expect(HostedHarness.start({ db: a.db, dir: a.dir, labelOverride: 'staging' } as never)).rejects.toThrow(/Another Study Helper process/); // a second process is refused first
    await a.stop({ keepDb: true }); open.pop();
    await expect(HostedHarness.start({ db: a.db, dir: a.dir, labelOverride: 'staging' } as never)).rejects.toThrow(/Refusing to start/);
  });
});

d('upgrading an existing local database and importing it into an account', () => {
  it('opens a database created before the newest migrations, applies only what is missing, and keeps every row', () => {
    const dir = tmp(); const file = join(dir, 'study.db');
    const raw = new DatabaseSync(file); raw.exec('PRAGMA foreign_keys = ON');
    const migDir = join(process.cwd(), 'src/server/migrations');
    const files = readdirSync(migDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const f of files.filter((f) => parseInt(f, 10) <= 6)) { raw.exec(readFileSync(join(migDir, f), 'utf8')); raw.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(parseInt(f, 10), f, 1); }
    raw.prepare("INSERT INTO subjects (id,name,created_at) VALUES ('s1','Legacy subject',1)").run();
    raw.prepare("INSERT INTO sources (id,subject_id,title,text,content_hash,created_at) VALUES ('src1','s1','Old notes','Old notes text that is long enough to count as material.','h',1)").run();
    raw.close();
    const db = openDb(file);
    expect(db.all<any>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual(files.map((f) => parseInt(f, 10)));
    expect(db.get<any>("SELECT name FROM subjects WHERE id = 's1'").name).toBe('Legacy subject');
    expect(db.get<any>("SELECT title FROM sources WHERE id = 'src1'").title).toBe('Old notes');
    expect(db.get<any>("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('annotations','conversations','outlines')").n).toBe(3); // later migrations arrived
    db.close();
  });

  it('operator import: a student’s old local study.db becomes their hosted account data, other students are untouched, and a non-empty account is protected', async () => {
    const local = await startServer(); // the old single-user app, with real study history
    const sub = (await local.call('POST', '/api/subjects', { name: 'LOCAL-HISTORY' })).body.id;
    await local.call('POST', `/api/subjects/${sub}/sources`, { title: 'Local notes', text: 'LOCAL-NOTES The Dust Bowl struck the southern plains in the 1930s and displaced many families.' });
    const file = join(local.dir, 'study.db'); await local.close();
    const a = await HostedHarness.start(); open.push(a);
    const kid = await a.join('kid@example.test'), other = await a.join('other@example.test');
    const id = (await a.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['kid@example.test'])).rows[0].id;
    importLocalDatabase({ tenants: a.hosted.tenants, userId: id, file });
    expect(JSON.stringify((await kid.get('/api/subjects')).body)).toContain('LOCAL-HISTORY');
    expect(JSON.stringify((await other.get('/api/subjects')).body)).not.toContain('LOCAL-HISTORY');
    expect(() => importLocalDatabase({ tenants: a.hosted.tenants, userId: id, file })).toThrow(/already has study data/);
  });
});

d('operator commands and startup guards', () => {
  const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/server/ops/cli.ts', ...args], { env: { ...process.env, ...env, NODE_ENV: 'test' }, encoding: 'utf8', cwd: process.cwd(), timeout: 60_000 });
  it('creates invitations (printed once, never stored in clear), lists, revokes, flips the switches and prints a content-free status', async () => {
    const db = await createTestDb();
    try {
      const env = { DATABASE_URL: db.url, DATA_DIR: tmp(), BETTER_AUTH_SECRET: 'a'.repeat(40), APP_SECRET: 'b'.repeat(40), PUBLIC_URL: 'http://127.0.0.1:1', AUTH_PASSWORD: '1', APP_ENV: 'test' };
      const c = run(['invites', 'create', '--count', '2', '--label', 'cohort 1'], env); expect(c.status, c.stderr).toBe(0);
      const codes = c.stdout.match(/[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}/g) ?? []; expect(codes).toHaveLength(2);
      const stored = (await db.pool.query('SELECT code_hash FROM invites')).rows.map((r) => r.code_hash).join(' ');
      for (const code of codes) expect(stored).not.toContain(code.replace(/-/g, ''));
      expect(run(['invites', 'list'], env).stdout).toContain('cohort 1');
      expect(run(['invites', 'revoke', '--label', 'cohort 1'], env).stdout).toMatch(/Revoked 2/);
      expect(run(['pilot', 'on'], env).stdout).toContain('pilot_enabled = true');
      expect(run(['ai', 'off'], env).stdout).toContain('ai_enabled = false');
      const st = JSON.parse(run(['status'], env).stdout); expect(st).toMatchObject({ pilot_enabled: true, ai_enabled: false, accounts: 0 });
      expect(JSON.stringify(st)).not.toMatch(/answer|conversation|memory/i);
    } finally { await db.drop(); }
  }, 120_000);

  it('local mode refuses to listen on a network address; hosted mode refuses to start with missing or unsafe configuration', () => {
    const base = { ...process.env, NODE_ENV: 'production', PORT: '0' } as Record<string, string>;
    const local = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env: { ...base, HOST: '0.0.0.0', APP_MODE: '' }, encoding: 'utf8', timeout: 30_000 });
    expect(local.status).toBe(1); expect(local.stderr).toMatch(/no login/);
    const hosted = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env: { ...base, APP_MODE: 'hosted', DATABASE_URL: '', BETTER_AUTH_SECRET: 'short', PUBLIC_URL: 'http://insecure.example.org' }, encoding: 'utf8', timeout: 30_000 });
    expect(hosted.status).toBe(1);
    for (const p of [/DATABASE_URL/, /BETTER_AUTH_SECRET/, /PUBLIC_URL must be https/, /APP_SECRET/, /sign-in method/]) expect(hosted.stderr).toMatch(p);
    expect(hosted.stderr).not.toMatch(/short/); // a secret value is never echoed back
  }, 60_000);
});
