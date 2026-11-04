import { Candidate, Candidates } from '../../core/guest/types';
import { dayNames } from '../../core/guest/extract';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The editable preview. Nothing here is saved until the person presses Save: ticks, edits and duplicate choices are all theirs. */
export function Preview({ value, onChange, onSave, onCancel, saveLabel = 'Save the ticked items' }: { value: Candidates; onChange: (c: Candidates) => void; onSave: () => void; onCancel: () => void; saveLabel?: string }) {
  const set = <K extends 'classes' | 'assignments' | 'commitments' | 'preferences' | 'goals'>(k: K, id: string, f: (x: Candidates[K][number]) => Candidates[K][number]) => onChange({ ...value, [k]: (value[k] as Candidates[K]).map((x) => (x.id === id ? f(x) : x)) } as Candidates);
  const picked = [...value.classes, ...value.assignments, ...value.commitments, ...value.preferences, ...value.goals].filter((x) => x.include).length;
  const blocked = value.assignments.filter((x) => x.include && x.duplicateOf && !x.resolution).length;
  const total = value.classes.length + value.assignments.length + value.commitments.length + value.preferences.length + value.goals.length;
  const Flags = ({ c }: { c: Candidate<unknown> }) => <>{c.flags.map((f, i) => <div key={i} className="mh-notice" style={{ marginTop: 6 }}>{f}</div>)}</>;
  return (
    <div aria-label="Preview of what was found">
      <div className="mh-panel tint"><h3>Review each item</h3><p className="mh-sub" style={{ fontSize: 13 }}>Nothing is saved yet. Untick anything wrong, fix any text, and check every date marked as a guess. Items the assistant or the rules only <strong>guessed about you</strong> are unticked; tick them only if they are true.</p></div>
      {total === 0 && <div className="mh-panel" style={{ marginTop: 14 }}><div className="mh-empty">Nothing recognisable was found. You can add things by hand in <a href="#/memory">My profile</a>, or try the questions instead.</div></div>}

      {value.classes.length > 0 && <section className="mh-panel" style={{ marginTop: 14 }}><h3>Classes</h3><div className="mh-list" style={{ marginTop: 10 }}>{value.classes.map((c) => (
        <div className="mh-task" key={c.id}><label className="mh-row" style={{ flex: 1 }}><input type="checkbox" style={{ width: 'auto' }} checked={c.include} onChange={(e) => set('classes', c.id, (x) => ({ ...x, include: e.target.checked }))} aria-label={`Save class ${c.item.name}`} /><input aria-label="Class name" value={c.item.name} onChange={(e) => set('classes', c.id, (x) => ({ ...x, item: { name: e.target.value } }))} style={{ flex: 1, width: 'auto' }} /></label>{c.inferred && <span className="mh-tag warn">Inferred</span>}<Flags c={c} /></div>))}</div></section>}

      {value.assignments.length > 0 && <section className="mh-panel" style={{ marginTop: 14 }}><h3>Assignments, tests and projects</h3><div className="mh-list" style={{ marginTop: 10 }}>{value.assignments.map((c) => (
        <div className="mh-task" key={c.id} style={{ display: 'block' }}>
          <label className="mh-row"><input type="checkbox" style={{ width: 'auto' }} checked={c.include} onChange={(e) => set('assignments', c.id, (x) => ({ ...x, include: e.target.checked }))} aria-label={`Save: ${c.item.title}`} />
            <input aria-label="Title" value={c.item.title} onChange={(e) => set('assignments', c.id, (x) => ({ ...x, item: { ...x.item, title: e.target.value } }))} style={{ flex: '1 1 14rem', width: 'auto' }} />
            {c.item.due.certainty === 'uncertain' && <span className="mh-tag warn">Date is a guess</span>}{c.inferred && <span className="mh-tag warn">Found by the assistant</span>}</label>
          <div className="mh-row" style={{ marginTop: 8 }}>
            <input aria-label="Class" placeholder="Class" value={c.item.className} onChange={(e) => set('assignments', c.id, (x) => ({ ...x, item: { ...x.item, className: e.target.value } }))} style={{ width: '9rem' }} />
            <select aria-label="Type" value={c.item.type} onChange={(e) => set('assignments', c.id, (x) => ({ ...x, item: { ...x.item, type: e.target.value as typeof x.item.type } }))} style={{ width: 'auto' }}><option value="homework">Homework</option><option value="test">Test or quiz</option><option value="project">Project or essay</option><option value="reading">Reading</option></select>
            <input aria-label="Due date" type="date" value={c.item.due.date ?? ''} onChange={(e) => set('assignments', c.id, (x) => ({ ...x, flags: x.flags.filter((f) => !/date|weekday|passed|assumed|rough/i.test(f)), item: { ...x.item, due: e.target.value ? { date: e.target.value, certainty: 'exact', reason: null, raw: x.item.due.raw } : { date: null, certainty: 'none', reason: null, raw: null } } }))} style={{ width: 'auto' }} />
            <input aria-label="Minutes it will take" type="number" min={5} max={600} step={5} value={c.item.estimateMin} onChange={(e) => set('assignments', c.id, (x) => ({ ...x, item: { ...x.item, estimateMin: Math.max(0, Number(e.target.value) || 0) } }))} style={{ width: '5.5rem' }} /><span className="mh-meta">min</span></div>
          <Flags c={c} />
          {c.duplicateOf && <fieldset className="mh-notice" style={{ border: 0 }}><legend className="mh-eyebrow">Possible duplicate: what should happen?</legend>
            {([['merge', 'Update the one I already have'], ['keep_both', 'Keep both'], ['skip', 'Skip this one']] as const).map(([v, label]) => <label key={v} className="mh-row" style={{ marginTop: 4 }}><input type="radio" style={{ width: 'auto' }} name={`dup-${c.id}`} checked={c.resolution === v} onChange={() => set('assignments', c.id, (x) => ({ ...x, include: v !== 'skip', resolution: v }))} />{label}</label>)}</fieldset>}
        </div>))}</div></section>}

      {value.commitments.length > 0 && <section className="mh-panel" style={{ marginTop: 14 }}><h3>Regular commitments</h3><div className="mh-list" style={{ marginTop: 10 }}>{value.commitments.map((c) => (
        <div className="mh-task" key={c.id} style={{ display: 'block' }}>
          <label className="mh-row"><input type="checkbox" style={{ width: 'auto' }} checked={c.include} onChange={(e) => set('commitments', c.id, (x) => ({ ...x, include: e.target.checked }))} aria-label={`Save: ${c.item.title}`} /><input aria-label="Commitment" value={c.item.title} onChange={(e) => set('commitments', c.id, (x) => ({ ...x, item: { ...x.item, title: e.target.value } }))} style={{ flex: '1 1 12rem', width: 'auto' }} />{c.inferred && <span className="mh-tag warn">Found by the assistant</span>}</label>
          <div className="mh-row" style={{ marginTop: 8 }}><span role="group" aria-label="Days" className="mh-row" style={{ gap: 4 }}>{DAYS.map((d, i) => <button type="button" key={i} aria-label={DAY_LABEL[i]} aria-pressed={c.item.days.includes(i)} className={c.item.days.includes(i) ? 'mh-primary' : 'mh-secondary'} style={{ padding: '6px 9px', boxShadow: 'none' }} onClick={() => set('commitments', c.id, (x) => ({ ...x, item: { ...x.item, days: x.item.days.includes(i) ? x.item.days.filter((d2) => d2 !== i) : [...x.item.days, i].sort() } }))}>{d}</button>)}</span>
            <input aria-label="Starts" type="time" value={c.item.start} onChange={(e) => set('commitments', c.id, (x) => ({ ...x, flags: x.flags.filter((f) => !/am\/pm|No time/.test(f)), item: { ...x.item, start: e.target.value } }))} style={{ width: 'auto' }} /><span className="mh-meta">to</span>
            <input aria-label="Ends" type="time" value={c.item.end} onChange={(e) => set('commitments', c.id, (x) => ({ ...x, flags: x.flags.filter((f) => !/end time|am\/pm|No time/.test(f)), item: { ...x.item, end: e.target.value } }))} style={{ width: 'auto' }} /><span className="mh-meta">{dayNames(c.item.days)}</span></div>
          <Flags c={c} /></div>))}</div></section>}

      {(value.preferences.length > 0 || value.goals.length > 0) && <section className="mh-panel" style={{ marginTop: 14 }}><h3>Things guessed about you</h3><p className="mh-sub">These were inferred from your text. They are only saved if you tick them, and they shape your plan.</p><div className="mh-list" style={{ marginTop: 10 }}>
        {value.preferences.map((c) => <div className="mh-task" key={c.id}><label className="mh-row" style={{ flex: 1 }}><input type="checkbox" style={{ width: 'auto' }} checked={c.include} onChange={(e) => set('preferences', c.id, (x) => ({ ...x, include: e.target.checked }))} aria-label={`Save: ${c.item.label}`} />{c.item.label}</label><span className="mh-tag warn">Inferred</span></div>)}
        {value.goals.map((c) => <div className="mh-task" key={c.id}><label className="mh-row" style={{ flex: 1 }}><input type="checkbox" style={{ width: 'auto' }} checked={c.include} onChange={(e) => set('goals', c.id, (x) => ({ ...x, include: e.target.checked }))} aria-label={`Save goal: ${c.item.text}`} /><input aria-label="Goal" value={c.item.text} onChange={(e) => set('goals', c.id, (x) => ({ ...x, item: { text: e.target.value } }))} style={{ flex: 1, width: 'auto' }} /></label><span className="mh-tag warn">Inferred</span></div>)}</div></section>}

      {(value.ignored.length > 0 || value.truncated) && <details className="mh-panel" style={{ marginTop: 14 }}><summary style={{ cursor: 'pointer' }}>{value.ignored.length} line{value.ignored.length === 1 ? '' : 's'} set aside{value.truncated ? ' · text was longer than the limit' : ''}</summary>
        {value.truncated && <div className="mh-notice">Only the first part of your text fit the size limit, so the rest was not read. Paste the rest separately.</div>}
        <ul style={{ fontSize: 12 }}>{value.ignored.map((i, k) => <li key={k}><code>{i.line}</code> — {i.reason}</li>)}</ul></details>}

      <div className="mh-row end" style={{ marginTop: 16 }}>
        {blocked > 0 && <span className="mh-meta" role="status">{blocked} possible duplicate{blocked === 1 ? '' : 's'} need{blocked === 1 ? 's' : ''} your choice</span>}
        <button className="mh-secondary" onClick={onCancel}>Discard</button>
        <button className="mh-primary" disabled={picked === 0 || blocked > 0} onClick={onSave}>{saveLabel} ({picked})</button></div>
    </div>
  );
}
