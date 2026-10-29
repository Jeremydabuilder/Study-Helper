import { OfflineProvider } from '../../ai/offline';
import { GeneratedQuestion } from '../../ai/schemas';
import { verifyMathSpec } from '../../core/mathCheck';
import { isMathSkill } from '../../core/mathgen';
import { buildContext } from '../../core/retrieval';
import { findQuote } from '../../core/sources';
import { SupportState, assessSupport, findContradiction, findUnmentioned, keyStatements, looksInterpretive } from '../../core/grounding';
import { NextAction } from '../../core/nextAction';
import { testsKeyFor } from './teachingMemory';
import { uid } from '../db';
import { Ctx, HttpError, getProfile, parse } from './common';
import { modelChunks } from './sourceSafety';
import { AIError } from '../../ai/provider';

export interface QuestionRow {
  id: string; concept_id: string; subject_id: string; kind: string; prompt: string; choices: string | null; answer_spec: string; rubric: string | null;
  hints: string; worked_example: string; explanation: string; difficulty: number; family: string | null; heldout: number; origin: string;
  verified: number | null; verify_note: string; source_note: string; grounding: 'source' | 'weak' | 'none'; retired_at?: number | null; reported_unclear?: number; focus?: string | null; contrast_id?: string | null; tests_key?: string | null; support_state?: string; on_hold?: number; interpretive?: number;
}

/** What the browser may see *before* answering: never the key, rubric, or explanation. */
export function publicQuestion(q: QuestionRow) {
  const choices = parse<{ text: string }[] | null>(q.choices, null);
  const spec = parse<any>(q.answer_spec, {});
  return {
    id: q.id, conceptId: q.concept_id, kind: q.kind, prompt: q.prompt, choices: choices?.map((c) => c.text) ?? null,
    answerType: spec.type as string, hintCount: parse<string[]>(q.hints, []).length, difficulty: q.difficulty,
    origin: q.origin, keyVerified: q.verified === null ? null : !!q.verified, sourceNote: q.source_note, grounding: q.grounding, supportState: q.support_state ?? 'none', interpretive: !!q.interpretive,
  };
}

export function getQuestion(ctx: Ctx, id: string): QuestionRow {
  const q = ctx.db.get<QuestionRow>('SELECT * FROM questions WHERE id = ?', id);
  if (!q) throw new HttpError(404, 'not_found', 'Question not found.');
  return q;
}

export interface PickOpts { conceptId: string; purpose: 'diagnostic' | 'practice' | 'review' | 'repair' | 'transfer' | 'exam'; exclude: string[]; lastKind?: string | null; easier?: boolean; useOffline?: boolean; action?: NextAction }

function unseen(ctx: Ctx, conceptId: string, exclude: string[], heldout: 0 | 1): QuestionRow[] {
  const rows = ctx.db.all<QuestionRow>(`SELECT * FROM questions q WHERE concept_id = ? AND heldout = ? AND retired_at IS NULL AND on_hold = 0 AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id) ORDER BY created_at, rowid`, conceptId, heldout);
  return rows.filter((r) => !exclude.includes(r.id));
}

/** Choose a question the student has never attempted; generate more only when the bank is empty. A follow-up action can ask for a specific kind of question. */
export async function pickQuestion(ctx: Ctx, o: PickOpts): Promise<QuestionRow> {
  const wantHeld = o.purpose === 'review' || o.purpose === 'transfer' || o.purpose === 'exam';
  const act = o.action;
  const choose = (): QuestionRow | null => {
    const order: (0 | 1)[] = wantHeld ? [1, 0] : [0];
    for (const h of order) {
      const cands = unseen(ctx, o.conceptId, o.exclude, h);
      if (!cands.length) continue;
      const varied = o.purpose === 'diagnostic' && o.lastKind ? cands.find((c) => c.kind !== o.lastKind) : undefined;
      if (varied) return varied;
      if (o.easier) { const e = [...cands].sort((a, b) => a.difficulty - b.difficulty)[0]; return e; }
      const other = act?.avoidKind ? cands.find((c) => c.kind !== act.avoidKind) : undefined; // a different form of the same idea
      return other ?? cands[0];
    }
    return null;
  };
  // an adaptive follow-up (discriminate / fill the gap / simpler): reuse a matching unseen question, else write one
  const special = act?.focus && act.focus !== 'practice' ? act : null;
  if (special) {
    const pool = unseen(ctx, o.conceptId, o.exclude, 0).filter((c) => c.focus === special.focus && (special.focus !== 'discriminate' || !special.contrast || c.contrast_id === special.contrast.id) && special.focus !== 'gap');
    if (pool[0]) return pool[0];
    try {
      await generateQuestions(ctx, o.conceptId, { focus: special.focus as GenFocus, useOffline: o.useOffline, contrastConceptId: special.contrast?.id, gapPoints: special.gapPoints });
      const fresh = unseen(ctx, o.conceptId, o.exclude, 0).find((c) => c.focus === special.focus);
      if (fresh) return fresh;
    } catch (e) { if (!(e instanceof AIError) && !(e instanceof HttpError)) throw e; /* fall back to an ordinary question below */ }
  }
  let q = choose();
  if (!q) {
    await generateQuestions(ctx, o.conceptId, { focus: o.purpose === 'repair' ? 'repair' : o.purpose === 'diagnostic' ? 'diagnostic' : wantHeld ? 'transfer' : 'practice', useOffline: o.useOffline });
    q = choose();
  }
  if (!q) throw new HttpError(409, 'no_new_questions', ctx.ai.live ? 'No new questions could be made for this concept right now.' : 'Offline mode has run out of new template questions for this concept. Add more material, or connect an AI provider for unlimited fresh questions.');
  return q;
}

export type GenFocus = 'diagnostic' | 'practice' | 'transfer' | 'repair' | 'discriminate' | 'gap' | 'simpler';
export interface GenOpts {
  focus: GenFocus; useOffline?: boolean; contrastConceptId?: string; gapPoints?: string[]; strict?: boolean;
  /** Exact passages to write from (already masked for the model) instead of the concept's top linked chunks, and the student's own notes about them (data). */
  passages?: { label: string; text: string }[]; notes?: string[];
}

/** Checks of the student's own material (diagnostic / fresh checks) must be grounded in it; practice questions may be labelled instead. */
const REQUIRES_GROUNDING: GenFocus[] = ['diagnostic', 'transfer'];

export async function generateQuestions(ctx: Ctx, conceptId: string, o: GenOpts): Promise<{ inserted: number; dropped: number; ungrounded: number; held: number }> {
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
  // homework questions on this topic are never reused as practice: a later check must not repeat what the student just worked on or was shown
  const homeworkSeen = ctx.db.all<any>('SELECT q.prompt FROM homework_questions q JOIN homework_concepts hc ON hc.question_id = q.id WHERE hc.concept_id = ?', conceptId).map((r) => r.prompt as string);
  const existing = [...ctx.db.all<any>('SELECT prompt FROM questions WHERE concept_id = ?', conceptId).map((r) => r.prompt as string), ...homeworkSeen];
  const others = ctx.db.all<any>("SELECT name, summary FROM concepts WHERE subject_id = ? AND status = 'confirmed' AND id != ?", c.subject_id, conceptId);
  const contrast = o.contrastConceptId ? ctx.db.get<any>('SELECT name, summary FROM concepts WHERE id = ?', o.contrastConceptId) : null;
  const batch = await provider.generateQuestions({
    subjectName: c.subject_name, concept: { name: c.name, summary: c.summary, skillTag: c.skill_tag }, excerpts: o.passages?.length ? o.passages : context.sourceExcerpts.map((e) => ({ label: e.label, text: e.text })),
    otherConcepts: others, misconceptions: context.misconceptions, studentNotes: [...context.memories, ...(o.notes ?? [])],
    practice: o.focus === 'diagnostic' ? 2 : 3, heldout: 1, avoidPrompts: existing, seed: existing.length + 1, focus: o.focus, gradeLevel: getProfile(ctx.db).grade,
    contrast: contrast ? { name: contrast.name, summary: contrast.summary } : undefined, gapPoints: o.gapPoints, strict: o.strict,
  });
  const ordered = [...batch.questions];
  let dropped = 0, ungrounded = 0, held = 0, served = 0;
  const cands: { q: GeneratedQuestion; row: NonNullable<ReturnType<typeof toRow>>; g: Ground; idx: number }[] = [];
  ordered.forEach((q, i) => {
    if (existing.includes(q.prompt)) { dropped++; return; }
    const row = toRow(ctx, q, c, provider, i >= ordered.length - 1 && ordered.length > 1);
    if (!row) { dropped++; return; }
    cands.push({ q, row, g: groundQuestion(ctx, c, q, row, provider.live), idx: i });
  });
  // One batched, structured comparison of question + key + source context (not one paid call per question). It is a fallible second opinion: if it is
  // unavailable (no provider, budget, an error) the deterministic result stands and nothing is claimed beyond it.
  let assessed = false;
  if (provider.live && provider.assessSupport) {
    const items = cands.filter((x) => x.g.ev && x.row.kind !== 'math' && x.g.state !== 'contradicted').map((x) => ({ index: x.idx, question: x.q.prompt, kind: x.row.kind, key: keyTexts(x.row), passage: x.g.ev!.context, label: `${x.g.ev!.sourceTitle}, ${x.g.ev!.label}`, interpretive: x.g.interpretive }));
    if (items.length) {
      try {
        const r = await provider.assessSupport(items);
        assessed = true;
        for (const v of r.items) {
          const x = cands.find((k) => k.idx === v.index); if (!x || !x.g.ev) continue;
          const where = `${x.g.ev.sourceTitle}, ${x.g.ev.label}`;
          if (v.verdict === 'supported' && x.g.state !== 'contradicted') x.g = { ...x.g, state: 'plausible', method: 'semantic', note: `Support checked by a second model reading: plausibly supported by your material (${where}). That reading is fallible: report the question if it looks wrong.` };
          else if (v.verdict === 'contradicted') x.g = { ...x.g, state: 'contradicted', method: 'semantic', note: `A second model reading found the answer key may conflict with your material (${where}): ${v.note || 'no detail'}.` };
          else if (v.verdict === 'insufficient' && x.g.state !== 'contradicted' && !x.g.interpretive) x.g = { ...x.g, state: 'insufficient', method: 'semantic', note: `Your material (${where}) may not say enough to check this answer: ${v.note || 'no detail'}.` };
        }
      } catch (e) { if (!(e instanceof AIError)) throw e; }
    }
  }
  const mustGround = REQUIRES_GROUNDING.includes(o.focus) && c.support === 'source' && provider.live;
  ctx.db.tx(() => {
    for (const { q, row, g } of cands) {
      const hold = g.state === 'contradicted' || (g.state === 'insufficient' && !g.interpretive);
      const okForCheck = g.state === 'plausible' || g.state === 'accepted' || (g.state === 'located' && g.lexical === 'supported' && !assessed && !g.interpretive);
      if (mustGround && row.kind !== 'math' && !hold && !okForCheck) { dropped++; ungrounded++; continue; } // a check of THEIR material must be tied to it
      const qid = uid();
      ctx.db.run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,choices,answer_spec,rubric,hints,worked_example,explanation,difficulty,family,heldout,origin,verified,verify_note,source_note,grounding,created_at,support_state,support_method,support_note,on_hold,hold_reason,interpretive)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, qid, c.id, c.subject_id, row.kind, q.prompt, row.choices, row.answer_spec, row.rubric, JSON.stringify(q.hints), q.worked_example, q.explanation,
        q.difficulty ?? 2, row.family, row.heldout, row.origin, row.verified, row.verify_note, g.note, g.state === 'plausible' ? 'source' : g.state === 'none' ? 'none' : 'weak', ctx.now(), g.state, g.method, g.note, Number(hold), hold ? g.note : null, Number(g.interpretive));
      if (['discriminate', 'gap', 'simpler'].includes(o.focus)) ctx.db.run('UPDATE questions SET focus = ?, contrast_id = ?, tests_key = ?, heldout = 0 WHERE id = ?', o.focus, o.contrastConceptId ?? null, o.focus === 'discriminate' ? testsKeyFor(c.id, { contrastConceptId: o.contrastConceptId }) : null, qid); // follow-ups are for now, not reserved for later checks
      if (g.ev) ctx.db.run('INSERT OR IGNORE INTO question_evidence (question_id,source_id,quote,char_start,char_end,label,support) VALUES (?,?,?,?,?,?,?)', qid, g.ev.sourceId, g.ev.quote, g.ev.start, g.ev.end, g.ev.label, g.state);
      if (hold) held++; else served++;
    }
  });
  const HELD_MSG = 'The generated questions conflict with, or are not supported by, your material, so they were held for your review (Subjects → Questions on hold) and not used.';
  if (!served && (ungrounded || held) && !o.strict) {
    // one regeneration, told to quote only what the excerpts say; if it only repeats what was already held, say that instead of a generic failure
    try { return await generateQuestions(ctx, conceptId, { ...o, strict: true }); } catch (e) { if (held && e instanceof AIError) throw new AIError('malformed', HELD_MSG); throw e; }
  }
  if (!served) throw new AIError('malformed', held ? HELD_MSG : ungrounded ? 'The generated questions could not be tied to your material, so I did not use them. Try again, or practise from Subjects.' : 'None of the generated questions passed validation. Please try again.');
  return { inserted: served, dropped, ungrounded, held };
}

const keyTexts = (row: { kind: string; choices: string | null; answer_spec: string; rubric: string | null }) => {
  const spec = parse<any>(row.answer_spec, {}), choices = parse<{ text: string }[] | null>(row.choices, null), rub = parse<any>(row.rubric, null);
  return keyStatements({ kind: row.kind, correctChoice: spec.type === 'choice' ? choices?.[spec.correct]?.text : undefined, keyPoints: rub?.keyPoints, sample: rub?.sample ?? undefined });
};

interface Ground { state: SupportState; method: 'template' | 'keyword' | 'rule' | 'semantic' | null; note: string; ev: ReturnType<typeof findEvidence>; lexical: 'supported' | 'quote_only' | null; interpretive: boolean }

/**
 * How a question relates to the student's material, said exactly. Keyword overlap can only ever say "located" (never "plausible"); a specific conflict found by a
 * rule holds the question; "plausible" comes only from a structured semantic reading (or, offline, from the question being built directly from the material).
 */
function groundQuestion(ctx: Ctx, c: any, q: GeneratedQuestion, row: { kind: string; choices: string | null; answer_spec: string; rubric: string | null }, live: boolean): Ground {
  const subjectName = ctx.db.get<any>('SELECT name FROM subjects WHERE id = ?', c.subject_id)?.name ?? '';
  const interpretive = row.kind !== 'math' && (q.interpretive ?? looksInterpretive(subjectName, q.prompt, row.kind));
  if (row.kind === 'math') return { state: 'none', method: null, note: '', ev: null, lexical: null, interpretive: false };
  if (!live) { // offline templates are built from the material's own wording (definitions, summaries, blanks)
    return c.support === 'source'
      ? { state: 'plausible', method: 'template', note: 'Built directly from the wording of your own material (no AI involved).', ev: null, lexical: null, interpretive }
      : { state: 'none', method: null, note: 'Not tied to a passage in your material.', ev: null, lexical: null, interpretive };
  }
  const ev = q.source_quote ? findEvidence(ctx, c.subject_id, c.source_id, q.source_quote) : null;
  if (!ev) return { state: 'none', method: null, note: interpretive ? 'Interpretive question: several answers can be defensible, judged on evidence from the text. Not tied to one passage.' : 'Not tied to a passage in your material.', ev: null, lexical: null, interpretive };
  const where = `${ev.sourceTitle}, ${ev.label}`;
  if (interpretive) return { state: 'located', method: null, note: `Interpretive question: several answers can be defensible, judged on evidence from the text. A passage was cited (${where}); support was not assessed as a single key.`, ev, lexical: null, interpretive };
  const stmts = keyTexts(row);
  for (const k of stmts) {
    const bad = findContradiction(k, ev.context);
    if (bad) return { state: 'contradicted', method: 'rule', note: `The answer key may conflict with your material (${where}). ${bad}`, ev, lexical: null, interpretive };
  }
  for (const k of stmts) {
    const missing = findUnmentioned(k, ev.context);
    if (missing) return { state: 'insufficient', method: 'rule', note: `Your material (${where}) may not say enough to check this. ${missing}`, ev, lexical: null, interpretive };
  }
  const spec = parse<any>(row.answer_spec, {}), choices = parse<{ text: string }[] | null>(row.choices, null), rub = parse<any>(row.rubric, null);
  const r = assessSupport(ev.passage, { kind: row.kind, correctChoice: spec.type === 'choice' ? choices?.[spec.correct]?.text : undefined, keyPoints: rub?.keyPoints, sample: rub?.sample ?? undefined });
  return { state: 'located', method: 'keyword', lexical: r.support === 'supported' ? 'supported' : 'quote_only', ev, interpretive,
    note: `Quote located in your material (${where}); whether it supports the answer was not assessed.${r.support === 'supported' ? ' The answer’s key terms do appear in it, but keyword overlap is only a heuristic.' : ' Few of the answer’s key words appear in it, which can also happen with an accurate paraphrase.'}` };
}

/** Locate a model-supplied quote in the student's confirmed materials; only a verbatim hit counts as evidence of existence. */
function findEvidence(ctx: Ctx, subjectId: string, preferred: string | null, quote: string) {
  const srcs = ctx.db.all<any>("SELECT id, title, text FROM sources WHERE subject_id = ? AND status = 'confirmed' ORDER BY (id = ?) DESC, created_at", subjectId, preferred ?? '');
  for (const src of srcs) {
    const hit = findQuote(src.text, quote); if (!hit) continue;
    const ch = ctx.db.get<any>('SELECT idx, label, text FROM source_chunks WHERE source_id = ? AND char_start <= ? AND char_end > ? ORDER BY idx LIMIT 1', src.id, hit.start, hit.start);
    const near = ch ? ctx.db.all<any>('SELECT text FROM source_chunks WHERE source_id = ? AND idx BETWEEN ? AND ? ORDER BY idx', src.id, ch.idx - 1, ch.idx + 1).map((r) => r.text as string).join('\n') : '';
    return { context: (near || (src.text as string).slice(Math.max(0, hit.start - 400), hit.end + 400)).slice(0, 2400), sourceId: src.id as string, sourceTitle: src.title as string, quote: (src.text as string).slice(hit.start, hit.end), start: hit.start, end: hit.end, label: (ch?.label as string) ?? 'location unknown', passage: (ch?.text as string) ?? (src.text as string).slice(hit.start, hit.end) };
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

/** Questions the checks held back (a conflict with the material, or not enough support). The student decides: accept it, or throw it away. */
export function heldQuestions(ctx: Ctx, subjectId: string) {
  return ctx.db.all<any>(`SELECT q.id, q.prompt, q.kind, q.support_state, q.support_method, q.hold_reason, c.name AS concept,
    (SELECT quote FROM question_evidence e WHERE e.question_id = q.id LIMIT 1) AS quote, (SELECT label FROM question_evidence e WHERE e.question_id = q.id LIMIT 1) AS label
    FROM questions q JOIN concepts c ON c.id = q.concept_id WHERE q.subject_id = ? AND q.on_hold = 1 AND q.retired_at IS NULL ORDER BY q.created_at DESC`, subjectId)
    .map((r) => ({ id: r.id, prompt: r.prompt, kind: r.kind, concept: r.concept, state: r.support_state, method: r.support_method, reason: r.hold_reason, quote: r.quote, label: r.label }));
}
export function resolveQuestion(ctx: Ctx, id: string, action: 'accept' | 'discard') {
  const q = ctx.db.get<any>('SELECT id FROM questions WHERE id = ?', id);
  if (!q) throw new HttpError(404, 'not_found', 'Question not found.');
  if (action === 'accept') ctx.db.run("UPDATE questions SET on_hold = 0, hold_reason = NULL, support_state = 'accepted', support_note = 'You reviewed this question and accepted it.', source_note = 'You reviewed this question and accepted it; the checks had flagged it.' WHERE id = ?", id);
  else ctx.db.run("UPDATE questions SET retired_at = ?, retired_reason = 'You discarded this question after review.' WHERE id = ?", ctx.now(), id);
  return { ok: true };
}
