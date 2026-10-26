/**
 * Calendar access behind a small gateway interface. The Google implementation requests ONLY the
 * read-only calendar scope. Tokens never leave the server.
 */
import type { RawGoogleEvent } from '../../core/calendar';

export const READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export interface TokenSet { access_token: string; refresh_token?: string; expires_at: number; scope: string }
export interface RemoteCalendar { id: string; name: string; tz: string; color: string | null; primary: boolean }

export type CalendarErrorCode = 'reauth_required' | 'org_blocked' | 'denied' | 'rate_limited' | 'unavailable' | 'not_configured' | 'api_disabled';
export class CalendarError extends Error {
  constructor(public code: CalendarErrorCode, message: string) { super(message); }
}

export const FRIENDLY: Record<CalendarErrorCode, string> = {
  reauth_required: 'Google access has expired or was revoked. Reconnect to keep syncing — everything already imported stays, and manual entry keeps working.',
  org_blocked: 'Your school or organisation’s Google settings are blocking this connection. A school-managed account often can’t authorise third-party apps. You can ask an administrator, connect a personal calendar that the school calendar is shared with, or just add tests and homework by hand — manual entry works the same.',
  denied: 'Access was not granted, so nothing was connected. You can try again or keep using manual entry.',
  rate_limited: 'Google is asking us to slow down. Try syncing again in a minute.',
  unavailable: 'Google Calendar could not be reached right now. Your imported data is unchanged; try again shortly.',
  not_configured: 'Google Calendar is not set up on this server (missing client ID, secret or APP_SECRET). See the setup instructions in the README. Manual entry works without it.',
  api_disabled: 'The Google Calendar API is not enabled for this app’s Google Cloud project.',
};

export interface CalendarGateway {
  readonly kind: 'google' | 'memory' | 'unconfigured';
  configured(): boolean;
  authUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, verifier: string): Promise<TokenSet>;
  listCalendars(t: TokenSet): Promise<{ calendars: RemoteCalendar[]; tokens: TokenSet }>;
  listEvents(t: TokenSet, calendarId: string, from: number, to: number): Promise<{ events: RawGoogleEvent[]; tokens: TokenSet }>;
  revoke(t: TokenSet): Promise<void>;
}

export class UnconfiguredGateway implements CalendarGateway {
  readonly kind = 'unconfigured' as const;
  configured() { return false; }
  private no(): never { throw new CalendarError('not_configured', FRIENDLY.not_configured); }
  authUrl(): string { return this.no(); }
  async exchangeCode(): Promise<TokenSet> { return this.no(); }
  async listCalendars(): Promise<never> { return this.no(); }
  async listEvents(): Promise<never> { return this.no(); }
  async revoke() { /* nothing to revoke */ }
}

export class GoogleGateway implements CalendarGateway {
  readonly kind = 'google' as const;
  constructor(private cfg: { clientId: string; clientSecret: string; redirectUri: string }, private fetchImpl: typeof fetch = fetch, private now: () => number = Date.now) {}
  configured() { return true; }

  authUrl(state: string, challenge: string) {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, response_type: 'code', scope: READONLY_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  private async tokenCall(body: Record<string, string>): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }) });
    } catch { throw new CalendarError('unavailable', FRIENDLY.unavailable); }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = String(json.error ?? '');
      if (err === 'invalid_grant') throw new CalendarError('reauth_required', FRIENDLY.reauth_required);
      if (err === 'access_denied' || err === 'admin_policy_enforced') throw new CalendarError('org_blocked', FRIENDLY.org_blocked);
      if (res.status === 429) throw new CalendarError('rate_limited', FRIENDLY.rate_limited);
      if (res.status >= 500) throw new CalendarError('unavailable', FRIENDLY.unavailable);
      throw new CalendarError('reauth_required', FRIENDLY.reauth_required);
    }
    return json;
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const j = await this.tokenCall({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier });
    const scope = String(j.scope ?? '');
    if (!scope.split(' ').includes(READONLY_SCOPE)) throw new CalendarError('denied', FRIENDLY.denied);
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: this.now() + (Number(j.expires_in) || 3600) * 1000, scope };
  }

  private async fresh(t: TokenSet): Promise<TokenSet> {
    if (t.expires_at - 60_000 > this.now()) return t;
    if (!t.refresh_token) throw new CalendarError('reauth_required', FRIENDLY.reauth_required);
    const j = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    return { access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: this.now() + (Number(j.expires_in) || 3600) * 1000, scope: j.scope ?? t.scope };
  }

  private async api(t: TokenSet, path: string, retried = false): Promise<{ data: any; tokens: TokenSet }> {
    const tokens = await this.fresh(t);
    let res: Response;
    try { res = await this.fetchImpl(`https://www.googleapis.com/calendar/v3${path}`, { headers: { authorization: `Bearer ${tokens.access_token}` } }); }
    catch { throw new CalendarError('unavailable', FRIENDLY.unavailable); }
    if (res.status === 401) {
      if (retried) throw new CalendarError('reauth_required', FRIENDLY.reauth_required);
      return this.api({ ...tokens, expires_at: 0 }, path, true); // expired server-side: refresh once and retry
    }
    if (res.status === 403) {
      const j: any = await res.json().catch(() => ({}));
      const reason = String(j?.error?.errors?.[0]?.reason ?? '');
      if (reason === 'accessNotConfigured') throw new CalendarError('api_disabled', FRIENDLY.api_disabled);
      if (/rateLimit/i.test(reason)) throw new CalendarError('rate_limited', FRIENDLY.rate_limited);
      throw new CalendarError('org_blocked', FRIENDLY.org_blocked);
    }
    if (res.status === 429) throw new CalendarError('rate_limited', FRIENDLY.rate_limited);
    if (res.status >= 500) throw new CalendarError('unavailable', FRIENDLY.unavailable);
    if (!res.ok) throw new CalendarError('unavailable', FRIENDLY.unavailable);
    return { data: await res.json(), tokens };
  }

  async listCalendars(t: TokenSet) {
    const { data, tokens } = await this.api(t, '/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,summaryOverride,timeZone,backgroundColor,primary)');
    const calendars: RemoteCalendar[] = (data.items ?? []).map((c: any) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, tz: c.timeZone || 'UTC', color: c.backgroundColor ?? null, primary: !!c.primary }));
    return { calendars, tokens };
  }

  async listEvents(t: TokenSet, calendarId: string, from: number, to: number) {
    const events: RawGoogleEvent[] = [];
    let tokens = t, pageToken = '';
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({
        timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', showDeleted: 'true', maxResults: '250', orderBy: 'startTime',
        fields: 'nextPageToken,items(id,status,summary,description,etag,updated,start,end,recurringEventId,transparency)',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.api(tokens, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      tokens = r.tokens;
      events.push(...(r.data.items ?? []));
      pageToken = r.data.nextPageToken ?? '';
      if (!pageToken) break;
    }
    return { events, tokens };
  }

  async revoke(t: TokenSet) {
    try { await this.fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }) }); } catch { /* best effort */ }
  }
}

/** In-memory gateway: powers the demo workspace and deterministic tests. No network, no OAuth. */
export class MemoryGateway implements CalendarGateway {
  readonly kind = 'memory' as const;
  calendars: RemoteCalendar[] = [];
  events = new Map<string, RawGoogleEvent[]>();
  failWith: CalendarError | null = null;
  calls = 0;
  configured() { return true; }
  authUrl(state: string) { return `memory://authorize?state=${state}`; }
  async exchangeCode(): Promise<TokenSet> { return { access_token: 'memory', refresh_token: 'memory', expires_at: Date.now() + 3600_000, scope: READONLY_SCOPE }; }
  async listCalendars(t: TokenSet) { this.calls++; if (this.failWith) throw this.failWith; return { calendars: this.calendars, tokens: t }; }
  async listEvents(t: TokenSet, calendarId: string, from: number, to: number) {
    this.calls++; if (this.failWith) throw this.failWith;
    const inWin = (e: RawGoogleEvent) => {
      const s = e.start?.dateTime ? Date.parse(e.start.dateTime) : e.start?.date ? Date.parse(e.start.date + 'T12:00:00Z') : null;
      return e.status === 'cancelled' || (s !== null && s >= from && s < to);
    };
    return { events: (this.events.get(calendarId) ?? []).filter(inWin).map((e) => ({ ...e })), tokens: t };
  }
  async revoke() { /* no-op */ }
}
