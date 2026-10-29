# Launch checklist

Automated checks (run in CI and locally): `npm run typecheck`, `npx vitest run` (needs PostgreSQL via TEST_DATABASE_URL), `npm run test:e2e`, `npm run scan:secrets`, `npm run audit:prod`, `npm run build:hosted`. All passed on the integration branch at the last run, with a **mocked** AI provider.

## Blockers before any real student
- [ ] School/administrator approval and a parent/guardian communication plan (PILOT.md) — **not decided by this project**.
- [ ] Confirmed age range, and that the AI provider's terms permit that range (PILOT.md) — **unresolved**.
- [ ] Privacy notice reviewed by someone qualified; `OPERATOR_NAME/CONTACT` set. Current text is a **draft**.
- [ ] Staging deployed and rehearsed (below). Render blueprint has never been applied.
- [ ] Google OAuth consent screen configured for the real domain; sign-in with Google tested by a human.
- [ ] One live smoke test of the paid assistant with a capped key (`npm run smoke:ai -- --confirm-spend`) — not run (no key/authorisation so far).
- [ ] Provider-side spend cap set.

## Manual checks (about 30 minutes, staging, made-up data)
1. Sign in with a real Google account via a fresh invitation; a second browser with no invite is refused.
2. Upload a real PDF, correct a page, start studying, answer, see the assistant reply.
3. Sign out and in; the work is still there. Open `/api/subjects/<other id>` from another account: nothing.
4. `pilot off` shows the pause page; `pilot on` resumes.
5. Take a backup, restore it on a second empty staging, confirm the account count.
