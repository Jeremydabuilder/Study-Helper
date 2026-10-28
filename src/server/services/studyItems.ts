import { tokens } from '../../core/retrieval';
import { uid } from '../db';
import { Ctx, HttpError, clip, parse } from './common';
import { CATEGORY_LABEL, annotationRow, locate } from './annotations';
import { generateQuestions } from './questions';
import { startSession } from './practice';

/**
 * Annotations become part of the existing study system: each reading gets one concept (origin "annotation"), and its cards and questions are ordinary
 * rows in `questions`, so sessions grade them (answer first, explanation after), diagnose mistakes, and schedule later reviews exactly as for any other concept.
 */

const MAX_ANNOTATIONS = 12, MIN_NOTE_WORDS = 4;
export type ItemKind = 'flashcard' | 'short_answer' | 'practice';

const trimQuote = (q: string, n = 400) => (q.length <= n ? q : `${q.slice(0, q.lastIndexOf(' ', n) > 200 ? q.lastIndexOf(' ', n) : n)} […]`);
const topWords = (s: string, n: number) => {
  const seen = new Map<string, number>();
  for (const t of tokens(s)) if (t.length >= 4 && !/^\d+$/.test(t)) seen.set(t, (seen.get(t) ?? 0) + t.length);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
};
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The reading's concept. Created on first use; students see it as “Reading: <title>” next to their other topics. */
export function readingConcept(ctx: Ctx, sourceId: string) {
  const s = ctx.db.get<any>('SELECT id, title, subject_id FROM sources WHERE id = ?', sourceId);
  if (!s) throw new HttpError(404, 'not_found', 'Reading not found.');
  const ex = ctx.db.get<any>("SELECT id FROM concepts WHERE source_id = ? AND origin = 'annotation'", sourceId);
  if (ex) return { id: ex.id as string, subjectId: s.subject_id as string };
  let name = clip(`Reading: ${s.title}`, 90);
  if (ctx.db.get('SELECT 1 FROM concepts WHERE subject_id = ? AND lower(name) = lower(?)', s.subject_id, name)) name = clip(`Reading: ${s.title}`, 80) + ` (${sourceId.slice(0, 4)})`;
  const id = uid(), now = ctx.now();
  ctx.db.run('INSERT INTO concepts (id,subject_id,name,summary,status,skill_tag,support,support_note,origin,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, s.subject_id, name, clip(`What you highlighted and wrote about in “${s.title}”.`, 500), 'confirmed', null, 'source', 'Made from your own highlights in this reading.', 'annotation', sourceId, now, now);
  return { id, subjectId: s.subject_id as string };
}

function addRef(ctx: Ctx, conceptId: string, sourceId: string, a: any, label: string) {
  if (ctx.db.get('SELECT 1 FROM concept_refs WHERE concept_id = ? AND source_id = ? AND char_start = ? AND char_end = ?', conceptId, sourceId, a.char_start, a.char_end)) return;
  const ch = ctx.db.get<any>('SELECT id FROM source_chunks WHERE source_id = ? AND char_start <= ? AND char_end > ? ORDER BY idx LIMIT 1', sourceId, a.char_start, a.char_start);
  ctx.db.run('INSERT INTO concept_refs (id,concept_id,source_id,chunk_id,quote,char_start,char_end,label) VALUES (?,?,?,?,?,?,?,?)', uid(), conceptId, sourceId, ch?.id ?? null, a.quote, a.char_start, a.char_end, label);
}

function insertQuestion(ctx: Ctx, o: { conceptId: string; subjectId: string; kind: string; prompt: string; rubric: any; hints: string[]; worked: string; explanation: string; heldout: 0 | 1; focus: string; sourceId: string; a: any; label: string; note: string; interpretive: boolean }) {
  const id = uid();
  ctx.db.run(`INSERT INTO questions (id,concept_id,subject_id,kind,prompt,answer_spec,rubric,hints,worked_example,explanation,difficulty,heldout,origin,verified,verify_note,source_note,grounding,created_at,focus,support_state,support_method,support_note,on_hold,interpretive)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, o.conceptId, o.subjectId, o.kind, o.prompt, JSON.stringify({ type: 'text' }), JSON.stringify(o.rubric), JSON.stringify(o.hints), o.worked, o.explanation, 2, o.heldout, 'annotation', null, '',
    o.note, 'weak', ctx.now(), o.focus, 'located', 'annotation', o.note, 0, Number(o.interpretive));
  ctx.db.run('INSERT OR IGNORE INTO question_evidence (question_id,source_id,quote,char_start,char_end,label,support) VALUES (?,?,?,?,?,?,?)', id, o.sourceId, o.a.quote, o.a.char_start, o.a.char_end, o.label, 'located');
  return id;
}

export async function makeStudyItems(ctx: Ctx, sourceId: string, b: { annotationIds: string[]; kinds: string[] }) {
  const s = ctx.db.get<any>("SELECT s.*, sub.name AS subject_name FROM sources s JOIN subjects sub ON sub.id = s.subject_id WHERE s.id = ? AND s.status = 'confirmed'", sourceId);
  if (!s) throw new HttpError(404, 'not_found', 'Reading not found.');
  const ids = [...new Set(b.annotationIds ?? [])];
  if (!ids.length) throw new HttpError(400, 'invalid', 'Select at least one annotation.');
  if (ids.length > MAX_ANNOTATIONS) throw new HttpError(400, 'too_many', `Select ${MAX_ANNOTATIONS} annotations or fewer at a time.`);
  const kinds = [...new Set(b.kinds ?? [])].filter((k): k is ItemKind => ['flashcard', 'short_answer', 'practice'].includes(k));
  if (!kinds.length) throw new HttpError(400, 'invalid', 'Choose what to make: flashcards, short-answer exercises, or practice questions.');
  const anns = ids.map((id) => annotationRow(ctx, sourceId, id)); // every id must belong to THIS reading
  const { id: conceptId, subjectId } = readingConcept(ctx, sourceId);
  const made = { flashcard: 0, short_answer: 0, practice: 0 };
  const skipped: { annotationId: string; kind: string; reason: string }[] = [];
  const has = (annId: string, kind: ItemKind, note: string) => !!ctx.db.get(`SELECT 1 FROM annotation_items i JOIN questions q ON q.id = i.question_id WHERE i.annotation_id = ? AND i.item_kind = ? AND i.note_snapshot = ? AND q.retired_at IS NULL`, annId, kind, note);

  ctx.db.tx(() => {
    for (const a of anns) {
      const label = locate(ctx, s, a.char_start, a.char_end).label;
      addRef(ctx, conceptId, sourceId, a, label);
      const cat = CATEGORY_LABEL[a.category].toLowerCase();
      const noted = words(a.note) >= MIN_NOTE_WORDS;
      const link = (qid: string, kind: ItemKind) => ctx.db.run('INSERT INTO annotation_items (question_id,annotation_id,item_kind,note_snapshot,created_at) VALUES (?,?,?,?,?)', qid, a.id, kind, a.note, ctx.now());
      for (const kind of kinds) {
        if (kind === 'practice') continue; // handled below
        if (!noted) { skipped.push({ annotationId: a.id, kind, reason: 'Write a sentence of your own about this passage first: the card is checked against your note, and there is nothing to check without one.' }); continue; }
        if (has(a.id, kind, a.note)) { skipped.push({ annotationId: a.id, kind, reason: 'Already made from this note.' }); continue; }
        const keyW = topWords(a.note, 6);
        if (kind === 'flashcard') {
          const qid = insertQuestion(ctx, {
            conceptId, subjectId, kind: 'short_answer', focus: 'flashcard', heldout: 0, sourceId, a, label, interpretive: true,
            prompt: `Flashcard (${label}): ${a.category === 'none' ? 'What does this passage show?' : `This passage was marked as ${cat}. What does it show?`} Answer from memory, in your own words.\n\n“${trimQuote(a.quote)}”`,
            rubric: { keyPoints: [{ point: clip(a.note, 300), keywords: keyW }], sample: clip(a.note, 600) },
            hints: ['Look at the key words in the passage.', 'Say what the passage does, then why it matters.'],
            worked: `Your note when you read it: ${clip(a.note, 400)}`, explanation: `Your own note from ${label}: “${clip(a.note, 500)}”`,
            note: 'Made from your own annotation. The key is your own note, which has not been checked against the passage; other valid readings are accepted.',
          });
          link(qid, 'flashcard'); made.flashcard++;
        } else {
          const qid = insertQuestion(ctx, {
            conceptId, subjectId, kind: 'evidence', focus: 'annotation_evidence', heldout: 1, sourceId, a, label, interpretive: true,
            prompt: `Evidence exercise (${label}, ${cat}): You wrote: “${clip(a.note, 300)}”\nWhich words or details in “${s.title}” support that? Quote or describe them, and explain how they support your point.`,
            rubric: { keyPoints: [{ point: 'Points to specific words or details in the passage', keywords: topWords(a.quote, 6) }, { point: 'Explains how the evidence supports the point', keywords: keyW }], sample: `The passage says: “${clip(a.quote, 400)}”` },
            hints: [`Look near ${label}.`, 'Name one exact word or phrase, then say what it shows.'],
            worked: `The highlighted passage (${label}): “${clip(a.quote, 500)}”`, explanation: `You marked this passage (${label}) as ${cat}: “${clip(a.quote, 500)}”`,
            note: 'Made from your own annotation; other valid evidence and readings are accepted.',
          });
          link(qid, 'short_answer'); made.short_answer++;
        }
      }
    }
  });

  if (kinds.includes('practice')) {
    if (ctx.ai.live) {
      // Written by the configured model from the passages you selected (the concept's linked passages), then held to the same grounding checks as any generated question.
      const r = await generateQuestions(ctx, conceptId, { focus: 'practice' });
      made.practice += r.inserted;
      if (r.held) skipped.push({ annotationId: '', kind: 'practice', reason: `${r.held} generated question${r.held > 1 ? 's were' : ' was'} held for your review because the checks found a problem (Subjects → Questions on hold).` });
    } else {
      // No AI: fill-in-the-blank questions cut directly from the highlighted sentence (a word from the passage is blanked out).
      ctx.db.tx(() => {
        for (const a of anns) {
          const label = locate(ctx, s, a.char_start, a.char_end).label;
          if (has(a.id, 'practice', a.note)) { skipped.push({ annotationId: a.id, kind: 'practice', reason: 'Already made from this passage.' }); continue; }
          const sentence = (a.quote.match(/[^.!?]+[.!?]?/g) ?? [a.quote]).map((x: string) => x.trim()).filter((x: string) => x.length >= 25).sort((x: string, y: string) => y.length - x.length)[0] ?? a.quote;
          const target = (sentence.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? []).sort((x: string, y: string) => y.length - x.length)[0];
          if (!target) { skipped.push({ annotationId: a.id, kind: 'practice', reason: 'This passage has no long enough word to blank out.' }); continue; }
          const blanked = sentence.replace(new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), '_____');
          const qid = insertQuestion(ctx, {
            conceptId, subjectId, kind: 'short_answer', focus: 'annotation_cloze', heldout: 0, sourceId, a, label, interpretive: false,
            prompt: `Fill in the blank (${label}): “${trimQuote(blanked, 300)}”`,
            rubric: { keyPoints: [{ point: target, keywords: [target.toLowerCase()] }], sample: target },
            hints: [`The word has ${target.length} letters and starts with “${target[0]}”.`, 'Think about what the sentence is saying.'],
            worked: `The sentence in your reading: “${trimQuote(sentence, 400)}”`, explanation: `From ${label}: “${trimQuote(sentence, 400)}”`,
            note: 'Cut directly from the highlighted passage (no AI involved).',
          });
          ctx.db.run('INSERT INTO annotation_items (question_id,annotation_id,item_kind,note_snapshot,created_at) VALUES (?,?,?,?,?)', qid, a.id, 'practice', a.note, ctx.now());
          made.practice++;
        }
      });
    }
  }
  return { conceptId, made, skipped, total: made.flashcard + made.short_answer + made.practice, practiceIsFill: !ctx.ai.live };
}

export function startReadingSession(ctx: Ctx, sourceId: string, b: { minutes?: number; abandonExisting?: boolean }) {
  const c = ctx.db.get<any>("SELECT id FROM concepts WHERE source_id = ? AND origin = 'annotation'", sourceId);
  const n = c ? ctx.db.get<any>('SELECT COUNT(*) n FROM questions WHERE concept_id = ? AND retired_at IS NULL AND on_hold = 0', c.id).n : 0;
  if (!c || !n) throw new HttpError(409, 'nothing_to_study', 'Make flashcards or questions from some annotations first.');
  return startSession(ctx, { mode: 'practice', conceptIds: [c.id], minutes: b.minutes ?? 10, abandonExisting: b.abandonExisting });
}

/* ------------------------------ essay outlines ------------------------------ */

interface OutlineSection { id: string; heading: string; category: string; claim: string; guidingQuestion: string; evidence: { annotationId: string; quote: string; location: string; note: string }[] }
const ORDER = ['argument', 'theme', 'characterization', 'imagery', 'evidence', 'vocabulary', 'other', 'none', 'question'];
const GUIDE: Record<string, string> = {
  argument: 'What is the claim, and which of your passages are reasons for it?', theme: 'What single idea connects these passages? State it as a sentence.', characterization: 'What do these passages together say about the person? Where does it change?',
  imagery: 'What pattern do these images form, and what does it add to the meaning?', evidence: 'What does this evidence prove, and what does it only suggest?', vocabulary: 'Which of these words carries the most meaning, and why?',
  other: 'How do these notes fit your main point?', none: 'How do these notes fit your main point?', question: 'Which of these questions can you now answer from the text?',
};

export function makeOutline(ctx: Ctx, sourceId: string, b: { annotationIds: string[]; title?: string }) {
  const s = ctx.db.get<any>("SELECT id, title FROM sources WHERE id = ? AND status = 'confirmed'", sourceId);
  if (!s) throw new HttpError(404, 'not_found', 'Reading not found.');
  const ids = [...new Set(b.annotationIds ?? [])];
  if (!ids.length) throw new HttpError(400, 'invalid', 'Select at least one annotation.');
  if (ids.length > 40) throw new HttpError(400, 'too_many', 'Select 40 annotations or fewer.');
  const anns = ids.map((id) => annotationRow(ctx, sourceId, id)).sort((a, c) => a.char_start - c.char_start);
  const src = ctx.db.get<any>('SELECT id, ocr FROM sources WHERE id = ?', sourceId);
  const groups = new Map<string, any[]>();
  for (const a of anns) groups.set(a.category, [...(groups.get(a.category) ?? []), a]);
  const prompt = ctx.db.get<any>('SELECT kind, text FROM reading_prompts WHERE source_id = ?', sourceId);
  const sections: OutlineSection[] = [...groups.entries()].sort((x, y) => ORDER.indexOf(x[0]) - ORDER.indexOf(y[0])).map(([cat, list]) => ({
    id: uid().slice(0, 8), heading: cat === 'none' ? 'Other notes' : CATEGORY_LABEL[cat], category: cat, claim: '', guidingQuestion: GUIDE[cat],
    evidence: list.map((a) => ({ annotationId: a.id, quote: trimQuote(a.quote, 500), location: locate(ctx, src, a.char_start, a.char_end).label, note: a.note })),
  }));
  const body = { readingTitle: s.title, prompt: prompt ? { kind: prompt.kind, text: prompt.text } : null, thesis: '', sections, basis: 'Built from the annotations you selected. Thesis and claims are yours to write; nothing here was written for you.' };
  const id = uid(), now = ctx.now(), title = clip(b.title, 120).trim() || `Outline: ${s.title}`;
  ctx.db.run('INSERT INTO outlines (id,source_id,title,body,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, sourceId, title, JSON.stringify(body), now, now);
  return getOutline(ctx, id);
}

export function getOutline(ctx: Ctx, id: string) {
  const o = ctx.db.get<any>('SELECT * FROM outlines WHERE id = ?', id);
  if (!o) throw new HttpError(404, 'not_found', 'Outline not found.');
  const body = parse<any>(o.body, {});
  const live = new Set(ctx.db.all<any>('SELECT id FROM annotations WHERE source_id = ?', o.source_id).map((r) => r.id));
  for (const sec of body.sections ?? []) for (const e of sec.evidence) e.stillAnnotated = live.has(e.annotationId);
  return { id: o.id, sourceId: o.source_id, title: o.title, createdAt: o.created_at, updatedAt: o.updated_at, ...body };
}

export function updateOutline(ctx: Ctx, id: string, b: { title?: string; thesis?: string; claims?: Record<string, string> }) {
  const o = ctx.db.get<any>('SELECT * FROM outlines WHERE id = ?', id);
  if (!o) throw new HttpError(404, 'not_found', 'Outline not found.');
  const body = parse<any>(o.body, {});
  if (b.thesis !== undefined) body.thesis = clip(b.thesis, 1500);
  for (const sec of body.sections ?? []) if (b.claims && sec.id in b.claims) sec.claim = clip(b.claims[sec.id], 1500);
  ctx.db.run('UPDATE outlines SET title = ?, body = ?, updated_at = ? WHERE id = ?', b.title === undefined ? o.title : clip(b.title, 120).trim() || o.title, JSON.stringify(body), ctx.now(), id);
  return getOutline(ctx, id);
}
export function deleteOutline(ctx: Ctx, id: string) { ctx.db.run('DELETE FROM outlines WHERE id = ?', id); return { ok: true }; }
