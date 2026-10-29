import { useState } from 'react';
import { ApiError, fmtDateTime, post, put, relTime, useApi } from '../api';
import { Chip, Empty, ErrorBox, Modal, Spinner, Toggle } from '../ui';
import { ItemEditor } from './ItemEditor';

const LABELS: [string, string][] = [['school', 'School'], ['homework', 'Homework'], ['tests', 'Tests & quizzes'], ['activity', 'Tennis / activities'], ['other', 'Other']];
const ERROR_TEXT: Record<string, string> = {
  denied: 'Access wasn’t granted, so nothing was connected. You can try again, or keep using manual entry.',
  org_blocked: 'Your school or organisation’s Google settings blocked this. School-managed accounts often can’t authorise third-party apps. You can ask an administrator, connect a personal calendar that your school calendar is shared with, or add tests and homework by hand — manual entry works the same.',
  unavailable: 'Google couldn’t be reached. Try again in a minute.', not_configured: 'Google Calendar isn’t set up on this server yet (see README). Manual entry works without it.',
};

export function CalendarPage({ go, query }: { go: (p: string) => void; query: string }) {
  const cal = useApi<any>('/calendar');
  const props = useApi<any[]>('/items?status=proposed');
  const subjects = useApi<any[]>('/subjects');
  const today = useApi<any>('/today');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [report, setReport] = useState<any>(null);
  const [showDisc, setShowDisc] = useState(false);
  const qp = new URLSearchParams(query);
  const c = cal.data;

  const run = async (label: string, fn: () => Promise<any>) => { setBusy(label); setErr(null); try { return await fn(); } catch (e) { setErr(e as ApiError); cal.reload(); } finally { setBusy(null); } };
  const connect = () => run('Connecting…', async () => { const r = await post('/calendar/connect'); if (r.url) window.location.href = r.url; else { await cal.reload(); } });
  const sync = () => run('Syncing…', async () => { setReport(await post('/calendar/sync')); await Promise.all([cal.reload(), props.reload(), today.reload()]); });
  const save = (list: any[]) => run('Saving…', async () => { await put('/calendar/calendars', { calendars: list }); await cal.reload(); });
  const patchCal = (id: string, p: any) => save([{ id, ...p }]);

  if (cal.loading && !c) return <div className="narrow"><h1>Calendar</h1><Spinner /></div>;
  if (cal.error && !c) return <div className="narrow"><h1>Calendar</h1><ErrorBox error={cal.error} onRetry={cal.reload} /></div>;
  if (!c) return null;
  const connected = c.status === 'connected' || c.status === 'reauth_required' || c.status === 'error';
  const selected = c.calendars.filter((x: any) => x.selected);
  const groups = new Map<string, any[]>();
  for (const p of props.data ?? []) { const k = p.event?.recurringId ?? p.id; groups.set(k, [...(groups.get(k) ?? []), p]); }

  return (
    <div className="narrow">
      <p className="small"><a href="#/plan">← Plan</a></p>
      <h1>Google Calendar</h1>
      {qp.get('connected') && <div className="notice good" role="status">Connected. Choose which calendars to include below, then sync.</div>}
      {qp.get('error') && <div className="notice bad" role="alert">{ERROR_TEXT[qp.get('error')!] ?? 'Connecting failed.'}</div>}
      {err && <ErrorBox error={err} onRetry={sync} />}
      {busy && <Spinner label={busy} />}

      <section className="card" aria-labelledby="st-h">
        <h2 id="st-h">{connected ? (c.demo ? 'Sample calendar connected' : 'Connected (read-only)') : 'Use your calendar to plan'}</h2>
        {c.demo && <div className="notice warn small">This is a <strong>sample calendar</strong> with made-up events. It never contacts Google.</div>}
        <p className="muted">I can read events from calendars you choose, find possible tests, quizzes, homework and projects, and plan study time around your classes and tennis.</p>
        <div className="notice info small"><strong>What Calendar can’t tell me:</strong> {c.limitation}</div>
        <ul className="small"><li><strong>Permission requested:</strong> {c.permissions}</li><li>Your Google access is stored encrypted on the server and is tied to your account only. It is never sent to your browser.</li><li>Your study schedule stays inside this app. Nothing is added to Google Calendar.</li></ul>

        {c.status === 'reauth_required' && <div className="notice bad" role="alert"><strong>Google needs you to reconnect.</strong> {c.lastError} Your imported events and items are still here.</div>}
        {c.status === 'error' && c.lastError && <div className="notice warn" role="alert">{c.lastError}</div>}
        {!connected && !c.available && <div className="notice warn small">{c.setupHint}</div>}

        <div className="row">
          {!connected || c.status === 'reauth_required' ? <button className="btn primary" disabled={!c.available || !!busy} onClick={connect}>{c.demo ? 'Use the sample calendar' : c.status === 'reauth_required' ? 'Reconnect Google Calendar' : 'Connect Google Calendar (read-only)'}</button>
            : <button className="btn primary" disabled={!!busy || selected.length === 0} onClick={sync}>Sync now</button>}
          {connected && <button className="btn" onClick={() => setShowDisc(true)}>Disconnect / delete data…</button>}
          <button className="btn unavailable" disabled title="Not available yet">Add study sessions to Calendar — not available yet</button>
        </div>
        {connected && <p className="small muted mt-s">Last successful sync: {c.lastSyncOkAt ? `${fmtDateTime(c.lastSyncOkAt)} (${relTime(c.lastSyncOkAt)})` : 'never'}{c.lastSyncAt && c.lastSyncAt !== c.lastSyncOkAt ? ` · last attempt ${relTime(c.lastSyncAt)}` : ''}{c.accountEmail ? ` · ${c.accountEmail}` : ''}</p>}
        {report && <div className="notice good small" role="status">Synced {report.calendars} calendar{report.calendars === 1 ? '' : 's'}: {report.added} new, {report.changed} changed, {report.cancelled} cancelled{report.missing ? `, ${report.missing} not found` : ''}; {report.proposed} possible academic item{report.proposed === 1 ? '' : 's'} to confirm.</div>}
        <p className="small muted">Later, an explicit “Add study sessions to Calendar” option would ask for separate write permission and show a preview of the exact events first. It would never edit or delete your school events.</p>
      </section>

      {connected && (
        <section className="card" aria-labelledby="cals-h">
          <h2 id="cals-h">Which calendars should I use?</h2>
          <p className="muted small">Nothing is imported from a calendar until you tick it. Pick a type to set sensible defaults, then adjust.</p>
          {c.calendars.length === 0 && <Empty title="No calendars found">Your account has no readable calendars.</Empty>}
          {c.calendars.map((k: any) => (
            <div key={k.id} className="upcoming" style={{ display: 'block' }}>
              <div className="row between">
                <Toggle checked={k.selected} onChange={(v) => patchCal(k.id, { selected: v })} label={k.name} hint={`${k.eventCount} events imported · time zone ${k.tz}`} />
                <select aria-label={`Type of ${k.name}`} value={k.label} onChange={(e) => patchCal(k.id, { label: e.target.value })} style={{ width: 'auto' }}>{LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </div>
              {k.selected && <div className="row gap-s" style={{ marginLeft: '1.7rem' }}>
                <Toggle checked={k.detectAcademic} onChange={(v) => patchCal(k.id, { detectAcademic: v })} label="Look for tests & homework" />
                <Toggle checked={k.countsBusy} onChange={(v) => patchCal(k.id, { countsBusy: v })} label="Counts as busy time" />
                {k.countsBusy && <Toggle checked={k.allDayBusy} onChange={(v) => patchCal(k.id, { allDayBusy: v })} label="All-day events block the whole day" />}
              </div>}
            </div>
          ))}
        </section>
      )}

      {(props.data?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="conf-h">
          <h2 id="conf-h">Confirm what I found <Chip tone="warn">{props.data!.length}</Chip></h2>
          <p className="muted small">These are <em>guesses</em> from event titles. On the left is the original event; on the right is what I’d add to your plan. Anything I couldn’t tell is marked unknown — fill it in or leave it. I never assume an event’s start time is a deadline, and I never guess what a test covers.</p>
          {[...groups.entries()].map(([k, list]) => <ProposalGroup key={k} list={list} subjects={subjects.data ?? []} reload={() => { props.reload(); today.reload(); }} />)}
        </section>
      )}
      {connected && props.data?.length === 0 && selected.length > 0 && <p className="muted small">No unconfirmed items. New events are checked each time you sync.</p>}

      {(today.data?.schedule?.changes?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="chg-h"><h2 id="chg-h">What changed in your calendar</h2>
          {today.data.schedule.changes.map((x: any) => <p key={x.id} className="small"><Chip tone="warn">{x.kind}</Chip> {x.title}{x.detail ? ` — ${x.detail}` : ''}</p>)}
          <button className="btn small" onClick={async () => { await post('/calendar/changes/seen'); today.reload(); }}>Mark as seen</button>
        </section>
      )}

      {showDisc && <Disconnect onClose={() => setShowDisc(false)} onDone={() => { setShowDisc(false); cal.reload(); props.reload(); today.reload(); }} />}
    </div>
  );
}

function ProposalGroup({ list, subjects, reload }: { list: any[]; subjects: any[]; reload: () => void }) {
  const [open, setOpen] = useState<any | null>(null);
  const recurring = list.length > 1;
  const first = list[0];
  const bulk = async (action: 'confirm' | 'dismiss') => { await post('/items/bulk', { ids: list.map((l) => l.id), action }); reload(); };
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      {recurring && <div className="row between"><span className="small"><Chip tone="info">Repeats · {list.length} upcoming</Chip> “{first.title}”</span><span className="row gap-s"><button className="btn small" onClick={() => bulk('confirm')}>Confirm all {list.length}</button><button className="btn small ghost" onClick={() => bulk('dismiss')}>Dismiss all</button></span></div>}
      {(recurring ? list.slice(0, 2) : list).map((p) => <Proposal key={p.id} p={p} onEdit={() => setOpen(p)} reload={reload} compact={recurring} />)}
      {recurring && list.length > 2 && <p className="small muted">…and {list.length - 2} more like it.</p>}
      {open && <Modal title="Confirm item" onClose={() => setOpen(null)}>
        <ItemEditor initial={open} subjects={subjects} saveLabel="Confirm" onSave={async (v) => { await post(`/items/${open.id}/confirm`, v); setOpen(null); reload(); }} />
      </Modal>}
    </div>
  );
}

function Proposal({ p, onEdit, reload, compact }: { p: any; onEdit: () => void; reload: () => void; compact?: boolean }) {
  const [err, setErr] = useState<ApiError | null>(null);
  return (
    <div className="cmp mb-s">
      <div className="event-box">
        <h4>Original calendar event</h4>
        <p style={{ margin: 0 }}><strong>{p.event?.title}</strong></p>
        <p className="small muted" style={{ margin: 0 }}>{p.event?.calendarName} · {p.event?.whenLabel}</p>
        {p.event?.description && <p className="small" style={{ margin: '.3rem 0 0', whiteSpace: 'pre-wrap' }}>{p.event.description.slice(0, 240)}</p>}
      </div>
      <div className="event-box">
        <h4>What I’d add</h4>
        <dl className="kv" style={{ margin: 0 }}>
          <dt>Type</dt><dd>{p.typeLabel} <span className="small muted">({p.proposal?.confidence === 'strong' ? 'title says so' : 'weak match'})</span></dd>
          <dt>Subject</dt><dd>{p.subjectName ?? <span className="unknown">unknown</span>}</dd>
          <dt>{['test', 'quiz', 'presentation'].includes(p.type) ? 'Date' : 'Due'}</dt><dd>{p.dueKind === 'unknown' ? <span className="unknown">unknown</span> : p.dueLabel}</dd>
          <dt>Topics</dt><dd>{p.topicsText ? <>“{p.topicsText}” <span className="small muted">(from the event, unverified)</span></> : <span className="unknown">unknown</span>}</dd>
        </dl>
        {p.proposal?.dueBasis && <p className="small muted" style={{ margin: '.4rem 0 0' }}>{p.proposal.dueBasis}</p>}
        {p.proposal?.reasons?.map((r: string, i: number) => <p key={i} className="small muted" style={{ margin: 0 }}>• {r}</p>)}
        {p.proposal?.possibleDuplicateOf && <p className="small" style={{ margin: '.3rem 0 0' }}><Chip tone="warn">Possible duplicate</Chip> A similar item already exists.</p>}
        {err && <ErrorBox error={err} />}
        <div className="row gap-s mt-s">
          <button className="btn small primary" onClick={onEdit}>{compact ? 'Review…' : 'Review & confirm…'}</button>
          <button className="btn small" onClick={async () => { try { await post(`/items/${p.id}/confirm`, {}); reload(); } catch (e) { setErr(e as ApiError); } }}>Confirm as shown</button>
          <button className="btn small ghost" onClick={async () => { await post(`/items/${p.id}/dismiss`); reload(); }}>Not academic</button>
        </div>
      </div>
    </div>
  );
}

function Disconnect({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [del, setDel] = useState(false), [keep, setKeep] = useState(true);
  const [err, setErr] = useState<ApiError | null>(null);
  return (
    <Modal title="Disconnect Google Calendar" onClose={onClose}>
      <p>Disconnecting stops syncing and removes the stored Google access from this server (and asks Google to revoke it).</p>
      <Toggle checked={del} onChange={setDel} label="Also delete everything imported from the calendar" hint="Removes imported events, calendar choices, and unconfirmed items." />
      {del && <Toggle checked={keep} onChange={setKeep} label="Keep items I already confirmed (as manual items)" hint="Untick to delete those too." />}
      {err && <ErrorBox error={err} />}
      <div className="row mt"><button className="btn danger" onClick={async () => { try { await post('/calendar/disconnect', { deleteImported: del, keepItems: keep }); onDone(); } catch (e) { setErr(e as ApiError); } }}>{del ? 'Disconnect and delete' : 'Disconnect'}</button><button className="btn" onClick={onClose}>Cancel</button></div>
      <p className="small muted mt-s">This never changes or deletes anything in your Google Calendar.</p>
    </Modal>
  );
}
