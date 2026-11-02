import { expect, test } from '@playwright/test';
test('personal setup offers explicit ChatGPT authorization without API keys or automatic sign-in', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Your ChatGPT account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
  await expect(page.getByText('Create an API key in the Anthropic Console.')).toHaveCount(0);
  await page.route('https://auth.openai.com/**', route => route.fulfill({ contentType: 'text/html', body: 'Mock OpenAI consent. No account was signed in.' }));
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page).toHaveURL(/https:\/\/auth\.openai\.com\/api\/accounts\/authorize/);
  const url = new URL(page.url());
  expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(url.searchParams.get('agent_name_hint')).toBe('Study Helper');
  expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/chatgpt\/callback$/);
  expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
});
test('personal settings identify the connected account and expose plan controls', async ({ page }) => {
  await page.route('**/api/chatgpt/status', r => r.fulfill({ json: { connected: true, email: 'verified-account@example.test', model: 'test-model', needsWelcome: false, usingPlan: true, manageUsageUrl: 'https://chatgpt.com/settings/usage' } }));
  await page.route('**/api/chatgpt/models', r => r.fulfill({ json: [{ slug: 'test-model', display_name: 'Account model' }] }));
  await page.goto('/#/settings');
  await expect(page.getByText('verified-account@example.test', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'ChatGPT model' })).toHaveValue('test-model');
  await expect(page.getByRole('link', { name: 'Manage usage' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
  await expect(page.getByRole('button', { name: 'Disconnect ChatGPT on this computer' })).toBeVisible();
});
