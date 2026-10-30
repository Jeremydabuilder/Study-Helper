import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pool, tx } from './pg';
import { Tenants } from './tenants';

/**
 * Backups of everything a restore needs: the shared database (as JSON, no external tools) and one consistent snapshot of every student's private database
 * (SQLite VACUUM INTO, safe while the app is running). The bundle contains student data: keep it private. With a passphrase every file is encrypted (AES-256-GCM).
 * Ordinary scheduled backups of the PostgreSQL service itself (the hosting provider's, or pg_dump) are still recommended in addition; see docs/OPERATIONS.md.
 */
const TABLES = ['app_settings', 'invites', 'user', 'account', 'session', 'verification', 'ai_requests', 'usage_counters', 'audit_log', 'reports']; // parents before children
const MAGIC = Buffer.from('SHBK1');

const enc = (data: Buffer, pass: string) => { const salt = randomBytes(16), iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', scryptSync(pass, salt, 32), iv); const ct = Buffer.concat([c.update(data), c.final()]); return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]); };
const dec = (blob: Buffer, pass: string) => { if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error('This file is not an encrypted backup (or the passphrase is needed).'); const salt = blob.subarray(5, 21), iv = blob.subarray(21, 33), tag = blob.subarray(33, 49); const d = createDecipheriv('aes-256-gcm', scryptSync(pass, salt, 32), iv); d.setAuthTag(tag); try { return Buffer.concat([d.update(blob.subarray(49)), d.final()]); } catch { throw new Error('Wrong passphrase, or the backup file was modified.'); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface Manifest { format: 'study-helper-backup'; version: 1; createdAt: string; dataLabel: string; encrypted: boolean; tables: { name: string; rows: number }[]; control: { file: string; sha256: string }; users: { id: string; file: string; sha256: string; bytes: number }[] }

export async function backup(o: { pool: Pool; tenants: Tenants; destDir: string; dataLabel: string; passphrase?: string; now: () => number }): Promise<Manifest> {
  if (existsSync(o.destDir) && readdirSync(o.destDir).length) throw new Error('The backup folder is not empty. Choose a new folder.');
  mkdirSync(join(o.destDir, 'users'), { recursive: true });
  const put = (rel: string, data: Buffer) => { const out = o.passphrase ? enc(data, o.passphrase) : data; const p = join(o.destDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, out); return { sha256: sha(out), bytes: out.length }; };
  const dump: Record<string, unknown[]> = {}; const tables: Manifest['tables'] = [];
  const c = await o.pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent view of the whole shared database
    for (const t of TABLES) { const r = await c.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${q(t)} t`); dump[t] = r.rows[0].rows; tables.push({ name: t, rows: (r.rows[0].rows as unknown[]).length }); }
    await c.query('COMMIT');
  } finally { c.release(); }
  const control = put('control.json', Buffer.from(JSON.stringify(dump)));
  const users: Manifest['users'] = [];
  for (const id of o.tenants.listUserIds()) {
    const lease = o.tenants.lease(id, 'real');
    try {
      const tmp = join(o.destDir, 'users', `${id}.snapshot`);
      lease.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const data = readFileSync(tmp); rmSync(tmp);
      const meta = put(`users/${id}/study.db`, data);
      users.push({ id, file: `users/${id}/study.db`, ...meta });
    } finally { lease.release(); }
  }
  const manifest: Manifest = { format: 'study-helper-backup', version: 1, createdAt: new Date(o.now()).toISOString(), dataLabel: o.dataLabel, encrypted: !!o.passphrase, tables, control: { file: 'control.json', sha256: control.sha256 }, users };
  writeFileSync(join(o.destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function verifyBackup(dir: string, passphrase?: string): Promise<Manifest> {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (m.format !== 'study-helper-backup' || m.version !== 1) throw new Error('Not a Study Helper backup.');
  if (m.encrypted && !passphrase) throw new Error('This backup is encrypted: a passphrase is required.');
  for (const f of [m.control, ...m.users]) if (sha(readFileSync(join(dir, f.file))) !== f.sha256) throw new Error(`Backup file ${f.file} is damaged or was modified.`);
  if (m.encrypted) { try { dec(readFileSync(join(dir, m.control.file)), passphrase!); } catch { throw new Error('The passphrase does not open this backup.'); } } // prove the passphrase, not just the file hashes
  return m;
}

/** Restore into an EMPTY deployment (no accounts). The environment label must match so staging data can never be restored into production or the reverse. */
export async function restore(o: { pool: Pool; dataDir: string; bundleDir: string; dataLabel: string; passphrase?: string }): Promise<{ users: number; rows: number }> {
  const m = await verifyBackup(o.bundleDir, o.passphrase);
  if (m.dataLabel !== o.dataLabel) throw new Error(`This backup is from "${m.dataLabel}" and this server is "${o.dataLabel}". Refusing to restore across environments.`);
  const open = (rel: string) => { const b = readFileSync(join(o.bundleDir, rel)); return m.encrypted ? dec(b, o.passphrase!) : b; };
  const dump = JSON.parse(open(m.control.file).toString('utf8')) as Record<string, Record<string, unknown>[]>;
  const existing = (await o.pool.query('SELECT COUNT(*)::int n FROM "user"')).rows[0].n as number;
  if (existing > 0) throw new Error('Refusing to restore: this deployment already has accounts. Restore into a new, empty database and data folder.');
  let rows = 0;
  await tx(o.pool, async (c) => {
    for (const t of [...TABLES].reverse()) if (t !== 'app_settings') await c.query(`DELETE FROM ${q(t)}`);
    await c.query('DELETE FROM app_settings WHERE key <> $1', ['data_label']);
    for (const t of TABLES) {
      const list = dump[t] ?? []; if (!list.length) continue;
      await c.query(`INSERT INTO ${q(t)} SELECT * FROM jsonb_populate_recordset(NULL::${q(t)}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);
      rows += list.length;
    }
  });
  for (const u of m.users) {
    const dest = join(o.dataDir, 'users', u.id, 'study.db'); mkdirSync(dirname(dest), { recursive: true });
    for (const sfx of ['-wal', '-shm']) rmSync(dest + sfx, { force: true });
    const tmp = `${dest}.restoring`; writeFileSync(tmp, open(u.file)); renameSync(tmp, dest);
  }
  return { users: m.users.length, rows };
}
export { copyFileSync };
