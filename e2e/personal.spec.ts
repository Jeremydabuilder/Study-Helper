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
test('a failed sign-in says why in plain words (different account) and does not repeat on reload', async ({ page }) => {
  await page.goto('/#/settings?tab=setup&chatgpt=failed&reason=account_mismatch');
  await expect(page.getByRole('alert').filter({ hasText: 'different ChatGPT account or workspace' })).toBeVisible();
  await expect(page.getByText('Nothing was changed')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings\?tab=setup$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your ChatGPT account' })).toBeVisible();
  await expect(page.getByText('different ChatGPT account or workspace')).toHaveCount(0);
});
test('a connection folder inside a cloud-synced folder blocks sign-in and explains the fix; a status error is shown, not an endless spinner', async ({ page }) => {
  await page.route('**/api/chatgpt/status', r => r.fulfill({ json: { connected: false, email: null, model: null, needsWelcome: false, usingPlan: false, storageWarning: 'The ChatGPT connection folder (C:\\Users\\Me\\OneDrive\\x) looks like it is inside a cloud-synced folder. Set CHATGPT_AUTH_DIR to a private folder.', manageUsageUrl: 'https://chatgpt.com/settings/usage' } }));
  await page.goto('/#/settings');
  await expect(page.getByRole('alert').filter({ hasText: 'CHATGPT_AUTH_DIR' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeDisabled();
  await page.unroute('**/api/chatgpt/status');
  await page.route('**/api/chatgpt/status', r => r.fulfill({ status: 500, json: { error: { code: 'x', message: 'Status is not available.' } } }));
  await page.reload();
  await expect(page.getByText('Status is not available.')).toBeVisible();
});
