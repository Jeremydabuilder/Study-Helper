import { expect, test } from '@playwright/test';

test('on a phone, Settings and the key controls fit the screen', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Remove key' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const p of ['/chat', '/help', '/']) { await page.goto(`/#${p}`); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), p).toBe(true); }
});
