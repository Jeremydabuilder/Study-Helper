import { defineConfig, devices } from '@playwright/test';

/** Browser tests for the owner-only My Helper site (real server, real PostgreSQL, scripted AI). Run: npm run test:e2e:owner */
process.env.E2E_CONTROL_PORT ??= '4191';
const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 4190}`;
export default defineConfig({
  testDir: 'e2e-owner', timeout: 60_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0, reporter: [['list']],
  use: { baseURL: APP, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 900 } }, testIgnore: /phone/ }, { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone/ }],
  webServer: { command: 'node --import tsx e2e/launcher.ts', url: `${APP}/healthz`, reuseExistingServer: false, timeout: 90_000, stdout: 'pipe', stderr: 'pipe', env: { E2E_OWNER: '1', E2E_APP_PORT: String(process.env.E2E_APP_PORT ?? 4190), E2E_CONTROL_PORT: String(process.env.E2E_CONTROL_PORT ?? 4191) } },
});
