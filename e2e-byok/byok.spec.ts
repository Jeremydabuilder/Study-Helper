import { Browser, Page, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { control } from '../e2e/support';

const KEY = 'gsk_' + 'Visitor1234567890'.repeat(3);   // the stand-in Groq accepts exactly this key
const OTHER = 'gsk_' + 'Second7654321098'.repeat(3);   // a well-formed key the stand-in rejects
let n = 0;
async function visitor(browser: Browser) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.30.0.${++n}` }, acceptDownloads: true });
  const page = await ctx.newPage(); const urls: string[] = []; page.on('request', (r) => urls.push(r.url() + ' ' + JSON.stringify(r.headers()['x-groq-key'] ? 'has-key-header' : '')));
  return { ctx, page, urls };
}
const storageDump = (page: Page) => page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
const calls = () => control<{ calls: { url: string; last4: string; redirect: string }[]; siteAiCalls: number; logsHaveKey: boolean }>('byok-calls');
async function addKey(page: Page, key = KEY, o: { remember?: boolean } = {}) {
  await page.goto('/#/settings');
  await page.getByLabel('Groq API key').fill(key);
  if (o.remember) await page.getByLabel(/Remember on this device/).check();
  await page.getByRole('button', { name: 'Use key' }).click();
  await expect(page.getByText(/Assistant: .*Your Groq key/)).toBeVisible();
}
const seedAssignment = async (page: Page) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByLabel('Assignment title').fill('Algebra worksheet'); await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your plan for today' })).toBeVisible();
};

test('before any key: manual planning and study tools work, AI actions point to Settings, and typed work survives a trip there', async ({ browser }) => {
  const { ctx, page } = await visitor(browser);
  await seedAssignment(page);                                                              // manual planning, no AI, no key
  await page.goto('/#/help');
  await expect(page.getByText(/A hint needs an AI assistant/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get a hint' })).toBeDisabled();
  await page.getByLabel('The question or instructions').fill('Solve 2x + 3 = 11'); await page.getByLabel(/Your attempt/).fill('x = 7');
  await page.getByRole('link', { name: 'Add your own Groq key in Settings' }).first().click();
  await expect(page).toHaveURL(/#\/settings/);
  await page.goto('/#/help');                                                              // back again: the draft is still there
  await expect(page.getByLabel('The question or instructions')).toHaveValue('Solve 2x + 3 = 11'); await expect(page.getByLabel(/Your attempt/)).toHaveValue('x = 7');
  await page.getByRole('button', { name: 'No assistant: steps to try' }).click(); await expect(page.getByText('Not from the assistant: general steps')).toBeVisible();
  await page.goto('/#/chat'); await expect(page.getByText(/Chat needs an AI assistant/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.goto('/#/practice'); await expect(page.getByText(/No notes saved/)).toBeVisible();
  await page.goto('/#/review'); await expect(page.getByText(/Nothing is due/)).toBeVisible();
  expect((await calls()).calls).toHaveLength(0);                                           // nothing was sent anywhere
  await ctx.close();
});

test('Settings: masked field with show/hide, local format check, and every Test connection outcome; no repeated clicks while testing', async ({ browser }) => {
  const { ctx, page } = await visitor(browser); await control('byok-mode', { mode: 'ok' });
  await page.goto('/#/settings');
  const field = page.getByLabel('Groq API key');
  await expect(field).toHaveAttribute('type', 'password'); await expect(page.getByText(/use <strong>your<\/strong>|AI requests use your Groq account/i).or(page.getByText(/AI requests use/))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Use key' })).toBeDisabled();
  await field.fill('not a key'); await expect(page.getByText(/does not look like a Groq key/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Use key' })).toBeDisabled();
  await field.fill(KEY); await page.getByRole('button', { name: 'Show key' }).click(); await expect(field).toHaveAttribute('type', 'text'); await page.getByRole('button', { name: 'Hide key' }).click(); await expect(field).toHaveAttribute('type', 'password');
  await expect(page.getByLabel(/Remember on this device/)).not.toBeChecked();
  // success
  await page.getByRole('button', { name: 'Test connection' }).click(); await expect(page.getByText(/Connected\. Your key works/)).toBeVisible();
  const first = await calls(); expect(first.calls).toHaveLength(1); expect(first.calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions'); expect(first.calls[0].redirect).toBe('error');
  // each failure, in plain words
  for (const [mode, heading, text] of [['invalid_key', 'Invalid key', /did not accept this key/], ['model', 'Model unavailable', /model is not available/], ['rate', 'Rate limit', /usage limit/], ['network', 'Network error', /Could not reach Groq/], ['forbidden', 'Access refused', /refused this key/], ['server', 'Groq problem', /temporary problem/]] as const) {
    await control('byok-mode', { mode });
    const btn = page.getByRole('button', { name: /Test connection|Try again in/ }); await expect(btn).toBeEnabled({ timeout: 12_000 }); await btn.click();
    await expect(page.getByRole('alert').filter({ hasText: heading })).toBeVisible(); await expect(page.getByRole('alert')).toContainText(text);
  }
  // no repeated clicks: the button is disabled while a test is running, and a double click makes one request
  await control('byok-mode', { mode: 'ok', delayMs: 1200 }); const before = (await calls()).calls.length;
  await page.getByRole('button', { name: /Test connection|Try again in/ }).waitFor(); await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Test connection' }).dblclick(); await expect(page.getByRole('button', { name: 'Testing…' })).toBeDisabled();
  await expect(page.getByText(/Connected\. Your key works/)).toBeVisible(); expect((await calls()).calls.length).toBe(before + 1);
  await control('byok-mode', { mode: 'ok', delayMs: 0 });
  // testing does not activate the key: that is "Use key"
  await expect(page.getByText(/Assistant: .*No assistant set up/)).toBeVisible();
  await ctx.close();
});

test('the key stays in memory by default (gone after reload); the visitor’s key is used for hints, chat and notes; failures keep drafts; the site’s key is never used', async ({ browser }) => {
  const { ctx, page, urls } = await visitor(browser); await control('byok-mode', { mode: 'ok' });
  await seedAssignment(page); await addKey(page);
  await expect(page.getByText(/memory only, this tab/)).toBeVisible();
  const dump = await storageDump(page); expect(dump).not.toContain(KEY.slice(4, 24));
  // hint with the visitor's key
  await page.goto('/#/help'); await page.getByLabel('The question or instructions').fill('Solve 2x + 3 = 11'); await page.getByRole('button', { name: 'Get a hint' }).click();
  await expect(page.getByText(/Hint from the assistant/)).toBeVisible(); await expect(page.getByText(/visitor’s own key/)).toBeVisible();
  // failure: draft kept, link to Settings, never the site's key
  await control('byok-mode', { mode: 'invalid_key' }); await page.getByLabel(/Your attempt/).fill('x = 7'); await page.getByRole('button', { name: 'Get a hint' }).click();
  await expect(page.getByRole('alert')).toContainText(/did not accept this key/i); await expect(page.getByRole('alert').getByRole('link', { name: 'Open Settings' })).toBeVisible();
  await expect(page.getByLabel('The question or instructions')).toHaveValue('Solve 2x + 3 = 11'); await expect(page.getByLabel(/Your attempt/)).toHaveValue('x = 7');
  await control('byok-mode', { mode: 'rate' }); await page.getByRole('button', { name: 'Get a hint' }).click(); await expect(page.getByRole('alert')).toContainText(/usage limit/); await expect(page.getByLabel(/Your attempt/)).toHaveValue('x = 7');
  // chat: the message stays in the box on failure and clears on success
  await page.goto('/#/chat'); await page.getByLabel('Your message').fill('What is a derivative?'); await control('byok-mode', { mode: 'network' });
  await page.getByRole('button', { name: 'Send' }).click(); await expect(page.getByRole('alert')).toContainText(/Could not reach Groq/); await expect(page.getByLabel('Your message')).toHaveValue('What is a derivative?');
  await control('byok-mode', { mode: 'ok' }); await page.getByRole('button', { name: 'Send' }).click(); await expect(page.getByText('Chat reply from the visitor’s own key.')).toBeVisible(); await expect(page.getByLabel('Your message')).toHaveValue('');
  // onboarding analysis
  await page.goto('/#/build/paste'); await page.getByLabel(/Paste anything/).fill('Math worksheet 4 due Friday\nBiology test Nov 12'); await expect(page.getByLabel(/This browser and the assistant/)).toBeEnabled();
  await page.getByLabel(/This browser and the assistant/).check(); await page.getByRole('button', { name: 'Find items with the assistant' }).click(); await expect(page.getByRole('heading', { name: 'Check what was found' })).toBeVisible();
  await expect(page.getByLabel('Save: Cell quiz')).not.toBeChecked();
  const c = await calls(); expect(c.siteAiCalls).toBe(0); expect(c.logsHaveKey).toBe(false); expect(c.calls.every((x) => x.url === 'https://api.groq.com/openai/v1/chat/completions' && x.last4 === KEY.slice(-4))).toBe(true);
  expect(urls.join('\n')).not.toContain(KEY);                                                                   // never in an address
  expect(await storageDump(page)).not.toContain(KEY.slice(4, 24));
  // reload: memory is cleared, so the key is gone and AI is off again
  await page.reload(); await page.goto('/#/settings'); await expect(page.getByText(/Assistant: .*No assistant set up/)).toBeVisible();
  await page.goto('/#/help'); await expect(page.getByLabel('The question or instructions')).toHaveValue('Solve 2x + 3 = 11'); // the typed draft survived the reload
  await ctx.close();
});

test('Remember on this device is optional and explained; Remove key clears memory and storage; exports and the profile never contain the key', async ({ browser }) => {
  const { ctx, page } = await visitor(browser); await control('byok-mode', { mode: 'ok' });
  await page.goto('/#/settings'); await expect(page.getByText(/Anyone who can use this browser profile can read it, and so can any script running on this site’s address/)).toBeVisible();
  await seedAssignment(page); await addKey(page, KEY, { remember: true });
  await expect(page.getByText(/remembered on this device/).first()).toBeVisible();
  const saved = await storageDump(page); expect(saved).toContain(KEY);                                           // remembered: it IS in localStorage, under one known name
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => localStorage.getItem(k)!.includes('Visitor1234567890')))).toEqual(['sh.guest.groqkey.v1']);
  expect(await page.evaluate(() => localStorage.getItem('sh.guest.profile.v1'))).not.toContain('Visitor1234567890');   // not in the study profile
  await page.reload(); await page.goto('/#/settings'); await expect(page.getByText(/Assistant: .*Your Groq key/)).toBeVisible();   // survives a reload
  // export: no credentials
  await page.goto('/#/memory'); const dl = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export a copy' }).click();
  const file = test.info().outputPath('profile.json'); await (await dl).saveAs(file); const text = readFileSync(file, 'utf8'); expect(text).not.toContain('Visitor1234567890'); expect(text).not.toMatch(/gsk_|groq/i);
  // importing a file with a planted credential field drops it
  const planted = JSON.parse(text); planted.profile.groqKey = KEY; planted.profile.preferences.apiKey = KEY; planted.apiKey = KEY;
  const pf = test.info().outputPath('planted.json'); (await import('node:fs')).writeFileSync(pf, JSON.stringify(planted)); page.once('dialog', (d) => d.accept()); await page.getByLabel('Import a profile file').setInputFiles(pf);
  await expect(page.getByText('Imported.')).toBeVisible(); expect(await page.evaluate(() => localStorage.getItem('sh.guest.profile.v1'))).not.toContain('Visitor1234567890');
  // remove: everywhere
  await page.goto('/#/settings'); await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByText(/removed from this browser: from memory and from storage/i)).toBeVisible(); await expect(page.getByText(/Assistant: .*No assistant set up/)).toBeVisible();
  expect(await storageDump(page)).not.toContain('Visitor1234567890'); expect(await page.evaluate(() => localStorage.getItem('sh.guest.groqkey.v1'))).toBeNull();
  await page.reload(); await page.goto('/#/settings'); await expect(page.getByText(/Assistant: .*No assistant set up/)).toBeVisible();
  await page.goto('/#/help'); await expect(page.getByRole('button', { name: 'Get a hint' })).toBeDisabled();
  // and "Clear everything" removes a remembered key too
  await addKey(page, KEY, { remember: true }); await page.goto('/#/memory'); await page.getByRole('button', { name: 'Clear everything…' }).click(); await page.getByRole('button', { name: 'Yes, erase it' }).click();
  expect(await storageDump(page)).not.toContain('Visitor1234567890');
  await ctx.close();
});

test('visitors are isolated: one visitor’s key never serves another, and a key header opens nothing private', async ({ browser, request }) => {
  const a = await visitor(browser), b = await visitor(browser); await control('byok-mode', { mode: 'ok' });
  const base = (await calls()).calls.length; await addKey(a.page);
  await b.page.goto('/#/help'); await expect(b.page.getByRole('button', { name: 'Get a hint' })).toBeDisabled();       // B has no key, and A's is not shared
  await b.page.goto('/#/settings'); await expect(b.page.getByText(/Assistant: .*No assistant set up/)).toBeVisible();
  const r = await b.page.request.post('/api/public/hint', { data: { question: 'Solve 2x+3=11' } }); expect(r.status()).toBe(503); expect((await r.json()).error.code).toBe('ai_setup_needed');
  expect((await calls()).calls.length).toBe(base);                                                                 // B's attempts reached Groq zero times
  // a key header does not unlock anything else
  for (const p of ['/api/items', '/api/memory', '/api/myhelper/state', '/api/account/export']) expect((await request.get(p, { headers: { 'x-groq-key': KEY } })).status(), p).toBe(401);
  await a.ctx.close(); await b.ctx.close();
});
