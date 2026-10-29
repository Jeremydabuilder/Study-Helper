# Operating the pilot

All commands run in the service shell: `npm run operator -- <command>` (see `help`). They print counts, codes and switches — never student content.

| Need | Command |
|---|---|
| Invite one person (you send the code yourself; nothing is sent automatically) | `invites create --count 1 --label "cohort 1" --days 7` |
| Cancel unused invites | `invites revoke --label "cohort 1"` |
| Pause the whole site / resume | `pilot off` / `pilot on` |
| Stop new accounts only | `signups pause` |
| Switch off the paid assistant for everyone | `ai off` |
| Cap accounts | `max-users 15` |
| See state, accounts, 24h spend | `status` |
| Read problem reports students chose to send | `reports` |
| Delete a student on request | `user delete --email x` |
| Prune old audit rows/reports | `retention` |

## Backups
`backup --to /var/data/backups/<date> --passphrase-env BACKUP_PASSPHRASE` writes a JSON dump of the control database, a consistent snapshot of every student database, and a sha256 manifest, AES-256-GCM encrypted if a passphrase is given. `verify --from <folder>` checks integrity. Render's own database backups (plan dependent) and disk snapshots are additional — confirm what your plan includes. **Keep at least one copy off the same disk.** A backup that has never been restored is unproven: do a restore rehearsal on staging (checklist item 6).

## Restore / outage recovery
1. `pilot off`. 2. Provision an empty database and disk with the same `DATA_LABEL`. 3. `restore --from <folder>`. 4. `status` shows the expected account count. 5. `pilot on`. Tell students what was lost (everything after the backup time).

## Incidents
- Unexpected spend: `ai off`, then check `status`; limits are enforced in the database, but the provider's own dashboard is the source of truth — set a provider-side spending cap too.
- Suspected data exposure: `pilot off`, preserve logs, and follow your school/legal notification duties (unresolved here, see PILOT.md).
- Logs contain request routes, status codes and ids only (whitelist logger). They never contain answers, uploaded text, calendar details or tokens; if you add logging, keep it that way.
