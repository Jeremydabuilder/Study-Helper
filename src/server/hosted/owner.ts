import { randomUUID } from 'node:crypto';
import type { Auth } from './auth';
import { Pool, audit, setSettingPg } from './pg';
import type { HostedConfig } from './config';

/**
 * Owner-only deployment: exactly one account, created (and its password kept in step) from the host's settings. No page can create another account.
 * The password comes from OWNER_PASSWORD, which lives in the host's secret settings; it is hashed with the authentication library's own hasher and
 * never logged or returned. Remove OWNER_PASSWORD after the first start if you prefer: the saved hash keeps working, and setting it again changes the password.
 */
export async function ensureOwner(auth: Auth, pool: Pool, cfg: HostedConfig): Promise<{ created: boolean; passwordChanged: boolean }> {
  const o = cfg.owner;
  const others = (await pool.query('SELECT COUNT(*)::int n FROM "user" WHERE lower(email) <> $1', [o.email])).rows[0].n as number;
  if (others > 0) throw new Error(`This database already has ${others} other account(s). An owner-only site must use a database of its own; refusing to start so nobody else can be reached.`);
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(o.email, { includeAccounts: true });
  let created = false, passwordChanged = false;
  if (!found) {
    if (!o.password) throw new Error('No owner account exists yet. Set OWNER_PASSWORD (at least 12 characters) in the host settings for the first start.');
    // Written directly: the library's own creation path runs the sign-up gate, which on this site refuses every account.
    const id = randomUUID(), hash = await ctx.password.hash(o.password);
    await pool.query('INSERT INTO "user" (id, name, email, "emailVerified", "isAnonymous", "createdAt", "updatedAt") VALUES ($1,$2,$3,true,false,now(),now())', [id, 'Owner', o.email]);
    await pool.query('INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())', [randomUUID(), id, 'credential', id, hash]);
    created = true;
  } else if (o.password) {
    const cred = (found.accounts as { providerId: string; password?: string | null }[]).find((a) => a.providerId === 'credential');
    const same = cred?.password ? await ctx.password.verify({ hash: cred.password, password: o.password }) : false;
    if (!same) {
      const hash = await ctx.password.hash(o.password);
      if (cred) await pool.query('UPDATE account SET password = $1, "updatedAt" = now() WHERE "userId" = $2 AND "providerId" = $3', [hash, found.user.id, 'credential']);
      else await pool.query('INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())', [randomUUID(), found.user.id, 'credential', found.user.id, hash]);
      await pool.query('DELETE FROM session WHERE "userId" = $1', [found.user.id]); // a changed password signs every device out
      passwordChanged = true;
    }
  }
  // the site is private, so it is always open to its owner and never accepts new accounts
  await setSettingPg(pool, 'pilot_enabled', true); await setSettingPg(pool, 'signups_open', false);
  if (created || passwordChanged) await audit(pool, created ? 'owner_created' : 'owner_password_changed', null, {});
  return { created, passwordChanged };
}
