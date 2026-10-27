import { afterEach, describe, expect, it } from 'vitest';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });

describe('first-use checklist', () => {
  it('starts empty, never calls an offline run verified, and reports each step from recorded state', async () => {
    s = await startServer();
    const r = await s.call('GET', '/api/first-use');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.steps.map((x: any) => [x.id, x]));
    expect(by.ai.state).toBe('skipped');
    expect(by.ai_output.state).toBe('skipped');
    expect(r.body.liveVerified).toBe(false);
    expect(by.material.state).toBe('todo');
    expect(by.session.state).toBe('todo');
    expect(by.later.state).toBe('todo');
    expect(r.body.complete).toBe(false);
  });

  it('marks material done once added', async () => {
    s = await startServer();
    const sub = await s.call('POST', '/api/subjects', { name: 'Bio' });
    await s.call('POST', `/api/subjects/${sub.body.id}/sources`, { title: 'Notes', text: 'Photosynthesis turns light, water and carbon dioxide into glucose and oxygen.' });
    const r = await s.call('GET', '/api/first-use');
    expect(r.body.steps.find((x: any) => x.id === 'material').state).toBe('done');
  });
});
