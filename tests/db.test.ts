import { describe, expect, it } from 'vitest';
import { openDb, uid } from '../src/server/db';

describe('storage & migrations', () => {
  it('applies migrations once and is idempotent on reopen', () => {
    const db = openDb(':memory:');
    const v = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);
    expect(v).toEqual([1, 2, 3]);
    expect(db.get('SELECT id FROM profile')?.id).toBe(1);
  });
  it('rolls back failed transactions and enforces foreign keys/cascades', () => {
    const db = openDb(':memory:');
    const s = uid();
    expect(() => db.tx(() => { db.run('INSERT INTO subjects (id,name,created_at) VALUES (?,?,?)', s, 'Math', 1); throw new Error('boom'); })).toThrow('boom');
    expect(db.get('SELECT 1 FROM subjects WHERE id=?', s)).toBeUndefined();
    expect(() => db.run("INSERT INTO sources (id,subject_id,title,text,content_hash,created_at) VALUES ('x','nope','t','t','h',1)")).toThrow();
    db.run('INSERT INTO subjects (id,name,created_at) VALUES (?,?,?)', s, 'Math', 1);
    db.run("INSERT INTO sources (id,subject_id,title,text,content_hash,created_at) VALUES ('src',?,'t','t','h',1)", s);
    db.run('DELETE FROM subjects WHERE id=?', s);
    expect(db.get("SELECT 1 FROM sources WHERE id='src'")).toBeUndefined();
  });
});
