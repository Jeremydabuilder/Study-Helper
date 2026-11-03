# Live checks (only you can do these)

Everything here needs something only you can provide: a hosting account, the owner password, a Groq key. Never paste a secret into chat; type secrets into the hosting dashboard's variable screen. Use fictional or low-stakes material first. Mark a line only after you saw it work.

## Owner site (see DEPLOYMENT.md for the steps)
- [ ] Deploy on Railway (or another Docker + Postgres + volume host). `https://YOUR-ADDRESS/readyz` says ready.
- [ ] Private window: only the sign-in box is shown. Signed out, `/api/myhelper/state` and `/api/items` return 401.
- [ ] Sign in with `OWNER_EMAIL` / `OWNER_PASSWORD` over HTTPS and stay signed in after a reload (this proves the secure cookie works behind the host's proxy).
- [ ] Sign in from a second device or browser.
- [ ] Study Helper tab: the live assistant is shown as on. Ask for a hint on a homework question; a real Groq answer comes back. (Not tested anywhere else.)
- [ ] School → Open in Study Helper shows the instructions you typed; School still lists one copy.
- [ ] Export from the original HTML → Import old data → preview → Import. Import again: nothing new.
- [ ] Redeploy / restart the service in the dashboard; reload; everything is still there (proves the volume and database persist).
- [ ] Open the address from the school network (unknown until tried).

## Friends mode (only if you use it)
- [ ] `AUTH_GUESTS=1`, `OPERATOR_TOKEN` set; create a code at `#/operator`; a friend's browser opens a private workspace with it; the same code fails the second time.
- [ ] Two friends use the assistant at once and see friendly "try again in …" messages, not errors, when Groq's shared allowance is tight.
