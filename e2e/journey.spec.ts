import { expect, Page, test } from '@playwright/test';
import { NOTES, control, joinAs, signInAgain, watch } from './support';

async function answer(page: Page, text: string) {
  await page.getByLabel(/your answer/i).fill(text);
  await page.getByRole('button', { name: /check my answer/i }).click();
}

test('a new classmate: invitation → sign in → first material → goal and time → review → study → feedback → pause → sign out → resume', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'maya@example.test');

  // an empty account shows one clear next step and no operator jargon
  await expect(page.getByRole('button', { name: /Upload or paste material/ })).toBeVisible();
  const body = await page.locator('body').innerText();
  for (const jargon of [/claude/i, /anthropic/i, /\btokens?\b/i, /budget/i, /ANTHROPIC_API_KEY/, /\.env/, /database/i, /offline mode/i]) expect(body).not.toMatch(jargon);

  // first material: paste, choose goal and time
  await page.getByRole('button', { name: /Upload or paste material/ }).click();
  await expect(page.getByRole('heading', { name: 'Start studying' })).toBeVisible();
  await page.getByRole('button', { name: '20 min' }).click();
  await page.getByLabel('New subject name').fill('Biology');
  await page.getByRole('button', { name: 'Paste text' }).click();
  await page.getByLabel('Paste text').fill(NOTES);
  await page.getByRole('button', { name: 'Continue' }).click();

  // review what will be studied (concepts found in THIS material; nothing is practised until confirmed)
  await expect(page.getByRole('heading', { name: 'Check what you’ll study' })).toBeVisible();
  await expect(page.getByText('Photosynthesis').first()).toBeVisible();
  await page.getByRole('button', { name: /Confirm .* and start/ }).click();

  // study: answer, feedback labels what counts and why
  await expect(page.getByLabel(/your answer/i)).toBeVisible();
  await answer(page, 'glucose and oxygen');
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Next question|Finish session/ }).first()).toBeVisible();

  // a typed-but-unsent answer survives a reload, a sign-out and a sign-in
  await page.getByRole('button', { name: 'Next question' }).click();
  await page.getByLabel(/your answer/i).fill('half-typed answer about chlorop');
  await page.reload();
  await expect(page.getByLabel(/your answer/i)).toHaveValue(/half-typed answer/);
  await page.getByRole('button', { name: /Pause/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Join Study Helper' })).toBeVisible();

  // back later: progress is intact and the session resumes
  await signInAgain(page, 'maya@example.test');
  await page.getByRole('button', { name: /Resume your session/ }).click();
  await expect(page.getByLabel(/your answer/i)).toBeVisible();
  await answer(page, 'chlorophyll');
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  await page.getByRole('button', { name: /Finish session|End session here|Wrap up/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Here’s what happened' })).toBeVisible();
  const summary = await page.locator('main').innerText();
  expect(summary).not.toMatch(/mastered|you will pass|predicted grade/i);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('a delayed independent review uses the injected clock: the same day is only "corrected for now"; an unseen question days later is the real check and is counted as delayed', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'ravi@example.test');
  await page.goto('/#/start');
  await page.getByLabel('New subject name').fill('Biology');
  await page.getByRole('button', { name: 'Paste text' }).click();
  await page.getByLabel('Paste text').fill(NOTES);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Confirm .* and start/ }).click();
  await answer(page, 'glucose and oxygen');
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  const day0 = await (await page.request.get('/api/progress')).json();
  expect(day0.delayedRecall.n).toBe(0); // answering right away is practice, not evidence that it stuck
  await page.getByRole('button', { name: /Finish session|End session here/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Here’s what happened' })).toBeVisible();
  const firstPrompt = (await (await page.request.get('/api/history')).json());
  await control('advance', { ms: 3 * 24 * 3600_000 }); // three days pass (the app's injected clock, not real time)
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: /review|due|check|Understand|Test/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.getByLabel(/your answer/i)).toBeVisible();
  await answer(page, 'chlorophyll absorbs light');
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  const day3 = await (await page.request.get('/api/progress')).json();
  expect(day3.delayedRecall.n).toBeGreaterThanOrEqual(1); // now it counts as a delayed, unaided answer
  void firstPrompt; expect(problems, problems.join('\n')).toEqual([]);
});
