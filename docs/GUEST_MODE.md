# Friends mode: invitation-only private workspaces (3–5 people)

This is the configuration for the owner **plus a few friends**. The owner-only site ([DEPLOYMENT.md](DEPLOYMENT.md)) is a different setting of the same app (`OWNER_ONLY=1`); the two cannot be switched on together.

## What it does
- `AUTH_GUESTS=1` lets a person open a private workspace **only with a single-use invitation code**. There is no email, Google or password step.
- Codes look like `XXXX-XXXX-XXXX-XXXX`. They are stored only as hashes, work once, expire (7 days by default) and can be revoked. A code is never put in a URL; it travels in a request body and a short-lived HttpOnly cookie. Using a code uses it atomically: twelve simultaneous attempts produce exactly one workspace.
- The server enforces this, including a direct call to `/api/auth/sign-in/anonymous` (rejected without a valid code cookie). The page is not the gate.
- Each person gets a separate server identity and a separate private database file, with their own export and delete controls.
- **Clearing cookies, using a private window or switching browser loses access** to that workspace (there is no account to recover it). People are told this on the entry page. Export first (Settings → Download my data).
- Unreachable guests (no valid session) are deleted after a seven-day grace period; the operator tools do the same deletion on request.

## Making codes without a terminal
Set `OPERATOR_TOKEN` (24+ random characters) as a service variable and open `https://YOUR-ADDRESS/#/operator`. Paste the token (kept only in that tab) to create or revoke invitations, pause admissions, or switch the study assistant off. Codes are shown once; send them yourself. This page does not exist in owner-only mode.

## Groq limits shared by everyone
All people share one Groq key and therefore one allowance. The app paces requests (per-minute and concurrent), stops sending after Groq refuses, and shows "try again in about …" instead of retrying in a loop. `LIMIT_USER_DAILY_AI_REQUESTS`, `LIMIT_GLOBAL_DAILY_AI_REQUESTS`, `LIMIT_USER_DAILY_TOKENS` and `LIMIT_GLOBAL_DAILY_TOKENS` cap use per person and overall. The Free tier is **not** guaranteed to support many people at once; mocked tests prove the rules, not capacity.

## Calendar and OCR
Off. Guests cannot connect Google Calendar. Screenshot/OCR reading needs a separate provider and stays off unless configured.

## Validation
`tests/hostedGuests.test.ts` (real Better Auth and PostgreSQL): invitation bypass attempts, reuse, expiry, revocation, concurrency, rate limits, no code in logs, isolation, export and deletion. No site has been deployed and no invitation has been sent.
