import { useRef, useState } from 'react';
import { selectExcerpts } from '../../core/guest/practice';
import { PageTop } from '../myhelper/Shell';
import { useDraft } from './drafts';
import { AiError, SetupNotice } from './Setup';
import { aiChat, useGuest, useProvider } from './store';

interface Turn { role: 'user' | 'assistant'; content: string }
/** A small study chat. Needs an assistant; your message stays in the box (and survives a trip to Settings) until an answer arrives. */
export function GuestChat() {
  const { profile } = useGuest(); const prov = useProvider();
  const [draft, setDraft] = useDraft('chat.draft'); const [turns, setTurns] = useState<Turn[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const lock = useRef(false);
  const excerpts = draft.trim() ? selectExcerpts(profile.notes, draft, { n: 3 }) : [];
  const send = async () => {
    const message = draft.trim().slice(0, 1500); if (!message || lock.current) return; lock.current = true; setBusy(true); setErr(null);
    try {
      const r = await aiChat({ message, history: turns.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 800) })), excerpts, profile: { className: undefined, goal: profile.goals[0]?.text, trouble: profile.preferences.trouble } });
      setTurns((t) => [...t, { role: 'user', content: message }, { role: 'assistant', content: r.reply }]); setDraft('');
    } catch (e) { setErr(e); } finally { lock.current = false; setBusy(false); }
  };
  return (<>
    <PageTop eyebrow="Ask" title="Chat" />
    <section className="mh-panel">
      <SetupNotice what="Chat" />
      <div className="mh-list" aria-live="polite" style={{ margin: '10px 0' }}>{turns.length === 0 ? <div className="mh-empty">Ask about a topic, or what to do next. It sees only your message and a few matching passages of your notes.</div> : turns.map((t, i) => <div key={i} className="mh-task" style={{ display: 'block', background: t.role === 'user' ? '#f7f5ff' : '#fff' }}><span className="mh-tag">{t.role === 'user' ? 'You' : 'Assistant'}</span><p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{t.content}</p></div>)}</div>
      <div className="mh-field"><label htmlFor="chat-m">Your message</label><textarea id="chat-m" style={{ minHeight: 90 }} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} /></div>
      <AiError error={err} />
      <details className="mh-sub" style={{ margin: '8px 0' }}><summary style={{ cursor: 'pointer' }}>What will be sent</summary><div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>Only this message ({draft.trim().length} characters), the last {Math.min(turns.length, 6)} message{turns.length === 1 ? '' : 's'} of this chat, {excerpts.length} short matching passage{excerpts.length === 1 ? '' : 's'} from your notes{profile.goals[0] ? ', and your first goal' : ''}. Not your assignments, commitments or other notes.</div></details>
      <div className="mh-row end"><button className="mh-primary" disabled={!draft.trim() || busy || !prov.ready} onClick={send}>{busy ? 'Thinking…' : 'Send'}</button></div>
    </section></>);
}
