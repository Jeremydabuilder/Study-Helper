import { expect, test } from '@playwright/test';
import { NOTES, joinAs, watch } from './support';

const noSideScroll = async (page: import('@playwright/test').Page, label: string) => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(w.sw, `${label} scrolls sideways (${w.sw} > ${w.iw})`).toBeLessThanOrEqual(w.iw + 1);
};

test('on a phone: sign in, move around with the bottom bar, study with taps, nothing overflows the screen', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'phone@example.test');
  await noSideScroll(page, 'Today');
  // the bottom navigation is reachable and every item is big enough to tap
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox(); const vp = page.viewportSize()!;
  expect(box!.y + box!.height).toBeGreaterThan(vp.height - 80); // docked at the bottom
  for (const label of ['Homework', 'Subjects', 'Readings', 'Chat', 'Plan', 'Progress', 'Memory', 'Settings']) {
    const link = nav.getByRole('link', { name: label });
    const b = await link.boundingBox(); expect(b!.height, `${label} tap target`).toBeGreaterThanOrEqual(32); expect(b!.x, `${label} on screen`).toBeGreaterThanOrEqual(0); expect(b!.x + b!.width).toBeLessThanOrEqual(vp.width + 1);
    await link.tap(); await expect(link).toHaveAttribute('aria-current', 'page'); await noSideScroll(page, label);
  }
  // add material and study by tapping
  await page.goto('/#/start');
  await page.getByLabel('New subject name').fill('Biology');
  await page.getByRole('button', { name: 'Paste text' }).tap();
  await page.getByLabel('Paste text').fill(NOTES);
  await noSideScroll(page, 'Start');
  await page.getByRole('button', { name: 'Continue' }).tap();
  await page.getByRole('button', { name: /Confirm .* and start/ }).tap();
  await page.getByLabel(/your answer/i).fill('glucose and oxygen');
  await noSideScroll(page, 'Study');
  await page.getByRole('button', { name: /check my answer/i }).tap();
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  await noSideScroll(page, 'Feedback');
  await page.goto('/#/settings'); await page.getByRole('tab', { name: 'Account' }).tap();
  await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeVisible(); await noSideScroll(page, 'Account');
  expect(problems, problems.join('\n')).toEqual([]);
});

test('on a phone: homework review, working, help and check results fit the screen and are reachable by tapping', async ({ page }) => {
  await joinAs(page, 'phonehw@example.test');
  await page.goto('/#/homework/new');
  await page.getByLabel('New subject name').fill('Algebra 1');
  await page.getByLabel('Instructions and questions').fill('Worksheet 4\n1. Solve for x: 2x + 3 = 11\n2. Solve: -2x < 6');
  await page.getByRole('button', { name: 'Continue' }).tap();
  await noSideScroll(page, 'Homework review');
  await page.getByRole('button', { name: 'Looks right: start this homework' }).tap();
  await expect(page.getByRole('heading', { name: 'Worksheet 4' })).toBeVisible();
  await noSideScroll(page, 'Homework workspace');
  await page.getByLabel('Your working for question 1').fill('2x + 3 = 11\n2x = 14\nx = 7');
  await page.getByRole('button', { name: 'Check my work' }).tap();
  await expect(page.getByRole('region', { name: 'Check result' })).toBeVisible();
  await noSideScroll(page, 'Check result');
  for (const name of ['Check my work', 'Give me a hint', 'Show the worked solution']) { const b = await page.getByRole('button', { name }).boundingBox(); expect(b!.height, name).toBeGreaterThanOrEqual(32); }
});
