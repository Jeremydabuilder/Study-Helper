import { expect, test } from '@playwright/test';

test('guest enters without identity, keeps work on reload and cannot see a second guest workspace', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible();
  await expect(page.getByText(/Guest mode ·/)).toBeVisible();
  const created = await page.request.post('/api/subjects', { data: { name: 'Guest-only biology' } });
  expect(created.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByText(/Guest mode ·/)).toBeVisible();
  expect(JSON.stringify(await (await page.request.get('/api/subjects')).json())).toContain('Guest-only biology');
  const second = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await second.newPage();
    await other.goto('/');
    await other.getByRole('button', { name: 'Continue without an account' }).click();
    await expect(other.getByRole('link', { name: 'Today' }).first()).toBeVisible();
    expect(JSON.stringify(await (await other.request.get('/api/subjects')).json())).not.toContain('Guest-only biology');
  } finally { await second.close(); }
});
