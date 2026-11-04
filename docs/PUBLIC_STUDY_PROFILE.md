# Public study profile (no account)

Turn on `PUBLIC_GUEST=1` on an **owner-only** site (`OWNER_ONLY=1`, see [DEPLOYMENT.md](DEPLOYMENT.md)) and anyone who opens the address can use Study Helper without an account. The owner still signs in at `#/owner` and keeps the private My Helper site, assignments, uploads, study history and AI requests behind the owner login. Without `PUBLIC_GUEST=1` nothing changes: a signed-out visitor sees only the owner sign-in.

## What a visitor gets
- **Build my study profile**, with three choices: **Paste notes**, **Answer questions**, **Skip for now** (add assignments by hand).
- **Paste notes**: a large paste is allowed (limit **200,000 characters**, `PUBLIC_MAX_PASTE_CHARS`, hard maximum 500,000; the counter shows it and anything beyond is not read). Notes are read in the browser first by plain rules. The visitor may also let the assistant read them: then the text goes, in up to 6 parts of about 6,000 characters (`PUBLIC_AI_MAX_CHUNKS`, `PUBLIC_AI_CHUNK_CHARS`), to this server and on to Groq. The page says so before anything is sent. Text beyond those parts is read by the browser rules only, and the page says that too.
- **Preview before saving.** Assignments (with due date, class, type, minutes), recurring commitments (days and times), classes, preferences and goals appear in an editable preview. Dates that needed a guess (a bare weekday, `3/4` that could be day/month, a date already passed, no year) are marked **Date is a guess** and shown with the reason. Possible duplicates of something already saved ask: update the one I have / keep both / skip, and are never merged silently. Things inferred about the person (sleep, study habits, goals) and everything the assistant found are **unticked** until the visitor ticks them.
- **Pasted text is data.** Lines that read like instructions to an AI ("ignore previous instructions…") are set aside, listed and never used. Everything sent to the model is wrapped as quoted data with a fixed system prompt, closing tags inside the text are neutralised, and the answer is validated and clipped before it is shown.
- **Answer questions**: five opening questions (classes, deadlines, commitments such as sports, typical sleep hours, what help is wanted), all skippable, then follow-ups chosen by fixed rules only when an answer would change the plan and the profile does not already hold it (so confirmed notes are never asked again), at most 20 in all. Finish any time; resume from the same place later. Deadlines and commitments typed as answers are previewed like pasted ones.
- **Today plan** from confirmed items: deadlines first, inside the time that is really free (after-school hours or weekend hours, minus today's commitments, bedtime from the sleep answer, and the study minutes the visitor says they have). Every block says why it is there; what does not fit is listed, not squeezed in; guessed dates are flagged. Each block opens a concrete action: **Get a hint** (homework help), **Start practice** (retrieval practice from the visitor's notes), **Start review** (cards due again).
- **Homework hint**, **Quiz** and **Review** work with the assistant off: general steps to try, practice questions made from the notes by plain rules, and a five-box review schedule where misses come back sooner. With the assistant on, a hint, better questions and answer checks are added.
- **My profile**: view and edit everything, export a copy (JSON), import a copy, and **clear everything**.

## Where data lives
- The profile and notes are in the browser's `localStorage` on that device only (`sh.guest.profile.v1`). The server has **no account, no copy and no log of them**. Another browser or device starts empty; clearing site data erases it; the page says so and offers an export.
- Later assistant calls send only what is needed: a hint sends the question, the attempt, up to 3 short passages of notes chosen because they match the question, and at most the class name, first goal and usual difficulty. Practice questions send up to 4 short passages. The hint page shows exactly this before sending. The whole profile is never sent.
- The server stores only counters (a keyed hash of the visitor's address, a day, a count). Addresses, text and answers are not stored or logged.

## Who pays for the AI
By default **visitors bring their own Groq key** (Settings; see [BRING_YOUR_OWN_KEY.md](BRING_YOUR_OWN_KEY.md)) and your Groq key is never used for strangers. Set `PUBLIC_OPERATOR_AI=1` only if you want visitors without a key to use your allowance too, within the caps below. A visitor who set their own key never falls back to yours.

## Protection of the shared Groq allowance (applies when `PUBLIC_OPERATOR_AI=1`)
Public routes are the only ones open to signed-out visitors (`/api/public/status|extract|hint|quiz|check`). Each AI route is limited, in order:
1. request size (64 KB; an oversize body is refused before it is read) and strict field limits;
2. per address per minute (`PUBLIC_IP_PER_MIN`, default 8);
3. per address per day (`PUBLIC_IP_DAILY`, default 40, counted in PostgreSQL);
4. one shared daily cap for all public visitors together (`PUBLIC_GLOBAL_DAILY`, default 400);
5. the site-wide ledger the owner already has: daily request/token/spend caps (`LIMIT_GLOBAL_DAILY_*`), the Groq capacity guard (per-minute pacing, cooldown after a refusal) and the concurrency limit;
An allowance that was taken but never reached the provider is given back. When any limit is hit the visitor gets a plain message, the rest of the app keeps working, and the assistant buttons wait.
Behind a host's proxy the address comes from the proxy (`TRUST_PROXY`, on by default, one hop). Per-address limits are only as good as that header: they bound casual overuse, they do not stop a determined attacker with many addresses; the shared daily caps are what bound the owner's spend. Set `PUBLIC_GLOBAL_DAILY` to a number you are comfortable with, and keep the Groq account on its Free tier unless you decide otherwise.

## Settings
`PUBLIC_GUEST=1` (needs `OWNER_ONLY=1`), `PUBLIC_OPERATOR_AI`, `PUBLIC_BYOK`, `PUBLIC_BYOK_PER_MIN`, `PUBLIC_BYOK_TEST_PER_MIN`, `PUBLIC_MAX_PASTE_CHARS`, `PUBLIC_AI_CHUNK_CHARS`, `PUBLIC_AI_MAX_CHUNKS`, `PUBLIC_IP_PER_MIN`, `PUBLIC_IP_DAILY`, `PUBLIC_GLOBAL_DAILY`. Add them in the Railway **Variables** screen like the others; no secret is involved. Remove `PUBLIC_GUEST` to switch it off.

## Checked, and not checked
Checked locally (real PostgreSQL, real browser, scripted AI): `tests/guestEngine.test.ts`, `tests/hostedPublic.test.ts`, `e2e-public/`. **Not** checked: any live Groq request (extraction quality on real notes is unknown), any real deployment, HTTPS or proxy address handling, access from the school network, mobile Safari, and how well the plain rules read notes written in styles other than the examples. The rules are deliberately cautious: when they are unsure they ask in the preview.
