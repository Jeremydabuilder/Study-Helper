import { expect, test } from '@playwright/test';

test('on a phone the guest app has a bottom bar, the three choices, and nothing scrolls sideways', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main (mobile)' })).toBeVisible();
  for (const path of ['/', '/build', '/build/paste', '/build/interview', '/help', '/practice', '/review', '/memory']) {
    await page.goto(`/#${path}`); await expect(page.getByRole('navigation', { name: 'Main (mobile)' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), path).toBe(true);
  }
});
