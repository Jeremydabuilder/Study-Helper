import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Tenants } from '../src/server/hosted/tenants';

it('refuses a demo reset until every sample request releases its handle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'study-reset-'));
  const tenants = new Tenants(dir);
  try {
    const real = tenants.lease('student_alice', 'real');
    real.db.run("INSERT INTO settings (key,value,updated_at) VALUES ('marker','\"real\"',1)");
    const first = tenants.lease('student_alice', 'demo');
    const second = tenants.lease('student_alice', 'demo');
    first.db.run("INSERT INTO settings (key,value,updated_at) VALUES ('marker','\"sample\"',1)");
    expect(tenants.dropDemo('student_alice')).toBe(false);
    expect(second.db.get("SELECT value FROM settings WHERE key='marker'")?.value).toBe('"sample"');
    first.release();
    expect(tenants.dropDemo('student_alice')).toBe(false);
    second.release();
    expect(tenants.dropDemo('student_alice')).toBe(true);
    const fresh = tenants.lease('student_alice', 'demo');
    expect(fresh.db.get("SELECT value FROM settings WHERE key='marker'")).toBeUndefined();
    expect(real.db.get("SELECT value FROM settings WHERE key='marker'")?.value).toBe('"real"');
    fresh.release(); real.release();
  } finally { tenants.closeAll(); rmSync(dir, { recursive: true, force: true }); }
});
