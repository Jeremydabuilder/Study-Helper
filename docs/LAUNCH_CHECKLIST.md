# Launch checklist: release candidate for 3–5 invited friends

**Release branch:** `claude/pilot-integration` (mirrored as `claude/gracious-ramanujan-crnd4h`); `main` and the default branch were not touched. Everything on `main`, `…-annotations`, `…-followups`, `…-trust-m6` and `…-autonomous-m5` is already contained in it.
**Code commit checked:** `64e561e`, in a **fresh clone** with `npm ci` (so nothing depended on leftover local files). It includes Codex PR #7 and #8, reviewed and merged. Later commits change only the regenerated `dist-server` bundles (verified byte-identical to a clean-clone build), the CI workflow and documentation; the final hash is in the hand-off message.
**Environment of every check below:** one Linux sandbox, Node 22.22.0, PostgreSQL 16 on 127.0.0.1 (real, not mocked), Chromium via Playwright, **mocked** identity provider, calendar provider and AI model. Nothing was run against Google, Anthropic, OCR, Render or HTTPS.

Status words: **Passed** (command, evidence) · **Failed** (problem, repair) · **Blocked** (exact missing dependency) · **Not applicable** (reason).

## A. Engineering checks (all re-run on this commit)
| # | Check | Status | Command / evidence |
|---|---|---|---|
| 0 | Codex PR #7 (tenant handle eviction; audit failures not suppressed) and PR #8 (sample reset vs active requests) | Passed | Reviewed line by line and merged. Their own tests (`tests/tenants.test.ts`, `tests/tenantReset.test.ts`) pass; typecheck and build were **re-run here** (PR #8 had not verified them). Added a route-level test (`tests/hostedRelease.test.ts`): reset is refused with 409 `demo_busy` while a request holds the sample database, works afterwards, and never touches the real workspace; the page retries a busy reset. Conflict in `package.json` resolved by keeping the stricter audit command (`npm audit --omit=dev`, peers included) |
| 1 | Type checking | Passed | `npm run typecheck` → exit 0 |
| 2 | All unit/integration tests with PostgreSQL **required** | Passed | `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/postgres REQUIRE_PG=1 npx vitest run` → 43 files, 441 tests passed, 0 skipped (a missing database fails the run; first attempt without Postgres failed loudly, as designed) |
| 3 | Browser tests, desktop and phone | Passed | `npm run build && npx playwright test` → 19 passed (exit 0) (new student journey, delayed review with injected clock, uploads, failures, isolation, keyboard-only, phone layout, homework) |
| 4 | Secret scan | Passed | `npm run scan:secrets` → 220 tracked files, no credential-shaped strings |
| 5 | Dependency audit | Passed | `npm audit` and `npm run audit:prod` → 0 vulnerabilities in the fresh clone (CI now also runs the full `npm audit --audit-level=moderate` and fails if the tracked bundles are stale). Earlier runs found 6 (vite/vitest/esbuild/tinypool, dev tools only); fixed by upgrading to vite 7 / vitest 4; all tests re-run afterwards. `audit:prod` no longer ends in `|| true` |
| 6 | Hosted production build | Passed | `npm run build:hosted` → exit 0 |
| 7 | Production rehearsal of the **built bundle** | Passed | `npm run rehearse:prod` → 51/51 checks. Runs `dist-server/main.mjs` from a copy installed with `npm ci --omit=dev`, production settings, fresh database and data folder, fake identity provider, no AI key |
| 8 | Invitation-only sign-up and sign-out | Passed | `tests/hostedAuth.test.ts`; rehearsal (no code → refused; used code → refused; pilot off → refused; sign-ups paused → refused); e2e journey |
| 9 | Two students cannot reach each other's records or files | Passed | `tests/hostedIsolation.test.ts` (three students, every route, files, calendar, demo), `tests/hostedHomework.test.ts` (21 homework routes), e2e isolation, rehearsal |
| 10 | Homework and study progress survive reload **and restart** | Passed | `tests/hostedRelease.test.ts` (same cookie, new server process: homework text, check result, progress, uploaded PDF bytes); rehearsal (SIGTERM, start again, same results) |
| 11 | AI errors preserve answers | Passed | e2e `failures.spec.ts` (timeout while grading, assistant off/allowance used, double click, session ended while typing); `tests/homework.test.ts` (assistant failure keeps working, records no help, retry works) |
| 12 | Per-user and global limits | Passed | `tests/hostedLimits.test.ts`, `tests/ledgerPg.test.ts` (concurrent reservations, per-user, global, concurrency, uploads, storage, chat) |
| 13 | Corrected grades and changed sources update learning evidence | Passed | `tests/hostedRelease.test.ts` (self-grade changes progress 0 → 1; editing a confirmed source page reconciles refs/questions); local `memoryTrust`, `learning`, `flow` tests |
| 14 | Mobile use | Passed | `e2e/mobile.spec.ts` (phone project): no sideways scroll on every page incl. homework, tap targets ≥ 32 px |
| 15 | Account export and deletion | Passed | `tests/hostedAccount.test.ts` (export has the student's own data and no secrets; deletion removes files and rows, signs out everywhere, keeps cost records anonymously, touches nobody else) |
| 16 | Backup and restore into an **empty** environment, representative records and files | Passed | `npm run rehearse:prod`: encrypted backup → restore into a new empty database and data folder → same browser sessions still signed in; subject and pasted text, homework working/version/check, study progress, a PDF **byte for byte**, second student intact and still isolated; used invitations stay used. Refused: wrong passphrase, second restore into a non-empty environment, production backup into staging. `tests/hostedOps.test.ts` also passes |
| 17 | Configuration guards and secure defaults | Passed | rehearsal: refuses to start with a short secret, password sign-in in production, no operator name, non-https address, no sign-in method; local mode refuses a network address; `/internal/metrics` needs the operator token; CSP, frame and content-type headers present; no student text in the server log; private files `no-store` |
| 18 | Single-instance storage constraint | Passed | enforced in code (PostgreSQL advisory lock): second process refused (`tests/hostedRelease.test.ts`, rehearsal); also `numInstances: 1` in both blueprints |
| 19 | Pause switches and recovery | Passed | rehearsal: pilot off → 503 pause message while `/healthz` stays up and nothing is lost; on → same session works; sign-ups paused → invitations refused, existing students unaffected |
| 20 | Calendar cannot block homework or studying | Passed | Calendar is off unless `CALENDAR_ENABLED=1`; the whole rehearsal (homework, study, uploads) ran with it off |
| 21 | Load, bounded | Passed (limited meaning) | `npm run loadtest -- --students 30 --seconds 60`: 63 req/s, p95 186 ms (re-run with 20 students: 52 req/s, p95 332 ms), no server errors apart from the mock model running out of distinct questions; found and fixed a sign-up pool deadlock. One laptop-class sandbox, mock AI: not a capacity promise |
| 22 | Render blueprints, structure | Passed | `tests/blueprints.test.ts`: one service/disk/database each, no cross-environment names, `numInstances: 1`, no secret values, the app accepts the configuration they imply |
| 23 | Render blueprints against Render's current documentation | **Blocked** | `docs.render.com`/`render.com` unreachable from this environment (host not allowed). Needs: run `render blueprints validate render.staging.yaml` (or the dashboard's validation) once |
| 24 | Obsolete documentation | Passed (was Failed) | README and `.env.example` still said "no login, authentication does not exist". Rewritten to separate **local mode** (no login, loopback only) from **hosted mode** (sign-in, invitations, per-student isolation) |

Defects found by this round and repaired: restore into a brand-new database failed ("relation user does not exist"); `verify` accepted a wrong backup passphrase; one instance per database was documented but not enforced; Google sign-in would have switched Calendar on; the redirect URI in the first deployment notes was wrong (`/api/auth/callback/google` is correct); one blueprint file created staging **and** production; dev-tool vulnerabilities; `audit:prod` swallowed failures.

## B. Staging validation (not yet done; needs a Render account)
| Check | Status |
|---|---|
| Blueprint accepted by Render; one web service, one disk, one database created | **Blocked**: Render account + payment method (yours) |
| `/readyz` healthy on the `onrender.com` address; migrations applied | Blocked on the line above |
| Invitation + password sign-up over real HTTPS (secure cookies behind Render's proxy) | Blocked on the line above |
| Upload, homework, study, restart (Render restarts the service), disk persistence | Blocked on the line above |
| Backup, then restore into a second empty staging | Blocked on the line above |

## C. Live external services: **UNVERIFIED** until exercised (see `docs/LIVE_CHECKS.md`)
| Item | Status | Missing dependency |
|---|---|---|
| Real Google sign-in (consent screen, redirect, `sub` identity) | Blocked | a Google OAuth client for the staging address (yours) |
| AI tutoring, grading, homework hints/checks, rubric feedback quality | Blocked | `ANTHROPIC_API_KEY` set in the host dashboard **and** your explicit test budget; then `npm run smoke:ai -- --confirm-spend` |
| OCR of photos and scans (`AI_OCR=anthropic`) | Blocked | same key and budget; OCR stays disabled by default |
| Google Calendar | Blocked and **disabled** | Calendar scope on the OAuth client, test user, `CALENDAR_ENABLED=1`; not needed for the pilot |
| Real handwriting/photo transcription of homework working | Blocked | OCR above |

## D. Decisions that are not engineering (open; nothing here claims compliance or approval)
- Whether a school or administrator must approve this, and who tells parents/guardians: **not decided; no approval has been obtained or invented.**
- Age range of your friends. The app assumes **no one under 13**; Anthropic's consumer terms require 18+, and what applies to a product built on its API for under-18 users is **unconfirmed** (`docs/PILOT.md`).
- Privacy notice: a **draft**. Needs your name/contact (`OPERATOR_NAME`, `OPERATOR_CONTACT`) and a review by someone qualified.
- Who is the operator, what you will do about a data incident, and the retention you will honour (audit 180 days, reports 90).
- Spending: the provider-side cap and `LIMIT_*` values you are willing to fund.
- **Production invitations stay closed.** `pilot_enabled` is off by default, `render.production.yaml` has not been applied, and no invitation has been created or sent anywhere except synthetic test databases.
