/**
 * Prepares a STAGING site for a rehearsal. It refuses to run unless APP_ENV=staging, writes nothing but control-plane switches and single-use invitation codes,
 * and contains no student data of any kind: testers use the built-in "sample data" workspace (made-up records) or paste made-up notes.
 * It prints codes; it never sends anything to anyone.
 *   APP_ENV=staging DATABASE_URL=... npm run seed:staging -- --count 5
 */
import { loadEnvFile } from '../src/server/config';
import { hostedConfigFromEnv } from '../src/server/hosted/config';
import { createPool, migrateControl, setSettingPg, audit } from '../src/server/hosted/pg';
import { createInvites } from '../src/server/hosted/invites';

loadEnvFile();
const { cfg } = hostedConfigFromEnv();
if (cfg.environment !== 'staging') { console.error('Refusing: APP_ENV is not "staging". This script is for the test site only.'); process.exit(2); }
if (!cfg.databaseUrl) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const i = process.argv.indexOf('--count'); const count = i > 0 ? Math.min(20, Math.max(1, Number(process.argv[i + 1]) || 5)) : 5;
const pool = createPool(cfg.databaseUrl, { max: 2, ssl: /sslmode=require/.test(cfg.databaseUrl) });
try {
  await migrateControl(pool);
  await setSettingPg(pool, 'data_label', 'staging'); await setSettingPg(pool, 'pilot_enabled', true); await setSettingPg(pool, 'signups_open', true); await setSettingPg(pool, 'pilot_max_users', 10); await setSettingPg(pool, 'ai_enabled', true);
  const codes = await createInvites(pool, { count, label: 'staging rehearsal', ttlDays: 3, now: Date.now() });
  await audit(pool, 'seed_staging', null, { invites: codes.length });
  console.log('Staging is on for up to 10 testers. Use made-up notes only. Single-use codes (shown once):\n'); codes.forEach((c) => console.log('  ' + c));
} finally { await pool.end(); }
