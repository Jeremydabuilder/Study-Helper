# Personal Study Helper with your ChatGPT account

This mode runs on your own computer. It does not require Render, a public website, an API key or an API billing fallback. It uses the official, opt-in ChatGPT plan authorization for eligible local personal apps. It generates NEW responses: it cannot send into an existing ChatGPT conversation, read its history, or inherit ChatGPT memory. Study context comes from the notes and memory saved in Study Helper. Plan eligibility, availability, limits and credits are controlled by OpenAI.

## Start

1. Install Node 22.13+ and run `npm ci` in the repository.
2. Run `npm run personal`. This builds the browser/server and starts a local server restricted to `127.0.0.1`. Use the branch/PR containing this feature, not an older clone.
3. Open `http://127.0.0.1:8787/#/settings` (or the port printed by the server). Use this direct address for account connection, not the Vite development proxy or a public tunnel.
4. Click **Continue with ChatGPT**. In OpenAI's browser page, choose the SAME account and workspace you use for this chat and approve plan use. This project never reads ChatGPT cookies, Codex credentials or account tokens from other apps. We cannot choose the current ChatGPT account automatically.
5. Check the verified email in Settings. Choose one of the account's returned models and dismiss the first-use confirmation. Model and plan selection apply to new requests.
6. Paste fictional notes and ask for a hint in Homework or Chat. Compare the answer with the source. Only this real sign-in and completed request establish live functionality; mock tests do not.

The app never automatically switches account, provider, or payment method. A later authorization must match the previously verified issuer, subject and issued client ID. Reconnect the original account if prompted. The app keeps this binding after disconnect; deliberate rebinding is not exposed in this version.

## Data and limits

Your study data stays in the usual local data folder. Private host identity and credentials are in `DATA_DIR/chatgpt-auth/`, excluded by the repository's `data` ignore rule for the default data directory. If you override DATA_DIR, keep it outside git and do not share it. Credential files use atomic writes with owner-only file permissions on Unix. Use a private user-owned folder on Windows; do not put it in a shared/synced directory. Credentials are not put in frontend responses, application exports, logs or the hosted backup bundle. Local disk access to this folder gives access to the saved connection.

**Disconnect** deletes the local tokens and stops new plan calls. It does not revoke OpenAI's grant; use **Manage usage** in ChatGPT to revoke access or adjust limits. Already-started requests may finish. Your notes remain.

Subscription/credit limits apply. The app also keeps its local daily request allowance. Plan calls use zero API-dollar estimates in the local ledger; this is NOT a promise of unlimited plan usage or no credit consumption. Manage actual usage in ChatGPT settings. Photos/OCR are not supported by this integration yet; paste text.

## Implementation and verification

- Official dynamic registration, stable per-installation host identifier, browser-bound expiring state, OIDC nonce and PKCE S256.
- Validates ID-token signatures through jose using OpenAI's JWKS, issuer/audience/expiry/subject/nonce, and the explicit plan/resource scopes. Callback codes are single-use.
- Tokens stay server-side. Concurrent expiry refreshes share one operation; rotating tokens are replaced together. Failed consent does not replace a working connection.
- Uses only `api.openai.com/v1/models` and `/responses`, account-advertised model slugs, `store:false`, `stream:true`, developer instructions and the app's necessary context. No private ChatGPT backend endpoints. No unsupported max_output_tokens, temperature, system message items or previous_response_id.
- A streamed answer succeeds only after `response.completed`. Partial output followed by a usage error, an incomplete answer or a dropped connection is refused as a successful answer.
- Hosted multi-user mode refuses AI_PROVIDER=chatgpt. Do not share this personal server or its credentials with friends.
- Live sign-in, renewal, real tutoring quality and account eligibility remain unverified until you test with your own account.

Official references checked November 1, 2026:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/ui-ux-guidelines
