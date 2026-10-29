import { defineConfig, devices } from '@playwright/test';

const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 4180}`;
export default defineConfig({
  testDir: 'e2e', timeout: 60_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0,
  reporter: [['list']],
  use: { baseURL: APP, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 900 } } }, { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ }],
  webServer: { command: 'npx tsx e2e/launcher.ts', url: `${APP}/healthz`, reuseExistingServer: false, timeout: 90_000, stdout: 'pipe', stderr: 'pipe' },
});
