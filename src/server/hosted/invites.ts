import { createHash, randomInt } from 'node:crypto';
import { Pool, audit, getSettingPg, tx } from './pg';

/**
 * Invitation codes: 16 characters from a 31-letter alphabet (about 79 bits), single-use, expiring, revocable. Only a hash is stored, so a database leak
 * does not leak working codes. A school email address is NOT treated as proof of anything: only a valid code admits a new account.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CLAIM_TTL_MS = 3 * 60_000;

export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashCode = (s: string) => createHash('sha256').update(`study-helper-invite:${normalizeCode(s)}`).digest('hex');
export const looksLikeCode = (s: string) => /^[A-HJ-NP-Z2-9]{16}$/.test(normalizeCode(s));
export function newCode(): string {
  const c = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`;
}

export type InviteProblem = 'unknown' | 'used' | 'expired' | 'revoked' | 'in_use';

export async function createInvites(pool: Pool, o: { count: number; label?: string; ttlDays?: number; now: number }): Promise<string[]> {
  const count = Math.max(1, Math.min(200, Math.floor(o.count)));
  const ttl = Math.max(1, Math.min(60, Math.floor(o.ttlDays ?? 7)));
  const codes: string[] = [];
  await tx(pool, async (c) => {
    for (let i = 0; i < count; i++) {
      const code = newCode(); codes.push(code);
      await c.query('INSERT INTO invites (code_hash, label, created_at, expires_at) VALUES ($1,$2,$3,$4)', [hashCode(code), (o.label ?? '').slice(0, 60), new Date(o.now), new Date(o.now + ttl * 86_400_000)]);
    }
  });
  await audit(pool, 'invites_created', null, { count, ttlDays: ttl, label: (o.label ?? '').slice(0, 60) });
  return codes;
}

/** Read-only check used by the invitation page. Says why a code does not work, but gives the same answer for "never existed" however it is probed. */
export async function checkInvite(pool: Pool, code: string, now: number): Promise<{ valid: true } | { valid: false; reason: InviteProblem }> {
  if (!looksLikeCode(code)) return { valid: false, reason: 'unknown' };
  const r = (await pool.query('SELECT expires_at, claimed_at, used_at, revoked_at FROM invites WHERE code_hash = $1', [hashCode(code)])).rows[0];
  if (!r) return { valid: false, reason: 'unknown' };
  if (r.revoked_at) return { valid: false, reason: 'revoked' };
  if (r.used_at) return { valid: false, reason: 'used' };
  if (r.expires_at.getTime() <= now) return { valid: false, reason: 'expired' };
  if (r.claimed_at && now - r.claimed_at.getTime() < CLAIM_TTL_MS) return { valid: false, reason: 'in_use' };
  return { valid: true };
}

/** Atomically take the code for one sign-up. Of any number of concurrent attempts, exactly one wins. */
export async function claimInvite(pool: Pool, code: string, now: number): Promise<string | null> {
  if (!looksLikeCode(code)) return null;
  const r = await pool.query(
    `UPDATE invites SET claimed_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2
       AND (claimed_at IS NULL OR claimed_at < $3) RETURNING id`, [hashCode(code), new Date(now), new Date(now - CLAIM_TTL_MS)]);
  return r.rows[0]?.id ?? null;
}
export async function finishInvite(pool: Pool, inviteId: string, userId: string, now: number) {
  await pool.query('UPDATE invites SET used_at = $2, used_by = $3 WHERE id = $1', [inviteId, new Date(now), userId]);
  await audit(pool, 'invite_used', userId, { inviteId });
}
export async function releaseClaim(pool: Pool, inviteId: string) { await pool.query('UPDATE invites SET claimed_at = NULL WHERE id = $1 AND used_at IS NULL', [inviteId]); }

export async function listInvites(pool: Pool, now: number) {
  return (await pool.query('SELECT id, label, created_at, expires_at, used_at, revoked_at, claimed_at FROM invites ORDER BY created_at DESC LIMIT 500')).rows.map((r) => ({
    id: String(r.id).slice(0, 8), label: r.label, createdAt: r.created_at, expiresAt: r.expires_at,
    status: r.revoked_at ? 'revoked' : r.used_at ? 'used' : r.expires_at.getTime() <= now ? 'expired' : 'open',
  }));
}
export async function revokeInvites(pool: Pool, o: { idPrefix?: string; label?: string }) {
  const r = await pool.query("UPDATE invites SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL AND (($1::text IS NOT NULL AND id::text LIKE $1 || '%') OR ($2::text IS NOT NULL AND label = $2))", [o.idPrefix ?? null, o.label ?? null]);
  await audit(pool, 'invites_revoked', null, { count: r.rowCount });
  return r.rowCount ?? 0;
}

/** Whether a brand-new account may be created right now, ignoring the code itself. */
export async function admissionOpen(pool: Pool): Promise<{ open: boolean; reason?: 'paused' | 'full' }> {
  if (!(await getSettingPg<boolean>(pool, 'pilot_enabled', false)) || !(await getSettingPg<boolean>(pool, 'signups_open', true))) return { open: false, reason: 'paused' };
  const max = await getSettingPg<number>(pool, 'pilot_max_users', 30);
  const n = (await pool.query('SELECT COUNT(*)::int n FROM "user"')).rows[0].n as number;
  return n >= max ? { open: false, reason: 'full' } : { open: true };
}
