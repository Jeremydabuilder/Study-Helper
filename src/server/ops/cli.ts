/**
 * Operator commands. They run on the server (for example in Render's shell) and never show student study content:
 * only counts, codes, switches and cost totals. Inviting is manual: this tool prints codes; it never sends anything to anyone.
 *   npm run operator -- <command>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../config';
import { hostedConfigFromEnv } from '../hosted/config';
import { createPool, getSettingPg, migrateControl, setSettingPg, audit } from '../hosted/pg';
import { createInvites, listInvites, revokeInvites } from '../hosted/invites';
import { spendReport } from '../hosted/limits';
import { Tenants } from '../hosted/tenants';
import { backup, restore, verifyBackup } from '../hosted/backup';
import { deleteAccount, importLocalDatabase } from '../hosted/account';

loadEnvFile();
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, d?: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : d; };
const has = (name: string) => rest.includes(`--${name}`);
const HELP = `Study Helper operator commands
  invites create --count 5 --label "cohort 1" --days 7   print new single-use codes (shown once; send them yourself)
  invites list | invites revoke --label "cohort 1" | --id <prefix>
  pilot on|off                  the whole site (off: every student sees a pause message; data is untouched)
  signups open|pause            allow / stop NEW accounts (invitations stay valid)
  ai on|off                     switch the paid study assistant on/off for everyone
  max-users <n>                 cap on accounts
  status                        switches, account count, spend in the last 24h (no content)
  reports                       problem reports students chose to send
  user delete --email <email>   delete one student's account and data (on their request)
  user import-local --email <email> --from ./data/study.db [--replace]   move a pre-hosting local database into that student's account
  backup --to <new folder> [--passphrase-env VAR]   restore --from <folder> [--passphrase-env VAR]   verify --from <folder>
  retention                     delete audit events older than 180 days and reports marked done older than 90 days`;

async function main() {
  if (!cmd || cmd === 'help') return console.log(HELP);
  const { cfg, problems } = hostedConfigFromEnv();
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set.');
  const pool = createPool(cfg.databaseUrl, { max: 3, ssl: /sslmode=require/.test(cfg.databaseUrl) });
  await migrateControl(pool);
  const dataDir = process.env.DATA_DIR ?? './data'; mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  const pass = (varName?: string) => (varName ? process.env[varName] : undefined);
  try {
    const sub = rest[0];
    if (cmd === 'invites' && sub === 'create') {
      const codes = await createInvites(pool, { count: Number(flag('count', '1')), label: flag('label', ''), ttlDays: Number(flag('days', '7')), now });
      console.log(`Created ${codes.length} single-use invitation code(s). They are shown ONCE. Send each to one person yourself:\n`); codes.forEach((c) => console.log('  ' + c));
      console.log(`\nThey expire in ${flag('days', '7')} days. The sign-up page is ${cfg.publicUrl || '(set PUBLIC_URL)'}/#/join`);
    } else if (cmd === 'invites' && sub === 'list') { console.table(await listInvites(pool, now)); }
    else if (cmd === 'invites' && sub === 'revoke') { console.log(`Revoked ${await revokeInvites(pool, { idPrefix: flag('id'), label: flag('label') })} unused invitation(s).`); }
    else if (cmd === 'pilot' || cmd === 'signups' || cmd === 'ai') {
      const key = cmd === 'pilot' ? 'pilot_enabled' : cmd === 'signups' ? 'signups_open' : 'ai_enabled';
      const on = sub === 'on' || sub === 'open'; if (!['on', 'off', 'open', 'pause'].includes(sub)) throw new Error(HELP);
      await setSettingPg(pool, key, on); await audit(pool, `switch_${key}`, null, { value: on }); console.log(`${key} = ${on}`);
    } else if (cmd === 'max-users') { await setSettingPg(pool, 'pilot_max_users', Number(sub)); console.log(`pilot_max_users = ${Number(sub)}`); }
    else if (cmd === 'status') {
      const hasUsers = (await pool.query("SELECT to_regclass('public.\"user\"') AS t")).rows[0].t !== null; // the sign-in tables are created when the app first starts
      const n = hasUsers ? (await pool.query('SELECT COUNT(*)::int n FROM "user"')).rows[0].n : 0;
      console.log(JSON.stringify({ environment: cfg.environment, dataLabel: await getSettingPg(pool, 'data_label', null), pilot_enabled: await getSettingPg(pool, 'pilot_enabled', false), signups_open: await getSettingPg(pool, 'signups_open', true), ai_enabled: await getSettingPg(pool, 'ai_enabled', true), max_users: await getSettingPg(pool, 'pilot_max_users', 30), accounts: n, config: problems.length ? { problems } : 'ok', spend: await spendReport(pool, now) }, null, 2));
    } else if (cmd === 'reports') { console.table((await pool.query('SELECT id, created_at, status, message, attachment IS NOT NULL AS has_attachment FROM reports ORDER BY created_at DESC LIMIT 50')).rows); }
    else if (cmd === 'user' && sub === 'delete') {
      const email = flag('email')?.toLowerCase(); if (!email) throw new Error('--email is required');
      const r = (await pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]; if (!r) throw new Error('No such account.');
      await deleteAccount({ pool, tenants: new Tenants(dataDir), userId: r.id, now: () => now }); console.log('Account and data deleted.');
    } else if (cmd === 'user' && sub === 'import-local') {
      const email = flag('email')?.toLowerCase(), from = flag('from'); if (!email || !from) throw new Error('--email and --from are required');
      const r = (await pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]; if (!r) throw new Error('No such account: the student must sign in once first.');
      const out = importLocalDatabase({ tenants: new Tenants(dataDir), userId: r.id, file: from, replace: has('replace') }); await audit(pool, 'local_data_imported', r.id, {}); console.log(`Imported (${out.attempts} saved answers).`);
    } else if (cmd === 'backup') {
      const to = flag('to'); if (!to) throw new Error('--to <new folder> is required');
      const m = await backup({ pool, tenants: new Tenants(dataDir), destDir: to, dataLabel: cfg.dataLabel, passphrase: pass(flag('passphrase-env')), now: () => now });
      console.log(`Backup written to ${to}: ${m.users.length} student database(s), ${m.tables.reduce((a, t) => a + t.rows, 0)} shared rows, ${m.encrypted ? 'encrypted' : 'NOT encrypted (keep it private)'}.`);
    } else if (cmd === 'verify') { const m = await verifyBackup(flag('from')!, pass(flag('passphrase-env'))); console.log(`Backup OK: made ${m.createdAt}, ${m.users.length} student database(s).`); }
    else if (cmd === 'restore') {
      const r = await restore({ pool, dataDir, bundleDir: flag('from')!, dataLabel: cfg.dataLabel, passphrase: pass(flag('passphrase-env')) });
      console.log(`Restored ${r.users} student database(s) and ${r.rows} shared rows. Restart the app, then check /readyz.`);
    } else if (cmd === 'retention') {
      const a = await pool.query("DELETE FROM audit_log WHERE at < now() - interval '180 days'"); const b = await pool.query("DELETE FROM reports WHERE status = 'done' AND created_at < now() - interval '90 days'");
      console.log(`Deleted ${a.rowCount} audit events and ${b.rowCount} old reports.`);
    } else console.log(HELP);
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : 'failed'); process.exit(1); });
