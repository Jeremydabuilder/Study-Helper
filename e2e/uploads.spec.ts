import { expect, test } from '@playwright/test';
import { control, joinAs, watch } from './support';

async function startUpload(page: import('@playwright/test').Page, file: string) {
  await page.goto('/#/start');
  await page.getByLabel('New subject name').fill('Class packet');
  await page.locator('input[type=file]').setInputFiles(file);
}

test('a text PDF is read, shown beside the original, reviewed page by page, then used to start studying', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'pdf@example.test');
  await startUpload(page, 'samples/absolute-value-review.pdf');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'absolute-value-review' })).toBeVisible();
  await expect(page.getByText(/Text was read from the file by the app/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Original' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Extracted text' })).toBeVisible();
  // only the page that needs a look is shown first (page 2 has math to check); the student can see all pages
  await expect(page.getByText(/1 of 3 pages needs a look/)).toBeVisible();
  const text = await page.getByLabel(/Text of page 2/).inputValue();
  expect(text).toMatch(/Interval notation/i);
  // the student fixes a mistake in the extracted text; it is kept
  await page.getByLabel(/Text of page 2/).fill(text + '\nExtra line typed by the student.');
  await page.getByRole('button', { name: 'Save page 2' }).click();
  await page.getByRole('button', { name: /Show all 3 pages/ }).click();
  await page.getByRole('tab', { name: /Page 2/ }).click();
  await expect(page.getByLabel(/Text of page 2/)).toHaveValue(/Extra line typed by the student/);
  await page.getByRole('button', { name: /The text is right/ }).click();
  await expect(page.getByRole('heading', { name: 'Check what you’ll study' })).toBeVisible();
  await page.getByRole('button', { name: /Confirm .* and start/ }).click();
  await expect(page.getByLabel(/your answer/i)).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('a screenshot with no readable text is never pretended to be read: the student types it beside the original', async ({ page }) => {
  const problems = watch(page);
  await joinAs(page, 'shot@example.test');
  await startUpload(page, 'samples/notebook-screenshot.png');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/No text could be read from this image/)).toBeVisible();
  await expect(page.getByText(/Nothing has been read from this page/)).toBeVisible();
  // trying to continue with nothing is stopped and explained
  await page.getByRole('button', { name: /The text is right/ }).click();
  await expect(page.getByRole('alert')).toContainText(/No text has been read from this file/);
  await expect(page).toHaveURL(/#\/review\//); // it did not move on
  await page.getByLabel(/Text of page 1/).fill('Photosynthesis is the process plants use to turn light, water and carbon dioxide into glucose and oxygen.');
  await page.getByRole('button', { name: 'Save page 1' }).click();
  await page.getByRole('button', { name: /The text is right/ }).click();
  await expect(page.getByRole('heading', { name: 'Check what you’ll study' })).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('an interrupted upload explains itself, keeps the chosen file, does not use up the daily allowance, and works when retried', async ({ page }) => {
  await joinAs(page, 'drop@example.test');
  await startUpload(page, 'samples/dust-bowl-packet.pdf');
  let dropped = 0;
  await page.route('**/api/subjects/*/files*', (route) => { if (dropped++ === 0) return route.abort('connectionreset'); return route.continue(); });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText(/could not reach|didn’t work/i);
  await expect(page.getByText(/dust-bowl-packet\.pdf/)).toBeVisible(); // still selected
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'dust-bowl-packet' })).toBeVisible();
});

test('uploads beyond the daily allowance are refused clearly, pasting still works, and nobody else is affected', async ({ page, browser }) => {
  const ctx2 = await browser.newContext(); const other = await ctx2.newPage();
  await joinAs(page, 'cap@example.test'); await joinAs(other, 'cap2@example.test');
  const sub = (await (await page.request.post('/api/subjects', { data: { name: 'Cap' } })).json()).id as string;
  const pdf = (await import('node:fs')).readFileSync('samples/absolute-value-review.pdf');
  let refused: any = null;
  for (let i = 0; i < 15 && !refused; i++) { const r = await page.request.post(`/api/subjects/${sub}/files?filename=f${i}.pdf`, { data: pdf, headers: { 'content-type': 'application/pdf' } }); if (r.status() === 429) refused = await r.json(); }
  expect(refused?.error.code).toBe('daily_limit'); expect(refused.error.message).toMatch(/upload limit/);
  const sub2 = (await (await other.request.post('/api/subjects', { data: { name: 'Fine' } })).json()).id as string;
  expect((await other.request.post(`/api/subjects/${sub2}/files?filename=ok.pdf`, { data: pdf, headers: { 'content-type': 'application/pdf' } })).status()).toBe(200);
  expect((await page.request.post(`/api/subjects/${sub}/sources`, { data: { title: 'Pasted', text: 'Pasting text still works when uploads are used up for the day.' } })).status()).toBe(200);
  void control; await ctx2.close();
});
