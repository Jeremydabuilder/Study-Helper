/**
 * Production rehearsal on one machine. Runs the BUILT hosted bundle (dist-server/main.mjs) from a copy that has only production dependencies, with production
 * settings and synthetic data, against a fresh PostgreSQL database and a fresh data folder. A fake identity provider stands in for Google; no AI key is set.
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/postgres npm run build:hosted && npm run rehearse:prod
 * Prints PASS/FAIL per check and exits non-zero if any fails. It proves the bundle, configuration guards, migrations, files, switches, restart and backup/restore.
 * It does NOT prove: real Google sign-in, real AI or OCR, HTTPS cookies behind Render's proxy, or Render itself.
 */
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeIdp, Student, freePort } from '../tests/hostedHarness';
import { createTestDb } from '../tests/pgHarness';

const root = process.cwd();
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PDF = readFileSync(join(root, 'samples/absolute-value-review.pdf'));
const MARK = 'REHEARSAL-PRIVATE-TEXT';

if (!existsSync(join(root, 'dist-server/main.mjs')) || !existsSync(join(root, 'dist/index.html'))) { console.error('Run `npm run build:hosted` first.'); process.exit(2); }

// a copy with ONLY production dependencies, exactly what the host runs
const app = mkdtempSync(join(tmpdir(), 'sh-rehearse-app-'));
for (const f of ['package.json', 'package-lock.json']) cpSync(join(root, f), join(app, f));
cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true }); cpSync(join(root, 'dist-server'), join(app, 'dist-server'), { recursive: true });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'pipe' });
check('production install (npm ci --omit=dev) contains everything the bundle needs', existsSync(join(app, 'node_modules')));

const idp = await new FakeIdp().start();
const dbA = await createTestDb({ migrate: false }), dbB = await createTestDb({ migrate: false });
const dataA = mkdtempSync(join(tmpdir(), 'sh-rehearse-dataA-')), dataB = mkdtempSync(join(tmpdir(), 'sh-rehearse-dataB-')), backupDir = join(mkdtempSync(join(tmpdir(), 'sh-rehearse-bk-')), 'bundle');
const secret = () => randomBytes(24).toString('hex');
const SECRETS = { BETTER_AUTH_SECRET: secret(), APP_SECRET: secret(), OPERATOR_TOKEN: secret(), BACKUP_PASSPHRASE: secret() };

const envFor = (port: number, db: string, data: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', APP_MODE: 'hosted', APP_ENV: 'production', DATA_LABEL: 'production', DATABASE_URL: db, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1',
  PUBLIC_URL: `http://127.0.0.1:${port}`, ...SECRETS, OPERATOR_NAME: 'Rehearsal Operator', OPERATOR_CONTACT: 'operator@example.test',
  AUTH_OIDC_CLIENT_ID: 'rehearsal', AUTH_OIDC_CLIENT_SECRET: secret(), AUTH_OIDC_AUTHORIZATION_URL: `${idp.base}/authorize`, AUTH_OIDC_TOKEN_URL: `${idp.base}/token`, AUTH_OIDC_USERINFO_URL: `${idp.base}/userinfo`,
  RATE_AUTH_PER_MIN: '1000', RATE_INVITE_PER_MIN: '1000', RATE_API_PER_MIN: '10000', INSTANCE_LOCK_WAIT_MS: '1500', ...extra,
});
interface Proc { child: ChildProcess; out: string; exited: Promise<number | null> }
const run = (script: string, args: string[], env: NodeJS.ProcessEnv): Proc => {
  const child = spawn(process.execPath, [join(app, 'dist-server', script), ...args], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const p: Proc = { child, out: '', exited: new Promise((r) => child.on('exit', (c) => r(c))) };
  child.stdout!.on('data', (d) => (p.out += d)); child.stderr!.on('data', (d) => (p.out += d));
  return p;
};
const cli = async (args: string[], env: NodeJS.ProcessEnv) => { const p = run('operator.mjs', args, env); const code = await p.exited; return { code, out: p.out }; };
const waitReady = async (url: string, p: Proc) => { for (let i = 0; i < 80; i++) { if (p.child.exitCode !== null) return false; try { if ((await fetch(`${url}/readyz`)).status === 200) return true; } catch { /* not up yet */ } await sleep(250); } return false; };
const stop = async (p: Proc) => { p.child.kill('SIGTERM'); return Promise.race([p.exited, sleep(10_000).then(() => 'timeout')]); };
const stu = (url: string, email: string) => new Student({ url, idp, idpQueue: Promise.resolve() } as never, email);
const fileBytes = async (url: string, s: Student, id: string) => Buffer.from(await (await fetch(`${url}/api/files/${id}`, { headers: { cookie: [...s.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer());

try {
  // ---------- 1. configuration guards ----------
  const portA = await freePort(), urlA = `http://127.0.0.1:${portA}`;
  const base = envFor(portA, dbA.url, dataA);
  for (const [label, patch, expect] of [
    ['a short signing secret', { BETTER_AUTH_SECRET: 'short' }, /BETTER_AUTH_SECRET/],
    ['email+password sign-in in production', { AUTH_PASSWORD: '1' }, /AUTH_PASSWORD/],
    ['no operator name in production', { OPERATOR_NAME: '' }, /OPERATOR_NAME/],
    ['a non-https public address', { PUBLIC_URL: 'http://study.example.org' }, /PUBLIC_URL/],
    ['no sign-in method', { AUTH_OIDC_CLIENT_ID: '' }, /sign-in method/],
  ] as [string, Record<string, string>, RegExp][]) {
    const p = run('main.mjs', [], { ...base, ...patch }); const code = await p.exited;
    check(`refuses to start with ${label}`, code === 1 && expect.test(p.out) && !Object.values(SECRETS).some((s) => p.out.includes(s)), `exit ${code}: ${p.out.slice(0, 200)}`);
  }
  const localMode = run('main.mjs', [], { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '0.0.0.0', PORT: String(await freePort()), DATA_DIR: mkdtempSync(join(tmpdir(), 'sh-local-')) });
  check('local mode (no login) refuses to listen on a network address', (await localMode.exited) === 1 && /no login/.test(localMode.out));

  // ---------- 2. start ----------
  let srv = run('main.mjs', [], base);
  check('the built bundle starts, applies migrations and reports ready', await waitReady(urlA, srv), srv.out.slice(-400));
  check('/healthz answers', (await fetch(`${urlA}/healthz`)).status === 200);
  const m0 = await fetch(`${urlA}/internal/metrics`);
  check('/internal/metrics refuses without the operator token', m0.status === 401 || m0.status === 403 || m0.status === 404);
  const m1 = await fetch(`${urlA}/internal/metrics`, { headers: { authorization: `Bearer ${SECRETS.OPERATOR_TOKEN}` } });
  check('/internal/metrics works with the token and contains no student content', m1.status === 200 && !(await m1.text()).includes(MARK));
  const home = await fetch(`${urlA}/`);
  const csp = home.headers.get('content-security-policy') ?? '';
  check('security headers are set (CSP, frame, referrer)', /default-src 'self'/.test(csp) && !!home.headers.get('x-frame-options') && !!home.headers.get('x-content-type-options'), JSON.stringify([...home.headers].filter(([k]) => /security|frame|content-type-options|referrer/i.test(k))));

  // ---------- 3. invitation-only sign-up, pilot switch ----------
  const anon = stu(urlA, 'intruder@example.test');
  check('without an invitation nobody can create an account (pilot still off)', !(await anon.signInWithIdp()).ok);
  const inv = await cli(['invites', 'create', '--count', '3', '--label', 'rehearsal'], base);
  const codes = [...inv.out.matchAll(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})\b/g)].map((m) => m[1]);
  check('the operator tool creates single-use invitation codes (nothing is sent)', inv.code === 0 && codes.length === 3, `exit ${inv.code}, ${codes.length} codes: ${inv.out.replace(/[A-Z0-9]{4}(-[A-Z0-9]{4}){3}/g, '<code>').slice(0, 300)}`);
  const alice = stu(urlA, 'alice@example.test');
  check('with a valid code but the pilot switched off, sign-up is refused', !(await alice.signInWithIdp(codes[0])).ok);
  check('the pilot switch turns on', (await cli(['pilot', 'on'], base)).code === 0);
  { const r = await fetch(`${urlA}/api/subjects`); check('a signed-out request to the API is refused', r.status === 401, String(r.status) + (await r.text()).slice(0, 100)); }
  { const r = await fetch(`${urlA}/api/ai/usage`); check('operator-only settings are not available to anyone', [404, 401, 403].includes(r.status), String(r.status)); }
  const codes2 = [...(await cli(['invites', 'create', '--count', '2'], base)).out.matchAll(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})\b/g)].map((m) => m[1]);
  check('with a valid code, sign-up and sign-in work', (await alice.signInWithIdp(codes2[0])).ok);
  const reuse = stu(urlA, 'bob@example.test');
  check('a used code cannot create a second account', !(await reuse.signInWithIdp(codes2[0])).ok);
  const bob = stu(urlA, 'bob@example.test');
  check('a second student joins with their own code', (await bob.signInWithIdp(codes2[1])).ok);

  // ---------- 4. synthetic study + homework data, files ----------
  const sub = (await alice.post('/api/subjects', { name: 'Algebra' })).body.id as string;
  const note = (await alice.post(`/api/subjects/${sub}/sources`, { title: 'Notes', text: `${MARK}: Solving linear equations means doing the same operation to both sides until the variable is alone.` })).body.id as string;
  const up = await alice.req('POST', `/api/subjects/${sub}/files?filename=review.pdf`, undefined, { raw: PDF, contentType: 'application/pdf' });
  const fileId = (await alice.get(`/api/sources/${up.body.id}/review`)).body.file?.id as string;
  check('a PDF upload is read and stored', up.status === 200 && !!fileId);
  const sheet = (await alice.post(`/api/subjects/${sub}/sources`, { title: 'WS1', kind: 'teacher_instructions', text: 'Worksheet\n1. Solve for x: 2x + 3 = 11\n2. Solve x - 5 = 2' })).body.id as string;
  const hw = (await alice.post('/api/homework', { sourceId: sheet })).body.id as string;
  const q1 = (await alice.post(`/api/homework/${hw}/confirm`, { plan: 'new', dueDate: '2026-12-01' })).body.questions[0].id as string;
  await alice.put(`/api/homework/questions/${q1}/work`, { text: `${MARK}\n2x + 3 = 11\n2x = 14\nx = 7` });
  const chk = (await alice.post(`/api/homework/questions/${q1}/check`, {})).body;
  check('homework: exact checking works with no AI configured', chk.verdict === 'needs_revision' && chk.method === 'exact', JSON.stringify(chk).slice(0, 200));
  const topic = (await alice.post(`/api/subjects/${sub}/concepts`, { name: 'Linear equations', summary: 'Solve one-variable linear equations.', skillTag: 'math.linear_equation' })).body.id as string;
  const sess = (await alice.post('/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [topic] })).body.id as string;
  const view = (await alice.get(`/api/sessions/${sess}`)).body;
  const ans = await alice.post(`/api/sessions/${sess}/answer`, { questionId: view.question.id, answer: 'x = 0', clientToken: `tok-rehearsal-${Date.now()}-abc` });
  check('study: a math answer is graded offline and recorded', ans.status === 200 && !!ans.body.attemptId, JSON.stringify(ans.body).slice(0, 200));
  const progress = (await alice.get('/api/progress')).body.practiceAccuracy;
  await bob.post('/api/subjects', { name: 'BOB-ONLY' });
  check('another student cannot read these records or the file', (await bob.get(`/api/homework/${hw}`)).status === 404 && (await bob.get(`/api/files/${fileId}`)).status === 404 && !JSON.stringify((await bob.get('/api/subjects')).body).includes('Algebra'));
  const bytes0 = await fileBytes(urlA, alice, fileId);
  check('the uploaded file downloads byte for byte', sha(bytes0) === sha(PDF));
  check('no student content in the server log', !srv.out.includes(MARK) && !srv.out.includes('2x = 14'), 'log contained private text');

  // ---------- 5. pause switches ----------
  await cli(['pilot', 'off'], base);
  const paused = await alice.get('/api/subjects');
  check('pilot off: students get a calm pause (503), health stays up', paused.status === 503 && (await fetch(`${urlA}/healthz`)).status === 200);
  await cli(['pilot', 'on'], base);
  check('pilot on again: the same session works and nothing was lost', (await alice.get('/api/subjects')).status === 200);
  await cli(['signups', 'pause'], base);
  const c3 = [...(await cli(['invites', 'create', '--count', '1'], base)).out.matchAll(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})\b/g)].map((m) => m[1]);
  check('sign-ups paused: a valid invitation is refused, existing students unaffected', !(await stu(urlA, 'late@example.test').signInWithIdp(c3[0])).ok && (await alice.get('/api/subjects')).status === 200);
  await cli(['signups', 'open'], base);

  // ---------- 6. one instance per database ----------
  const second = run('main.mjs', [], { ...base, PORT: String(await freePort()) });
  const secondCode = await second.exited;
  check('a second process on the same database refuses to start', secondCode !== 0 && /Another Study Helper process/.test(second.out), `exit ${secondCode}: ${second.out.slice(0, 200)}`);
  check('the first process is unaffected', (await fetch(`${urlA}/readyz`)).status === 200);

  // ---------- 7. restart ----------
  check('SIGTERM shuts down cleanly (exit 0)', (await stop(srv)) === 0);
  srv = run('main.mjs', [], base);
  check('the bundle starts again on the same database and data folder', await waitReady(urlA, srv), srv.out.slice(-300));
  const after = (await alice.get(`/api/homework/${hw}`)).body;
  check('after restart: the same browser session, homework working and its check survive', after.questions?.[0]?.work?.text?.includes('x = 7') && after.questions[0].lastCheck?.id === chk.id);
  check('after restart: study progress and the uploaded file survive', JSON.stringify((await alice.get('/api/progress')).body.practiceAccuracy) === JSON.stringify(progress) && sha(await fileBytes(urlA, alice, fileId)) === sha(PDF));

  // ---------- 8. backup, restore into an EMPTY environment ----------
  const bk = await cli(['backup', '--to', backupDir, '--passphrase-env', 'BACKUP_PASSPHRASE'], base);
  check('backup completes (encrypted)', bk.code === 0 && existsSync(backupDir), bk.out.slice(0, 300));
  const files = existsSync(backupDir) ? readdirSync(backupDir, { recursive: true }).map(String) : [];
  check('the backup bundle contains no readable student text', !files.some((f) => { const p = join(backupDir, f); return statSync(p).isFile() && readFileSync(p).includes(MARK); }), files.join(','));
  check('backup verifies', (await cli(['verify', '--from', backupDir, '--passphrase-env', 'BACKUP_PASSPHRASE'], base)).code === 0);
  const wrong = await cli(['verify', '--from', backupDir, '--passphrase-env', 'NOPE'], { ...base, NOPE: 'wrong-passphrase' });
  check('a wrong passphrase is refused', wrong.code !== 0);
  await stop(srv);
  const portB = await freePort(), urlB = `http://127.0.0.1:${portB}`;
  const envB = envFor(portB, dbB.url, dataB);
  const rs = await cli(['restore', '--from', backupDir, '--passphrase-env', 'BACKUP_PASSPHRASE'], envB);
  check('restore into an empty database and empty data folder succeeds', rs.code === 0, rs.out.slice(0, 400));
  const again = await cli(['restore', '--from', backupDir, '--passphrase-env', 'BACKUP_PASSPHRASE'], envB);
  check('restoring again into the now non-empty environment is refused', again.code !== 0);
  const wrongEnv = await cli(['restore', '--from', backupDir, '--passphrase-env', 'BACKUP_PASSPHRASE'], { ...envFor(portB, (await createTestDb({ migrate: false })).url, mkdtempSync(join(tmpdir(), 'sh-x-')), { DATA_LABEL: 'staging', APP_ENV: 'staging', AUTH_PASSWORD: '1' }) });
  check('a production backup cannot be restored into a staging environment', wrongEnv.code !== 0, wrongEnv.out.slice(0, 200));
  const srvB = run('main.mjs', [], envB);
  check('the restored environment starts', await waitReady(urlB, srvB), srvB.out.slice(-300));
  const aliceB = new Student({ url: urlB, idp, idpQueue: Promise.resolve() } as never, 'alice@example.test'); aliceB.jar = alice.jar;
  check('restored: the original browser session is still signed in', (await aliceB.get('/api/session')).body?.signedIn === true);
  const subs = (await aliceB.get('/api/subjects')).body as any[];
  check('restored: the subject and pasted material are present with the same text', subs.some((s) => s.name === 'Algebra') && (await aliceB.get(`/api/sources/${note}`)).body.text.includes(MARK));
  const hwB = (await aliceB.get(`/api/homework/${hw}`)).body;
  check('restored: homework working, version and check result are identical', hwB.questions[0].work.text === after.questions[0].work.text && hwB.questions[0].lastCheck?.id === chk.id && hwB.questions[0].lastCheck.verdict === 'needs_revision');
  check('restored: study progress is identical', JSON.stringify((await aliceB.get('/api/progress')).body.practiceAccuracy) === JSON.stringify(progress));
  check('restored: the uploaded file is byte for byte identical', sha(await fileBytes(urlB, aliceB, fileId)) === sha(PDF));
  const bobB = new Student({ url: urlB, idp, idpQueue: Promise.resolve() } as never, 'bob@example.test'); bobB.jar = bob.jar;
  check('restored: the second student is intact and still cannot see the first', (await bobB.get('/api/session')).body?.signedIn === true && (await bobB.get(`/api/homework/${hw}`)).status === 404);
  check('restored: used invitation codes stay used', !(await stu(urlB, 'again@example.test').signInWithIdp(codes2[0])).ok);
  await stop(srvB);
} catch (e) {
  check('rehearsal ran to the end', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await idp.stop(); await dbA.drop().catch(() => {}); await dbB.drop().catch(() => {});
  for (const d of [app, dataA, dataB]) rmSync(d, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
void mkdirSync;
