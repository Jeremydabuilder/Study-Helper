import { Pool, tx } from './pg';

/** Never relabel another environment or partially change its switches. */
export async function prepareStaging(pool: Pool) {
  await tx(pool, async (c) => {
    // Serialize the initial label claim with other settings writers, including server startup.
    await c.query('LOCK TABLE app_settings IN EXCLUSIVE MODE');
    const label = (await c.query("SELECT value FROM app_settings WHERE key = 'data_label'")).rows[0]?.value;
    if (label !== undefined && label !== 'staging') throw new Error('Refusing to seed: this database belongs to another environment.');
    for (const [key, value] of Object.entries({ data_label: 'staging', pilot_enabled: true, signups_open: true, pilot_max_users: 10, ai_enabled: false })) {
      await c.query('INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [key, JSON.stringify(value)]);
    }
  });
}
