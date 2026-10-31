import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Tenants } from '../src/server/hosted/tenants';

describe('tenant handle pressure', () => {
  it('keeps all active handles usable and trims overflow when a request releases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'study-tenants-'));
    const tenants = new Tenants(dir, { maxOpen: 1, now: () => 1 });
    try {
      const alice = tenants.lease('student_alice', 'real');
      const bob = tenants.lease('student_bob', 'real');
      expect(alice.db.get('SELECT 1 AS n')?.n).toBe(1);
      expect(bob.db.get('SELECT 1 AS n')?.n).toBe(1);
      expect(tenants.openCount).toBe(2);
      alice.release();
      expect(tenants.openCount).toBe(1);
      expect(bob.db.get('SELECT 1 AS n')?.n).toBe(1);
      alice.release(); // releasing twice must not close another student's active handle
      expect(bob.db.get('SELECT 1 AS n')?.n).toBe(1);
      bob.release();
      const reopened = tenants.lease('student_alice', 'real');
      expect(reopened.db.get('SELECT id FROM profile')?.id).toBe(1);
      reopened.release();
    } finally {
      tenants.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
