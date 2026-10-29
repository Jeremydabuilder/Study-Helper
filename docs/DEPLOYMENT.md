# Deployment (Render candidate) and rollback

Status: **never deployed.** `render.yaml` has not been applied to a real Render account (none was available, and the sandbox could not reach Render). Treat every step below as untested until the staging rehearsal in LAUNCH_CHECKLIST.md is done.

Recorded code state: branch `claude/pilot-integration` (not merged into the default branch). Deploy a **commit hash**, not a branch name; write it in your deploy notes.

## Shape
One Node 22 web service per environment (staging, production) + one PostgreSQL database + one persistent disk at `/var/data`. Each student's study data is a private SQLite file under `DATA_DIR/users/<id>/`. Because those files live on one disk, **run exactly one instance** per service (no autoscaling, no zero-downtime overlap). Deploys cause a short outage; schedule them outside school hours.

## First deploy (staging)
1. Create a Render account and add a payment method yourself (not done by this project).
2. New → Blueprint → this repository, choose the commit. Review the plan before approving: it creates two services, two databases and two disks.
3. Fill the `sync:false` variables for **staging only** (`PUBLIC_URL`; leave `ANTHROPIC_API_KEY` empty for an offline staging site, or set a key with a tiny `LIMIT_GLOBAL_DAILY_USD`).
4. When healthy (`/readyz`), open the Shell and run `APP_ENV=staging npm run seed:staging -- --count 3` for rehearsal invitation codes. Send them yourself.
5. Complete LAUNCH_CHECKLIST.md on staging with made-up data only.

## Production
Same, with the production service: set `OPERATOR_NAME`, `OPERATOR_CONTACT`, Google OAuth values (redirect URIs listed in GOOGLE_SETUP.md, plus the site sign-in callback `https://<site>/api/auth/oauth2/callback/google`), `ANTHROPIC_API_KEY`, and review every `LIMIT_*`. `pilot_enabled` starts **off**: turn it on only after the checklist (`npm run operator -- pilot on`). The server refuses to start in production with missing or weak required settings.

## Rollback
- Code: Render → service → Deploys → redeploy the previous known-good commit. Schema changes are additive and forward-only; a rollback to an older build keeps working with a newer schema, but check release notes before relying on that.
- Data: see OPERATIONS.md (backup/restore). `restore` only works into an **empty** deployment with the same data label, so a restore is a rebuild, not an undo.
- Stop everything fast: `npm run operator -- pilot off` (students see a pause message, nothing is lost) or `ai off` (study continues without the assistant).

## Not provided
Custom domain/DNS, email sending, alerting service, WAF. Render's own metrics + `/internal/metrics` (content-free) are the monitoring.
