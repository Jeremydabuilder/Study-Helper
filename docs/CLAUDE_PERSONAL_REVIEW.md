Review the personal ChatGPT integration in https://github.com/Jeremydabuilder/Study-Helper on branch codex/chatgpt-personal against claude/pilot-integration.

Codex owns the implementation branch. Work on a NEW branch named claude/review-personal-chatgpt; do not push to Codex's branch or merge anything. You are the independent reviewer.

Goal: Jeremy runs npm run personal on his own computer, chooses Continue with ChatGPT, authorizes the same ChatGPT account/workspace he uses for this chat, selects an account-advertised model, and receives NEW study answers in Study Helper using eligible plan usage. It must not claim to access this existing conversation or ChatGPT memory. Public/classmates hosting is outside this feature. The existing Groq capacity work is separately saved on the local codex/groq-test-readiness branch and is not part of this review.

First read docs/PERSONAL_CHATGPT.md and OpenAI's CURRENT official SIWC local-plan registration, models/inference, token/refresh, UI and preview-limitations documentation. Confirm the protocol is still supported; do not use undocumented ChatGPT backend endpoints or borrowed Codex client IDs/tokens.

Review src/server/personal/, src/ai/chatgpt.ts, factory/runtime integration, local host/origin controls, Settings UI and tests/chatgptPersonal.test.ts plus e2e/personal.spec.ts. Try to reproduce account/client substitution, callback state/nonce/expiry/replay failures, disconnect/refresh races, token leaks, unsafe credential persistence, hosted sharing, forbidden Responses parameters, incomplete streams accepted as success, and wrong-account/paid-API fallback. Check that the selected account remains bound after disconnect/restart and credentials are never copied from ChatGPT/Codex profiles. Review owner-only files, explicit consent, manage-usage controls, and actual Windows startup instructions.

Run typecheck, relevant tests and hosted build. Full CI must retain real PostgreSQL tests and existing browser/restart/backup protections. Use fake accounts and mocked responses; do not obtain credentials, perform real sign-in, spend money, deploy, send invitations, or claim mock checks establish live functionality.

Return concrete findings ordered by severity with file/line, reproduction, impact and proposed fix. If you fix a confirmed issue, make a focused PR on your review branch against codex/chatgpt-personal. Clearly separate verified behavior from live-account checks that Jeremy must complete. Do not add unrelated features or rewrite the app.
