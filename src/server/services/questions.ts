import { OfflineProvider } from '../../ai/offline';
import { GeneratedQuestion } from '../../ai/schemas';
import { verifyMathSpec } from '../../core/mathCheck';
import { isMathSkill } from '../../core/mathgen';
import { buildContext } from '../../core/retrieval';
import { findQuote } from '../../core/sources';
import { assessSupport } from '../../core/grounding';
import { uid } from '../db';
import { Ctx, HttpError, getProfile, parse } from './common';
import { modelChunks } from './sourceSafety';
import { AIError } from '../../ai/provider';

export interface QuestionRow {
  id: string; concept_id: string; subject_id: string; kind: string; prompt: string; choices: string | null; answer_spec: string; rubric: string | null;
  hints: string; worked_example: string; explanation: string; difficulty: number; family: string | null; heldout: number; origin: string;
  verified: number | null; verify_note: string; source_note: string; grounding: 'source' | 'weak' | 'none'; retired_at?: number | null; reported_unclear?: number;
}

/** What the browser may see *before* answering: never the key, rubric, or explanation. */
export function publicQuestion(q: QuestionRow) {
  const choices = parse<{ text: string }[] | null>(q.choices, null);
  const spec = parse<any>(q.answer_spec, {});
  return {
    id: q.id, conceptId: q.concept_id, kind: q.kind, prompt: q.prompt, choices: choices?.map((c) => c.text) ?? null,
    answerType: spec.type as string, hintCount: parse<string[]>(q.hints, []).length, difficulty: q.difficulty,
    origin: q.origin, keyVerified: q.verified === null ? null : !!q.verified, sourceNote: q.source_note, grounding: q.grounding,
  };
}

export function getQuestion(ctx: Ctx, id: string): QuestionRow {
  const q = ctx.db.get<QuestionRow>('SELECT * FROM questions WHERE id = ?', id);
  if (!q) throw new HttpError(404, 'not_found', 'Question not found.');
  return q;
}

export interface PickOpts { conceptId: string; purpose: 'diagnostic' | 'practice' | 'review' | 'repair' | 'transfer' | 'exam'; exclude: string[]; lastKind?: string | null; easier?: boolean; useOffline?: boolean }

function unseen(ctx: Ctx, conceptId: string, exclude: string[], heldout: 0 | 1): QuestionRow[] {
  const rows = ctx.db.all<QuestionRow>(`SELECT * FROM questions q WHERE concept_id = ? AND heldout = ? AND retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY created_at, rowid`, conceptId, heldout);
  return rows.filter((r) => !exclude.includes(r.id));
}

/** Choose a question the student has never attempted; generate more only when the bank is empty. */
export async function pickQuestion(ctx: Ctx, o: PickOpts): Promise<QuestionRow> {
  const wantHeld = o.purpose === 'review' || o.purpose === 'transfer' || o.purpose === 'exam';
  const choose = (): QuestionRow | null => {
    const order: (0 | 1)[] = wantHeld ? [1, 0] : [0];
    for (const h of order) {
      const cands = unseen(ctx, o.conceptId, o.exclude, h);
      if (!cands.length) continue;
      const varied = o.purpose === 'diagnostic' && o.lastKind ? cands.find((c) => c.kind !== o.lastKind) : undefined;
      if (varied) return varied;
      if (o.easier) { const e = [...cands].sort((a, b) => a.difficulty - b.difficulty)[0]; return e; }
      return cands[0];
    }
    return null;
  };
  let q = choose();
  if (!q) {
    await generateQuestions(ctx, o.conceptId, { focus: o.purpose === 'repair' ? 'repair' : o.purpose === 'diagnostic' ? 'diagnostic' : wantHeld ? 'transfer' : 'practice', useOffline: o.useOffline });
    q = choose();
  }
  if (!q) throw new HttpError(409, 'no_new_questions', ctx.ai.live ? 'No new questions could be made for this concept right now.' : 'Offline mode has run out of new template questions for this concept. Add more material, or connect an AI provider for unlimited fresh questions.');
  return q;
}

export type GenFocus = 'diagnostic' | 'practice' | 'transfer' | 'repair' | 'discriminate' | 'gap' | 'simpler';
export interface GenOpts { focus: GenFocus; useOffline?: boolean; contrastConceptId?: string; gapPoints?: string[]; strict?: boolean }

/** Checks of the student's own material (diagnostic / fresh checks) must be grounded in it; practice questions may be labelled instead. */
const REQUIRES_GROUNDING: GenFocus[] = ['diagnostic', 'transfer'];

export async function generateQuestions(ctx: Ctx, conceptId: string, o: GenOpts): Promise<{ inserted: number; dropped: number; ungrounded: number }> {
  const c = ctx.db.get<any>('SELECT c.*, s.name AS subject_name FROM concepts c JOIN subjects s ON s.id = c.subject_id WHERE c.id = ?', conceptId);
  if (!c) throw new HttpError(404, 'not_found', 'Concept not found.');
  const math = isMathSkill(c.skill_tag);
  // Math skills use verified deterministic generators: no model call, unlimited fresh variants.
  const provider = math || o.useOffline ? ctx.offline : ctx.ai;
  const chunkRows = ctx.db.all<any>('SELECT ch.id, ch.label, ch.text, ch.source_id, ch.char_start FROM source_chunks ch JOIN sources s ON s.id = ch.source_id WHERE s.subject_id = ? AND s.status = \'confirmed\' ORDER BY ch.source_id, ch.idx', c.subject_id);
  const refChunkIds = ctx.db.all<any>('SELECT chunk_id FROM concept_refs WHERE concept_id = ? AND chunk_id IS NOT NULL AND stale = 0', conceptId).map((r) => r.chunk_id);
  const memories = ctx.db.all<any>('SELECT id, kind, text, subject_id AS subjectId, concept_id AS conceptId FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30');
  const mis = ctx.db.all<any>("SELECT description, count FROM misconceptions WHERE concept_id = ? AND status = 'active' ORDER BY count DESC", conceptId);
  const context = buildContext({ concept: { id: c.id, name: c.name, summary: c.summary, subjectId: c.subject_id }, chunks: modelChunks(ctx, chunkRows), refChunkIds, memories, misconceptions: mis });
  const existing = ctx.db.all<any>('SELECT prompt FROM questions WHERE concept_id = ?', conceptId).map((r) => r.prompt);
  const others = ctx.db.all<any>("SELECT name, summary FROM concepts WHERE subject_id = ? AND status = 'confirmed' AND id != ?", c.subject_id, conceptId);
  const contrast = o.contrastConceptId ? ctx.db.get<any>('SELECT name, summary FROM concepts WHERE id = ?', o.contrastConceptId) : null;
  const batch = await provider.generateQuestions({
    subjectName: c.subject_name, concept: { name: c.name, summary: c.summary, skillTag: c.skill_tag }, excerpts: context.sourceExcerpts.map((e) => ({ label: e.label, text: e.text })),
    otherConcepts: others, misconceptions: context.misconceptions, studentNotes: context.memories,
    practice: o.focus === 'diagnostic' ? 2 : 3, heldout: 1, avoidPrompts: existing, seed: existing.length + 1, focus: o.focus, gradeLevel: getProfile(ctx.db).grade,
    contrast: contrast ? { name: contrast.name, summary: contrast.summary } : undefined, gapPoints: o.gapPoints, strict: o.strict,
  });
  const ordered = [...batch.questions];
  let inserted = 0, dropped = 0, ungrounded = 0;
  const mustGround = REQUIRES_GROUNDING.includes(o.focus) && c.support === 'source' && provider.live;
  ctx.db.tx(() => {
    ordered.forEach((q, i) => {
      if (existing.includes(q.prompt)) { dropped++; return; }
      const row = toRow(ctx, q, c, provider, i >= ordered.length - 1 && ordered.length > 1);
      if (!row) { dropped++; return; }
      const g = groundQuestion(ctx, c, q, row);
      if (mustGround && row.kind !== 'math' && g.grounding !== 'source') { dropped++; ungrounded++; return; } // a check of THEIR material must be tied to it
      const qid = uid();
      ctx.db.run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,choices,answer_spec,rubric,hints,worked_example,explanation,difficulty,family,heldout,origin,verified,verify_note,source_note,grounding,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, qid, c.id, c.subject_id, row.kind, q.prompt, row.choices, row.answer_spec, row.rubric, JSON.stringify(q.hints), q.worked_example, q.explanation,
        q.difficulty ?? 2, row.family, row.heldout, row.origin, row.verified, row.verify_note, g.note, g.grounding, ctx.now());
      if (g.ev) ctx.db.run('INSERT OR IGNORE INTO question_evidence (question_id,source_id,quote,char_start,char_end,label,support) VALUES (?,?,?,?,?,?,?)', qid, g.ev.sourceId, g.ev.quote, g.ev.start, g.ev.end, g.ev.label, g.support);
      inserted++;
    });
  });
  if (!inserted && ungrounded && !o.strict) return generateQuestions(ctx, conceptId, { ...o, strict: true }); // one regeneration, told to quote only what the excerpts say
  if (!inserted) throw new AIError('malformed', ungrounded ? 'The generated questions could not be tied to your material, so I did not use them. Try again, or practise from Subjects.' : 'None of the generated questions passed validation. Please try again.');
  return { inserted, dropped, ungrounded };
}

/** Decide how a question relates to the student's material, and say exactly that. */
function groundQuestion(ctx: Ctx, c: any, q: GeneratedQuestion, row: { kind: string; choices: string | null; answer_spec: string; rubric: string | null }) {
  const none = { grounding: 'none' as const, note: row.kind === 'math' ? '' : 'Not tied to a passage in your material.', ev: null as ReturnType<typeof findEvidence>, support: 'unchecked' };
  if (row.kind === 'math' || !q.source_quote) return none;
  const ev = findEvidence(ctx, c.subject_id, c.source_id, q.source_quote);
  if (!ev) return none; // the quote is not in the material at all
  const spec = parse<any>(row.answer_spec, {}), choices = parse<{ text: string }[] | null>(row.choices, null), rub = parse<any>(row.rubric, null);
  const r = assessSupport(ev.passage, { kind: row.kind, correctChoice: spec.type === 'choice' ? choices?.[spec.correct]?.text : undefined, keyPoints: rub?.keyPoints, sample: rub?.sample ?? undefined });
  const where = `${ev.sourceTitle}, ${ev.label}`;
  if (r.support === 'supported') return { grounding: 'source' as const, support: 'supported', ev, note: `From your material (${where}). Checked by keyword match: the passage contains the answer’s key terms. That does not guarantee the question is correct.` };
  return { grounding: 'weak' as const, support: 'quote_only', ev, note: `A quote from your material (${where}) was attached, but it does not clearly contain what the answer needs. Treat the source link as unconfirmed.` };
}

/** Locate a model-supplied quote in the student's confirmed materials; only a verbatim hit counts as evidence of existence. */
function findEvidence(ctx: Ctx, subjectId: string, preferred: string | null, quote: string) {
  const srcs = ctx.db.all<any>("SELECT id, title, text FROM sources WHERE subject_id = ? AND status = 'confirmed' ORDER BY (id = ?) DESC, created_at", subjectId, preferred ?? '');
  for (const src of srcs) {
    const hit = findQuote(src.text, quote); if (!hit) continue;
    const ch = ctx.db.get<any>('SELECT label, text FROM source_chunks WHERE source_id = ? AND char_start <= ? AND char_end > ? ORDER BY idx LIMIT 1', src.id, hit.start, hit.start);
    return { sourceId: src.id as string, sourceTitle: src.title as string, quote: (src.text as string).slice(hit.start, hit.end), start: hit.start, end: hit.end, label: (ch?.label as string) ?? 'location unknown', passage: (ch?.text as string) ?? (src.text as string).slice(hit.start, hit.end) };
  }
  return null;
}

function toRow(ctx: Ctx, q: GeneratedQuestion, c: any, provider: { live: boolean }, heldout: boolean) {
  let answer_spec: any; let choices: string | null = null; let rubric: string | null = null;
  let verified: number | null = null, verify_note = '';
  const kind = q.kind;
  if (kind === 'multiple_choice') {
    choices = JSON.stringify(q.choices); answer_spec = { type: 'choice', correct: q.correct_choice };
    verify_note = 'Multiple-choice key comes from the generator; check it if it looks wrong.';
  } else if (kind === 'math') {
    const type = q.math_type === 'expr' ? 'math_expr' : q.math_type === 'number' ? 'math_number' : 'math_set';
    answer_spec = { type, answer: q.answer, variable: 'x', ...(q.relation ? { relation: q.relation } : {}) };
    if (type === 'math_set') {
      const v = verifyMathSpec(answer_spec);
      if (v.verified === false) return null; // answer key contradicts an independent solve: discard, never show
      verified = v.verified === true ? 1 : null; verify_note = v.note;
    } else verify_note = 'Answer key not independently verified.';
    if (!provider.live) { verified = verified ?? null; }
  } else {
    answer_spec = { type: 'text', ...(q.answer ? { accept: [q.answer] } : {}) };
    rubric = JSON.stringify({ keyPoints: (q.rubric?.key_points ?? []).map((k) => ({ point: k.point, keywords: k.keywords })), sample: q.rubric?.sample_answer ?? null });
  }
  const source_note = ''; // filled in by the caller once the quote is located (with its page) in the student's material
  return {
    kind, choices, answer_spec: JSON.stringify(answer_spec), rubric, family: (q as any).family ?? null, heldout: Number(heldout), verified, verify_note, source_note,
    origin: isMathSkill(c.skill_tag) ? 'generator' : provider.live ? 'ai' : 'template',
  };
}
