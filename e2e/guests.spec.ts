import { control } from './support';
import { expect, test } from '@playwright/test';

test('guest enters without identity, keeps work on reload and cannot see a second guest workspace', async ({ page, browser }) => {
  await page.goto('/');
  // no code, no workspace: the button stays disabled, and a made-up code is refused
  await expect(page.getByRole('button', { name: 'Open my workspace' })).toBeDisabled();
  await page.getByLabel('Invitation code').fill('ABCD-EFGH-JKLM-NPQR');
  await page.getByRole('button', { name: 'Open my workspace' }).click();
  await expect(page.getByRole('alert')).toContainText(/not recognised/);
  const { codes } = await control('invites', { count: 2 });
  await page.getByLabel('Invitation code').fill(codes[0]);
  await page.getByRole('button', { name: 'Open my workspace' }).click();
  await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible();
  await expect(page.getByText(/Guest mode ·/)).toBeVisible();
  expect(page.url()).not.toContain(codes[0].slice(0, 4)); // the code is never left in the address
  // the same code cannot open a second workspace, even by calling the endpoint directly
  const reuse = await (await browser.newContext({ baseURL: new URL(page.url()).origin })).newPage();
  await reuse.goto('/');
  await reuse.getByLabel('Invitation code').fill(codes[0]);
  await reuse.getByRole('button', { name: 'Open my workspace' }).click();
  await expect(reuse.getByRole('alert')).toContainText(/already been used/);
  const direct = await reuse.request.post('/api/auth/sign-in/anonymous', { data: {} });
  expect(direct.status()).toBe(403);
  await reuse.context().close();
  const created = await page.request.post('/api/subjects', { data: { name: 'Guest-only biology' } });
  expect(created.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByText(/Guest mode ·/)).toBeVisible();
  expect(JSON.stringify(await (await page.request.get('/api/subjects')).json())).toContain('Guest-only biology');
  const second = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await second.newPage();
    await other.goto('/');
    await other.getByLabel('Invitation code').fill(codes[1]);
    await other.getByRole('button', { name: 'Open my workspace' }).click();
    await expect(other.getByRole('link', { name: 'Today' }).first()).toBeVisible();
    expect(JSON.stringify(await (await other.request.get('/api/subjects')).json())).not.toContain('Guest-only biology');
  } finally { await second.close(); }
});
