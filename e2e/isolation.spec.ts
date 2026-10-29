import { expect, test } from '@playwright/test';
import { NOTES, joinAs } from './support';

test('two classmates in separate browsers: each sees only their own work, and typing the other’s links or ids shows nothing', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage(), b = await (await browser.newContext()).newPage();
  await joinAs(a, 'alice@example.test'); await joinAs(b, 'bob@example.test');
  const mk = async (p: typeof a, name: string, secret: string) => {
    const subject = (await (await p.request.post('/api/subjects', { data: { name } })).json()).id as string;
    await p.request.post(`/api/subjects/${subject}/sources`, { data: { title: `${name} notes`, text: `${secret} ${NOTES}` } });
    const c = (await (await p.request.post(`/api/subjects/${subject}/concepts`, { data: { name: `${name} concept`, summary: secret } })).json()).id as string;
    await p.request.patch(`/api/concepts/${c}`, { data: { status: 'confirmed' } });
    const sess = (await (await p.request.post('/api/sessions', { data: { mode: 'practice', minutes: 10, conceptIds: [c] } })).json()).id as string;
    return { subject, sess };
  };
  const A = await mk(a, 'ALICE-SUBJECT', 'ALICE-SECRET-SENTENCE'); const B = await mk(b, 'BOB-SUBJECT', 'BOB-SECRET-SENTENCE');
  await a.goto('/#/subjects'); await b.goto('/#/subjects');
  await expect(a.getByText('ALICE-SUBJECT')).toBeVisible(); await expect(b.getByText('BOB-SUBJECT')).toBeVisible();
  expect(await a.locator('body').innerText()).not.toContain('BOB'); expect(await b.locator('body').innerText()).not.toContain('ALICE');
  // bob follows alice's links
  for (const url of [`/#/subjects/${A.subject}`, `/#/study/${A.sess}`]) {
    await b.goto(url); await b.waitForTimeout(600);
    const text = await b.locator('body').innerText();
    expect(text, url).not.toContain('ALICE'); expect(text, url).toMatch(/not found|didn’t work|ended|Session ended|try again/i);
  }
  // and the API agrees
  expect((await b.request.get(`/api/subjects/${A.subject}`)).status()).toBe(404);
  expect((await b.request.get(`/api/sessions/${A.sess}`)).status()).toBe(404);
  // signing out one does not sign out the other
  await a.getByRole('button', { name: 'Sign out' }).click();
  await expect(a.getByRole('heading', { name: 'Join Study Helper' })).toBeVisible();
  expect((await b.request.get('/api/subjects')).status()).toBe(200);
  void B;
});
