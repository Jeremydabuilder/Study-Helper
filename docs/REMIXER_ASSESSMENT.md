# DreamHost Remixer: compatibility assessment

**Result: not established.** Remixer's official documentation could not be read in this environment, so nothing below is a verified compatibility claim. This file records what was and was not found, and what adaptation would be needed *if* the unverified assumptions hold.

## What was consulted
- `help.dreamhost.com` (the Remixer overview knowledge-base article) and `console.groq.com`: **not reachable** from the build sandbox (the hosts are outside its allowed network domains), so their pages were not read.
- Search-result excerpts only (not the official page bodies): DreamHost's June 12, 2026 announcement ["DreamHost Expands Remixer into an AI Website and App Builder"](https://www.dreamhost.com/news/press-releases/dreamhost-expands-remixer-into-an-ai-website-and-app-builder/), and DreamHost's ["Build Real Apps with Remixer"](https://www.dreamhost.com/news/announcements/meet-app-builder-remixer/) post. The excerpts say Remixer generates a frontend, backend, database and sign-in from a chat prompt; that apps can "sign in users, store files, keep secrets, and run server-side actions at runtime"; that it lists secure storage of API keys as a feature; and that AI actions draw on plan credits. The Knowledge Base overview is listed at <https://help.dreamhost.com/hc/en-us/articles/46355723313812-Remixer-overview>.

## What could not be verified (do not assume any of it)
- Whether Remixer can **import an existing GitHub repository** at all (the sources found describe building from prompts and reopening Remixer projects, not importing repositories).
- What runtime "server actions" use (language, Node version, request size and time limits, outbound network access to `api.groq.com`), and whether arbitrary dependencies can be installed.
- How secrets are stored and exposed to server actions (names, scoping, whether they appear in the browser bundle or logs).
- Whether a Remixer project provides PostgreSQL, a writable persistent folder, or a long-running process.

## What this repository needs, and the likely gap
The full owner site is an Express server with PostgreSQL, a persistent folder of per-user SQLite files, a startup lock for a single instance, and sign-in. Nothing found suggests Remixer can host that; treat it as **incompatible until DreamHost's documentation or support says otherwise**. (DreamHost also advertises always-on Node.js VPS hosting at <https://www.dreamhost.com/hosting/vps/nodejs/>; whether it fits this app was not assessed.)

The **public no-account study profile** is a different shape and is the only part that might port:
- the browser app is static (`npm run build` → `dist/`), with the profile in the visitor's `localStorage`;
- its server needs are seven small stateless endpoints (`/api/public/status|extract|hint|quiz|check|chat|byok/test`) that hold no data. They are plain functions of (request, optional visitor key header) → JSON, defined in `src/server/hosted/publicApi.ts` with the transport in `src/ai/byok.ts`.
If Remixer's server actions can make outbound HTTPS calls, accept custom request headers and keep an operator secret, those could in principle be re-implemented as actions, the visitor key passed in a header, and the operator's `GROQ_API_KEY` kept in the platform's secret store. The per-address and daily caps use PostgreSQL counters here and would need a replacement store, or be dropped in favour of BYOK-only.

## Adaptation checklist (all unverified, in the order to check)
1. Ask DreamHost (or read the Remixer docs once `help.dreamhost.com` is reachable) whether a GitHub repository can be imported, and what languages and limits server actions have.
2. Confirm outbound access to `https://api.groq.com/openai/v1/chat/completions` from a server action, and that request headers reach it.
3. Confirm how secrets reach actions and that they never reach the browser bundle or logs.
4. If all three hold: build `dist/` as static files, port the seven endpoints, drop the owner site, PostgreSQL and the volume, and run the BYOK tests (`tests/byok.test.ts`, `tests/hostedByok.test.ts`) against the ported endpoints as a specification.
No part of this was attempted, and no Remixer project was created.
