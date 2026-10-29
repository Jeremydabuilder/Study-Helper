import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { genericOAuth } from 'better-auth/plugins';
import { Pool, audit } from './pg';
import { HostedConfig } from './config';
import { admissionOpen, claimInvite, finishInvite, hashCode, looksLikeCode, normalizeCode } from './invites';
import { getSettingPg } from './pg';

export const INVITE_COOKIE = 'sh_invite';

/** Reads one cookie from a request-like object. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } } }
  return null;
}
const cookieOf = (ctx: any): string | null => ctx?.request?.headers?.get?.('cookie') ?? ctx?.headers?.get?.('cookie') ?? null;

/**
 * `authPool` is Better Auth's own connection pool: it holds one connection per sign-up while our invitation hooks need a second one from `pool`.
 * Sharing one pool deadlocks under a burst of sign-ups (found by the load test). Authentication with Better Auth (maintained, TypeScript, Postgres-backed sessions). Settings that matter for a school pilot:
 *  - closed by default: an account is created only with a valid single-use invitation AND while the pilot is switched on and not full
 *  - no account linking, so one sign-in method can never take over another identity
 *  - only the email address is stored (no name, no profile photo): the app needs an identifier, nothing else
 *  - secure, HttpOnly, SameSite=Lax cookies; sessions live in the database and are revoked by sign-out immediately (no cookie cache)
 */
export function createAuth(pool: Pool, cfg: HostedConfig, now: () => number = Date.now, authPool: Pool = pool) {
  const secure = cfg.publicUrl.startsWith('https://');
  const plugins = cfg.oidc ? [genericOAuth({ config: [{
    providerId: cfg.oidc.providerId, clientId: cfg.oidc.clientId, clientSecret: cfg.oidc.clientSecret,
    authorizationUrl: cfg.oidc.authorizationUrl, tokenUrl: cfg.oidc.tokenUrl, userInfoUrl: cfg.oidc.userInfoUrl, scopes: cfg.oidc.scopes, pkce: true,
    // OpenID Connect identifies the person by the stable "sub" claim (never by email, which can change)
    accountSubject: ({ profile }: { profile: Record<string, any> }) => String(profile.sub ?? profile.id ?? ''),
    // keep only what the app needs: an email address. No display name or photo is stored.
    mapProfileToUser: (p: Record<string, any>) => ({ email: String(p.email ?? '').toLowerCase(), name: 'Student', image: undefined, emailVerified: p.email_verified === true }),
  }] })] : [];
  return betterAuth({
    database: authPool, secret: cfg.authSecret, baseURL: cfg.publicUrl, basePath: '/api/auth', trustedOrigins: [cfg.publicUrl],
    emailAndPassword: { enabled: cfg.passwordSignIn, minPasswordLength: 10, maxPasswordLength: 128, autoSignIn: true, requireEmailVerification: false },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: cfg.sessionDays * 86_400, updateAge: 86_400, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: secure, cookiePrefix: 'sh', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure }, ipAddress: { ipAddressHeaders: ['x-forwarded-for'] }, disableCSRFCheck: false },
    rateLimit: { enabled: true, window: 60, max: cfg.rate.authPerMin, customRules: { '/sign-in/*': { window: 60, max: cfg.rate.authPerMin }, '/sign-up/*': { window: 60, max: cfg.rate.authPerMin } } },
    user: {
      validateUserInfo: async ({ source }: any, ctx: any) => {
        if (source.action === 'link-account') return { error: 'linking_disabled', errorDescription: 'Linking sign-in methods is not supported.' };
        if (source.action !== 'create-user') return;
        const adm = await admissionOpen(pool);
        if (!adm.open) return { error: adm.reason === 'full' ? 'pilot_full' : 'pilot_closed', errorDescription: adm.reason === 'full' ? 'The pilot is full right now.' : 'The pilot is not accepting new students right now.' };
        const code = readCookie(cookieOf(ctx), INVITE_COOKIE);
        const inviteId = code && looksLikeCode(code) ? await claimInvite(pool, code, now()) : null;
        if (!inviteId) return { error: 'invite_required', errorDescription: 'You need a valid invitation to create an account.' };
        claimed.set(hashCode(code!), inviteId);
        return;
      },
    },
    databaseHooks: {
      user: { create: { after: async (user: any, ctx: any) => {
        const code = readCookie(cookieOf(ctx), INVITE_COOKIE);
        const key = code ? hashCode(code) : null;
        const inviteId = key ? claimed.get(key) : null;
        if (inviteId) { claimed.delete(key!); await finishInvite(pool, inviteId, user.id, now()); }
        await audit(pool, 'user_created', user.id, { method: ctx?.path ?? 'unknown' });
      } } },
      session: { create: { before: async () => { if (!(await getSettingPg<boolean>(pool, 'pilot_enabled', false))) return false; } } },
    },
    plugins,
  });
}
const claimed = new Map<string, string>(); // code hash -> claimed invite id, between the admission check and the user insert (same process)

export type Auth = ReturnType<typeof createAuth>;

/** Create Better Auth's tables (user, session, account, verification) if they are missing. Idempotent. */
export async function migrateAuth(auth: Auth) {
  const { runMigrations } = await getMigrations(auth.options as any);
  await runMigrations();
}
export { normalizeCode };
