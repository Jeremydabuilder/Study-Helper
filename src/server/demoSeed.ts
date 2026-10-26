/**
 * Sample ("demo") workspace. Lives in its own database file. Built by driving the REAL services on a simulated
 * clock, so the sample history is produced by the same code paths (grading, scheduling, misconceptions) as real use.
 * Everything here is made up; nothing is a real teacher's rubric or a real student's record.
 */
import type { OfflineProvider } from '../ai/offline';
import { RawGoogleEvent } from '../core/calendar';
import { verifyQuotes } from '../core/sources';
import { chunkText } from '../core/sources';
import { DAY, addDaysKey, localDateKey, zonedToUtc } from '../core/time';
import { Db, uid } from './db';
import { AppConfig, Ctx, parse, setSetting } from './services/common';
import { MemoryGateway } from './services/calendarGoogle';
import * as content from './services/content';
import * as practice from './services/practice';
import * as cal from './services/calendar';
import * as items from './services/items';
import * as mem from './services/memory';
import { getQuestion } from './services/questions';

const TZ = 'America/New_York';

export const MATH_NOTES = `--- Page 1 ---
Unit 3 — Equations, inequalities and sets (sample notes)

Solving linear equations: undo operations in reverse order and keep both sides balanced. Always check your answer by substituting it back.

Solving linear inequalities: solve like an equation, but reverse the inequality sign whenever you multiply or divide both sides by a negative number.

--- Page 2 ---
Compound inequalities: an "and" inequality such as -3 < 2x + 1 <= 9 is solved by doing the same step to all three parts. An "or" inequality gives two separate pieces.

Absolute value equations: |u| = r means u = r or u = -r when r is positive. If r is negative there is no solution. Check each candidate in the original equation because some can be extraneous.

--- Page 3 ---
Absolute value inequalities: |u| < r means -r < u < r, while |u| > r means u < -r or u > r.

Sets and set operations: the union of A and B lists everything in A or B; the intersection lists only what is in both; A - B lists what is in A but not B.
`;

export const HISTORY_PACKET = `Review packet: Causes of World War I (sample)

Militarism: the build-up of armies and navies and the belief that military strength should guide national policy.
Alliances: formal agreements between countries to defend one another, such as the Triple Entente and the Triple Alliance.
Imperialism: competition between powers to build empires and control colonies and resources.
Nationalism: strong pride in one's nation, including movements of ethnic groups seeking their own state.
Assassination of Archduke Franz Ferdinand: the June 1914 killing in Sarajevo that triggered the crisis.
July Crisis: the weeks of diplomacy and ultimatums after the assassination that ended with alliances pulling the great powers into war.
`;

export const ENGLISH_NOTES = `Sample passage and rubric (made up for the demo — not a real teacher's rubric)

Claim and evidence: a strong argument states a clear claim and supports it with specific evidence from the text.
Quoting versus paraphrasing: a quotation uses the author's exact words in quotation marks; a paraphrase restates the idea in your own words.
Explaining reasoning: after giving evidence, explain how it supports your claim instead of leaving the reader to guess.
`;

type Strategy = 'correct' | 'wrong' | 'partial' | 'hint' | 'idk' | 'conf_wrong';
const timeAt = (base: number, days: number, hhmm: string) => zonedToUtc(addDaysKey(localDateKey(new Date(base), TZ), days), hhmm, TZ).getTime();

export async function seedDemo(db: Db, deps: { cfg: AppConfig; now: () => number; offline: OfflineProvider; demoGw: MemoryGateway }) {
  const realNow = deps.now();
  let t = timeAt(realNow, -21, '16:00');
  const ctx: Ctx = { db, workspace: 'demo', now: () => t, ai: deps.offline, offline: deps.offline, cfg: deps.cfg, calendar: deps.demoGw };
  db.run('UPDATE profile SET name=?, grade=?, timezone=?, default_minutes=?, about=?, updated_at=? WHERE id=1', 'Jeremy (sample)', '8', TZ, 20, 'SAMPLE PROFILE — made-up data for the demo. Competitive tennis; busy afternoons.', realNow);
  setSetting(db, 'demo_anchor', realNow, realNow);

  const mk = (name: string, aliases: string[]) => content.createSubject(ctx, { name, aliases }).id;
  const math = mk('Math', ['Algebra']), hist = mk('History', ['Social Studies']), eng = mk('English', ['ELA']);

  const addConcept = (subjectId: string, sourceId: string, text: string, c: { name: string; summary: string; quote: string; tag?: string }) => {
    const id = uid();
    const chunks = db.all<any>('SELECT id, char_start, char_end FROM source_chunks WHERE source_id=?', sourceId);
    const { verified } = verifyQuotes(text, chunkText(text), [c.quote]);
    db.run('INSERT INTO concepts (id,subject_id,name,summary,status,skill_tag,support,support_note,origin,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, subjectId, c.name, c.summary, 'confirmed', c.tag ?? null, verified.length ? 'source' : 'unverified', verified.length ? 'Quote found in the sample material.' : '', 'student', sourceId, t, t);
    for (const v of verified) db.run('INSERT INTO concept_refs (id,concept_id,source_id,chunk_id,quote,char_start,char_end,label) VALUES (?,?,?,?,?,?,?,?)', uid(), id, sourceId, chunks.find((r) => v.start >= r.char_start && v.start < r.char_end)?.id ?? null, v.quote, v.start, v.end, v.label);
    return id;
  };

  // ---- Math ----
  const ms = content.addSource(ctx, math, { title: 'Unit 3 notes (sample)', kind: 'notes', text: MATH_NOTES, origin: 'sample' }).id;
  const M = {
    lin: addConcept(math, ms, MATH_NOTES, { name: 'Solving linear equations', summary: 'Undo operations in reverse order, keep both sides balanced, and check by substituting.', quote: 'undo operations in reverse order and keep both sides balanced', tag: 'math.linear_equation' }),
    ineq: addConcept(math, ms, MATH_NOTES, { name: 'Solving linear inequalities', summary: 'Solve like an equation, but reverse the inequality sign when multiplying or dividing by a negative.', quote: 'reverse the inequality sign whenever you multiply or divide both sides by a negative number', tag: 'math.linear_inequality' }),
    comp: addConcept(math, ms, MATH_NOTES, { name: 'Compound inequalities', summary: '"And" inequalities: do the same step to all three parts. "Or" inequalities give two separate pieces.', quote: 'is solved by doing the same step to all three parts', tag: 'math.compound_inequality' }),
    absEq: addConcept(math, ms, MATH_NOTES, { name: 'Absolute value equations', summary: '|u| = r means u = r or u = -r (r > 0); no solution if r < 0; check for extraneous solutions.', quote: '|u| = r means u = r or u = -r when r is positive', tag: 'math.abs_equation' }),
    absIn: addConcept(math, ms, MATH_NOTES, { name: 'Absolute value inequalities', summary: '|u| < r means -r < u < r; |u| > r means u < -r or u > r.', quote: '|u| < r means -r < u < r', tag: 'math.abs_inequality' }),
    sets: addConcept(math, ms, MATH_NOTES, { name: 'Sets and set operations', summary: 'Union (in A or B), intersection (in both), difference (in A not B).', quote: 'the union of A and B lists everything in A or B', tag: 'math.sets' }),
  };
  for (const [c, p] of [[M.ineq, M.lin], [M.comp, M.ineq], [M.absEq, M.lin], [M.absIn, M.absEq], [M.absIn, M.ineq]]) db.run('INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id) VALUES (?,?)', c, p);

  // ---- History ----
  const hs = content.addSource(ctx, hist, { title: 'Causes of WWI review packet (sample)', kind: 'review_packet', text: HISTORY_PACKET, origin: 'sample' }).id;
  const H: Record<string, string> = {};
  for (const line of HISTORY_PACKET.split('\n')) {
    const m = line.match(/^([^:]{3,60}):\s+(.{20,})$/);
    if (m && !m[1].startsWith('Review')) H[m[1]] = addConcept(hist, hs, HISTORY_PACKET, { name: m[1], summary: m[2], quote: line.trim() });
  }
  db.run('INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id) VALUES (?,?)', H['July Crisis'], H['Alliances']);
  db.run('INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id) VALUES (?,?)', H['July Crisis'], H['Assassination of Archduke Franz Ferdinand']);

  // ---- English (material only; shows concepts + sources, no attempts) ----
  const es = content.addSource(ctx, eng, { title: 'Argument rubric (SAMPLE, invented)', kind: 'rubric', text: ENGLISH_NOTES, origin: 'sample' }).id;
  for (const line of ENGLISH_NOTES.split('\n')) {
    const m = line.match(/^([^:]{3,60}):\s+(.{20,})$/);
    if (m) addConcept(eng, es, ENGLISH_NOTES, { name: m[1], summary: m[2], quote: line.trim() });
  }

  // ---- scripted study history, produced by the real practice loop ----
  let tok = 0;
  const answerFor = (qid: string, how: Strategy): { answer: string } => {
    const q = getQuestion(ctx, qid), spec = parse<any>(q.answer_spec, {});
    if (spec.type === 'choice') { const n = parse<any[]>(q.choices, []).length; return { answer: String(how === 'wrong' || how === 'conf_wrong' || how === 'idk' ? (spec.correct + 1) % n : spec.correct) }; }
    if (spec.type?.startsWith('math')) {
      if (how === 'partial') { const first = String(spec.answer).split(' or ')[0]; return { answer: first === spec.answer ? 'x = 99' : first }; }
      if (how === 'wrong' || how === 'conf_wrong') {
        // a realistic mistake: for inequalities, the flipped direction
        const a = String(spec.answer);
        return { answer: /x\s*<=?\s/.test(a) && !/or/.test(a) ? a.replace('<=', '>=').replace('<', '>') : /x\s*>=?\s/.test(a) && !/or/.test(a) ? a.replace('>=', '<=').replace('>', '<') : 'x = 99' };
      }
      return { answer: spec.answer };
    }
    const rubric = parse<any>(q.rubric, { keyPoints: [] });
    if (rubric.keyPoints.length === 1) return { answer: how === 'correct' || how === 'hint' ? rubric.keyPoints[0].point : 'not sure' };
    return { answer: rubric.keyPoints.flatMap((k: any) => k.keywords).join(' ') };
  };
  const play = async (mode: 'diagnostic' | 'practice' | 'review', conceptIds: string[] | undefined, subjectId: string, hows: Strategy[]) => {
    const { id } = practice.startSession(ctx, { mode, subjectId, minutes: 15, conceptIds, abandonExisting: true });
    for (const how of hows) {
      const v: any = await practice.sessionView(ctx, id);
      if (v.phase !== 'question') break;
      t += 20_000 + (how === 'idk' ? 5_000 : 25_000);
      if (how === 'hint') practice.requestHint(ctx, id, v.question.id);
      const a = answerFor(v.question.id, how);
      await practice.submitAnswer(ctx, id, { questionId: v.question.id, answer: how === 'idk' ? '' : a.answer, idk: how === 'idk', confidence: how === 'conf_wrong' ? 3 : how === 'correct' ? 2 : 1, clientToken: `seed-${tok++}-${Math.random().toString(36).slice(2)}` });
      t += 3_000;
      await practice.nextQuestion(ctx, id);
    }
    await practice.finishSession(ctx, id);
  };
  const dayAt = (d: number, hhmm: string) => { t = timeAt(realNow, d, hhmm); };

  dayAt(-21, '16:10'); await play('diagnostic', undefined, math, ['correct', 'conf_wrong', 'wrong', 'partial', 'idk', 'correct']);
  dayAt(-20, '16:30'); await play('practice', [M.ineq], math, ['hint', 'correct', 'correct']);
  dayAt(-14, '17:00'); await play('review', undefined, math, ['correct', 'correct']);
  dayAt(-12, '16:40'); await play('practice', [M.absEq], math, ['partial', 'correct', 'correct']);
  dayAt(-7, '17:15'); await play('review', undefined, math, ['correct', 'correct', 'correct']);
  dayAt(-3, '16:20'); await play('practice', [M.comp], math, ['wrong', 'hint', 'correct']);
  dayAt(-10, '18:30'); await play('diagnostic', undefined, hist, ['correct', 'wrong', 'correct', 'wrong', 'correct', 'correct']);
  dayAt(-2, '19:40'); await play('review', undefined, hist, ['correct', 'wrong']);

  // ---- memory notes (clearly labelled by kind) ----
  t = timeAt(realNow, -21, '15:50');
  mem.addMemory(ctx, { text: 'I have tennis most afternoons, so short 10–20 minute sessions work best.' });
  mem.addMemory(ctx, { text: 'When I’m stuck I like to see a worked example first.', subjectId: math });
  db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', uid(), 'ai_inferred', 'May rush multi-step problems (inferred from several hinted attempts — sample inference, correct or delete it).', math, null, JSON.stringify({ origin: 'ai', basis: 'sample', note: 'Sample inference' }), t, t);

  // ---- calendar: connect the sample calendar, sync, confirm one item; leave others for the confirmation screen ----
  t = realNow;
  demoCalendarEvents(db, deps.demoGw, realNow);
  await cal.connectMemory(ctx);
  cal.setCalendars(ctx, [
    { id: 'demo-school', selected: true, label: 'school' }, { id: 'demo-homework', selected: true, label: 'homework' },
    { id: 'demo-tests', selected: true, label: 'tests' }, { id: 'demo-tennis', selected: true, label: 'activity', allDayBusy: true },
  ]);
  await cal.syncNow(ctx);
  const mathTest = items.listItems(ctx, 'proposed').find((i) => /Unit 3 Test/i.test(i.title) && i.event?.calendarName.startsWith('Tests'));
  if (mathTest) items.confirmProposal(ctx, mathTest.id, { subjectId: math, conceptIds: Object.values(M), estimateMin: 120 });
  setSetting(db, 'demo_seeded', true, realNow);
}

/** Deterministic sample calendar, anchored to the day the sample workspace was created. */
export function demoCalendarEvents(db: Db, gw: MemoryGateway, nowFallback: number) {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'demo_anchor'");
  const anchor = row ? Number(JSON.parse(row.value)) : nowFallback;
  const today = localDateKey(new Date(anchor), TZ);
  const at = (d: number, hhmm: string) => zonedToUtc(addDaysKey(today, d), hhmm, TZ).toISOString();
  const timed = (id: string, summary: string, d: number, from: string, to: string, extra: Partial<RawGoogleEvent> = {}): RawGoogleEvent =>
    ({ id, summary, status: 'confirmed', start: { dateTime: at(d, from), timeZone: TZ }, end: { dateTime: at(d, to), timeZone: TZ }, etag: `"${id}-1"`, updated: new Date(anchor).toISOString(), ...extra });
  const allDay = (id: string, summary: string, d: number, days = 1, extra: Partial<RawGoogleEvent> = {}): RawGoogleEvent =>
    ({ id, summary, status: 'confirmed', start: { date: addDaysKey(today, d) }, end: { date: addDaysKey(today, d + days) }, etag: `"${id}-1"`, updated: new Date(anchor).toISOString(), ...extra });
  const dow = (d: number) => new Date(`${addDaysKey(today, d)}T12:00:00Z`).getUTCDay();

  gw.calendars = [
    { id: 'demo-school', name: 'School (sample)', tz: TZ, color: '#4f7cac', primary: true },
    { id: 'demo-homework', name: 'Homework (sample)', tz: TZ, color: '#7a9e7e', primary: false },
    { id: 'demo-tests', name: 'Tests & quizzes (sample)', tz: TZ, color: '#b5651d', primary: false },
    { id: 'demo-tennis', name: 'Tennis (sample)', tz: TZ, color: '#8e6bbf', primary: false },
  ];
  const school: RawGoogleEvent[] = [], tennis: RawGoogleEvent[] = [];
  for (let d = 0; d < 21; d++) {
    if (dow(d) >= 1 && dow(d) <= 5) {
      school.push(timed(`school-${d}`, 'School day (classes)', d, '08:00', '15:00', { recurringEventId: 'school-day' }));
      if ([1, 3, 5].includes(dow(d))) tennis.push(timed(`tennis-${d}`, 'Tennis practice', d, '16:00', '17:30', { recurringEventId: 'tennis-practice' }));
    }
  }
  tennis.push({ id: 'tennis-cancelled', summary: 'Tennis practice', status: 'cancelled', recurringEventId: 'tennis-practice', start: { dateTime: at(2, '16:00') }, end: { dateTime: at(2, '17:30') } });
  tennis.push(allDay('tournament', 'Regional tournament', 7, 2));
  const tests = [
    timed('math-test', 'Math Unit 3 Test', 6, '10:00', '11:00', { description: 'Covers: solving equations, inequalities, absolute value, sets\nBring a calculator.' }),
    allDay('hist-quiz', 'History quiz', 3),
    timed('sci-review', 'Science unit test review session', 5, '19:00', '19:45'),
  ];
  const homework = [
    timed('eng-essay', 'English essay draft due', 4, '08:00', '08:15'),
    allDay('sci-lab', 'Science lab report', 9),
    timed('math-ws', 'Math worksheet 3.2', 1, '19:30', '20:00'),
  ];
  const dupMath = timed('math-test-dup', 'Math Unit 3 Test', 6, '10:00', '11:00');
  gw.events.set('demo-school', [...school, dupMath]);
  gw.events.set('demo-tennis', tennis);
  gw.events.set('demo-tests', tests);
  gw.events.set('demo-homework', homework);
}
