/** The two Render blueprints are checked structurally here. They have NOT been validated by Render itself (see docs/DEPLOYMENT.md). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { hostedConfigFromEnv } from '../src/server/hosted/config';

const load = (f: string) => parse(readFileSync(f, 'utf8')) as any;
const env = (svc: any) => Object.fromEntries(svc.envVars.map((e: any) => [e.key, e]));

describe.each([['render.staging.yaml', 'staging'], ['render.production.yaml', 'production']])('%s', (file, name) => {
  const d = load(file); const svc = d.services[0]; const e = env(svc);
  it('creates exactly one service and one database, none for the other environment', () => {
    expect(d.services).toHaveLength(1); expect(d.databases).toHaveLength(1);
    expect(JSON.stringify(d)).not.toMatch(name === 'staging' ? /pilot|production/ : /staging/);
    expect(svc.name).toContain(name === 'staging' ? 'staging' : 'pilot');
  });
  it('is one instance with a disk, deploys only by hand, and checks readiness', () => {
    expect(svc.numInstances).toBe(1); expect(svc.autoDeploy).toBe(false); expect(svc.healthCheckPath).toBe('/readyz');
    expect(svc.disk.mountPath).toBe(e.DATA_DIR.value); expect(svc.disk.sizeGB).toBeGreaterThan(0);
    expect(svc.buildCommand).toContain('--include=dev'); expect(svc.startCommand).toBe('npm run start:hosted');
  });
  it('keeps the database private and takes its address from the platform', () => {
    expect(d.databases[0].ipAllowList).toEqual([]); expect(e.DATABASE_URL.fromDatabase.name).toBe(d.databases[0].name);
  });
  it('holds no secret values: generated or entered in the dashboard', () => {
    for (const k of ['BETTER_AUTH_SECRET', 'APP_SECRET', 'OPERATOR_TOKEN']) expect(e[k].generateValue).toBe(true);
    for (const k of ['ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPERATOR_NAME']) if (e[k]) { expect(e[k].sync).toBe(false); expect(e[k].value).toBeUndefined(); }
  });
  it('with the dashboard values filled in, the app accepts the configuration', () => {
    const vals: Record<string, string> = { RENDER_EXTERNAL_URL: 'https://example.onrender.com' };
    for (const [k, v] of Object.entries<any>(e)) vals[k] = v.value ?? (v.generateValue ? `${k}-`.padEnd(40, 'x') + (k === 'APP_SECRET' ? 'a' : 'b') : v.fromDatabase ? 'postgres://u:p@h/db' : '');
    Object.assign(vals, name === 'production' ? { OPERATOR_NAME: 'A Person', OPERATOR_CONTACT: 'a@example.test', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' } : {});
    const { problems, cfg } = hostedConfigFromEnv(vals as never);
    expect(problems).toEqual([]); expect(cfg.environment).toBe(name); expect(cfg.dataLabel).toBe(name); expect(cfg.publicUrl).toBe('https://example.onrender.com');
  });
});
it('staging allows password sign-in and production does not', () => {
  expect(env(load('render.staging.yaml').services[0]).AUTH_PASSWORD.value).toBe('1');
  expect(env(load('render.production.yaml').services[0]).AUTH_PASSWORD).toBeUndefined();
});
