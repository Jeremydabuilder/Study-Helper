# Deployment: private owner site (My Helper + Study Helper) on Railway

**Status: never deployed.** Nothing in this repository has been run on Railway. The steps below are written from Railway’s dashboard flow as described in third-party search excerpts (the Railway and Groq documentation hosts could not be opened from the build environment), so **screen names and prices may differ — check them against Railway’s own pages as you go.** Everything inside the container (build commands, start command, health check, storage rules) was tested locally with a real PostgreSQL; the container image itself was **not** built here (see “What is not verified”).

Why Railway: Render is blocked on your network. The app needs one long-running Node process, a PostgreSQL database and a persistent folder for your study files (small per-user SQLite files). A host that only serves static files, or whose disk is wiped on each deploy, will not work. Railway offers a Dockerfile deploy, a PostgreSQL add-on and Volumes. **Other hosts that fit the same shape:** Fly.io (Dockerfile + volume + Postgres) or any small VPS running Docker. Nothing here is Railway-specific except the dashboard clicks.

You will pay for this (Railway has no free hosting that stays on); choose the plan yourself. Nothing in the repository buys or upgrades anything.

## What you are setting up

```
Browser (any device) ──HTTPS──▶ ONE Node service  ──▶ PostgreSQL service  (accounts, sessions, limits)
                                      │
                                      └──▶ Volume mounted at /data  (your homework, notes, My Helper data)
                                      └──▶ Groq (AI), key stored only as a service variable
```

Owner-only mode (`OWNER_ONLY=1`): one account, created on first start from `OWNER_EMAIL` and `OWNER_PASSWORD`. Guest entry, invitations, public sign-up, Google sign-in and the operator page are all switched off, in the server — not just hidden. Run exactly **one** instance; the app refuses to start a second one against the same database.

## Step by step (all in the browser)

1. **Put the code where Railway can read it.** Merge or choose the branch you want to deploy in GitHub (`Jeremydabuilder/Study-Helper`).
2. **Railway dashboard → New Project → Deploy from GitHub repo →** pick the repository and branch. Railway finds the `Dockerfile` in the repository root and builds from it. Let the first build fail or stop if it starts; it needs the settings below.
3. **Add the database:** in the project canvas choose **Create / New → Database → Add PostgreSQL**.
4. **Add the volume:** open the Node service → **Settings → Volumes** (or right-click the service on the canvas → *Attach volume*) → mount path **`/data`**. Without a volume your files disappear on every deploy. The app also refuses to start if the database has data but `/data` is empty (it assumes you forgot the volume).
5. **Give the service an address:** Node service → **Settings → Networking → Generate Domain**. Copy the `https://….up.railway.app` address.
6. **Set the variables** (Node service → **Variables**). Use *New Variable* for each. Replace the example values; **type secrets into the dashboard, never into chat, a file in the repository or a URL.**

   | Variable | Value |
   |---|---|
   | `APP_ENV` | `production` |
   | `DATA_LABEL` | `production` |
   | `DATABASE_URL` | the Postgres service’s connection URL — use Railway’s *variable reference* (`${{Postgres.DATABASE_URL}}`) so you do not copy it |
   | `PUBLIC_URL` | the generated `https://….up.railway.app` address (no trailing slash). Update it if you later add your own domain |
   | `BETTER_AUTH_SECRET` | a random string of 32+ characters (see “Making secrets” below) |
   | `APP_SECRET` | a **different** random string of 32+ characters |
   | `OWNER_ONLY` | `1` |
   | `OWNER_EMAIL` | the email address you will sign in with (it is never emailed anything) |
   | `OWNER_PASSWORD` | a long password you choose, **12+ characters**. Needed on first start; see “Changing the password” |
   | `OWNER_NAME` | the name shown in “Good morning, …” (default `Jeremy`) |
   | `AI_PROVIDER` | `groq` |
   | `GROQ_API_KEY` | your key from the Groq console (see below) |

   **Optional: let anyone use the study profile without an account** (they never see your private data; see [PUBLIC_STUDY_PROFILE.md](PUBLIC_STUDY_PROFILE.md)): add `PUBLIC_GUEST` = `1`, and set `PUBLIC_GLOBAL_DAILY` (default 400 assistant requests a day for all visitors together) and `PUBLIC_IP_DAILY` (default 40 per address) to numbers you accept. Leave it unset to keep the whole site private.

   Optional limits that protect the shared Groq allowance (all optional; defaults are conservative): `LIMIT_GLOBAL_DAILY_AI_REQUESTS`, `LIMIT_GLOBAL_DAILY_TOKENS`, `LIMIT_USER_DAILY_TOKENS`, `GROQ_RPM`, `GROQ_TPM`, `GROQ_MAX_CONCURRENT`, `GROQ_MODEL`. Leave `AUTH_GUESTS`, `GOOGLE_*` and `OPERATOR_*` unset: `OWNER_ONLY=1` already refuses to start if `AUTH_GUESTS=1` is also set.
7. **Health check:** Node service → **Settings → Deploy → Healthcheck Path** = `/readyz` (it checks the database and that `/data` is writable). **Replicas / instances: 1.**
8. **Deploy** (Deployments → Redeploy). Watch **Logs**: you should see the server start, the owner account created (the log says that it exists, never the password), and no error lines. Then open the domain.
9. **Sign in** with `OWNER_EMAIL` / `OWNER_PASSWORD`. Open **Settings** in the sidebar and check that the study assistant shows as available.
10. **Try it** with the steps in “Try it” below.

### Making secrets
Any password manager’s “generate 40 random characters” works. In a terminal: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (run it twice: one value for each secret). Keep them in your password manager — **if `BETTER_AUTH_SECRET` is lost or changed you are signed out; if `APP_SECRET` changes, stored Calendar tokens (not used here) become unreadable.**

### Adding the Groq key (browser only)
1. In the Groq console (console.groq.com) sign in → **API Keys → Create API Key**. Name it e.g. “my-helper”. Copy the key once.
2. Railway → Node service → **Variables → New Variable** → name `GROQ_API_KEY`, paste the key → **Add**; also set `AI_PROVIDER` = `groq`.
3. Railway redeploys. Reload the site; the Study Helper tab should say the live assistant is on.
4. To rotate it: create a new key in Groq, replace the variable, redeploy, then delete the old key in Groq.

Free-tier reality (from third-party summaries; **verify on your Groq “Limits” page**): the free allowance is shared by the whole account — roughly a few dozen requests per minute and about a thousand per day for the default model — and Groq can change it. For one person that is usually plenty; when it runs out, the site says so, keeps your work, and tells you roughly when to come back. The app does not upgrade you or switch provider automatically. If you want a paid Groq plan, you change that in Groq’s own dashboard.

### Changing the owner password or email
- **Password:** change `OWNER_PASSWORD` in Variables and redeploy. At start the app notices the value changed, sets the new password and **signs out every device**. (If you remove the variable after the first start, the existing password simply stays.)
- **Email:** the owner account is bound to the first `OWNER_EMAIL`. To change it, ask for a code change; the server will refuse to start rather than quietly create a second account.

### If you forget the password
Set a new `OWNER_PASSWORD` and redeploy. There is no “forgot password” email, on purpose (no outside door).

## Try it (the exact steps)
1. Open the site in a **private window** first: you should see only the sign-in box, no sign-up, guest or invitation option.
2. Visit `https://YOUR-ADDRESS/api/myhelper/state` while signed out → `401`. (Also `/api/items`, `/api/memory`: all `401`.)
3. Sign in. You land on **Today** with your name. The sidebar shows **Today, School, Projects, Study Helper**.
4. **School → Add with instructions…** → paste a few lines of a worksheet → **Save & open in Study Helper**. The homework workspace opens with those lines. Go back to School: still one assignment, now marked “In Study Helper”.
5. **Study Helper → Start from an assignment / Make a quiz from my notes** → paste notes → answer a question.
6. **Import your old data** (next section). Reload the page. Sign in from your phone with the same email and password; the same data is there.
7. In Railway press **Redeploy** → after it is back, reload: everything is still there.

## Moving your existing My Helper data
Your old data lives in the browser that used the original file, under the name `myHelperState`. It cannot be read from another browser or computer, so export it **there**:
1. Open `legacy/my-helper-with-export.html` from this repository in the **same browser and the same way** you opened your original file (a file opened from a different folder or address is a different storage area). It is your original page plus one button. Check that your tasks and projects appear.
2. Press **Export my data (for the hosted version)**. A file `my-helper-export.json` downloads.
3. If you can only reach the original page unchanged: open it, press F12 → Console, run `copy(localStorage.getItem('myHelperState'))`, and paste the result into the import page’s “paste it instead” box.
4. On the hosted site: **Import old data** (sidebar) → choose the file. A **preview** lists what would be added (new vs. already here). Nothing is saved until you press **Import**. Pressing it again, or importing the same file a second time, adds nothing: the preview then says “Everything in this file is already here”.
- School tasks become School assignments (the same list the Study Helper tab works on); Personal and Project tasks and your projects keep their own lists; memory notes join Study Helper’s memory (identical notes are not duplicated). “Today / Tomorrow” become real dates counted from the day each task was created; “This week” stays undated rather than invent a deadline.

## Backups and keeping your work
- Everything lives in two places: the Postgres service and the `/data` volume. **Back up both.** Railway’s own backup features and prices are described on its site (unverified here). The app can also export your data: **Settings → Download my data**.
- Never delete the volume or the database to “start fresh” unless you mean to.
- The app writes a marker file in `/data` so a deploy with a missing/empty volume is refused instead of silently starting empty.

## What is not verified (be honest with yourself about these)
- **The container image was not built here** (the build sandbox’s network blocked `npm ci` inside Docker). The same commands (`npm ci`, `npm run build:hosted`, `node dist-server/main.mjs`) were run directly and pass; the first Railway build is the first real test of the Dockerfile.
- **No real Railway deployment, HTTPS request or volume was exercised.** Secure cookies behind Railway’s proxy depend on `PUBLIC_URL` being `https://…` and the proxy forwarding the original scheme; test sign-in over the real address, and if you are bounced back to sign-in, tell me what the Logs say.
- **No live Groq call was made.** All AI behaviour was tested against scripted fakes. The model default is `openai/gpt-oss-120b`; if Groq renamed it the assistant will say it is unavailable — then set `GROQ_MODEL` to a model your Groq account lists.
- **School network:** unknown until you try the `*.up.railway.app` address from school.
- Railway steps and prices come from excerpts, not from reading Railway’s documentation.

## Rollback
Railway → Deployments → pick an earlier successful deployment → *Redeploy*. Database migrations only add things; an older build ignores new tables. Restoring data is a separate step (backups above).

## Local checks that match what runs in the container
```
npm ci
npm run typecheck
npm test               # needs PostgreSQL: TEST_DATABASE_URL=postgres://… REQUIRE_PG=1
npm run build:hosted
npm run test:e2e:owner # real browser, real PostgreSQL, scripted AI
npm run rehearse:prod  # built bundle: restart, backup/restore, single instance
```
Friends/guest mode (invitation codes for 3–5 classmates) is a different configuration of the same app; see [GUEST_MODE.md](GUEST_MODE.md).
