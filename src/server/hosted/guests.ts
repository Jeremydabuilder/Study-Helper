import { deleteAccount } from './account';
import { Pool } from './pg';
import { Tenants } from './tenants';

export const GUEST_GRACE_DAYS = 7;

/** Only unreachable guests are eligible. Active sessions and busy tenant handles
 * are protected; account users are never candidates. One hosted instance owns
 * this disk/database, and the caller serializes maintenance runs. */
export async function cleanupGuests(o: { pool: Pool; tenants: Tenants; now: () => number; onDeleted?: (id: string) => void }) {
  const at = new Date(o.now());
  await o.pool.query(`DELETE FROM guest_expiry g WHERE NOT EXISTS
    (SELECT 1 FROM "user" u WHERE u.id = g.user_id AND u."isAnonymous" = true)
    OR EXISTS (SELECT 1 FROM session s WHERE s."userId" = g.user_id AND s."expiresAt" > $1)`, [at]);
  await o.pool.query(`INSERT INTO guest_expiry (user_id, unreachable_since)
    SELECT u.id, $1 FROM "user" u WHERE u."isAnonymous" = true
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s."userId" = u.id AND s."expiresAt" > $1)
    ON CONFLICT (user_id) DO NOTHING`, [at]);
  const rows = (await o.pool.query(`SELECT g.user_id FROM guest_expiry g JOIN "user" u ON u.id = g.user_id
    WHERE u."isAnonymous" = true AND g.unreachable_since <= $1
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s."userId" = u.id AND s."expiresAt" > $2)
    ORDER BY g.unreachable_since LIMIT 50`, [new Date(o.now() - GUEST_GRACE_DAYS * 86_400_000), at])).rows;
  let deleted = 0;
  for (const r of rows) {
    // Don't wait for an active request or AI call; try again next hour instead.
    if (!o.tenants.remove(r.user_id)) continue;
    await deleteAccount({ ...o, userId: r.user_id });
    o.onDeleted?.(r.user_id);
    deleted++;
  }
  return { deleted };
}
