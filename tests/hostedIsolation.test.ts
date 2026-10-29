/**
 * Student separation, attacked from the outside. Three synthetic students each create private data containing their own marker string.
 * Every other student then tries every route they can reach, with their own session and with the other students' real identifiers.
 * Nothing carrying another student's marker may ever appear in a response, no foreign record may change, and the files on disk must not mix.
 * (Mocked: identity provider, calendar provider, AI replies. Real: application code, PostgreSQL, authentication library, SQLite files.)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptJson } from '../src/server/crypto';
import { deriveUserSecret } from '../src/server/hosted/hosted';
import { FakeGoogle, HostedHarness, Student } from './hostedHarness';
import { PG_AVAILABLE } from './pgHarness';

const d = describe.skipIf(!PG_AVAILABLE);
const PDF = PG_AVAILABLE ? readFileSync(join(process.cwd(), 'samples/absolute-value-review.pdf')) : Buffer.alloc(0);
let h: HostedHarness; const google = new FakeGoogle();
interface Mine { s: Student; tag: string; subject: string; source: string; concept: string; session: string; attempt: string; memory: string; convo: string; reading: string; annotation: string; item: string; fileId: string | null; fileSource: string; email: string }
const mine: Record<string, Mine> = {};

async function seed(name: string): Promise<Mine> {
  const tag = name.toUpperCase();
  const s = await h.join(`${name}@example.test`);
  const subject = (await s.post('/api/subjects', { name: `${tag}-SUBJECT` })).body.id;
  const source = (await s.post(`/api/subjects/${subject}/sources`, { title: `${tag}-NOTES`, text: `${tag}-SECRET-TEXT. Photosynthesis lets plants turn light, water and carbon dioxide into glucose and oxygen. ${tag}-private-detail.` })).body.id;
  const concept = (await s.post(`/api/subjects/${subject}/concepts`, { name: `${tag}-CONCEPT`, summary: `${tag} concept about photosynthesis` })).body.id;
  await s.patch(`/api/concepts/${concept}`, { status: 'confirmed' });
  const sess = (await s.post('/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [concept] })).body;
  const view = (await s.get(`/api/sessions/${sess.id}`)).body;
  const ans = (await s.post(`/api/sessions/${sess.id}/answer`, { questionId: view.question.id, answer: `${tag}-MY-ANSWER glucose and oxygen`, clientToken: `tok-${tag}-0001-abcdef` })).body;
  const memory = (await s.post('/api/memory', { text: `${tag}-MEMORY I like worked examples` })).body.id;
  const convo = (await s.post('/api/conversations', { mode: 'general' })).body.id;
  await s.post(`/api/conversations/${convo}/messages`, { text: `${tag}-CHAT-MESSAGE hello` });
  const text = `${tag}-READING first sentence here. Second sentence about the sea.`;
  const reading = (await s.post('/api/readings', { subjectName: `${tag}-ENGLISH`, title: `${tag}-READING`, text })).body.id;
  const annotation = (await s.post(`/api/readings/${reading}/annotations`, { start: 0, end: 20, category: 'theme', note: `${tag}-ANNOTATION-NOTE` })).body.id;
  const item = (await s.post('/api/items', { type: 'homework', title: `${tag}-HOMEWORK`, subjectId: subject, dueDate: '2026-11-05' })).body.id;
  const up = await s.req('POST', `/api/subjects/${subject}/files?filename=${tag}.pdf`, undefined, { raw: PDF, contentType: 'application/pdf' });
  const fileSource = up.body?.id ?? up.body?.sourceId ?? '';
  const fileId: string | null = (await s.get(`/api/sources/${fileSource}/review`)).body?.file?.id ?? null;
  // calendar: connect through the hosted OAuth round trip with an OAuth code that is unique to this student
  const conn = (await s.post('/api/calendar/connect', {})).body;
  google.eventsFor.set(tag, [{ id: `ev-${tag}`, status: 'confirmed', summary: `${tag}-CALENDAR-EVENT test on Friday`, start: { dateTime: '2026-11-06T14:00:00Z' }, end: { dateTime: '2026-11-06T15:00:00Z' } } as never]);
  const cb = await s.get(`/api/calendar/oauth/callback?code=${tag}&state=${conn.state}`); expect(cb.headers.get('location')).toMatch(/connected=1/);
  await s.post('/api/calendar/sync', {});
  return { s, tag, subject, source, concept, session: sess.id, attempt: ans.attemptId, memory, convo, reading, annotation, item, fileId, fileSource, email: `${name}@example.test` };
}

beforeAll(async () => {
  if (!PG_AVAILABLE) return;
  h = await HostedHarness.start({ gateway: google });
  for (const n of ['alice', 'bob', 'cara']) mine[n] = await seed(n);
}, 120_000);
afterAll(async () => { await h?.stop(); });

const others = (n: string) => Object.keys(mine).filter((k) => k !== n);
const text = (r: { body: unknown }) => JSON.stringify(r.body);

d('three students: data created', () => {
  it('seeding really produced data for everybody (so "nothing leaked" is not just "nothing existed")', async () => {
    for (const m of Object.values(mine)) {
      expect(text(await m.s.get('/api/subjects'))).toContain(`${m.tag}-SUBJECT`);
      expect(text(await m.s.get('/api/memory'))).toContain(`${m.tag}-MEMORY`);
      expect(text(await m.s.get(`/api/conversations/${m.convo}`))).toContain(`${m.tag}-CHAT-MESSAGE`);
      expect(text(await m.s.get(`/api/readings/${m.reading}`))).toContain(`${m.tag}-ANNOTATION-NOTE`);
      expect(text(await m.s.get('/api/items'))).toContain(`${m.tag}-HOMEWORK`);
      expect(text(await m.s.get('/api/calendar'))).toContain(`Calendar of ${m.tag}`);
    }
  });
});

d('no response ever carries another student’s content', () => {
  const READS = ['/api/subjects', '/api/memory', '/api/today', '/api/history', '/api/progress', '/api/items', '/api/readings', '/api/conversations', '/api/schedule', '/api/calendar', '/api/profile', '/api/settings', '/api/meta', '/api/status', '/api/first-use', '/api/plan/override', '/api/sessions/active', '/api/account', '/api/chat/status', '/api/chat/context?mode=study&q=photosynthesis%20secret%20homework%20chat'];
  for (const viewer of ['alice', 'bob', 'cara']) {
    it(`${viewer} reads everything he or she can; nobody else's markers appear`, async () => {
      const me = mine[viewer];
      const foreign = others(viewer).map((o) => mine[o].tag);
      for (const p of READS) { const r = await me.s.get(p); for (const t of foreign) expect(text(r), `${viewer} GET ${p} leaked ${t}`).not.toContain(t); }
      for (const ws of ['real', 'demo'] as const) {
        const ex = await me.s.post('/api/export', { sections: ['profile', 'settings', 'memories', 'learning', 'items'], includeSourceText: true }, { ws });
        for (const t of foreign) expect(text(ex)).not.toContain(t);
      }
      const acct = await me.s.get('/api/account/export?files=1');
      expect(acct.status).toBe(200); for (const t of foreign) expect(text(acct)).not.toContain(t);
      expect(text(acct)).toContain(me.tag); // and it does contain their own
      const demo = await me.s.get('/api/subjects', { ws: 'demo' }); for (const t of mine ? foreign : []) expect(text(demo)).not.toContain(t);
    });
  }
});

d('tampered identifiers: another student’s real ids are "not found", and nothing changes', () => {
  it('bob and cara use alice’s ids on every route that takes an id', async () => {
    const a = mine.alice;
    const attacks: [string, string, unknown?][] = [
      ['GET', `/api/subjects/${a.subject}`], ['PATCH', `/api/subjects/${a.subject}`, { name: 'HACKED' }], ['DELETE', `/api/subjects/${a.subject}`],
      ['POST', `/api/subjects/${a.subject}/sources`, { title: 'x', text: 'planted text planted text planted text' }], ['POST', `/api/subjects/${a.subject}/concepts`, { name: 'planted' }],
      ['GET', `/api/sources/${a.source}`], ['GET', `/api/sources/${a.source}/review`], ['DELETE', `/api/sources/${a.source}`], ['POST', `/api/sources/${a.source}/extract`, {}], ['POST', `/api/sources/${a.source}/confirm`, {}],
      ['GET', `/api/files/${a.fileId}`], ['PATCH', `/api/concepts/${a.concept}`, { name: 'HACKED' }], ['DELETE', `/api/concepts/${a.concept}`],
      ['GET', `/api/sessions/${a.session}`], ['POST', `/api/sessions/${a.session}/answer`, { questionId: 'x', answer: 'y', clientToken: 'tok-evil-0001-abcdef' }], ['POST', `/api/sessions/${a.session}/finish`, {}], ['POST', `/api/sessions/${a.session}/abandon`, {}], ['POST', `/api/sessions/${a.session}/hint`, { questionId: 'x' }],
      ['POST', `/api/attempts/${a.attempt}/self-grade`, { correctness: 0 }], ['POST', `/api/attempts/${a.attempt}/clarify`, { text: 'tell me' }], ['POST', `/api/attempts/${a.attempt}/regrade`, {}], ['POST', `/api/attempts/${a.attempt}/report-unclear`, {}], ['POST', `/api/attempts/${a.attempt}/cause`, { cause: 'slip' }],
      ['PATCH', `/api/memory/${a.memory}`, { text: 'HACKED' }], ['POST', `/api/memory/${a.memory}/status`, { status: 'dismissed' }],
      ['GET', `/api/conversations/${a.convo}`], ['POST', `/api/conversations/${a.convo}/messages`, { text: 'hi' }], ['DELETE', `/api/conversations/${a.convo}`],
      ['GET', `/api/readings/${a.reading}`], ['POST', `/api/readings/${a.reading}/annotations`, { start: 0, end: 10 }], ['PATCH', `/api/readings/${a.reading}/annotations/${a.annotation}`, { note: 'HACKED' }], ['DELETE', `/api/readings/${a.reading}/annotations/${a.annotation}`],
      ['POST', `/api/readings/${a.reading}/annotations/${a.annotation}/feedback`, {}], ['POST', `/api/readings/${a.reading}/study`, { annotationIds: [a.annotation], kinds: ['flashcard'] }], ['POST', `/api/readings/${a.reading}/outlines`, { annotationIds: [a.annotation] }],
      ['PATCH', `/api/items/${a.item}`, { title: 'HACKED' }], ['DELETE', `/api/items/${a.item}`], ['POST', `/api/items/${a.item}/complete`, { done: true }],
    ];
    for (const who of ['bob', 'cara']) {
      for (const [m, p, b] of attacks) {
        const r = await mine[who].s.req(m, p, b);
        // deleting something that does not exist in your own account is a harmless no-op (200); everything else must be "not found" or refused
        expect(m === 'DELETE' ? [200, 404] : [404, 400, 409], `${who} ${m} ${p} -> ${r.status} ${text(r).slice(0, 120)}`).toContain(r.status);
        expect(text(r)).not.toContain('ALICE');
      }
    }
    // alice's records are exactly as she left them
    const af = mine.alice.s;
    expect(text(await af.get('/api/subjects'))).toContain('ALICE-SUBJECT'); expect(text(await af.get('/api/subjects'))).not.toContain('HACKED');
    expect(text(await af.get('/api/memory'))).toContain('ALICE-MEMORY'); expect(text(await af.get('/api/memory'))).not.toContain('HACKED');
    expect(text(await af.get(`/api/readings/${a.reading}`))).toContain('ALICE-ANNOTATION-NOTE');
    expect(text(await af.get(`/api/conversations/${a.convo}`))).toContain('ALICE-CHAT-MESSAGE');
    expect(text(await af.get('/api/items'))).toContain('ALICE-HOMEWORK'); expect(text(await af.get('/api/items'))).not.toContain('HACKED');
    expect((await af.get(`/api/sessions/${a.session}`)).status).toBe(200);
    expect((await af.get(`/api/sources/${a.source}`)).status).toBe(200);
  });

  it('path-like, oversized and injection-style identifiers are refused or not found', async () => {
    const b = mine.bob.s;
    for (const id of ['../../etc/passwd', '..%2f..%2fdata', "' OR 1=1 --", 'x'.repeat(5000), '%00', '*']) {
      for (const p of [`/api/subjects/${encodeURIComponent(id)}`, `/api/files/${encodeURIComponent(id)}`, `/api/sessions/${encodeURIComponent(id)}`, `/api/conversations/${encodeURIComponent(id)}`]) {
        const r = await b.get(p); expect([400, 404, 414], `${p} -> ${r.status}`).toContain(r.status);
      }
    }
  });

  it('a client-supplied user id is never trusted: extra identity fields in requests change nothing', async () => {
    const b = mine.bob.s;
    const r = await b.post('/api/subjects', { name: 'BOB-ODD', userId: mine.alice.email, user_id: 'alice', studentId: 'alice' }, { headers: { 'x-user-id': 'alice', 'x-forwarded-user': mine.alice.email, 'x-student': 'alice' } });
    expect(r.status).toBe(200);
    expect(text(await mine.alice.s.get('/api/subjects'))).not.toContain('BOB-ODD');
    expect(text(await b.get('/api/subjects'))).toContain('BOB-ODD');
    expect(text(await b.get('/api/meta'))).not.toContain('alice@');
  });
});

d('physical separation and the calendar', () => {
  it('each student has their own database files and no file contains another student’s content', async () => {
    const root = join(h.dir, 'users');
    const dirs = readdirSync(root); expect(dirs).toHaveLength(3);
    const blob = (dir: string) => Buffer.concat(readdirSync(join(root, dir)).map((f) => readFileSync(join(root, dir, f))));
    const idOf = async (email: string) => (await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id as string;
    for (const n of Object.keys(mine)) {
      const mineBytes = blob(await idOf(mine[n].email)).toString('latin1');
      expect(mineBytes).toContain(mine[n].tag);
      for (const o of others(n)) expect(mineBytes, `${n}'s files contain ${o}'s marker`).not.toContain(`${mine[o].tag}-SECRET-TEXT`);
    }
  });

  it('calendar connections are separate: tokens are encrypted per student, an old state cannot be replayed by another student, and events never cross', async () => {
    const aliceId = (await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['alice@example.test'])).rows[0].id as string;
    const bobId = (await h.db.pool.query('SELECT id FROM "user" WHERE email = $1', ['bob@example.test'])).rows[0].id as string;
    const lease = h.hosted.tenants.lease(aliceId, 'real');
    const enc = lease.db.get<any>('SELECT token_enc FROM cal_connection WHERE id = 1').token_enc as string; lease.release();
    expect(enc).not.toContain('rt-ALICE'); expect(enc.startsWith('v1.')).toBe(true);
    const master = 'c'.repeat(20) + 'D'.repeat(20);
    expect(decryptJson<{ refresh_token: string }>(enc, deriveUserSecret(master, aliceId)).refresh_token).toBe('rt-ALICE');
    expect(() => decryptJson(enc, deriveUserSecret(master, bobId))).toThrow(); // bob's key cannot open alice's tokens
    expect(() => decryptJson(enc, master)).toThrow(); // neither can the master secret directly
    // replaying alice's state through bob's session
    const bob = mine.bob.s, alice = mine.alice.s;
    const st = (await alice.post('/api/calendar/connect', {})).body.state;
    const replay = await bob.get(`/api/calendar/oauth/callback?code=BOB&state=${st}`);
    expect(replay.headers.get('location')).toMatch(/error=denied/);
    expect(text(await bob.get('/api/calendar'))).not.toContain('Calendar of ALICE');
    // events (assignments proposed from the calendar) stay with their owner
    for (const n of Object.keys(mine)) {
      const items = text(await mine[n].s.get('/api/items?status=proposed')) + text(await mine[n].s.get('/api/items'));
      for (const o of others(n)) expect(items).not.toContain(`${mine[o].tag}-CALENDAR-EVENT`);
    }
  });

  it('sample (demo) data is per student: resetting or changing one student’s sample leaves others untouched', async () => {
    const a = mine.alice.s, b = mine.bob.s;
    expect((await a.get('/api/subjects', { ws: 'demo' })).status).toBe(200);
    expect((await b.get('/api/subjects', { ws: 'demo' })).status).toBe(200);
    await a.post('/api/subjects', { name: 'ALICE-DEMO-ONLY' }, { ws: 'demo' });
    expect(text(await b.get('/api/subjects', { ws: 'demo' }))).not.toContain('ALICE-DEMO-ONLY');
    expect(text(await a.get('/api/subjects'))).not.toContain('ALICE-DEMO-ONLY'); // and it is not in her real data
    expect((await a.post('/api/demo/reset', {})).status).toBe(200);
    expect(text(await a.get('/api/subjects', { ws: 'demo' }))).not.toContain('ALICE-DEMO-ONLY');
    expect(text(await b.get('/api/subjects'))).toContain('BOB-SUBJECT'); // real data never touched by a demo reset
  }, 60_000);
});

d('private files', () => {
  it('an uploaded original can be downloaded by its owner only', async () => {
    const a = mine.alice;
    if (!a.fileId) throw new Error('upload seeding did not produce a file id (adjust the seeding helper)');
    const own = await a.s.req('GET', `/api/files/${a.fileId}`); expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe('no-store');
    for (const o of others('alice')) expect((await mine[o].s.get(`/api/files/${a.fileId}`)).status).toBe(404);
    expect((await h.student('nobody@example.test').get(`/api/files/${a.fileId}`)).status).toBe(401);
  });
});
