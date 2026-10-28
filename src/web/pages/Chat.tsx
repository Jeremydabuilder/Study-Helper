import { useEffect, useRef, useState } from 'react';
import { ApiError, del, get, post, useApi } from '../api';
import { Chip, Empty, ErrorBox, Spinner } from '../ui';

type Mode = 'study' | 'general';
const MODE_KEY = 'sh.chat.mode';
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'general' ? 'general' : 'study'; } catch { return 'study'; } };

export function Chat({ go }: { go: (p: string) => void }) {
  const status = useApi<any>('/chat/status');
  const [mode, setModeState] = useState<Mode>(readMode);
  const list = useApi<any>(`/conversations?mode=${mode}`, [mode]);
  const [cid, setCid] = useState<string | null>(null);
  const setMode = (m: Mode) => { setModeState(m); setCid(null); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
  if (status.loading && !status.data) return <div className="narrow"><h1>Chat</h1><Spinner /></div>;
  if (status.error && !status.data) return <div className="narrow"><h1>Chat</h1><ErrorBox error={status.error} onRetry={status.reload} /></div>;
  const st = status.data;
  const m = st.modes.find((x: any) => x.id === mode);
  return (
    <div className="narrow">
      <h1>Chat</h1>
      <div className="seg mb-s" role="group" aria-label="Chat mode">
        {st.modes.map((x: any) => <button key={x.id} aria-pressed={mode === x.id} onClick={() => setMode(x.id)}>{x.label} mode</button>)}
      </div>
      <div className={`notice ${mode === 'study' ? 'info' : 'neutral'} small`} role="status" style={mode === 'general' ? { background: 'var(--surface-2)' } : undefined}>
        <strong>{m.label} mode is on.</strong> {m.description}
      </div>
      {!st.ai.available && <div className="notice warn small" role="status">{st.ai.why}</div>}
      <p className="small muted">This chat cannot: {st.cannot.join('; ').toLowerCase()}. {st.calendar.note}</p>
      <div className="chat-layout">
        <ConversationList mode={mode} list={list} cid={cid} setCid={setCid} />
        <div className="grow">
          {cid ? <Thread key={cid} id={cid} mode={mode} available={st.ai.available} onGone={() => { setCid(null); list.reload(); }} onSent={list.reload} go={go} />
            : <Empty title="No conversation open" action={<NewConversation mode={mode} onCreate={(id) => { setCid(id); list.reload(); }} />}>{mode === 'study' ? 'Study mode uses only what is relevant to each message and shows you what it used.' : 'General mode uses none of your study data.'}</Empty>}
        </div>
      </div>
    </div>
  );
}

function NewConversation({ mode, onCreate, sourceId }: { mode: Mode; onCreate: (id: string) => void; sourceId?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const readings = useApi<any>(mode === 'study' ? '/readings' : null);
  const [src, setSrc] = useState('');
  const go = async () => { setBusy(true); setErr(null); try { const c = await post('/conversations', { mode, sourceId: src || sourceId || null }); onCreate(c.id); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } };
  return (
    <div className="stack">
      {mode === 'study' && readings.data?.readings?.length > 0 && (
        <label className="field"><span className="field-label">Focus on a reading (optional)</span>
          <select value={src} onChange={(e) => setSrc(e.target.value)}><option value="">None — use whatever is relevant</option>{readings.data.readings.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>)}
      {err && <ErrorBox error={err} />}
      <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Starting…' : `New ${mode} conversation`}</button>
    </div>
  );
}

function ConversationList({ mode, list, cid, setCid }: { mode: Mode; list: ReturnType<typeof useApi<any>>; cid: string | null; setCid: (id: string | null) => void }) {
  const items: any[] = list.data?.conversations ?? [];
  return (
    <nav className="chat-list" aria-label={`${mode} conversations`}>
      <button className="btn small" onClick={() => setCid(null)}>＋ New</button>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Spinner />}
      {items.map((c) => <button key={c.id} className={`chat-item ${cid === c.id ? 'on' : ''}`} onClick={() => setCid(c.id)} aria-current={cid === c.id ? 'true' : undefined}><span className="grow">{c.title}</span><span className="small muted">{c.messages}</span></button>)}
      {!list.loading && items.length === 0 && <p className="small muted">No {mode} conversations yet.</p>}
    </nav>
  );
}

function Thread({ id, mode, available, onGone, onSent, go }: { id: string; mode: Mode; available: boolean; onGone: () => void; onSent: () => void; go: (p: string) => void }) {
  const c = useApi<any>(`/conversations/${id}`);
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(`sh.draft.chat.${id}`) ?? ''; } catch { return ''; } });
  const [direct, setDirect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [c.data?.messages.length, busy]);
  const keep = (v: string) => { setText(v); try { v ? sessionStorage.setItem(`sh.draft.chat.${id}`, v) : sessionStorage.removeItem(`sh.draft.chat.${id}`); } catch { /* ignore */ } };
  if (c.loading && !c.data) return <Spinner />;
  if (c.error && !c.data) return <ErrorBox error={c.error} onRetry={c.reload}><button className="btn" onClick={onGone}>Close</button></ErrorBox>;
  const d = c.data;
  const send = async () => {
    const t = text.trim(); if (!t) return;
    setBusy(true); setErr(null);
    try { const r = await post(`/conversations/${id}/messages`, { text: t, direct }); c.setData(r); keep(''); setPreview(null); onSent(); }
    catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  };
  const showContext = async () => { try { setPreview(await get(`/chat/context?mode=${mode}&q=${encodeURIComponent(text)}${d.sourceId ? `&sourceId=${d.sourceId}` : ''}`)); } catch (e) { setErr(e as ApiError); } };
  return (
    <section className="card thread" aria-label="Conversation">
      <div className="row between"><div><Chip tone={mode === 'study' ? 'info' : 'neutral'}>{mode === 'study' ? 'Study mode' : 'General mode'}</Chip> {d.reading && <span className="small muted">about “{d.reading}”</span>}</div>
        <button className="btn ghost small danger" onClick={async () => { if (confirm('Delete this conversation? This cannot be undone.')) { await del(`/conversations/${id}`); onGone(); } }}>Delete</button></div>
      <div className="msgs" role="log" aria-live="polite">
        {d.messages.length === 0 && <p className="muted small">{mode === 'study' ? 'Ask about your readings, assignments or topics. I will guide you step by step unless you tick “Just answer directly”.' : 'Ask anything: everyday questions, writing, brainstorming, code. Answers are direct.'}</p>}
        {d.messages.map((m: any) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="small muted">{m.role === 'user' ? 'You' : 'Assistant'}{m.role === 'assistant' && m.direct && mode === 'study' ? ' · direct answer' : ''}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
            {m.role === 'assistant' && mode === 'study' && (
              <details className="small muted"><summary>{m.used?.length ? `Used ${m.used.length} item${m.used.length > 1 ? 's' : ''} from your study data` : 'Used nothing from your study data'}</summary>
                <ul>{(m.used ?? []).map((u: any, i: number) => <li key={i}>{u.label}</li>)}</ul>{m.removedQuotes ? <p>{m.removedQuotes} quotation(s) removed because they were not in the context.</p> : null}</details>)}
          </div>
        ))}
        {busy && <div className="msg assistant"><Spinner label="Thinking…" /></div>}
        <div ref={end} />
      </div>
      {err && <ErrorBox error={err} onRetry={err.retryable ? send : undefined} />}
      {preview && <div className="notice info small"><strong>{preview.note}</strong>{preview.used.length > 0 && <ul>{preview.used.map((u: any, i: number) => <li key={i}>{u.label}</li>)}</ul>}</div>}
      <textarea value={text} onChange={(e) => keep(e.target.value)} rows={3} maxLength={4000} aria-label="Your message" placeholder={mode === 'study' ? 'Ask about your studies…' : 'Ask anything…'} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} disabled={!available} />
      <div className="row between mt-s">
        <div className="row gap-s">
          {mode === 'study' ? <label className="toggle" style={{ padding: 0 }}><input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} /><span>Just answer directly</span></label> : <span className="small muted">General mode answers directly.</span>}
          {mode === 'study' && <button className="btn ghost small" onClick={showContext}>What would be used?</button>}
        </div>
        <button className="btn primary" disabled={busy || !text.trim() || !available} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {!available && <p className="small muted">Set up an AI provider in <a href="#/settings">Settings → Setup</a> to chat.</p>}
      <p className="small muted">{mode === 'study' ? 'Nothing here is saved to Memory unless you add it yourself.' : 'None of your study data is sent, and nothing here is saved to Memory.'} <button className="btn ghost small" onClick={() => go('/memory')}>Open Memory</button></p>
    </section>
  );
}
