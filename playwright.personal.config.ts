import { defineConfig, devices } from '@playwright/test';
const baseURL = `http://127.0.0.1:${process.env.E2E_PERSONAL_PORT ?? 4190}`;
export default defineConfig({
  testDir: 'e2e', testMatch: /personal\.spec\.ts/, timeout: 30000, workers: 1, retries: 0,
  use: { ...devices['Desktop Chrome'], baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} },
  webServer: { command: 'node --import tsx e2e/personal-launcher.ts', url: `${baseURL}/api/chatgpt/status`, reuseExistingServer: false, timeout: 30000 },
});
