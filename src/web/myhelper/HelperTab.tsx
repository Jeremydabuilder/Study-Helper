import { useState } from 'react';
import { useApi } from '../api';
import { NextCard as HomeworkNext } from '../pages/Homework';
import { PageTop } from './Shell';
import { openInStudyHelper } from './School';
import { toast } from './ctx';

interface Act { em: string; title: string; text: string; to: string; cta: string }
const LIVE: Act[] = [
  { em: '📝', title: 'Work on an assignment', text: 'Open homework, split it into questions, ask for a hint, get your steps checked.', to: '/homework', cta: 'Open homework' },
  { em: '✅', title: 'Check my draft', text: 'Open a homework question and paste your answer. It checks it against your own work and the instructions.', to: '/homework', cta: 'Choose a question' },
  { em: '🧪', title: 'Make a quiz from my notes', text: 'Add notes or a reading and get questions made from them.', to: '/start', cta: 'Start with notes' },
  { em: '🔁', title: 'Review what I’ve learned', text: 'Spaced review of what you studied, chosen for what is shaky.', to: '/review', cta: 'Start a review' },
  { em: '💬', title: 'Ask a question', text: 'Explain a topic or talk through what to do next. Study mode uses only your relevant notes and shows what it used.', to: '/chat', cta: 'Open chat' },
  { em: '📈', title: 'See my progress', text: 'What you have learned, what needs repair, and what it remembers about you.', to: '/progress', cta: 'See progress' },
];
const TEMPLATES: { id: string; em: string; title: string; ask: string; build: (x: string) => string }[] = [
  { id: 'focus', em: '⏱️', title: 'Focus sprint plan', ask: 'What do you need to finish?', build: (x) => `I need to finish: ${x || '[my task]'}.\nHelp me do a 25-minute focus sprint: pick the first tiny step, list what to have ready, and tell me when to stop and check in.` },
  { id: 'idea', em: '💡', title: 'Shape an idea', ask: 'What is the idea?', build: (x) => `Here is my idea: ${x || '[my idea]'}.\nAsk me 3 clarifying questions, then suggest 3 small ways to start and one way to test it quickly.` },
];

/** The "Study Helper" tab: where assignments get worked on. Live actions go to the real Study Helper pages; the two at the bottom only write a prompt for you to copy, and say so. */
export function HelperTab({ go, meta }: { go: (p: string) => void; meta: any }) {
  const st = useApi<any>('/myhelper/state');
  const next = useApi<any>('/homework/next');
  const live = !!meta?.ai?.live;
  const assignments = (st.data?.assignments ?? []).filter((a: any) => !a.done).slice(0, 6);
  return (<>
    <PageTop eyebrow="Work on it" title="Study Helper" />
    <section className="mh-hero"><div><h3>Work on your assignments here</h3><p>School keeps the list. Study Helper is where you get hints, check drafts, make quizzes from notes and review.</p></div><div className="mh-orb" aria-hidden /></section>
    <div className={`mh-notice ${live ? 'good' : ''}`} role="status" style={{ marginTop: 0 }}>{live ? 'Live study assistant is on.' : 'The live study assistant is not available right now. Practice, notes and reviews still work, and your work is saved.'}</div>
    {next.data?.task && <div style={{ marginTop: 18 }}><HomeworkNext next={next.data} go={go} onChange={next.reload} /></div>}
    <section className="mh-panel" style={{ marginTop: 18 }} aria-label="Your assignments">
      <div className="mh-head"><div><h3>Start from an assignment</h3><div className="mh-sub">Opens it with its instructions already filled in. It stays the same assignment as in School.</div></div><a className="mh-text-btn" href="#/school">Go to School</a></div>
      {assignments.length === 0 ? <div className="mh-empty">{st.loading ? 'Loading…' : 'No open assignments. Add one in School.'}</div> : <div className="mh-list">{assignments.map((a: any) => (
        <div className="mh-task" key={a.id}><span className="mh-title">{a.title}<br /><span className="mh-meta">{a.dueLabel || 'No date'}</span></span>
          <button className="mh-link-btn" onClick={async () => { if ((await openInStudyHelper(a, go)) === 'needs_instructions') { toast('Add its instructions in School first.'); go('/school'); } }}>{a.homework ? 'Continue' : 'Open in Study Helper'}</button></div>))}</div>}
    </section>
    <h3 style={{ margin: '26px 0 12px' }}>What you can do <span className="mh-tag mint" style={{ marginLeft: 8 }}>Study Helper</span></h3>
    <div className="mh-helpers">{LIVE.map((a) => <a key={a.title} className="mh-helper" href={`#${a.to}`} style={{ textDecoration: 'none' }}><span className="em" aria-hidden>{a.em}</span><strong>{a.title}</strong><small>{a.text}</small><span className="mh-text-btn">{a.cta} →</span></a>)}</div>
    <h3 style={{ margin: '26px 0 4px' }}>Copyable prompts <span className="mh-tag warn" style={{ marginLeft: 8 }}>Template only</span></h3>
    <p className="mh-sub" style={{ marginBottom: 12 }}>These two do not call any AI. They only write a prompt you can copy into a chat of your own.</p>
    <div className="mh-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginTop: 0 }}>{TEMPLATES.map((t) => <Template key={t.id} t={t} />)}</div>
  </>);
}

function Template({ t }: { t: (typeof TEMPLATES)[number] }) {
  const [x, setX] = useState(''); const [out, setOut] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(out); toast('Prompt copied'); } catch { toast('Select the text and copy it'); } };
  return (
    <section className="mh-panel" aria-label={t.title}>
      <div className="mh-head"><h3><span aria-hidden>{t.em}</span> {t.title}</h3><span className="mh-tag warn">Template — not AI</span></div>
      <div className="mh-field"><label htmlFor={`tp-${t.id}`}>{t.ask}</label><input id={`tp-${t.id}`} value={x} onChange={(e) => setX(e.target.value)} /></div>
      <button className="mh-secondary" onClick={() => setOut(t.build(x.trim()))}>Write the prompt</button>
      {out && <><pre className="mh-pre">{out}</pre><button className="mh-primary" onClick={copy} style={{ marginTop: 10 }}>Copy prompt</button></>}
    </section>
  );
}
