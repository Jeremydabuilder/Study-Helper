import { useEffect, useState } from 'react';
import { ApiError, useApi } from '../api';
import { ErrorBox, Field } from '../ui';

export const TYPE_OPTIONS: [string, string][] = [['test', 'Test'], ['quiz', 'Quiz'], ['homework', 'Homework'], ['project', 'Project'], ['presentation', 'Presentation'], ['other_deadline', 'Other deadline']];

/** Shared by manual entry and by the calendar confirmation screen. Empty = unknown; nothing is guessed. */
export function ItemEditor({ initial, subjects, onSave, saveLabel, extra }: { initial: any; subjects: any[]; onSave: (v: any) => Promise<void>; saveLabel: string; extra?: React.ReactNode }) {
  const [v, setV] = useState({
    title: initial.title ?? '', type: initial.type ?? 'homework', subjectId: initial.subjectId ?? '', dueDate: initial.dueDate ?? '', dueTime: initial.dueTime ?? '',
    topicsText: initial.topicsText ?? '', conceptIds: initial.conceptIds ?? [], estimateMin: initial.estimateMin ?? '', format: initial.format ?? '', notes: initial.notes ?? '',
  });
  const [err, setErr] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const subj = useApi<any>(v.subjectId ? `/subjects/${v.subjectId}` : null, [v.subjectId]);
  useEffect(() => { setV((p) => ({ ...p, conceptIds: p.conceptIds })); }, [subj.data]);
  const concepts: any[] = (subj.data?.concepts ?? []).filter((c: any) => c.status === 'confirmed');
  const prep = ['test', 'quiz', 'presentation'].includes(v.type);
  const set = (k: string, val: any) => setV((p) => ({ ...p, [k]: val }));

  return (
    <form onSubmit={async (e) => {
      e.preventDefault(); setSaving(true); setErr(null);
      try { await onSave({ title: v.title, type: v.type, subjectId: v.subjectId || null, dueDate: v.dueDate || null, dueTime: v.dueDate && v.dueTime ? v.dueTime : null, topicsText: v.topicsText || null, conceptIds: v.conceptIds, estimateMin: v.estimateMin === '' ? null : Number(v.estimateMin), format: v.format, notes: v.notes }); }
      catch (e2) { setErr(e2 as ApiError); } finally { setSaving(false); }
    }}>
      <div className="grid2">
        <Field label="Title"><input value={v.title} onChange={(e) => set('title', e.target.value)} required maxLength={120} /></Field>
        <Field label="Type"><select value={v.type} onChange={(e) => set('type', e.target.value)}>{TYPE_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Subject" hint={v.subjectId ? undefined : 'Unknown — pick one so I can link topics.'}><select value={v.subjectId} onChange={(e) => { set('subjectId', e.target.value); set('conceptIds', []); }}><option value="">Unknown / none</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label={prep ? 'Date' : 'Due date'} hint={v.dueDate ? undefined : 'Unknown — I won’t schedule it until you set one.'}>
          <div className="row gap-s"><input type="date" value={v.dueDate} onChange={(e) => set('dueDate', e.target.value)} style={{ flex: 1 }} /><input type="time" aria-label="Time (optional)" value={v.dueTime} onChange={(e) => set('dueTime', e.target.value)} style={{ width: 120 }} disabled={!v.dueDate} /></div>
        </Field>
      </div>
      {prep && (
        <div className="mt-s">
          <span className="field-label">What does it cover?</span>
          {v.topicsText && <p className="small muted">From the event: “{v.topicsText}” <span className="muted">(not verified — match it to your concepts below)</span></p>}
          {!v.subjectId ? <p className="small unknown">Topics unknown. Choose a subject to link concepts.</p> : concepts.length === 0 ? <p className="small unknown">No confirmed concepts in this subject yet.</p> : (
            <div className="row gap-s">{concepts.map((c: any) => (
              <label key={c.id} className="chip" style={{ cursor: 'pointer', padding: '.3rem .7rem' }}><input type="checkbox" checked={v.conceptIds.includes(c.id)} onChange={(e) => set('conceptIds', e.target.checked ? [...v.conceptIds, c.id] : v.conceptIds.filter((x: string) => x !== c.id))} /> {c.name}</label>))}</div>
          )}
          {v.conceptIds.length === 0 && <p className="small unknown mt-s">Coverage unknown — I won’t guess. {v.subjectId ? 'Tick the topics your teacher said are included.' : ''}</p>}
        </div>
      )}
      <div className="grid2 mt-s">
        <Field label="Time you expect to need (minutes)" hint={v.estimateMin === '' ? 'Unknown — a default from Settings is used for planning.' : undefined}><input type="number" min={0} max={6000} value={v.estimateMin} onChange={(e) => set('estimateMin', e.target.value)} /></Field>
        <Field label={prep ? 'Format (optional)' : 'Notes (optional)'}><input value={prep ? v.format : v.notes} onChange={(e) => set(prep ? 'format' : 'notes', e.target.value)} placeholder={prep ? 'e.g. 20 multiple choice + 2 written' : ''} /></Field>
      </div>
      {extra}
      {err && <ErrorBox error={err} />}
      <div className="row mt"><button className="btn primary" disabled={saving || !v.title.trim()}>{saving ? 'Saving…' : saveLabel}</button></div>
    </form>
  );
}
