import { expect, Page, request } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 4181}`;
export async function control<T = any>(path: string, body: unknown = {}): Promise<T> {
  const ctx = await request.newContext(); const r = await ctx.post(`${CONTROL}/control/${path}`, { data: body }); const j = await r.json(); await ctx.dispose();
  if (!r.ok()) throw new Error(`control ${path}: ${JSON.stringify(j)}`); return j;
}
/** Collects problems a person would never see in a screenshot: page errors, failed requests, and policy (CSP) violations. */
export function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d|status of 503/.test(m.text())) problems.push(`console: ${m.text()}`); });
  return problems;
}
/** A new student, exactly like a classmate: invitation code → Continue with Google (fake identity provider). */
export async function joinAs(page: Page, email: string) {
  const { codes } = await control('invites', { count: 1 });
  await control('idp', { email });
  await page.goto('/#/join');
  await expect(page.getByRole('heading', { name: 'Join Study Helper' })).toBeVisible();
  await page.getByLabel('Invitation code').fill(codes[0]);
  await page.getByRole('button', { name: 'Check code' }).click();
  await expect(page.getByText('Code accepted')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible();
}
export async function signInAgain(page: Page, email: string) {
  await control('idp', { email });
  await page.goto('/#/join');
  await page.getByRole('button', { name: 'I already have an account' }).click();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('link', { name: 'Today' }).first()).toBeVisible();
}
export const NOTES = `--- Page 1 ---
Photosynthesis is the process plants use to turn light, water and carbon dioxide into glucose and oxygen.
Chlorophyll is the green pigment in chloroplasts that absorbs light energy.`;
