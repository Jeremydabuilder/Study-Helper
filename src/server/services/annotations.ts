import { findQuote, maskForModel, isOnlyMarkers } from '../../core/sources';
import { tokens } from '../../core/retrieval';
import { uid } from '../db';
import { Ctx, HttpError, clip, getProfile, parse } from './common';
import { exclusionsFor } from './sourceSafety';
import { AIError } from '../../ai/provider';
import type { AnnotationFeedback } from '../../ai/schemas';

/**
 * Annotation workspace. The server is the only place a highlight's quote is made: it copies the text from the stored reading at the
 * given offsets, so a quotation can never be invented or edited in the browser. Locations are the reading's own sections/pages.
 */

export const CATEGORIES = ['theme', 'characterization', 'imagery', 'argument', 'evidence', 'question', 'vocabulary', 'other'] as const;
export type Category = (typeof CATEGORIES)[number] | 'none';
export const CATEGORY_LABEL: Record<string, string> = { none: 'Uncategorised', theme: 'Theme', characterization: 'Characterization', imagery: 'Imagery', argument: 'Argument', evidence: 'Evidence', question: 'Question', vocabulary: 'Vocabulary', other: 'Other' };

const MAX_SPAN = 2000, MAX_NOTE = 2000, MAX_PROMPT = 6000, MAX_ASSISTS = 12, MIN_FEEDBACK_WORDS = 4;

const srcRow = (ctx: Ctx, id: string) => {
  const s = ctx.db.get<any>('SELECT s.*, sub.name AS subject_name FROM sources s JOIN subjects sub ON sub.id = s.subject_id WHERE s.id = ?', id);
  if (!s) throw new HttpError(404, 'not_found', 'Reading not found.');
  return s;
};
const confirmedSrc = (ctx: Ctx, id: string) => {
  const s = srcRow(ctx, id);
  if (s.status !== 'confirmed') throw new HttpError(409, 'draft_source', 'Check and confirm the extracted text first (Subjects → this material → review). Highlights are only kept on text you have confirmed.');
  return s;
};
/** An annotation always belongs to the reading named in the URL; an id from another reading is "not found", not accessible through this one. */
export function annotationRow(ctx: Ctx, sourceId: string, id: string) {
  const a = ctx.db.get<any>('SELECT * FROM annotations WHERE id = ? AND source_id = ?', id, sourceId);
  if (!a) throw new HttpError(404, 'not_found', 'Annotation not found in this reading.');
  return a;
}

/** Where a span is in the reading. A page number is given only when the reading's page information is reliable; otherwise the section (¶) is named. */
export function locate(ctx: Ctx, s: { id: string; ocr: number }, start: number, end: number) {
  const chunks = ctx.db.all<any>('SELECT idx, label, page, uncertain, char_start, char_end FROM source_chunks WHERE source_id = ? ORDER BY idx', s.id);
  const at = (off: number) => chunks.find((c) => c.char_start <= off && off < c.char_end) ?? [...chunks].reverse().find((c) => c.char_start <= off) ?? chunks[0];
  const a = at(start), b = at(Math.max(start, end - 1));
  if (!a) return { label: 'in this reading', pageReliable: false, page: null as number | null };
  const reliable = (c: any) => c.page != null && !s.ocr && !c.uncertain;
  const lab = (c: any) => (reliable(c) ? c.label : String(c.label).replace(/^p\. \d+, /, ''));
  const base = b && b.idx !== a.idx ? `${lab(a)} to ${lab(b)}` : lab(a);
  const unconfirmedPage = a.page != null && !reliable(a);
  return { label: unconfirmedPage ? `${base} (page not confirmed)` : base, pageReliable: reliable(a), page: reliable(a) ? (a.page as number) : null };
}

/** Text as an AI model may see it: passages that look like instructions to an AI are left out, as everywhere else in the app. */
export function modelView(ctx: Ctx, s: { id: string; text: string }, start: number, end: number) {
  const spans = exclusionsFor(ctx, [s.id]).get(s.id) ?? [];
  const passage = maskForModel(s.text.slice(start, end), start, spans);
  const from = Math.max(0, start - 700), to = Math.min(s.text.length, end + 700);
  const context = maskForModel(s.text.slice(from, to), from, spans);
  return { passage, context, usable: !isOnlyMarkers(passage) };
}

/** A model may paraphrase freely but may not quote text that is not there: any longer quotation not found in the provided text is removed. */
export function stripInventedQuotes(text: string, haystack: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(/[“"]([^”"\n]{20,400})[”"]/g, (m, inner: string) => {
    if (findQuote(haystack, inner)) return m;
    removed++;
    return '[quotation removed: not found in the text]';
  });
  return { text: out, removed };
}

const overlapOf = (note: string, quote: string) => {
  const n = [...new Set(tokens(note))]; if (!n.length) return 0;
  const q = new Set(tokens(quote));
  return n.filter((w) => q.has(w)).length / n.length;
};

/* ------------------------------ readings ------------------------------ */

export function listReadings(ctx: Ctx) {
  return ctx.db.all<any>(`SELECT s.id, s.title, s.kind, s.subject_id, sub.name AS subject_name, s.created_at, LENGTH(s.text) AS chars, s.file_id IS NOT NULL AS has_file,
      (SELECT COUNT(*) FROM annotations a WHERE a.source_id = s.id) AS annotations,
      (SELECT COUNT(*) FROM annotations a WHERE a.source_id = s.id AND a.note <> '') AS noted,
      EXISTS (SELECT 1 FROM reading_prompts p WHERE p.source_id = s.id) AS has_prompt
    FROM sources s JOIN subjects sub ON sub.id = s.subject_id WHERE s.status = 'confirmed' AND sub.archived = 0 ORDER BY s.created_at DESC`)
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind, subjectId: r.subject_id, subject: r.subject_name, chars: r.chars, hasFile: !!r.has_file, annotations: r.annotations, noted: r.noted, hasPrompt: !!r.has_prompt, createdAt: r.created_at }));
}

function annotationView(ctx: Ctx, s: any, a: any) {
  let start = a.char_start, end = a.char_end, orphaned = false;
  if (s.text.slice(start, end) !== a.quote) { // the reading was edited or replaced: find the passage again, never guess
    const hit = findQuote(s.text, a.quote);
    if (hit && s.text.slice(hit.start, hit.end) === a.quote) { start = hit.start; end = hit.end; ctx.db.run('UPDATE annotations SET char_start = ?, char_end = ?, source_rev = ? WHERE id = ?', start, end, s.rev ?? 1, a.id); }
    else orphaned = true;
  }
  const loc = orphaned ? { label: 'passage no longer found in the current text', pageReliable: false, page: null } : locate(ctx, s, start, end);
  const assists = ctx.db.all<any>('SELECT * FROM annotation_assists WHERE annotation_id = ? ORDER BY created_at, rowid', a.id).map((x) => ({
    id: x.id, kind: x.kind, term: x.term, payload: parse<any>(x.payload, {}), at: x.created_at, model: x.model, stale: x.kind === 'feedback' && x.note_snapshot !== a.note,
  }));
  const items = ctx.db.all<any>(`SELECT i.item_kind, q.id, q.retired_at FROM annotation_items i JOIN questions q ON q.id = i.question_id WHERE i.annotation_id = ? ORDER BY i.created_at`, a.id)
    .map((r) => ({ id: r.id, kind: r.item_kind, active: !r.retired_at }));
  return { id: a.id, start, end, quote: a.quote, category: a.category, note: a.note, location: loc.label, page: loc.page, pageReliable: loc.pageReliable, orphaned, createdAt: a.created_at, updatedAt: a.updated_at, assists, items };
}

export function getReading(ctx: Ctx, id: string) {
  const s = srcRow(ctx, id);
  const chunks = ctx.db.all<any>('SELECT idx, label, page, uncertain, char_start start, char_end end FROM source_chunks WHERE source_id = ? ORDER BY idx', id);
  const ex = exclusionsFor(ctx, [id]).get(id) ?? [];
  const prompt = ctx.db.get<any>('SELECT kind, text, updated_at FROM reading_prompts WHERE source_id = ?', id);
  const anyPage = chunks.some((c) => c.page != null), uncertain = chunks.some((c) => c.uncertain);
  const warnings: string[] = [];
  if (s.status !== 'confirmed') warnings.push('This text has not been confirmed yet, so highlights are disabled. Check the extracted text first.');
  if (s.ocr) warnings.push('Part of this text was read from a scan or typed from an image. Check it against the original; page numbers are not shown for it.');
  else if (uncertain) warnings.push('Some passages (usually maths) were flagged as possibly misread. Page numbers are not shown for those, and you should check them against the original.');
  if (ex.length) warnings.push(`${ex.length} passage${ex.length > 1 ? 's look' : ' looks'} like instructions to an AI. ${ex.length > 1 ? 'They are' : 'It is'} left out of anything sent to an AI model.`);
  const live = ctx.ai.live && !!ctx.ai.assist;
  return {
    reading: { id: s.id, title: s.title, kind: s.kind, subjectId: s.subject_id, subject: s.subject_name, text: s.text, status: s.status, ocr: !!s.ocr, hasFile: !!s.file_id, pageNumbers: anyPage && !s.ocr ? 'where the text has page markers' : 'none (sections are numbered instead)' },
    chunks, excluded: ex, warnings,
    prompt: prompt ? { kind: prompt.kind, text: prompt.text, updatedAt: prompt.updated_at } : null,
    annotations: ctx.db.all<any>('SELECT * FROM annotations WHERE source_id = ? ORDER BY char_start, created_at', id).map((a) => annotationView(ctx, s, a)),
    ai: { available: live, label: live ? ctx.ai.label : null, note: live ? `Explanations, definitions and feedback use ${ctx.ai.label}. The passage you select and your note are sent to it; nothing else from your account.` : 'No AI provider is set up. Highlighting, notes, flashcards and outlines still work; explanations, definitions and AI feedback need one (Settings → Setup).' },
    outlines: ctx.db.all<any>('SELECT id, title, updated_at FROM outlines WHERE source_id = ? ORDER BY updated_at DESC', id).map((o) => ({ id: o.id, title: o.title, updatedAt: o.updated_at })),
    conceptId: ctx.db.get<any>("SELECT id FROM concepts WHERE source_id = ? AND origin = 'annotation'", id)?.id ?? null,
  };
}

export function setPrompt(ctx: Ctx, sourceId: string, b: { kind: 'prompt' | 'rubric'; text: string } | null) {
  srcRow(ctx, sourceId);
  if (!b || !b.text.trim()) { ctx.db.run('DELETE FROM reading_prompts WHERE source_id = ?', sourceId); return { prompt: null }; }
  if (!['prompt', 'rubric'].includes(b.kind)) throw new HttpError(400, 'invalid', 'Choose prompt or rubric.');
  const text = clip(b.text, MAX_PROMPT).trim();
  ctx.db.run('INSERT INTO reading_prompts (source_id,kind,text,updated_at) VALUES (?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET kind = excluded.kind, text = excluded.text, updated_at = excluded.updated_at', sourceId, b.kind, text, ctx.now());
  return { prompt: { kind: b.kind, text } };
}
const promptFor = (ctx: Ctx, sourceId: string) => { const p = ctx.db.get<any>('SELECT kind, text FROM reading_prompts WHERE source_id = ?', sourceId); return p ? { kind: p.kind as 'prompt' | 'rubric', text: p.text as string } : null; };

/* ------------------------------ annotations ------------------------------ */

export function createAnnotation(ctx: Ctx, sourceId: string, b: { start: number; end: number; category?: string; note?: string }) {
  const s = confirmedSrc(ctx, sourceId);
  let start = Number(b.start), end = Number(b.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > s.text.length || start >= end) throw new HttpError(400, 'invalid_span', 'Select some text in the reading first.');
  while (start < end && /\s/.test(s.text[start])) start++;
  while (end > start && /\s/.test(s.text[end - 1])) end--;
  if (end - start < 3) throw new HttpError(400, 'invalid_span', 'Select at least a few characters.');
  if (end - start > MAX_SPAN) throw new HttpError(400, 'too_long', `That highlight is too long (${end - start} characters). Select ${MAX_SPAN} characters or fewer.`);
  const category = b.category && (CATEGORIES as readonly string[]).includes(b.category) ? b.category : 'none';
  const note = clip(b.note, MAX_NOTE).trim();
  const id = uid(), now = ctx.now();
  ctx.db.run('INSERT INTO annotations (id,source_id,char_start,char_end,quote,source_rev,category,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, sourceId, start, end, s.text.slice(start, end), s.rev ?? 1, category, note, now, now);
  return annotationView(ctx, s, ctx.db.get('SELECT * FROM annotations WHERE id = ?', id));
}

export function updateAnnotation(ctx: Ctx, sourceId: string, id: string, b: { category?: string; note?: string }) {
  const s = srcRow(ctx, sourceId), a = annotationRow(ctx, sourceId, id);
  const category = b.category === undefined ? a.category : (b.category === 'none' || (CATEGORIES as readonly string[]).includes(b.category)) ? b.category : (() => { throw new HttpError(400, 'invalid', 'Unknown category.'); })();
  const note = b.note === undefined ? a.note : clip(b.note, MAX_NOTE).trim();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE annotations SET category = ?, note = ?, updated_at = ? WHERE id = ?', category, note, ctx.now(), id);
    // Study items made from the old note no longer reflect what the student wrote: retire them (their answers stay in history) so new ones can be made.
    if (note !== a.note) retireItems(ctx, id, 'The note this was made from was edited.');
  });
  refreshReadingNote(ctx, sourceId);
  return annotationView(ctx, s, ctx.db.get('SELECT * FROM annotations WHERE id = ?', id));
}

export function deleteAnnotation(ctx: Ctx, sourceId: string, id: string) {
  annotationRow(ctx, sourceId, id);
  ctx.db.tx(() => {
    retireItems(ctx, id, 'The annotation this was made from was deleted.');
    ctx.db.run('DELETE FROM annotations WHERE id = ?', id);
  });
  refreshReadingNote(ctx, sourceId);
  return { ok: true };
}

/** Questions are never deleted when their annotation changes (attempts reference them); they are retired so they stop being served. */
function retireItems(ctx: Ctx, annotationId: string, reason: string) {
  const qs = ctx.db.all<any>('SELECT question_id FROM annotation_items WHERE annotation_id = ?', annotationId);
  for (const q of qs) ctx.db.run('UPDATE questions SET retired_at = COALESCE(retired_at, ?), retired_reason = COALESCE(retired_reason, ?) WHERE id = ?', ctx.now(), reason, q.question_id);
}

/* ------------------------------ AI help (optional) ------------------------------ */

const TEMPLATE_QUESTIONS: Record<string, string[]> = {
  theme: ['What idea does this passage return to? Where else in the reading does it appear?', 'Is the idea stated directly, or only implied? What shows you?'],
  characterization: ['What does this tell you about the person, and which exact words show it?', 'Does this match or contradict how the person acts elsewhere?'],
  imagery: ['Which image is strongest here, and what does it make you feel or picture?', 'What would change if the image were replaced by a plain statement?'],
  argument: ['What claim is being made, and what reasons are given for it?', 'What would someone who disagrees say?'],
  evidence: ['What claim does this evidence support? Does it prove it or only suggest it?', 'Is there other evidence in the reading that points a different way?'],
  question: ['What would you need to find in the text to answer your own question?'],
  vocabulary: ['What does the word mean here? What other meanings does it have?'],
  other: ['Why did you mark this passage? What would you say to someone who skipped it?', 'What does this passage do that the sentences around it do not?'],
  none: ['Why did you mark this passage? What would you say to someone who skipped it?', 'What does this passage do that the sentences around it do not?'],
};

export async function assist(ctx: Ctx, sourceId: string, id: string, b: { kind: string; term?: string }) {
  const kind = b.kind as 'explain' | 'define' | 'question';
  if (!['explain', 'define', 'question'].includes(kind)) throw new HttpError(400, 'invalid', 'Choose explain, define or question.');
  const s = srcRow(ctx, sourceId), a = annotationRow(ctx, sourceId, id);
  if (ctx.db.get<any>('SELECT COUNT(*) n FROM annotation_assists WHERE annotation_id = ? AND kind <> ?', id, 'feedback').n >= MAX_ASSISTS) throw new HttpError(409, 'limit', `That is plenty of help on one passage (${MAX_ASSISTS} requests). Write your own reading, then ask for feedback.`);
  let term = '';
  if (kind === 'define') {
    term = clip(b.term, 60).trim();
    if (!term) throw new HttpError(400, 'invalid', 'Type the word or phrase to define.');
    if (!a.quote.toLowerCase().includes(term.toLowerCase())) throw new HttpError(400, 'term_not_in_passage', `“${term}” is not in the highlighted passage. Select the passage that contains the word.`);
  }
  const live = ctx.ai.live && !!ctx.ai.assist;
  let payload: any;
  if (!live) {
    if (kind !== 'question') throw new HttpError(409, 'no_ai', `${kind === 'explain' ? 'Explaining a passage' : 'Defining a word in context'} needs an AI provider, and none is set up. Your highlights and notes still work (Settings → Setup).`);
    payload = { text: TEMPLATE_QUESTIONS[a.category].map((q, i) => `${i + 1}. ${q}`).join('\n'), ai: false, note: 'Standard prompts for this category. They are not based on the content of this passage; connect an AI provider for passage-specific questions.', removedQuotes: 0 };
  } else {
    const v = modelView(ctx, s, a.char_start, a.char_end);
    if (!v.usable) throw new HttpError(409, 'excluded', 'This passage looks like it contains instructions to an AI, so it is left out of anything sent to a model. You can still annotate it yourself.');
    const loc = locate(ctx, s, a.char_start, a.char_end).label;
    const r = await ctx.ai.assist!({ kind, passage: v.passage, context: v.context, location: loc, term: term || undefined, readingTitle: s.title, subjectName: s.subject_name, prompt: promptFor(ctx, sourceId), gradeLevel: getProfile(ctx.db).grade });
    const clean = stripInventedQuotes(r.text, v.context);
    payload = { text: clean.text, ai: true, removedQuotes: clean.removed, note: 'Written by an AI model: it can be wrong. Check it against the text and your own reading.' };
  }
  ctx.db.run('INSERT INTO annotation_assists (id,annotation_id,kind,term,payload,model,created_at) VALUES (?,?,?,?,?,?,?)', uid(), id, kind, term || null, JSON.stringify(payload), live ? ctx.ai.modelFor?.('grade') ?? null : null, ctx.now());
  return annotationView(ctx, s, ctx.db.get('SELECT * FROM annotations WHERE id = ?', id));
}

export async function feedback(ctx: Ctx, sourceId: string, id: string) {
  const s = srcRow(ctx, sourceId), a = annotationRow(ctx, sourceId, id);
  const words = a.note.trim().split(/\s+/).filter(Boolean).length;
  if (words < MIN_FEEDBACK_WORDS) throw new HttpError(409, 'write_first', 'Write your own interpretation first (at least a sentence), then ask for feedback. Feedback is about your thinking, so it needs something of yours to look at.');
  const overlap = overlapOf(a.note, a.quote);
  const live = ctx.ai.live && !!ctx.ai.annotationFeedback;
  const loc = locate(ctx, s, a.char_start, a.char_end).label;
  const prompt = promptFor(ctx, sourceId);
  let fb: any;
  if (live) {
    const v = modelView(ctx, s, a.char_start, a.char_end);
    if (!v.usable) throw new HttpError(409, 'excluded', 'This passage looks like it contains instructions to an AI, so it is left out of anything sent to a model.');
    const r: AnnotationFeedback = await ctx.ai.annotationFeedback!({ passage: v.passage, context: v.context, location: loc, category: CATEGORY_LABEL[a.category], note: a.note, overlap, readingTitle: s.title, subjectName: s.subject_name, prompt, gradeLevel: getProfile(ctx.db).grade });
    let removed = 0;
    const cl = (t: string) => { const c = stripInventedQuotes(t, v.context + '\n' + a.note); removed += c.removed; return c.text; };
    fb = { ai: true, basis: 'model', stance: r.stance, observation: cl(r.observation), strengths: cl(r.strengths), nextSteps: r.next_steps.map(cl), questions: r.questions.map(cl), promptLink: prompt ? cl(r.prompt_link) : '', removedQuotes: removed, overlap };
  } else {
    // Without an AI the only honest signal is how much of the note is copied from the passage. It cannot judge reasoning.
    const copied = overlap >= 0.7;
    fb = {
      ai: false, basis: 'word-overlap rule', overlap,
      stance: copied ? 'restates' : 'not_assessed',
      observation: copied ? `About ${Math.round(overlap * 100)}% of the meaningful words in your note also appear in the passage, so it is probably mostly a summary or paraphrase.` : `Only ${Math.round(overlap * 100)}% of the meaningful words in your note come from the passage. That does not show the note reasons well or badly: without an AI provider this check only counts copied words and cannot judge the reasoning.`,
      strengths: '',
      nextSteps: copied ? ['Say what the passage DOES (shows, suggests, contrasts, implies), not just what it says.', 'Add a “because” or “which shows” and name the exact word or detail that supports it.'] : ['Check that your note points to a specific word, detail or sentence in the passage.', 'Ask: what would a reader miss if this passage were cut?'],
      questions: TEMPLATE_QUESTIONS[a.category].slice(0, 2),
      promptLink: prompt ? `A ${prompt.kind} is attached. Basic mode cannot compare your note to it; re-read it and check which part this note answers.` : '', removedQuotes: 0,
    };
  }
  ctx.db.run('INSERT INTO annotation_assists (id,annotation_id,kind,payload,note_snapshot,model,created_at) VALUES (?,?,?,?,?,?,?)', uid(), id, 'feedback', JSON.stringify(fb), a.note, live ? ctx.ai.modelFor?.('grade') ?? null : null, ctx.now());
  refreshReadingNote(ctx, sourceId);
  return annotationView(ctx, s, ctx.db.get('SELECT * FROM annotations WHERE id = ?', id));
}

export const deleteAssist = (ctx: Ctx, sourceId: string, annotationId: string, assistId: string) => {
  annotationRow(ctx, sourceId, annotationId);
  ctx.db.run('DELETE FROM annotation_assists WHERE id = ? AND annotation_id = ?', assistId, annotationId);
  refreshReadingNote(ctx, sourceId);
  return { ok: true };
};

/* ------------------------------ tentative memory ------------------------------ */

const NOTE_MIN_RESTATES = 3;
/**
 * A tentative note in Memory when several different annotations in one reading were judged to mostly restate the passage. One restating note is nothing:
 * it needs at least three different passages and half of those that got feedback. The note is labelled inferred and tentative, can be dismissed, and is
 * withdrawn when its evidence disappears. A note the student dismissed or edited is never touched again.
 */
export function refreshReadingNote(ctx: Ctx, sourceId: string) {
  const s = ctx.db.get<any>('SELECT s.id, s.title, s.subject_id FROM sources s WHERE s.id = ?', sourceId);
  if (!s) return;
  const key = `reading_restates:${sourceId}`;
  const existing = ctx.db.get<any>("SELECT * FROM memories WHERE json_extract(provenance, '$.key') = ? AND deleted_at IS NULL", key);
  const prov0 = existing ? parse<any>(existing.provenance, {}) : {};
  if (existing && (prov0.dismissed || prov0.correctedByStudent)) return;
  const rows = ctx.db.all<any>(`SELECT a.id, a.note, (SELECT f.payload FROM annotation_assists f WHERE f.annotation_id = a.id AND f.kind = 'feedback' AND f.note_snapshot = a.note ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1) AS fb
    FROM annotations a WHERE a.source_id = ?`, sourceId);
  const judged = rows.filter((r) => r.fb).map((r) => ({ id: r.id, stance: parse<any>(r.fb, {}).stance }));
  const restating = judged.filter((j) => j.stance === 'restates');
  const enough = restating.length >= NOTE_MIN_RESTATES && restating.length * 2 >= judged.length;
  if (!enough) { if (existing) ctx.db.run('DELETE FROM memories WHERE id = ?', existing.id); return; }
  const text = `In “${s.title}”, ${restating.length} of the ${judged.length} annotations that got feedback mostly restate the passage instead of explaining it. Tentative: it rests on these notes only and may not hold for other readings.`;
  const prov = { origin: 'app', basis: 'inferred', tentative: true, key, kind: 'reading_restates', annotationIds: restating.map((r) => r.id), sourceId, note: 'Made by the app from feedback on your annotations' };
  const now = ctx.now();
  if (existing) ctx.db.run('UPDATE memories SET text = ?, provenance = ?, updated_at = ? WHERE id = ?', text, JSON.stringify({ ...prov0, ...prov }), now, existing.id);
  else ctx.db.run('INSERT INTO memories (id,kind,text,subject_id,concept_id,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', uid(), 'ai_inferred', text, s.subject_id, null, JSON.stringify(prov), now, now);
}

export { AIError };
