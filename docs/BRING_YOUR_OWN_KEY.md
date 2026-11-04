# Bring your own Groq key (no-account visitors)

Visitors who use Study Helper without an account can run its AI actions on **their own Groq account**. Open **Settings** in the public app. It needs `PUBLIC_GUEST=1` on an owner-only site ([PUBLIC_STUDY_PROFILE.md](PUBLIC_STUDY_PROFILE.md)); it is on by default there and `PUBLIC_BYOK=0` turns it off.

## For a visitor (what the Settings page does)
1. Paste a Groq API key (the field is masked; **Show/Hide** toggles it). Pick a model (default `openai/gpt-oss-120b`, or any name from your Groq account).
2. **Test connection** sends one small real request (a 16-token chat completion) and says plainly: *Connected*, *Invalid key*, *Access refused*, *Model unavailable*, *Rate limit* (with the wait), *Network error*, *No answer in time* or *Groq problem*. The button is disabled while the test runs, so repeated clicks make one request.
3. **Use key** starts using it. By default it lives **in memory for this tab only** and is gone after a reload or closing the tab.
4. **Remember on this device** (unchecked by default) saves it in the browser's `localStorage` so it survives reloads. The page warns: anyone who can use that browser profile can read it, and so can any script running on this site's address; do not use it on a shared or public computer.
5. **Remove key** clears every place the app put it (memory and `localStorage`). **Clear everything** on the profile page also removes it, along with drafts and the profile.

AI requests then use that Groq account and its limits. While a visitor's key is set it is the only thing used: if Groq refuses it, the visitor sees the reason and a link to Settings; the site's key is never used instead.

Before a key is set: planning, practice cards, review and manual setup all work. Any AI action says what it needs and links to Settings, and what was typed (homework question, attempt, chat message) stays in its box and survives a trip to Settings (same-tab `sessionStorage`).

Which actions use the key: onboarding analysis of pasted notes, homework hints, quiz questions and answer checks (Practice and Review), and the new Chat page.

## For the site owner
- `PUBLIC_OPERATOR_AI` (default **off**): lets visitors without a key use *your* Groq key within the shared daily caps in PUBLIC_STUDY_PROFILE.md. With it off, strangers can only use the AI by bringing their own key, so your Groq allowance is never spent on them. (This is a change from the first version of the public mode, which spent your allowance by default.)
- `PUBLIC_BYOK` (default on), `PUBLIC_BYOK_PER_MIN` (default 20 AI requests a minute per address), `PUBLIC_BYOK_TEST_PER_MIN` (default 6 key tests a minute per address).
- Your own `GROQ_API_KEY` is never read, replaced or exposed by any of this.

## Why the server relays the request, and how the key is protected
Whether Groq accepts requests made directly from a web page (CORS) could **not be verified**: Groq's documentation host and API are not reachable from the build environment, and the sources found disagree. A server relay works either way, so that is what is built. The relay:
- accepts the key **only in a request header** (`x-groq-key`), never in a URL or body, and ignores a key placed in the address;
- checks its shape (letters, digits, `-`, `_`, 20–256 characters) and the model name before anything is sent;
- sends it **only** to `https://api.groq.com/openai/v1/chat/completions` as a Bearer header, with redirects refused so it can never be carried to another address;
- builds a fresh provider for every request: no cache, no shared state between visitors, no connection to the site's key, ledger or capacity guard;
- never writes it, or anything from a failed Groq reply, to logs, the database, metrics, error reports or responses (errors use fixed text);
- limits request size (64 KB), time (30 s per request, 20 s per test), requests per minute and concurrent requests per address.
A key held in the browser is readable by any script on this site's origin; the site loads scripts only from itself (see the content security policy) and has no third-party scripts, but an injected script would still see it. A key in `localStorage` is also readable by anyone using that browser profile.

## Checked and not checked
Checked (automated, stand-in for Groq, **no real Groq request**): `tests/byok.test.ts` (fixed address, redirect refusal, each failure kind, no key or reply text in messages, timeout, key/model validation), `tests/hostedByok.test.ts` (relay only with a key, no fallback to the site's key for six failure kinds, visitor isolation under concurrency, key absent from logs, all database tables, responses, headers and URLs, limits, owner routes still 401), `tests/guestKeystore.test.ts` (memory-only default, remember, remove clears both, damaged storage, export/import carry no credentials, planted credentials dropped), `e2e-byok/` (real browser: Settings flow and all outcomes, no double requests, draft preservation, reload, remember/remove, export, two visitors).
**Not checked:** a real Groq request with a real key; that `openai/gpt-oss-120b` or the suggested models exist today or what a real 401/404/429 body looks like (the mapping follows the documented-style statuses 401/403/404/429/5xx and is untested against Groq); Groq's CORS behaviour (irrelevant to the relay, but it means a direct-from-browser option was not built); the relay's behaviour behind a real HTTPS proxy; access from the school network.
