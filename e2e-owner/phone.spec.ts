import { expect, test } from '@playwright/test';

test('on a phone the owner gets the bottom bar and nothing scrolls sideways', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('owner@example.test'); await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const bar = page.getByRole('navigation', { name: 'Main (mobile)' });
  await expect(bar).toBeVisible();
  for (const path of ['/', '/school', '/projects', '/helper', '/import']) {
    await page.goto(`/#${path}`);
    await expect(bar).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), path).toBe(true);
  }
  await bar.getByRole('link', { name: 'School' }).click();
  await expect(page.getByRole('heading', { name: 'School', level: 2 })).toBeVisible();
});
