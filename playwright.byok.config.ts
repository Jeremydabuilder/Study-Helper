import { defineConfig, devices } from '@playwright/test';

/** Browser tests for "bring your own Groq key". The server's call to Groq is a stand-in (NO real Groq request is made). Run: npm run test:e2e:byok */
process.env.E2E_CONTROL_PORT ??= '4211';
const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 4210}`;
export default defineConfig({
  testDir: 'e2e-byok', timeout: 60_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0, reporter: [['list']],
  use: { baseURL: APP, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 900 } }, testIgnore: /phone/ }, { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone/ }],
  webServer: { command: 'node --import tsx e2e/launcher.ts', url: `${APP}/healthz`, reuseExistingServer: false, timeout: 90_000, stdout: 'pipe', stderr: 'pipe', env: { E2E_OWNER: '1', E2E_PUBLIC: '1', E2E_APP_PORT: String(process.env.E2E_APP_PORT ?? 4210), E2E_CONTROL_PORT: String(process.env.E2E_CONTROL_PORT), E2E_LIMITS: JSON.stringify({ PUBLIC_IP_PER_MIN: '200', PUBLIC_BYOK_PER_MIN: '200', PUBLIC_BYOK_TEST_PER_MIN: '200' }) } },
});
