import { afterEach, describe, expect, it } from 'vitest';
import { startServer, TestServer } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });
const INSTR = 'Worksheet 4\n1. Solve for x: 2x + 3 = 11\n2. Solve x - 5 = 2\nShow your work.';
const items = async () => (await s.call('GET', '/api/items')).body as any[];

describe('My Helper tasks and School', () => {
  it('keeps one copy of an assignment: School tasks ARE Study Helper assignments, other tasks live in My Helper', async () => {
    s = await startServer();
    const a = (await s.call('POST', '/api/myhelper/tasks', { title: 'Finish history outline', category: 'School', when: 'Tomorrow' })).body;
    const b = (await s.call('POST', '/api/myhelper/tasks', { title: 'Pack tennis bag', category: 'Personal', when: 'Today' })).body;
    expect(a.kind).toBe('assignment'); expect(b.kind).toBe('task');
    const st = (await s.call('GET', '/api/myhelper/state')).body;
    expect(st.assignments.map((x: any) => x.title)).toEqual(['Finish history outline']); expect(st.tasks.map((x: any) => x.title)).toEqual(['Pack tennis bag']);
    expect((await items()).filter((i) => i.title === 'Finish history outline')).toHaveLength(1);
    expect(st.assignments[0].dueDate).toBe('2026-10-27');                       // Tomorrow = a real date (clock is Mon 26 Oct)
    expect(st.tasks[0].dueDate).toBe('2026-10-26');
    const week = (await s.call('POST', '/api/myhelper/tasks', { title: 'Read chapter', category: 'School', when: 'This week' })).body;
    expect((await items()).find((i) => i.id === week.id)).toMatchObject({ dueKind: 'unknown' });   // "this week" is not turned into an invented deadline
    expect((await s.call('POST', `/api/myhelper/tasks/${b.id}/done`, { done: true })).status).toBe(200);
    expect((await s.call('GET', '/api/myhelper/state')).body.tasks[0].done).toBe(true);
    expect((await s.call('POST', '/api/myhelper/tasks', { title: '  ', category: 'School', when: 'Today' })).status).toBe(400);
    expect((await s.call('POST', '/api/myhelper/tasks', { title: 'x', category: 'Nope', when: 'Today' })).status).toBe(400);
  });
  it('projects: create, edit, advance through the five stages, restart after Share, delete', async () => {
    s = await startServer();
    const p = (await s.call('POST', '/api/myhelper/projects', { name: 'Science fair', description: 'Plants and light' })).body.id;
    for (let i = 0; i < 4; i++) await s.call('PATCH', `/api/myhelper/projects/${p}`, { advance: true });
    expect((await s.call('PATCH', `/api/myhelper/projects/${p}`, { notes: 'Ask Mr. K', nextAction: 'Buy seeds' })).body).toMatchObject({ stage: 5, notes: 'Ask Mr. K', nextAction: 'Buy seeds' });
    expect((await s.call('PATCH', `/api/myhelper/projects/${p}`, { advance: true })).body.stage).toBe(1);
    expect((await s.call('DELETE', `/api/myhelper/projects/${p}`)).status).toBe(200);
    expect((await s.call('GET', '/api/myhelper/state')).body.projects).toEqual([]);
  });
});

describe('Open in Study Helper', () => {
  it('starts from the assignment with its instructions already filled in, links the SAME assignment, and never makes a second one', async () => {
    s = await startServer();
    const id = (await s.call('POST', '/api/items', { title: 'Algebra worksheet 4', type: 'homework', dueDate: '2026-11-05', instructions: INSTR })).body.id;
    const opened = (await s.call('POST', '/api/homework/from-item', { itemId: id })).body;
    expect(opened).toMatchObject({ created: true, state: 'draft', needsInstructions: false });
    const draft = (await s.call('GET', `/api/homework/${opened.homeworkId}`)).body;
    expect(draft.instructions).toBe(INSTR); expect(draft.questions.map((q: any) => q.label)).toEqual(['1', '2']); expect(draft.title).toBe('Algebra worksheet 4');
    expect(draft.matches).toEqual([]);                                                              // it is not offered a duplicate Plan entry
    const done = await s.call('POST', `/api/homework/${opened.homeworkId}/confirm`, {});          // no `plan` choice needed: the link already exists
    expect(done.status).toBe(200); expect(done.body.plan.itemId).toBe(id);
    expect((await items()).filter((i) => i.type === 'homework')).toHaveLength(1);
    const again = (await s.call('POST', '/api/homework/from-item', { itemId: id })).body;
    expect(again).toMatchObject({ homeworkId: opened.homeworkId, created: false, state: 'active' });
    expect((await s.call('GET', '/api/myhelper/state')).body.assignments[0].homework).toMatchObject({ id: opened.homeworkId, state: 'active' });
    expect((await s.call('GET', '/api/subjects')).body.map((x: any) => x.name)).toContain('School');  // an assignment without a subject goes under "School"
  });
  it('asks for instructions when there are none, refuses unknown or foreign ids, and refuses to reuse the same instructions for another assignment', async () => {
    s = await startServer();
    const bare = (await s.call('POST', '/api/items', { title: 'Read chapter 3', type: 'homework' })).body.id;
    expect((await s.call('POST', '/api/homework/from-item', { itemId: bare })).body).toMatchObject({ needsInstructions: true, homeworkId: null });
    expect((await s.call('PATCH', `/api/items/${bare}`, { instructions: INSTR })).status).toBe(200);
    const first = (await s.call('POST', '/api/homework/from-item', { itemId: bare })).body;
    expect(first.homeworkId).toBeTruthy();
    const twin = (await s.call('POST', '/api/items', { title: 'Same sheet, other assignment', type: 'homework', instructions: INSTR })).body.id;
    expect((await s.call('POST', '/api/homework/from-item', { itemId: twin })).status).toBe(409);
    expect((await s.call('POST', '/api/homework/from-item', { itemId: 'nope' })).status).toBe(404);
  });
});

describe('importing the old My Helper data', () => {
  const OLD = {
    tasks: [
      { id: 1761000000000, title: 'Finish history outline', category: 'School', due: 'Today', done: false },
      { id: 1761000000001, title: 'Math practice', category: 'School', due: 'This week', done: true },
      { id: 1761000000002, title: 'Tennis match Saturday', category: 'Personal', due: 'This week', done: false },
      { id: 1761000000003, title: 'Find two sources', category: 'Project', due: 'Tomorrow', done: false },
      { id: 1761000000004, title: '   ', category: 'School', due: 'Today' },
    ],
    projects: [{ id: 1761000000010, name: 'Science fair idea', desc: 'Plants and light', stage: 3, notes: 'n', nextAction: 'seeds' }, { id: 1761000000011, name: '' }],
    memory: [{ id: 1, text: 'I play competitive tennis.', pinned: true }, { id: 2, text: 'I have a match every Saturday morning' }, { id: 3, text: 'x' }],
  };
  it('previews without writing anything, then imports once; repeating the import (same file or the wrapped export) changes nothing', async () => {
    s = await startServer();
    await s.call('POST', '/api/memory', { text: 'I play  competitive tennis.' });                       // already there, with different spacing
    const before = JSON.stringify((await s.call('GET', '/api/myhelper/state')).body);
    const pre = (await s.call('POST', '/api/myhelper/import/preview', { payload: OLD })).body;
    expect(pre.totals).toMatchObject({ new: 6, alreadyImported: 1, invalid: 3, imported: 0 });
    expect(pre.byKind.task).toMatchObject({ new: 4, invalid: 1 }); expect(pre.byKind.project).toMatchObject({ new: 1, invalid: 1 }); expect(pre.byKind.memory).toMatchObject({ new: 1, alreadyImported: 1, invalid: 1 });
    expect(pre.items.find((i: any) => i.label === 'Math practice')).toMatchObject({ status: 'new', where: 'School assignments' });
    expect(JSON.stringify((await s.call('GET', '/api/myhelper/state')).body)).toBe(before);              // preview wrote nothing
    expect((await s.call('POST', '/api/myhelper/import', { payload: OLD })).status).toBe(400);           // needs an explicit confirmation
    const done = (await s.call('POST', '/api/myhelper/import', { payload: OLD, confirm: true })).body;
    expect(done.totals).toMatchObject({ imported: 6 });
    const st = (await s.call('GET', '/api/myhelper/state')).body;
    expect(st.assignments.map((a: any) => a.title).sort()).toEqual(['Finish history outline', 'Math practice']);
    expect(st.assignments.find((a: any) => a.title === 'Math practice')).toMatchObject({ done: true, dueDate: null });   // "This week" stays undated
    expect(st.assignments.find((a: any) => a.title === 'Finish history outline').dueDate).toBe('2025-10-20');          // "Today" on the day it was added (the old id is that moment in milliseconds)
    expect(st.tasks.map((t: any) => t.title).sort()).toEqual(['Find two sources', 'Tennis match Saturday']);
    expect(st.projects).toHaveLength(1); expect(st.projects[0]).toMatchObject({ name: 'Science fair idea', stage: 3, notes: 'n', nextAction: 'seeds' });
    const mem = (await s.call('GET', '/api/memory')).body.memories.map((m: any) => m.text); expect(mem).toContain('I have a match every Saturday morning'); expect(mem.filter((t: string) => /competitive tennis/.test(t))).toHaveLength(1);
    const snapshot = JSON.stringify([st, (await s.call('GET', '/api/memory')).body.memories.length]);
    for (const payload of [OLD, { format: 'my-helper-export', version: 1, exportedAt: 'x', state: OLD }]) {
      const again = (await s.call('POST', '/api/myhelper/import', { payload, confirm: true })).body;
      expect(again.totals).toMatchObject({ imported: 0, new: 0 });
    }
    expect(JSON.stringify([(await s.call('GET', '/api/myhelper/state')).body, (await s.call('GET', '/api/memory')).body.memories.length])).toBe(snapshot);
    // and a deleted item does not come back by importing again
    await s.call('DELETE', `/api/myhelper/tasks/${st.tasks[0].id}`);
    await s.call('POST', '/api/myhelper/import', { payload: OLD, confirm: true });
    expect((await s.call('GET', '/api/myhelper/state')).body.tasks).toHaveLength(1);
  });
  it('accepts the bare value from the browser, items without ids, and rejects nonsense', async () => {
    s = await startServer();
    const noIds = { tasks: [{ title: 'No id task', category: 'Personal', due: 'Today' }, { title: 'No id task', category: 'Personal', due: 'Today' }], projects: [], memory: [] };
    const pre = (await s.call('POST', '/api/myhelper/import/preview', { payload: noIds })).body;
    expect(pre.totals).toMatchObject({ new: 2 });                                                          // two real tasks, even though they look alike
    await s.call('POST', '/api/myhelper/import', { payload: noIds, confirm: true });
    expect((await s.call('POST', '/api/myhelper/import', { payload: noIds, confirm: true })).body.totals).toMatchObject({ imported: 0, alreadyImported: 2 });
    expect((await s.call('GET', '/api/myhelper/state')).body.tasks).toHaveLength(2);
    expect((await s.call('POST', '/api/myhelper/import/preview', { payload: 'not json' })).status).toBe(400);
    expect((await s.call('POST', '/api/myhelper/import/preview', { payload: { tasks: 'x' } })).status).toBe(400);
    expect((await s.call('POST', '/api/myhelper/import/preview', {})).status).toBe(400);
  });
});
