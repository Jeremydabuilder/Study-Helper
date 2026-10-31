# Independent release hardening — 2026-10-31

Base: `ef92cc372c23f72480035042728409c943406dcc` on `claude/pilot-integration`.
This branch consolidates the source fixes from Codex PRs #7 and #8 without changing the integration branch or publishing a site.

## Changes

- Acquire student database leases before eviction; trim idle overflow on release. Refuse sample resets while a sample request is active, returning HTTP 409 without deleting its seed/gateway state.
- Bundle the staging seed tool and run operator/seed commands with plain Node. Previously the Render build removed `tsx` but the documented shell commands still required it.
- Staging seed refuses mismatched `DATA_LABEL` and database labels; label and switch changes are transactional. It leaves paid AI off. PostgreSQL integration regression tests are included.
- Use `node --import tsx` for non-watch development/evaluation CLIs and browser launcher, avoiding unnecessary CLI IPC sockets. Evaluation tests still execute real subprocesses and verify consent/missing-key failures.
- Add built-release-tool checks and the existing full production rehearsal to CI; run CI on Codex branches too.
- Review Render configuration against its official Blueprint reference, update compute plan IDs/manual deploy field, and pin PostgreSQL 16 to match CI. Actual Render validation and deployment remain unperformed.

## Verification in this pass

- Node 24.22.1 here (Render/CI targets Node 22).
- Typecheck and hosted build passed. Built operator help and seed environment rejection checks passed.
- Full available test run: 381 passed, 61 PostgreSQL-dependent tests skipped, no failures. This does **not** establish hosted-account or staging-seed database correctness. PostgreSQL-required CI must pass before release.
- Production audit reported zero vulnerabilities after the dependency upgrades already present in the base branch. Secret scan passed. No suppressed audit failure was introduced.
- No real Google, AI, OCR, Render deployment, or hosted browser run in this pass. No credentials or provider budget was used.
- This environment has no PostgreSQL service; attempting to provision one failed due to OS privilege restrictions. Do not replace required PostgreSQL tests with mocks or skip them in CI.

## Remaining launch gates

1. PostgreSQL-required CI including staging-seed protection and production rehearsal must pass on this exact revision.
2. Validate the Blueprint in Render and rehearse a real staging deployment; confirm startup, persistent disk and restart.
3. Exercise real invitation + Google sign-in and a bounded live AI session (and OCR if offered). Confirm cookie behavior through the actual HTTPS proxy.
4. Resolve the operator/provider/age/privacy items already documented in the launch checklist; no approval is asserted here.
5. Keep production invitations disabled until those gates are resolved. Start with 3–5 friends only after the first real student flow succeeds.

There are no hosting credentials in this workspace and no public deployment was performed. The code is a reviewable staging candidate, not a certified production release.
