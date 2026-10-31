import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, PG_AVAILABLE, TestDb } from './pgHarness';
import { prepareStaging } from '../src/server/hosted/staging';
import { getSettingPg, setSettingPg } from '../src/server/hosted/pg';

let db: TestDb | undefined;
afterEach(async () => { await db?.drop(); db = undefined; });
describe.skipIf(!PG_AVAILABLE)('staging seed environment boundary', () => {
  it('refuses a production database without changing its label or switches', async () => {
    db = await createTestDb();
    await setSettingPg(db.pool, 'data_label', 'production');
    await setSettingPg(db.pool, 'pilot_enabled', false);
    await expect(prepareStaging(db.pool)).rejects.toThrow('another environment');
    expect(await getSettingPg(db.pool, 'data_label', null)).toBe('production');
    expect(await getSettingPg(db.pool, 'pilot_enabled', null)).toBe(false);
    expect(await getSettingPg(db.pool, 'signups_open', 'absent')).toBe('absent');
  });
  it('claims an empty database as staging and leaves paid AI disabled', async () => {
    db = await createTestDb();
    await prepareStaging(db.pool);
    expect(await getSettingPg(db.pool, 'data_label', null)).toBe('staging');
    expect(await getSettingPg(db.pool, 'pilot_enabled', null)).toBe(true);
    expect(await getSettingPg(db.pool, 'ai_enabled', null)).toBe(false);
    await prepareStaging(db.pool);
    expect(await getSettingPg(db.pool, 'data_label', null)).toBe('staging');
  });
});
