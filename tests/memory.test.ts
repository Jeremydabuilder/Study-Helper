import { afterEach, describe, expect, it } from 'vitest';
import { OfflineProvider } from '../src/ai/offline';
import { LLMProvider } from '../src/ai/llm';
import { startServer, TestServer, token } from './helpers';

let s: TestServer;
afterEach(async () => { await s?.close(); });

const NOTES = `--- Page 1 ---
Unit 3 — Equations and inequalities (my notes)

Solving linear equations: undo operations in reverse order and keep both sides balanced.

Solving linear inequalities: solve like an equation, but reverse the inequality sign whenever you multiply or divide both sides by a negative number.

--- Page 2 ---
Absolute value equations: |u| = r means u = r or u = -r when r is positive.
`;

describe('offline extraction', () => {
  it('summarises from the definition line (not the heading), keeps document order, and links known math prerequisites', async () => {
    const r = await new OfflineProvider().extractConcepts({ subjectName: 'Math', chunks: [{ id: '1', label: 'p', text: NOTES }], maxConcepts: 10 });
    expect(r.concepts.map((c) => c.name)).toEqual(['Solving linear equations', 'Solving linear inequalities', 'Absolute value equations']);
    expect(r.concepts[1].summary).toMatch(/^solve like an equation/);
    expect(r.concepts[1].prerequisites).toEqual(['Solving linear equations']);
    expect(r.concepts.every((c) => NOTES.includes(c.quotes[0]))).toBe(true);
  });
});

describe('cost and fairness guarantees', () => {
  it('math practice makes zero model calls; held-out questions are never served during practice but are used for review', async () => {
    let calls = 0;
    const llm = new LLMProvider({ provider: 'fake', defaultModel: 'x', complete: async () => { calls++; return '{}'; } });
    s = await startServer({ llm });
    const db = s.rt.ctx('real').db;
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Equations', skillTag: 'math.linear_equation' })).body.id;
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 30, conceptIds: [c] })).body.id;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
      if (v.phase !== 'question') break;
      seen.push(v.question.id);
      const spec = JSON.parse(db.get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec);
      await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: spec.answer, clientToken: token() });
      await s.call('POST', `/api/sessions/${sid}/next`, {});
    }
    expect(calls).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    const held = db.all<any>('SELECT id FROM questions WHERE heldout=1').map((r) => r.id);
    expect(held.length).toBeGreaterThan(0);
    expect(seen.some((id) => held.includes(id))).toBe(false); // transfer checks stay unseen
    // a review a day later draws from the held-out pool first
    await s.call('POST', `/api/sessions/${sid}/finish`);
    s.clock.now += 3 * 86400000;
    const rev = (await s.call('POST', '/api/sessions', { mode: 'review', minutes: 10 })).body.id;
    const v = (await s.call('GET', `/api/sessions/${rev}`)).body;
    expect(held).toContain(v.question.id);
  });
});

describe('inspectable, correctable memory', () => {
  it('labels provenance, turns corrected inferences into student-stated facts, and deletes for real', async () => {
    s = await startServer();
    const db = s.rt.ctx('real').db;
    const id = (await s.call('POST', '/api/memory', { text: 'I like worked examples first' })).body.id;
    db.run("INSERT INTO memories (id,kind,text,provenance,created_at,updated_at) VALUES ('m2','ai_inferred','Rushes multi-step problems','{\"origin\":\"ai\"}',1,1)");
    let m = (await s.call('GET', '/api/memory')).body;
    expect(m.memories.map((x: any) => x.kind).sort()).toEqual(['ai_inferred', 'student_stated']);
    await s.call('PATCH', '/api/memory/m2', { text: 'Sometimes rushes, but only on tired days' });
    m = (await s.call('GET', '/api/memory')).body;
    const fixed = m.memories.find((x: any) => x.id === 'm2');
    expect(fixed.kind).toBe('student_stated'); expect(fixed.provenance).toMatchObject({ correctedByStudent: true, previousKind: 'ai_inferred' });
    await s.call('DELETE', `/api/memory/${id}`);
    expect(db.get('SELECT 1 FROM memories WHERE id=?', id)).toBeUndefined();
    expect((await s.call('POST', '/api/memory', { text: 'x' })).status).toBe(400);
  });
});

describe('import / export', () => {
  it('previews without writing, imports only what was selected, tags imports, and rebuilds scheduling from history', async () => {
    // source workspace with a little history
    s = await startServer();
    const sub = (await s.call('POST', '/api/subjects', { name: 'Math' })).body.id;
    const c = (await s.call('POST', `/api/subjects/${sub}/concepts`, { name: 'Equations', skillTag: 'math.linear_equation' })).body.id;
    await s.call('POST', '/api/memory', { text: 'Tennis most afternoons' });
    await s.call('POST', '/api/memory', { text: 'A private note I do not want to move' });
    await s.call('PUT', '/api/profile', { name: 'Jeremy', grade: '8' });
    const sid = (await s.call('POST', '/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [c] })).body.id;
    const v = (await s.call('GET', `/api/sessions/${sid}`)).body;
    const spec = JSON.parse(s.rt.ctx('real').db.get<any>('SELECT answer_spec FROM questions WHERE id=?', v.question.id).answer_spec);
    await s.call('POST', `/api/sessions/${sid}/answer`, { questionId: v.question.id, answer: spec.answer, clientToken: token() });
    const file = (await s.call('POST', '/api/export', { sections: ['profile', 'memories', 'learning'], includeSourceText: true })).body;
    expect(file.format).toBe('study-helper-export');
    await s.close();

    // a fresh, empty workspace
    s = await startServer();
    const db = s.rt.ctx('real').db;
    const prev = (await s.call('POST', '/api/import/preview', { file })).body;
    expect(prev.subjects).toHaveLength(1); expect(prev.subjects[0]).toMatchObject({ name: 'Math', concepts: 1, attempts: 1, isNew: true });
    expect(prev.memories).toHaveLength(2);
    for (const t of ['subjects', 'memories', 'attempts', 'concepts']) expect(db.get<any>(`SELECT COUNT(*) n FROM ${t}`).n).toBe(0); // preview wrote nothing
    expect(db.get<any>('SELECT name FROM profile').name).toBe('');

    const keep = prev.memories.find((m: any) => /Tennis/.test(m.text)).id;
    const r = await s.call('POST', '/api/import/commit', { file, selection: { memoryIds: [keep], subjectIds: [prev.subjects[0].id] } });
    expect(r.body.imported).toMatchObject({ memories: 1, subjects: 1, concepts: 1, attempts: 1 });
    expect(db.all<any>('SELECT text, provenance FROM memories').map((m) => m.text)).toEqual(['Tennis most afternoons']);
    expect(JSON.parse(db.get<any>('SELECT provenance FROM memories').provenance).origin).toBe('import');
    expect(db.get<any>('SELECT name FROM profile').name).toBe(''); // profile was not selected
    expect(db.get<any>('SELECT COUNT(*) n FROM concept_state').n).toBe(1); // scheduling recomputed from imported attempts
    // importing again is idempotent
    await s.call('POST', '/api/import/commit', { file, selection: { memoryIds: [keep], subjectIds: [prev.subjects[0].id] } });
    expect(db.get<any>('SELECT COUNT(*) n FROM attempts').n).toBe(1);
  });
  it('rejects files that are not valid exports, with a readable error', async () => {
    s = await startServer();
    const r = await s.call('POST', '/api/import/preview', { file: { format: 'something-else' } });
    expect(r.status).toBe(422); expect(r.body.error.message).toMatch(/not a valid Study Helper export/);
    expect((await s.call('POST', '/api/import/preview', { file: { format: 'study-helper-export', version: 99, exportedAt: 1, sections: {} } })).status).toBe(422);
  });
});
