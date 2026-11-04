import { defineConfig, devices } from '@playwright/test';

/** Browser tests for the public no-account study profile on an owner-only site (real server, real PostgreSQL, scripted AI). Run: npm run test:e2e:public */
process.env.E2E_CONTROL_PORT ??= '4201';
const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 4200}`;
export default defineConfig({
  testDir: 'e2e-public', timeout: 60_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0, reporter: [['list']],
  use: { baseURL: APP, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 900 } }, testIgnore: /phone/ }, { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone/ }],
  webServer: { command: 'node --import tsx e2e/launcher.ts', url: `${APP}/healthz`, reuseExistingServer: false, timeout: 90_000, stdout: 'pipe', stderr: 'pipe', env: { E2E_OWNER: '1', E2E_PUBLIC: '1', E2E_APP_PORT: String(process.env.E2E_APP_PORT ?? 4200), E2E_CONTROL_PORT: String(process.env.E2E_CONTROL_PORT), E2E_LIMITS: JSON.stringify({ PUBLIC_OPERATOR_AI: '1', PUBLIC_IP_PER_MIN: '100', PUBLIC_IP_DAILY: '5', PUBLIC_GLOBAL_DAILY: '400' }) } },
});
