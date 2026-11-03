import { expect, Page, test } from '@playwright/test';
import { resolve } from 'node:path';
import { control } from '../e2e/support';

const OWNER = { email: 'owner@example.test', password: 'correct horse battery staple' };
const LEGACY = 'file://' + resolve('legacy/my-helper-with-export.html');
const SHEET = 'Algebra worksheet 4\n1. Solve for x: 2x + 3 = 11\n2. Solve for y: 5y - 4 = 21';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Study Helper' })).toBeVisible();
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test('a signed-out visitor sees only the sign-in, and the server refuses private data and AI routes', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(/Join Study Helper|Invitation|guest/i)).toHaveCount(0);
  for (const p of ['/api/myhelper/state', '/api/items', '/api/memory', '/api/homework', '/api/conversations', '/api/account/export']) expect((await request.get(p)).status(), p).toBe(401);
  expect((await request.post('/api/conversations/x/messages', { data: { text: 'hi' } })).status()).toBe(401);
  expect((await request.post('/api/auth/sign-in/anonymous', { data: {} })).status()).toBeGreaterThanOrEqual(400);
  expect((await request.post('/api/auth/sign-up/email', { data: { email: 'x@example.test', password: 'a long enough password', name: 'x' } })).status()).toBeGreaterThanOrEqual(400);
  await page.getByLabel('Email').fill(OWNER.email); await page.getByLabel('Password').fill('wrong wrong wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('did not match');
});

test('owner sees Today / School / Projects / Study Helper (no AI Helpers tab) and School → Open in Study Helper carries the instructions, one copy', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Jeremy/ })).toBeVisible();
  for (const n of ['Today', 'School', 'Projects', 'Study Helper']) await expect(nav(page).getByRole('link', { name: n })).toBeVisible();
  await expect(page.getByText('AI Helpers')).toHaveCount(0);

  await nav(page).getByRole('link', { name: 'School' }).click();
  await page.getByRole('button', { name: 'Add with instructions…' }).click();
  await page.getByLabel('Title').fill('Algebra worksheet 4');
  await page.getByLabel('Instructions / questions').fill(SHEET);
  await page.getByRole('button', { name: 'Save & open in Study Helper' }).click();
  await expect(page).toHaveURL(/#\/homework\//);
  await expect(page.getByText('Solve for x: 2x + 3 = 11').first()).toBeVisible();

  await nav(page).getByRole('link', { name: 'School' }).click();
  await expect(page.getByText('Algebra worksheet 4')).toHaveCount(1);        // one copy
  await expect(page.getByText('In Study Helper', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue in Study Helper' }).click();
  await expect(page).toHaveURL(/#\/homework\//);
  await nav(page).getByRole('link', { name: 'School' }).click();
  await expect(page.getByText('Algebra worksheet 4')).toHaveCount(1);        // still one copy, and no second homework
  await page.goto('/#/homework');
  await expect(page.getByText('Algebra worksheet 4')).toHaveCount(1);

  // an assignment without instructions asks for them instead of opening an empty workspace
  await nav(page).getByRole('link', { name: 'School' }).click();
  await page.getByLabel('New assignment').fill('Read chapter 3'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Open in Study Helper' }).click();
  await expect(page.getByText(/no instructions yet|Paste them/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('Study Helper pages open inside the My Helper frame without errors (review, settings, chat, progress, memory, homework)', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  for (const p of ['/review', '/settings', '/chat', '/progress', '/memory', '/homework', '/subjects', '/plan', '/start']) {
    await page.goto(`/#${p}`);
    await expect(page.locator('#mh-main h1, #mh-main h2').first()).toBeVisible();
    await expect(nav(page)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('the Study Helper tab links live actions and labels the prompt templates', async ({ page }) => {
  await signIn(page);
  await nav(page).getByRole('link', { name: 'Study Helper' }).click();
  await expect(page.getByRole('heading', { name: 'Study Helper', level: 2 })).toBeVisible();
  for (const t of ['Work on an assignment', 'Check my draft', 'Make a quiz from my notes', 'Review what I’ve learned']) await expect(page.getByText(t)).toBeVisible();
  await expect(page.getByText('Template — not AI')).toHaveCount(2);
  await page.getByLabel('What do you need to finish?').fill('lab report');
  await page.getByRole('button', { name: 'Write the prompt' }).first().click();
  await expect(page.locator('pre.mh-pre')).toContainText('lab report');
});

test('export from the original page → preview → import → safe to repeat → survives reload, restart and a second device', async ({ browser, page }) => {
  // 1. the original HTML, with data in its localStorage, exports a file
  const old = await browser.newContext({ acceptDownloads: true }); const op = await old.newPage();
  await op.goto(LEGACY);
  await op.evaluate(() => localStorage.setItem('myHelperState', JSON.stringify({
    tasks: [{ id: 1761000000001, title: 'Finish essay outline', category: 'School', due: 'Tomorrow', done: false }, { id: 1761000000002, title: 'Call grandma', category: 'Personal', due: 'Today', done: false }, { id: 1761000000003, title: 'Sand the shelf', category: 'Project', due: 'This week', done: true }],
    projects: [{ id: 1761000000010, name: 'Bookshelf', desc: 'Build a shelf', stage: 3, notes: 'Pine wood', nextAction: 'Buy screws' }],
    memory: [{ id: 1761000000020, text: 'I focus best in 20-minute blocks', pinned: true }],
  })));
  await op.reload();
  const dl = op.waitForEvent('download');
  await op.getByRole('button', { name: /Export my data/ }).first().click();
  const file = test.info().outputPath('my-helper-export.json'); await (await dl).saveAs(file);
  await old.close();

  // 2. sign in, preview shows what would happen and writes nothing
  await signIn(page);
  await page.goto('/#/import');
  await page.getByLabel('my-helper-export.json').setInputFiles(file);
  await expect(page.getByText('Preview — nothing has been saved yet')).toBeVisible();
  await page.goto('/#/school'); await expect(page.getByText('Finish essay outline')).toHaveCount(0);   // nothing saved by the preview
  await page.goto('/#/import'); await page.getByLabel('my-helper-export.json').setInputFiles(file);
  await page.getByRole('button', { name: /^Import \d+ new/ }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();

  const check = async (p: Page) => {
    await p.goto('/#/school'); await expect(p.getByText('Finish essay outline')).toHaveCount(1);
    await p.goto('/#/projects'); await expect(p.getByText('Bookshelf')).toHaveCount(1);
    await p.goto('/#/'); await expect(p.getByText('Call grandma')).toHaveCount(1);
  };
  await check(page);

  // 3. importing again changes nothing
  await page.goto('/#/import'); await page.getByLabel('my-helper-export.json').setInputFiles(file);
  await expect(page.getByText('Everything in this file is already here')).toBeVisible();
  await check(page);

  // 4. reload
  await page.reload(); await check(page);

  // 5. server restart (same database, same data folder)
  await control('restart');
  await page.goto('/'); await expect(page.getByRole('heading', { name: /Good .*Jeremy/ })).toBeVisible({ timeout: 20_000 });
  await check(page);

  // 6. a second browser (another device) signs in and sees the same data
  const other = await browser.newContext(); const p2 = await other.newPage();
  await signIn(p2); await check(p2);
  await other.close();
});
