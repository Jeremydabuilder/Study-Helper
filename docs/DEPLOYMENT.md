# Deployment (Render candidate): staging first

**Release branch:** `claude/pilot-integration` (also pushed as `claude/gracious-ramanujan-crnd4h`). It contains everything on `main` plus the hosted pilot and the homework helper. `main` and the default branch are untouched. Deploy a **commit hash**, written in your deploy notes, never "latest of a branch".
**Status:** never deployed. The Render blueprints below were checked only by this repository's own structure tests and by running the same build and start commands locally; Render's documentation could not be reached from the build environment, so field names and plan names are **unvalidated** (see "Before the first sync").

## Shape
One Node 22 web service per environment, one PostgreSQL database, one persistent disk at `/var/data`. Each student's private study data is a SQLite file under `DATA_DIR/users/<id>/`. Because those files live on one disk:
- run **exactly one instance** per service. The blueprints set `numInstances: 1` (a service with a disk cannot be scaled out on Render), and the app **enforces** it: the process holds a PostgreSQL advisory lock for its whole life; a second process on the same database waits up to `INSTANCE_LOCK_WAIT_MS` (default 30 s, for a deploy overlap) and then exits with "Another Study Helper process is already using this database". Tested (`tests/hostedRelease.test.ts`, `npm run rehearse:prod`).
- a deploy means a short outage. Deploy outside school hours.

## Files
- `render.staging.yaml`: staging only (1 service, 1 disk of 2 GB, 1 database). Email+password sign-in (still invitation-only) so no real Google accounts are needed; made-up data only.
- `render.production.yaml`: production only. Do not create it until `docs/LAUNCH_CHECKLIST.md` has no open blockers.
Each file creates nothing for the other environment. Environment labels (`DATA_LABEL`) make a staging server refuse a production database or data folder and the reverse.

## Commands (identical locally and on Render)
- Build: `npm ci --include=dev && npm run build:hosted && npm run prune:prod` (`--include=dev` because Render may set `NODE_ENV=production` during the build, which would skip the build tools).
- Start: `npm run start:hosted` (sets `APP_MODE=hosted NODE_ENV=production`, runs `dist-server/main.mjs`; migrations apply at start).
- Health check: `GET /readyz` (database reachable and migrated), liveness `GET /healthz`. Both are public and contain no student data.
- Node: 22.13 or newer (`NODE_VERSION=22.13.0`).

## Environment variables
| Variable | Staging | Production | Notes |
|---|---|---|---|
| `APP_ENV`, `DATA_LABEL` | `staging` | `production` | set by the blueprint; must match each other |
| `DATABASE_URL` | from the blueprint | from the blueprint | internal connection string; the database allows no outside addresses (`ipAllowList: []`) |
| `DATA_DIR` | `/var/data` | `/var/data` | the disk's mount path |
| `BETTER_AUTH_SECRET`, `APP_SECRET`, `OPERATOR_TOKEN` | generated | generated | never printed; `APP_SECRET` must differ from `BETTER_AUTH_SECRET` |
| `PUBLIC_URL` | optional | optional | defaults to Render's `RENDER_EXTERNAL_URL` (`https://<service>.onrender.com`); set it only for a custom domain |
| `AUTH_PASSWORD=1` | yes | **refused** unless `AUTH_PASSWORD_ALLOW_IN_PRODUCTION=1` | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | not needed | required for Google sign-in | dashboard only (`sync: false`) |
| `OPERATOR_NAME`, `OPERATOR_CONTACT` | optional | **required** | printed in the privacy notice |
| `ANTHROPIC_API_KEY` | leave empty | only after a live smoke test | empty = the assistant is simply unavailable; math checking, notes and reviews still work |
| `CALENDAR_ENABLED` | leave unset | leave unset | Calendar stays off unless this is `1`; signing in with Google never enables it |
| `LIMIT_*`, `RATE_*` | `LIMIT_GLOBAL_DAILY_USD=0.5` | per-student $0.30/day, global $5/day | see `.env.example` |
The app refuses to start with a missing or weak secret, an `http` public address, or no sign-in method; it prints which setting, never the value.

## Google sign-in (production, or a staging that uses Google)
In Google Cloud Console create an OAuth client of type "Web application". Add the **authorized redirect URI** `https://<your address>/api/auth/callback/google` (checked against the running app: this is the redirect the app sends). Requested scopes: `openid email` only. If you later switch Calendar on, add `https://<your address>/api/calendar/oauth/callback` as well and see `GOOGLE_SETUP.md`. Keep the consent screen's test users to your friends while the app is in Testing.

## Staging, step by step (no production resources are created)
1. In Render: New → Blueprint → this repository → branch `claude/pilot-integration` → **Blueprint file path `render.staging.yaml`**. Before approving, read the plan: it must list one web service, one disk and one database, all named `…staging…`.
2. Leave `ANTHROPIC_API_KEY` and `PUBLIC_URL` empty. Wait for the deploy to turn healthy (`/readyz`).
3. In the service Shell: `npm run seed:staging -- --count 3` (refuses outside staging) prints three single-use invitation codes and switches the pilot on for up to 10 testers. Send codes yourself; nothing is sent automatically.
4. Run the staging items in `docs/LAUNCH_CHECKLIST.md` ("Staging validation") and `docs/LIVE_CHECKS.md`.
5. Rehearse backup and restore on staging (OPERATIONS.md).

## Before the first sync (unvalidated against Render)
Run `render blueprints validate render.staging.yaml` (Render CLI) or let the dashboard validate it, and compare with Render's current Blueprint specification: `plan` names for the web service and database, `numInstances`, `disk`, `ipAllowList`, `fromDatabase`/`connectionString`, `generateValue`, and whether a "Blueprint file path" other than `render.yaml` can be chosen. If a name differs, change only that name; the app does not depend on Render-specific features.

## Rollback
- Code: Render → service → Deploys → redeploy the previous known-good commit. Schema changes are additive and forward-only.
- Data: OPERATIONS.md (backup/restore). Restore targets an **empty** database and disk with the same `DATA_LABEL`, so it is a rebuild, not an undo.
- Stop fast: `npm run operator -- pilot off` (students see a pause message, nothing is lost) or `ai off`.
