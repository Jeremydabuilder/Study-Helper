import { Student } from './hostedHarness';

export const NOTES = `--- Page 1 ---
Photosynthesis is the process plants use to turn light, water and carbon dioxide into glucose and oxygen.
Chlorophyll is the green pigment in chloroplasts that absorbs light energy.`;

/** Paste a source, let the (scripted) model find concepts, confirm them, and start a practice session. Returns the first question. */
export async function startStudy(s: Student, o: { subject?: string; text?: string } = {}) {
  const subject = (await s.post('/api/subjects', { name: o.subject ?? 'Biology' })).body.id as string;
  const source = (await s.post(`/api/subjects/${subject}/sources`, { title: 'Notes', text: o.text ?? NOTES })).body.id as string;
  const ex = await s.post(`/api/sources/${source}/extract`, {});
  if (ex.status !== 200) throw new Error(`extract failed: ${ex.status} ${JSON.stringify(ex.body)}`);
  const concepts = (await s.get(`/api/subjects/${subject}`)).body.concepts as { id: string; status: string }[];
  for (const c of concepts) await s.patch(`/api/concepts/${c.id}`, { status: 'confirmed' });
  const conceptId = concepts[0].id;
  const sess = await s.post('/api/sessions', { mode: 'practice', minutes: 10, conceptIds: [conceptId] });
  if (sess.status !== 200) throw new Error(`session failed: ${sess.status} ${JSON.stringify(sess.body)}`);
  const view = (await s.get(`/api/sessions/${sess.body.id}`)).body;
  return { subject, source, conceptId, sessionId: sess.body.id as string, question: view.question as { id: string; prompt: string }, view };
}
let n = 0;
export const tok = () => `tok-${Date.now()}-${n++}-abcdefgh`;
