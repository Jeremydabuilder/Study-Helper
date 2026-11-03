import { DEFAULT_LIMITS, Limits } from './limits';

export type Environment = 'production' | 'staging' | 'test';
export interface OidcConfig { providerId: string; clientId: string; clientSecret: string; authorizationUrl: string; tokenUrl: string; userInfoUrl: string; scopes: string[] }
export interface HostedConfig {
  environment: Environment;
  databaseUrl: string; publicUrl: string; authSecret: string;
  oidc: OidcConfig | null; passwordSignIn: boolean; guestEnabled: boolean;
  /** One person owns this deployment: a single email + password login, and every other way in (sign-up, guests, invitations, social sign-in) is switched off. */
  owner: { enabled: boolean; email: string; password: string | null; name: string };
  limits: Limits; trustProxy: boolean; sessionDays: number;
  /** requests per minute: signed-in student, sign-in endpoints per address, invitation checks per address */
  rate: { apiPerMin: number; authPerMin: number; invitePerMin: number };
  /** a marker the staging database must carry so a staging server can never open production data (and vice versa) */
  dataLabel: string;
  /** who runs this site: shown in the privacy notice. Required in production so students always know who to contact. */
  operator: { name: string; contact: string };
}

/** Google's published OpenID Connect endpoints (checked against https://accounts.google.com/.well-known/openid-configuration). Overridable so tests and other identity providers can be used. */
const GOOGLE = { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo' };

export function hostedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { cfg: HostedConfig; problems: string[] } {
  const g = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : null);
  const num = (k: string, d: number) => { const v = g(k); const n = v === null ? NaN : Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const environment = (g('APP_ENV') as Environment | null) ?? (env.NODE_ENV === 'production' ? 'production' : 'test');
  const problems: string[] = [];
  const ownerEnabled = g('OWNER_ONLY') === '1';
  // PUBLIC_URL is best set by hand; hosts that publish the address they gave the service (Railway: RAILWAY_PUBLIC_DOMAIN) are a convenience fallback
  const publicUrl = (g('PUBLIC_URL') ?? (g('RAILWAY_PUBLIC_DOMAIN') ? `https://${g('RAILWAY_PUBLIC_DOMAIN')}` : '')).replace(/\/+$/, '');
  const authSecret = g('BETTER_AUTH_SECRET') ?? '';
  if (!['production', 'staging', 'test'].includes(environment)) problems.push('APP_ENV must be production, staging or test.');
  if (!g('DATABASE_URL')) problems.push('DATABASE_URL is required in hosted mode.');
  try {
    const u = new URL(publicUrl);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (environment !== 'test' && u.protocol !== 'https:' && !local) problems.push('PUBLIC_URL must be https in production and staging.');
  } catch { problems.push('PUBLIC_URL must be the full public address, e.g. https://study.example.org.'); }
  if (authSecret.length < 32) problems.push('BETTER_AUTH_SECRET must be at least 32 random characters.');
  if (!g('APP_SECRET') || g('APP_SECRET')!.length < 32) problems.push('APP_SECRET must be at least 32 random characters (it protects stored Calendar tokens).');
  if (g('APP_SECRET') && g('APP_SECRET') === authSecret) problems.push('APP_SECRET and BETTER_AUTH_SECRET must be different values.');
  const clientId = g('AUTH_OIDC_CLIENT_ID') ?? g('GOOGLE_CLIENT_ID'), clientSecret = g('AUTH_OIDC_CLIENT_SECRET') ?? g('GOOGLE_CLIENT_SECRET');
  const oidc: OidcConfig | null = !ownerEnabled && clientId && clientSecret ? {
    providerId: g('AUTH_OIDC_PROVIDER_ID') ?? 'google', clientId, clientSecret,
    authorizationUrl: g('AUTH_OIDC_AUTHORIZATION_URL') ?? GOOGLE.authorizationUrl, tokenUrl: g('AUTH_OIDC_TOKEN_URL') ?? GOOGLE.tokenUrl, userInfoUrl: g('AUTH_OIDC_USERINFO_URL') ?? GOOGLE.userInfoUrl, scopes: ['openid', 'email'],
  } : null;
  // password sign-in exists for staging with fictional accounts and for students without a Google account; it is still invite-gated
  const ownerEmail = (g('OWNER_EMAIL') ?? '').toLowerCase(), ownerPassword = g('OWNER_PASSWORD');
  const passwordSignIn = ownerEnabled ? true : g('AUTH_PASSWORD') === '1';
  const guestEnabled = ownerEnabled ? false : g('AUTH_GUESTS') === '1';
  if (ownerEnabled) {
    if (g('AUTH_GUESTS') === '1') problems.push('OWNER_ONLY=1 cannot be combined with AUTH_GUESTS=1: an owner-only site has no guest entry.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) problems.push('OWNER_EMAIL must be the email address you sign in with.');
    if (ownerPassword !== null && ownerPassword.length < 12) problems.push('OWNER_PASSWORD must be at least 12 characters.');
  }
  if (!ownerEnabled && !oidc && !passwordSignIn && !guestEnabled) problems.push('Configure at least one sign-in method: Google/OIDC credentials, AUTH_PASSWORD=1, or AUTH_GUESTS=1.');
  if (!ownerEnabled && environment === 'production' && passwordSignIn && g('AUTH_PASSWORD_ALLOW_IN_PRODUCTION') !== '1') problems.push('AUTH_PASSWORD=1 is not allowed in production unless AUTH_PASSWORD_ALLOW_IN_PRODUCTION=1 (accounts would then rely on invitations alone).');
  const dataLabel = g('DATA_LABEL') ?? environment;
  const operator = { name: g('OPERATOR_NAME') ?? '', contact: g('OPERATOR_CONTACT') ?? '' };
  if (!ownerEnabled && environment === 'production' && (!operator.name || !operator.contact)) problems.push('OPERATOR_NAME and OPERATOR_CONTACT are required in production: the privacy notice must say who runs the site and how to reach them.');
  const limits: Limits = {
    ...DEFAULT_LIMITS,
    userDailyRequests: num('LIMIT_USER_DAILY_AI_REQUESTS', DEFAULT_LIMITS.userDailyRequests), userDailyUsd: num('LIMIT_USER_DAILY_USD', DEFAULT_LIMITS.userDailyUsd),
    globalDailyUsd: num('LIMIT_GLOBAL_DAILY_USD', DEFAULT_LIMITS.globalDailyUsd), userConcurrentAi: num('LIMIT_USER_CONCURRENT_AI', DEFAULT_LIMITS.userConcurrentAi),
    globalConcurrentAi: num('LIMIT_GLOBAL_CONCURRENT_AI', DEFAULT_LIMITS.globalConcurrentAi), userDailyUploads: num('LIMIT_USER_DAILY_UPLOADS', DEFAULT_LIMITS.userDailyUploads),
    userDailyUploadMb: num('LIMIT_USER_DAILY_UPLOAD_MB', DEFAULT_LIMITS.userDailyUploadMb), userStorageMb: num('LIMIT_USER_STORAGE_MB', DEFAULT_LIMITS.userStorageMb),
    userDailyChat: num('LIMIT_USER_DAILY_CHAT', DEFAULT_LIMITS.userDailyChat), userDailyExtractions: num('LIMIT_USER_DAILY_EXTRACTIONS', DEFAULT_LIMITS.userDailyExtractions),
    globalConcurrentExtractions: num('LIMIT_GLOBAL_CONCURRENT_EXTRACTIONS', DEFAULT_LIMITS.globalConcurrentExtractions),
    globalDailyRequests: num('LIMIT_GLOBAL_DAILY_AI_REQUESTS', DEFAULT_LIMITS.globalDailyRequests), globalDailyTokens: num('LIMIT_GLOBAL_DAILY_TOKENS', DEFAULT_LIMITS.globalDailyTokens), userDailyTokens: num('LIMIT_USER_DAILY_TOKENS', DEFAULT_LIMITS.userDailyTokens),
  };
  return { cfg: { environment, databaseUrl: g('DATABASE_URL') ?? '', publicUrl, authSecret, oidc, passwordSignIn, guestEnabled, limits, trustProxy: g('TRUST_PROXY') !== '0', operator, sessionDays: num('SESSION_DAYS', ownerEnabled ? 30 : 7), owner: { enabled: ownerEnabled, email: ownerEmail, password: ownerPassword, name: (g('OWNER_NAME') ?? 'Jeremy').slice(0, 40) }, dataLabel, rate: { apiPerMin: num('RATE_API_PER_MIN', 300), authPerMin: num('RATE_AUTH_PER_MIN', 40), invitePerMin: num('RATE_INVITE_PER_MIN', 20) } }, problems };
}
