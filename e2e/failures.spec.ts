import { expect, Page, test } from '@playwright/test';
import { NOTES, control, joinAs, signInAgain, watch } from './support';

async function startSession(page: Page, email: string, subject = 'Biology') {
  await joinAs(page, email);
  await page.goto('/#/start');
  await page.getByLabel('New subject name').fill(subject);
  await page.getByRole('button', { name: 'Paste text' }).click();
  await page.getByLabel('Paste text').fill(NOTES);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Confirm .* and start/ }).click();
  await expect(page.getByLabel(/your answer/i)).toBeVisible();
}
const check = (page: Page) => page.getByRole('button', { name: /check my answer/i });

test('provider timeout while grading: the answer is saved and shown as not graded, nothing is counted, retry works, and a grade correction updates progress', async ({ page }) => {
  const problems = watch(page);
  await startSession(page, 'timeout@example.test');
  await page.getByLabel(/your answer/i).fill('glucose and oxygen');
  await control('llm-fail', { code: 'timeout' });
  await check(page).click();
  await expect(page.getByText('Saved, but not graded')).toBeVisible();
  await expect(page.getByText('glucose and oxygen').first()).toBeVisible(); // the answer is shown back
  await expect(page.getByText(/not counted/i).first()).toBeVisible();
  let prog = await (await page.request.get('/api/progress')).json();
  expect(prog.practiceAccuracy.n).toBe(0); // no false learning evidence
  await page.getByRole('button', { name: 'Retry grading' }).click();
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  prog = await (await page.request.get('/api/progress')).json();
  expect(prog.practiceAccuracy.n).toBe(1); expect(prog.practiceAccuracy.rate).toBe(1);
  // the student disagrees with the final grade for that attempt: the correction flows into progress
  const hist = await (await page.request.get('/api/history')).json();
  const attemptId = hist[0].id as string; expect(attemptId).toBeTruthy();
  expect((await page.request.post(`/api/attempts/${attemptId}/self-grade`, { data: { correctness: 0 } })).status()).toBe(200);
  prog = await (await page.request.get('/api/progress')).json();
  expect(prog.practiceAccuracy.rate).toBe(0); // the correction replaced the earlier conclusion
  expect(problems.filter((p) => !/504|timeout/i.test(p)), problems.join('\n')).toEqual([]);
});

test('assistant switched off or allowance used up: answers are saved, the student can grade themselves, and the wording never mentions money or models', async ({ page }) => {
  await startSession(page, 'allowance@example.test');
  await control('setting', { key: 'ai_enabled', value: false });
  await page.getByLabel(/your answer/i).fill('glucose and oxygen');
  await check(page).click();
  await expect(page.getByText('Saved, but not graded')).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).toMatch(/switched off|unavailable/i); expect(text).not.toMatch(/\$|usd|claude|anthropic|token|budget/i);
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByText(/Correct|Counted/).first()).toBeVisible();
  await control('setting', { key: 'ai_enabled', value: true });
});

test('double-clicking "Check my answer" records one attempt and grades once', async ({ page }) => {
  await startSession(page, 'double@example.test');
  const before = (await control('state')).llmCalls;
  await page.getByLabel(/your answer/i).fill('glucose and oxygen');
  await check(page).dblclick();
  await expect(page.getByText(/Correct/).first()).toBeVisible();
  const hist = JSON.stringify(await (await page.request.get('/api/history')).json());
  expect((hist.match(/glucose and oxygen/g) ?? []).length).toBeLessThanOrEqual(2); // not 2 separate attempts
  expect((await control('state')).llmCalls - before).toBeLessThanOrEqual(3); // one grading (+ at most a repair and a follow-up question), never one per click
  const prog = await (await page.request.get('/api/progress')).json();
  expect(prog.practiceAccuracy.n).toBe(1);
});

test('the session ends while a student is typing: they are taken to sign-in, and after signing in their typed answer is still there', async ({ page }) => {
  await startSession(page, 'expired@example.test');
  await page.getByLabel(/your answer/i).fill('my careful answer about chlorophyll');
  await control('expire-sessions');
  await check(page).click();
  await expect(page.getByRole('heading', { name: /Join Study Helper|Sign in/ })).toBeVisible();
  await signInAgain(page, 'expired@example.test');
  await page.getByRole('button', { name: /Resume your session/ }).click();
  await expect(page.getByLabel(/your answer/i)).toHaveValue('my careful answer about chlorophyll');
});

test('pausing the pilot shows a calm message, loses nothing, and resumes', async ({ page }) => {
  await startSession(page, 'paused@example.test');
  await page.getByLabel(/your answer/i).fill('typed before the pause');
  await control('setting', { key: 'pilot_enabled', value: false });
  await check(page).click();
  await expect(page.getByRole('heading', { name: 'Study Helper is paused' })).toBeVisible();
  await control('setting', { key: 'pilot_enabled', value: true });
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible();
  await page.goto('/#/');
  await page.getByRole('button', { name: /Resume your session/ }).click();
  await expect(page.getByLabel(/your answer/i)).toHaveValue('typed before the pause');
});

test('"Report a problem" shows exactly what will be sent before anything is stored', async ({ page }) => {
  await joinAs(page, 'report@example.test');
  await page.getByRole('button', { name: 'Report a problem' }).click();
  await page.getByLabel('What went wrong?').fill('A question about chlorophyll looked wrong to me.');
  await page.getByLabel(/Anything you want to show us/).fill('Which pigment absorbs light? (the key said "water")');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('This is exactly what will be sent')).toBeVisible();
  await expect(page.getByText('the key said "water"')).toBeVisible();
  await page.getByRole('button', { name: 'Send this' }).click();
  await expect(page.getByText(/Thank you/)).toBeVisible();
});
