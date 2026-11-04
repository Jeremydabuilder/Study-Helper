/** The container recipe and the documented owner-site settings are checked structurally here. They have NOT been built or run on a hosting provider (see docs/DEPLOYMENT.md). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hostedConfigFromEnv } from '../src/server/hosted/config';
import { configFromEnv } from '../src/server/config';

const docker = readFileSync('Dockerfile', 'utf8');
describe('Dockerfile', () => {
  it('runs the one hosted process from the built bundle with production packages only', () => {
    expect(docker).toMatch(/npm run build:hosted/); expect(docker).toMatch(/npm ci --omit=dev/); expect(docker).toMatch(/CMD \["node", "dist-server\/main\.mjs"\]/);
    expect(docker).toMatch(/APP_MODE=hosted/); expect(docker).toMatch(/DATA_DIR=\/data/); expect(docker).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
  });
  it('contains no secret values', () => {
    expect(docker).not.toMatch(/(SECRET|PASSWORD|TOKEN|API_KEY)\s*=\s*\S/);
  });
  it('keeps secrets, data and tests out of the image', () => {
    const ignore = readFileSync('.dockerignore', 'utf8');
    for (const p of ['.env', 'data', 'node_modules', '.git']) expect(ignore).toContain(p);
  });
});

describe('the owner-site settings in docs/DEPLOYMENT.md', () => {
  const doc = readFileSync('docs/DEPLOYMENT.md', 'utf8');
  const vars = { APP_ENV: 'production', DATABASE_URL: 'postgres://u:p@h:5432/db', PUBLIC_URL: 'https://my-helper.example.app', BETTER_AUTH_SECRET: 'a'.repeat(40), APP_SECRET: 'b'.repeat(40), DATA_LABEL: 'production',
    OWNER_ONLY: '1', OWNER_EMAIL: 'me@example.test', OWNER_PASSWORD: 'a long owner password', OWNER_NAME: 'Jeremy', AI_PROVIDER: 'groq', GROQ_API_KEY: 'gsk_test_placeholder' };
  it('every variable the guide asks for is documented, and together they are accepted by the app', () => {
    for (const k of Object.keys(vars)) expect(doc, k).toContain(k);
    const { problems, cfg } = hostedConfigFromEnv(vars as never);
    expect(problems).toEqual([]); expect(cfg.owner.enabled).toBe(true); expect(cfg.guestEnabled).toBe(false); expect(cfg.oidc).toBeNull(); expect(cfg.passwordSignIn).toBe(true);
  });
  it('Groq is the live provider and the key is read on the server only', () => {
    const c = configFromEnv({ ...vars, DATA_DIR: '/tmp/x' } as never);
    expect(c.aiProvider).toBe('groq'); expect(c.groqKey).toBe('gsk_test_placeholder');
  });
  it('an owner site refuses to start with guests switched on, a short password, or no owner email', () => {
    expect(hostedConfigFromEnv({ ...vars, AUTH_GUESTS: '1' } as never).problems.join()).toMatch(/AUTH_GUESTS/);
    expect(hostedConfigFromEnv({ ...vars, OWNER_PASSWORD: 'short' } as never).problems.join()).toMatch(/OWNER_PASSWORD/);
    expect(hostedConfigFromEnv({ ...vars, OWNER_EMAIL: '' } as never).problems.join()).toMatch(/OWNER_EMAIL/);
  });
  it('the public study-profile settings are documented and accepted', () => {
    const pubDoc = readFileSync('docs/PUBLIC_STUDY_PROFILE.md', 'utf8');
    for (const k of ['PUBLIC_GUEST', 'PUBLIC_MAX_PASTE_CHARS', 'PUBLIC_AI_CHUNK_CHARS', 'PUBLIC_AI_MAX_CHUNKS', 'PUBLIC_IP_PER_MIN', 'PUBLIC_IP_DAILY', 'PUBLIC_GLOBAL_DAILY', 'PUBLIC_OPERATOR_AI', 'PUBLIC_BYOK']) expect(pubDoc, k).toContain(k);
    const byokDoc = readFileSync('docs/BRING_YOUR_OWN_KEY.md', 'utf8'); for (const k of ['PUBLIC_OPERATOR_AI', 'PUBLIC_BYOK', 'PUBLIC_BYOK_PER_MIN', 'PUBLIC_BYOK_TEST_PER_MIN', 'https://api.groq.com/openai/v1/chat/completions']) expect(byokDoc, k).toContain(k);
    expect(hostedConfigFromEnv({ ...vars, PUBLIC_GUEST: '1' } as never).cfg.publicGuest).toMatchObject({ operatorAi: false, byok: true });
    expect(hostedConfigFromEnv({ ...vars, PUBLIC_GUEST: '1', PUBLIC_OPERATOR_AI: '1', PUBLIC_BYOK: '0' } as never).cfg.publicGuest).toMatchObject({ operatorAi: true, byok: false });
    const { problems, cfg } = hostedConfigFromEnv({ ...vars, PUBLIC_GUEST: '1' } as never);
    expect(problems).toEqual([]); expect(cfg.publicGuest).toMatchObject({ enabled: true, maxPasteChars: 200000, perIpDaily: 40, globalDaily: 400 });
    expect(hostedConfigFromEnv({ ...vars } as never).cfg.publicGuest.enabled).toBe(false);
  });
  it('no Render files are left', () => {
    for (const f of ['render.staging.yaml', 'render.production.yaml']) expect(() => readFileSync(f)).toThrow();
  });
});
