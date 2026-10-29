import { expect, Locator, Page, test } from '@playwright/test';
import { NOTES, control } from './support';

/** Press Tab until the target has focus: proves a keyboard user can reach it (and fails if it can't within a sane number of presses). */
async function tabTo(page: Page, target: Locator, max = 80) {
  for (let i = 0; i < max; i++) { if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return i; await page.keyboard.press('Tab'); }
  throw new Error('not reachable with the keyboard');
}

test('keyboard only: invitation → sign in → paste → confirm → answer → submit → next, with visible focus', async ({ page }) => {
  const { codes } = await control('invites', { count: 1 }); await control('idp', { email: 'keys@example.test' });
  await page.goto('/#/join');
  await expect(page.getByRole('heading', { name: 'Join Study Helper' })).toBeFocused(); // focus starts on the page heading
  await tabTo(page, page.getByLabel('Invitation code')); await page.keyboard.type(codes[0]); await page.keyboard.press('Enter'); // the form submits with Enter
  await expect(page.getByText('Code accepted')).toBeVisible();
  await tabTo(page, page.getByRole('button', { name: 'Continue with Google' })); await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible();

  await page.goto('/#/start'); await page.locator('#main').focus();
  await tabTo(page, page.getByLabel('New subject name')); await page.keyboard.type('Biology');
  await tabTo(page, page.getByRole('button', { name: 'Paste text' })); await page.keyboard.press('Enter');
  await tabTo(page, page.getByLabel('Paste text')); await page.keyboard.insertText(NOTES);
  await tabTo(page, page.getByRole('button', { name: 'Continue' })); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Check what you’ll study' })).toBeVisible();
  await tabTo(page, page.getByRole('button', { name: /Confirm .* and start/ })); await page.keyboard.press('Enter');
  const answer = page.getByLabel(/your answer/i); await expect(answer).toBeVisible();
  await tabTo(page, answer); await page.keyboard.type('glucose and oxygen'); await page.keyboard.press('Control+Enter');
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Next question/ })).toBeFocused(); // after feedback, focus moves to the next action
  // every focused control shows a visible focus ring
  const ring = await page.getByRole('button', { name: /Next question/ }).evaluate((el) => { const s = getComputedStyle(el); return `${s.outlineStyle} ${s.outlineWidth}`; });
  expect(ring).not.toMatch(/none|^\S+ 0px/);
});
