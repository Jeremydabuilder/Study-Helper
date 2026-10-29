import { Ctx, HttpError } from '../services/common';
import * as port from '../services/portability';
import * as cal from '../services/calendar';
import { Pool, audit, tx } from './pg';
import { Tenants } from './tenants';

const MB = 1024 * 1024;

/** Everything the student made, in one JSON file. Calendar tokens and other secrets are never included. */
export function exportAccount(ctx: Ctx, o: { email: string; withFiles: boolean }) {
  const study = port.exportData(ctx, { sections: ['profile', 'settings', 'memories', 'learning', 'items'], includeSourceText: true });
  const conversations = ctx.db.all<any>('SELECT id, mode, title, created_at, updated_at FROM conversations ORDER BY created_at').map((c) => ({
    ...c, messages: ctx.db.all<any>('SELECT role, content, direct, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', c.id),
  }));
  const fileRows = ctx.db.all<any>('SELECT id, filename, kind, bytes FROM source_files');
  const total = fileRows.reduce((a, f) => a + f.bytes, 0);
  let files: unknown = fileRows.map((f) => ({ id: f.id, filename: f.filename, kind: f.kind, bytes: f.bytes }));
  if (o.withFiles) {
    if (total > 40 * MB) throw new HttpError(413, 'too_large', 'Your uploaded files are too large to include in one download. Download them one by one from each material instead.');
    files = ctx.db.all<any>('SELECT id, filename, kind, bytes, data FROM source_files').map((f) => ({ id: f.id, filename: f.filename, kind: f.kind, bytes: f.bytes, base64: Buffer.from(f.data as Uint8Array).toString('base64') }));
  }
  const conn = cal.connectionStatus(ctx);
  return {
    format: 'study-helper-account-export', version: 1, exportedAt: ctx.now(),
    account: { email: o.email },
    study, conversations, uploadedFiles: files,
    calendar: { connected: conn.status === 'connected', calendars: conn.calendars.filter((c: any) => c.selected).map((c: any) => ({ name: c.label || c.name })), note: 'Imported calendar events and connection tokens are not exported. Assignments you confirmed are in "study.sections.items".' },
    notes: ['The "study" section can be imported again in Settings → Data.', 'Chat conversations are included here only; they are not part of the importable study file.'],
  };
}

/**
 * Permanent deletion. Order matters: first the student's files (so nothing readable outlives the account), then the shared database. Both steps can be retried safely.
 * Spending records stay for cost accounting but lose their link to the person.
 */
export async function deleteAccount(o: { pool: Pool; tenants: Tenants; userId: string; now: () => number }) {
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) { removed = o.tenants.remove(o.userId); if (!removed) await new Promise((r) => setTimeout(r, 250)); }
  if (!removed) throw new HttpError(409, 'busy', 'Something is still running on your account. Wait a few seconds and try again.');
  await tx(o.pool, async (c) => {
    const email = (await c.query('SELECT email FROM "user" WHERE id = $1', [o.userId])).rows[0]?.email as string | undefined;
    await c.query('UPDATE ai_requests SET user_id = NULL WHERE user_id = $1', [o.userId]);
    await c.query('DELETE FROM usage_counters WHERE user_id = $1', [o.userId]);
    await c.query('DELETE FROM reports WHERE user_id = $1', [o.userId]);
    await c.query('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [o.userId]);
    await c.query('UPDATE invites SET used_by = NULL WHERE used_by = $1', [o.userId]);
    await c.query('DELETE FROM session WHERE "userId" = $1', [o.userId]);
    await c.query('DELETE FROM account WHERE "userId" = $1', [o.userId]);
    if (email) await c.query('DELETE FROM verification WHERE identifier = $1', [email]);
    await c.query('DELETE FROM "user" WHERE id = $1', [o.userId]);
  });
  await audit(o.pool, 'account_deleted', null, {});
}
