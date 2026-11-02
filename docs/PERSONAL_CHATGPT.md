# Personal Study Helper with your ChatGPT account

This mode runs on your own computer. It does not require Render, a public website, an API key or an API billing fallback. It uses the official, opt-in ChatGPT plan authorization for eligible local personal apps. It generates NEW responses: it cannot send into an existing ChatGPT conversation, read its history, or inherit ChatGPT memory. Study context comes from the notes and memory saved in Study Helper. Plan eligibility, availability, limits and credits are controlled by OpenAI.

## Start

**Windows (PowerShell), the usual case**

1. Install Node.js 22.13 or newer (the current LTS from https://nodejs.org). Open a **new** PowerShell and check `node -v`.
2. Get this branch and enter its folder, for example `cd C:\Users\<you>\Study-Helper`, then run `npm ci` once.
3. Keep the saved sign-in out of any cloud-synced folder. If the repository is inside OneDrive, Dropbox, iCloud Drive or Google Drive, point the connection folder somewhere private **before the first start**:
   ```powershell
   $env:CHATGPT_AUTH_DIR = "$env:LOCALAPPDATA\StudyHelper\chatgpt-auth"
   $env:DATA_DIR = "$env:LOCALAPPDATA\StudyHelper\data"   # optional: also keeps your study notes out of the sync
   ```
   (Study Helper refuses to start a sign-in whose folder looks synced, and tells you so in Settings. Set the variables again in each new PowerShell window, or use `setx` once and open a new window. Always use the same folder: the account binding lives there.)
4. Run `npm run personal`. It builds, then serves **only** on `http://127.0.0.1:8787` (Windows may not show a firewall prompt because nothing listens on the network). Stop it with `Ctrl+C`.
5. Open `http://127.0.0.1:8787/#/settings` (use this address, not `localhost`, not a tunnel, not the Vite dev server).

**macOS / Linux:** the same, with `export CHATGPT_AUTH_DIR="$HOME/.local/share/study-helper/chatgpt-auth"` if the repository is inside a synced folder.

**Then, in the browser**

1. Click **Continue with ChatGPT**. On OpenAI's page choose the SAME account and workspace you use for this chat and approve plan use. This project never reads ChatGPT cookies, Codex credentials or tokens from other apps. We cannot pick your current ChatGPT account for you.
2. Settings shows the verified email. Check it. Choose one of the models your account returns, and dismiss the first-use note.
3. Paste fictional notes and ask for a hint in Homework or Chat. Compare the answer with the source. Only this real sign-in and a completed request establish live functionality; mock tests do not.

The app never automatically switches account, provider, or payment method. A later authorization must match the previously verified issuer, subject and issued client ID, and a different account is refused with a plain message. The binding is kept after disconnect and restart. There is deliberately no button to rebind. To change accounts on purpose: close Study Helper, delete the `chatgpt-auth` folder (inside `DATA_DIR`, or where `CHATGPT_AUTH_DIR` points), start again and connect the new account. That also creates a new host identifier.

## Data and limits

Your study data stays in the usual local data folder. Private host identity and credentials are in `DATA_DIR/chatgpt-auth/`, excluded by the repository's `data` ignore rule for the default data directory. If you override DATA_DIR, keep it outside git and do not share it. Credential files use atomic writes with owner-only file permissions on Unix. On Windows file modes do nothing, so at start the folder is restricted to your Windows account (and the system account) with `icacls`; if Windows refuses, a warning is printed and you must keep the folder somewhere only you can open. The folder is never allowed to sit inside a cloud-synced folder (see above). The tokens are stored as plain JSON protected only by those permissions (unlike Calendar tokens in the hosted app, they are not encrypted). Credentials are not put in frontend responses, application exports, logs or the hosted backup bundle. Local disk access to this folder gives access to the saved connection. Anyone who can open `http://127.0.0.1:8787` on this computer (another account on a shared PC, or a program you run) can use the connected plan through Study Helper, so use this mode only on a computer you alone use. Run only ONE Study Helper per connection folder: two processes renewing the same rotating token invalidate each other.

**Disconnect** deletes the local tokens and stops new plan calls. It does not revoke OpenAI's grant; use **Manage usage** in ChatGPT to revoke access or adjust limits. Already-started requests may finish. Your notes remain.

Subscription/credit limits apply. The app also keeps its local daily request allowance. Plan calls use zero API-dollar estimates in the local ledger; this is NOT a promise of unlimited plan usage or no credit consumption. Manage actual usage in ChatGPT settings. Photos/OCR are not supported by this integration yet; paste text.

## Implementation and verification

- Official dynamic registration, stable per-installation host identifier, browser-bound expiring state, OIDC nonce and PKCE S256.
- Validates ID-token signatures through jose using OpenAI's JWKS, issuer/audience/expiry/subject/nonce, and the explicit plan/resource scopes. Callback codes are single-use.
- Tokens stay server-side. A token is renewed when under a minute remains, and a request the provider refuses (401) renews once and is sent again. Concurrent renewals share one operation; rotating tokens are replaced together and are never discarded because you changed the model or opened Settings meanwhile. If the provider says the saved sign-in is permanently ended (`refresh_token_reused`, `refresh_token_invalidated`, `invalid_grant`), the local tokens are cleared, the account binding is kept and Settings asks you to reconnect. Failed consent does not replace a working connection, and a forged link cannot cancel a sign-in in progress.
- Uses only `api.openai.com/v1/models` and `/responses`, account-advertised model slugs, `store:false`, `stream:true`, developer instructions and the app's necessary context. No private ChatGPT backend endpoints. No unsupported max_output_tokens, temperature, system message items or previous_response_id.
- The sign-in return page is exempt from the same-origin check (OpenAI's redirect may carry its Origin); it is protected by the one-use state, the browser-bound cookie and the nonce instead. All other routes still refuse a foreign Origin or a non-loopback Host.
- A streamed answer succeeds only after `response.completed`; text delivered as streamed output items is used only when that completed event carried none. Partial output followed by a usage error, an incomplete answer or a dropped connection is refused as a successful answer.
- Hosted multi-user mode refuses AI_PROVIDER=chatgpt. Do not share this personal server or its credentials with friends.
- Live sign-in, renewal, real tutoring quality and account eligibility remain unverified until you test with your own account. See `docs/PERSONAL_CHATGPT_REVIEW.md` for exactly what is verified by mocks and what only a live account can show.

Official references checked November 1, 2026:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/ui-ux-guidelines
