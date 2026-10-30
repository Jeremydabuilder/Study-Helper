# Live checks: what is still unverified, and the shortest way to verify it

Everything here needs something only you can provide. Never paste a secret into chat; enter secrets in the Render dashboard (they are `sync: false`). Use fictional material only. Mark each line only after you saw it work.

**One-time setup (about 20 minutes)**
1. Render: create the staging blueprint (`DEPLOYMENT.md`). Open the `…onrender.com` address; `/readyz` should say ready.
2. Google (optional for staging, required for production): OAuth client, redirect URI `https://<staging address>/api/auth/callback/google`, add your own account as a test user. Put `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in the dashboard and redeploy.
3. Anthropic (optional): put `ANTHROPIC_API_KEY` in the dashboard; set a provider-side spend cap first; keep `LIMIT_GLOBAL_DAILY_USD=0.5`.

**Checks (about 20 minutes, with made-up notes)**
- [ ] Sign in with Google using a staging invitation (`npm run seed:staging -- --count 2` in the Render shell). A second browser without a code is refused.
- [ ] Paste a few made-up notes, let the assistant propose concepts, answer one question in words: you get graded feedback.
- [ ] Homework: paste a made-up worksheet, type working with one wrong step, Check my work (exact), then Give me a hint (assistant).
- [ ] Upload a photo of a printed made-up page; compare what was read with the original (only if you enabled OCR).
- [ ] Restart the service in Render; reload; everything is still there.
- [ ] Run `npm run smoke:ai -- --confirm-spend` in the shell once; it reports usage and cost.
Until a line is ticked, the matching feature is described as **unverified** everywhere, including to your friends.
