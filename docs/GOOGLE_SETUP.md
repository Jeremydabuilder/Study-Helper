# Google Calendar setup (read-only)

> **Status of this guide.** Written from Google's documented OAuth flow. Google's developer docs were not reachable from the environment where this was written, and no real Google credentials were available, so **the live Google flow has not been run**. The app's OAuth, refresh, revocation and read-only behaviour is covered by tests against a fake Google server (see README → What was tested). Google renames console screens from time to time; if a label below differs, follow the intent and check Google's current OAuth documentation.

## What the app asks for

- One scope only: `https://www.googleapis.com/auth/calendar.readonly` — view events on calendars you choose.
- It cannot create, edit or delete events. Study sessions you plan stay inside the app.
- It cannot see **Google Classroom** assignments or anything in a school portal. Only what is on a calendar. Add other assignments by hand.
- Access tokens and the refresh token stay on this server, encrypted with `APP_SECRET` (AES-256-GCM). They are never sent to the browser or logged.

## Steps

1. **Create / pick a Google Cloud project** at https://console.cloud.google.com/ (a personal project is fine).
2. **Enable the Google Calendar API** (APIs & Services → Library → "Google Calendar API" → Enable). If sync later says the API is not enabled, this step was missed.
3. **Configure the OAuth consent screen** (APIs & Services → OAuth consent screen / "Google Auth Platform"):
   - User type **External** (a personal Gmail) or **Internal** (only if your own Workspace organisation owns the project).
   - Fill in the app name and your email.
   - Add the scope `.../auth/calendar.readonly` (it is a *sensitive* scope).
   - While the publishing status is **Testing**, add your Google account under **Test users**.
4. **Create credentials**: APIs & Services → Credentials → *Create credentials* → **OAuth client ID** → Application type **Web application**.
   - **Authorized redirect URIs** → add exactly:
     `http://localhost:8787/api/calendar/oauth/callback`
     (If you change `PORT`, change the port here and in `GOOGLE_REDIRECT_URI`.) Google matches redirect URIs **exactly** — scheme, host, port and path. `localhost` and `127.0.0.1` are different; browse the app at the same host you registered. `http://` is only acceptable for localhost; any real host must be `https://`.
   - No "Authorized JavaScript origins" are needed (the browser never talks to Google directly).
5. **Fill in `.env`**:
   ```
   GOOGLE_CLIENT_ID=<ends with .apps.googleusercontent.com>
   GOOGLE_CLIENT_SECRET=<from the same dialog>
   GOOGLE_REDIRECT_URI=http://localhost:8787/api/calendar/oauth/callback
   APP_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   ```
6. `npm run doctor` — it checks the variables and the redirect URI format without printing secrets. Restart the app.
7. In the app: **Plan → Calendar → Connect Google Calendar (read-only)**, approve on Google's page, choose which calendars to include (nothing is imported until you tick one), press **Sync now**, then confirm the proposed tests/homework.

## Things that will happen (and are handled)

| Situation | What you will see |
|---|---|
| "Google hasn't verified this app" warning | Expected for a personal project using a sensitive scope in Testing mode. Continue → Advanced → go to the app (you must be listed as a test user). |
| **Testing mode refresh tokens last ~7 days** | Per search results quoting Google's setup docs, a project in *Testing* status gets refresh tokens that expire after 7 days. The app then shows **"Calendar needs reconnecting"**; imported events, items and manual entry are kept. Press *Reconnect*. Moving the consent screen to *In production* is how Google avoids this, and may require Google's app verification for the sensitive scope; that is a decision for the account owner. |
| Access denied / closed the window | "Access wasn't granted, so nothing was connected." |
| School/Workspace admin blocks third-party apps (`admin_policy_enforced`, 403) | An explanation plus the options: ask an administrator to allow the app, share the school calendar to a personal calendar and connect that, or use manual entry. Nothing is lost. |
| Calendar API not enabled | "The Google Calendar API is not enabled for this app's Google Cloud project." |
| Rate limited | "Google is asking us to slow down" — try again shortly. |

## Disconnecting

*Plan → Calendar → Disconnect / delete data…* asks Google to revoke the grant, wipes the stored token, and (optionally) deletes everything imported; confirmed items can be kept as manual items. You can also remove access at https://myaccount.google.com/permissions.

## Verifying it end to end yourself (about 5 minutes)

1. Connect; tick one calendar; Sync. Check the proposals show the original event beside what the app would add, with unknowns marked.
2. In Google Calendar move one test event and cancel another. Sync again. The moved item shows "event changed" with the new date; the cancelled one is paused, not deleted.
3. Disconnect; confirm in https://myaccount.google.com/permissions that access is gone.
4. Confirm nothing in your Google Calendar was modified (it cannot be; the scope is read-only).
