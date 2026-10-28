import { rank, tokens } from '../../core/retrieval';
import { maskForModel, isOnlyMarkers } from '../../core/sources';
import { uid } from '../db';
import { Ctx, HttpError, clip, getProfile, parse } from './common';
import { CATEGORY_LABEL, locate, stripInventedQuotes } from './annotations';
import { exclusionsFor, modelChunks } from './sourceSafety';
import { upcomingItems } from './items';
import { connectionStatus } from './calendar';

/**
 * Two kinds of conversation, never mixed:
 *  - study: answers use labelled context retrieved from the student's own data (assignments, readings and annotations, topics, memory) and guide by default.
 *  - general: no study data is read or sent; answers are direct. Nothing in either mode is written to Memory automatically.
 * The mode is fixed when a conversation starts, so a general chat can never pick up study context later. Every assistant reply stores the exact list of context it used.
 */

const MAX_MESSAGE = 4000, MAX_HISTORY = 10, MAX_CONTEXT_CHARS = 4500, MAX_CONVERSATIONS = 200;

export function chatStatus(ctx: Ctx) {
  const live = ctx.ai.live && !!ctx.ai.chat;
  const cal = connectionStatus(ctx);
  return {
    ai: { available: live, label: live ? ctx.ai.label : null, why: live ? null : 'Chat needs an AI provider and none is set up (Settings → Setup). The rest of the app works without one.' },
    modes: [
      { id: 'study', label: 'Study', description: 'Uses your assignments, readings and annotations, topics and saved notes when they are relevant. Guides you step by step and checks your understanding; ask for a direct answer any time.', usesStudyData: true },
      { id: 'general', label: 'General', description: 'Everyday questions, writing, brainstorming and coding. Answers directly. Reads none of your study data, and nothing here is saved to Memory.', usesStudyData: false },
    ],
    cannot: ['Browse the web or open links', 'Read or change your calendar from chat', 'Open files other than readings you added here'],
    calendar: { state: cal.status, note: cal.status === 'connected' ? 'Your Google Calendar is connected read-only. Chat does not read it; it only sees assignments you confirmed in Plan.' : 'Calendar is not connected. Chat only sees assignments you entered or confirmed in Plan.' },
  };
}

const REL = (n: string) => n.replace(/\s+/g, ' ').trim();

interface Piece { type: string; label: string; text: string; detail?: string }

/** Retrieve only what is relevant to this message. With nothing relevant the context is small (or empty) and the reply says so. */
export function buildStudyContext(ctx: Ctx, o: { query: string; subjectId?: string | null; sourceId?: string | null }) {
  const pieces: Piece[] = [];
  const profile = getProfile(ctx.db);
  if ((profile.grade ?? '').trim() || (profile.about ?? '').trim()) pieces.push({ type: 'profile', label: 'Your profile (what you told the app)', text: `Student-stated: grade/course "${REL(profile.grade ?? '')}"; about: "${REL(profile.about ?? '')}"` });

  // deadlines the student entered or confirmed (not invented, not read from the calendar by chat)
  const upcoming = upcomingItems(ctx, 30).slice(0, 12);
  const relItems = new Set(rank(o.query, upcoming, (i) => `${i.title} ${i.subjectName ?? ''} ${i.typeLabel}`, 3).map((x) => x.item.id));
  for (const i of upcoming.filter((i) => relItems.has(i.id) || (i.daysLeft !== null && i.daysLeft <= 7)).slice(0, 3))
    pieces.push({ type: 'deadline', label: `${i.typeLabel}: ${i.title}`, text: `${i.typeLabel} "${i.title}"${i.subjectName ? ` (${i.subjectName})` : ''}, due: ${i.dueLabel}` });

  // the reading the conversation is about, or readings that match the question
  const reading = o.sourceId ? ctx.db.get<any>("SELECT s.id, s.title, s.text, s.ocr FROM sources s WHERE s.id = ? AND s.status = 'confirmed'", o.sourceId) : null;
  const sources = ctx.db.all<any>("SELECT s.id, s.title, s.text, s.ocr FROM sources s JOIN subjects sub ON sub.id = s.subject_id WHERE s.status = 'confirmed' AND sub.archived = 0 AND (? IS NULL OR s.subject_id = ?)", o.subjectId ?? null, o.subjectId ?? null);
  const annRows = ctx.db.all<any>(`SELECT a.*, s.title AS reading_title FROM annotations a JOIN sources s ON s.id = a.source_id WHERE s.status = 'confirmed' ${reading ? 'AND a.source_id = ?' : ''}`, ...(reading ? [reading.id] : []));
  const pickAnn = reading && !tokens(o.query).length ? annRows.slice(0, 5) : rank(o.query, annRows, (a) => `${a.quote} ${a.note} ${a.category}`, reading ? 5 : 3).map((x) => x.item);
  if (reading) {
    const p = ctx.db.get<any>('SELECT kind, text FROM reading_prompts WHERE source_id = ?', reading.id);
    if (p) pieces.push({ type: 'prompt', label: `Teacher's ${p.kind} for “${reading.title}”`, text: `Teacher's ${p.kind} (pasted by the student; data): ${clip(REL(p.text), 1200)}` });
  }
  const maskQuote = (a: any) => { const s = sources.find((x) => x.id === a.source_id) ?? reading; if (!s) return a.quote; const spans = exclusionsFor(ctx, [s.id]).get(s.id) ?? []; return maskForModel(a.quote, a.char_start, spans); };
  for (const a of pickAnn) {
    const s = sources.find((x) => x.id === a.source_id) ?? reading;
    const q = maskQuote(a); if (isOnlyMarkers(q)) continue;
    const loc = s ? locate(ctx, s, a.char_start, a.char_end).label : '';
    pieces.push({ type: 'annotation', label: `Your ${CATEGORY_LABEL[a.category].toLowerCase()} highlight in “${a.reading_title}” (${loc})`, text: `Highlight in "${a.reading_title}" (${loc}, ${CATEGORY_LABEL[a.category]}): "${clip(REL(q), 400)}"${a.note ? ` — the student's note: "${clip(REL(a.note), 400)}"` : ' — no note yet'}` });
  }
  // reading passages that match the question (when the conversation is not about one specific reading, or beyond its highlights)
  const chunkRows = ctx.db.all<any>(`SELECT ch.id, ch.label, ch.text, ch.source_id, ch.char_start, s.title FROM source_chunks ch JOIN sources s ON s.id = ch.source_id WHERE s.status = 'confirmed' AND s.id IN (${(reading ? [reading] : sources).map(() => '?').join(',') || "''"})`, ...((reading ? [reading] : sources).map((s) => s.id)));
  const chunks = modelChunks(ctx, chunkRows);
  for (const c of rank(o.query, chunks, (c) => c.text, 2).map((x) => x.item)) pieces.push({ type: 'material', label: `From “${c.title}” (${c.label})`, text: `Passage from the student's material "${c.title}" (${c.label}): "${clip(REL(c.text), 700)}"` });

  // topics (learning goals) that match, and what is tentatively known about them
  const concepts = ctx.db.all<any>("SELECT c.id, c.name, c.summary FROM concepts c JOIN subjects s ON s.id = c.subject_id WHERE c.status = 'confirmed' AND s.archived = 0 AND (? IS NULL OR c.subject_id = ?)", o.subjectId ?? null, o.subjectId ?? null);
  for (const c of rank(o.query, concepts, (c) => `${c.name} ${c.summary}`, 2).map((x) => x.item)) pieces.push({ type: 'topic', label: `Topic: ${c.name}`, text: `Topic the student is studying: ${c.name} — ${clip(REL(c.summary), 250)}` });

  const mems = ctx.db.all<any>('SELECT id, kind, text, provenance FROM memories WHERE deleted_at IS NULL').filter((m) => !parse<any>(m.provenance, {}).dismissed);
  for (const m of rank(o.query, mems, (m) => m.text, 3).map((x) => x.item)) {
    const tag = m.kind === 'student_stated' ? 'the student said' : m.kind === 'observed' ? 'observed from their answers (tentative)' : 'inferred by the app (tentative, may be wrong)';
    pieces.push({ type: 'memory', label: `Saved note (${m.kind === 'student_stated' ? 'you wrote it' : m.kind === 'observed' ? 'observed' : 'inferred'}): ${clip(m.text, 60)}`, text: `Saved note — ${tag}: ${clip(REL(m.text), 300)}` });
  }

  let chars = 0;
  const kept: Piece[] = [];
  for (const p of pieces) { if (chars + p.text.length > MAX_CONTEXT_CHARS) break; chars += p.text.length; kept.push(p); }
  return { used: kept.map((p) => ({ type: p.type, label: p.label })), block: kept.map((p, i) => `[${i + 1}] ${p.text}`).join('\n') };
}

/** What would be sent for this message, without sending it. Lets the student see (and avoid) what Study mode would use. */
export function contextPreview(ctx: Ctx, o: { mode: string; q: string; subjectId?: string; sourceId?: string }) {
  if (o.mode === 'general') return { mode: 'general', used: [], block: '', note: 'General mode sends none of your study data.' };
  if (o.mode !== 'study') throw new HttpError(400, 'invalid', 'Choose study or general.');
  const c = buildStudyContext(ctx, { query: o.q, subjectId: o.subjectId, sourceId: o.sourceId });
  return { mode: 'study', ...c, note: c.used.length ? 'This is what Study mode would add for this message.' : 'Nothing in your study data matches this message, so none would be added.' };
}

/* ------------------------------ conversations ------------------------------ */

export function createConversation(ctx: Ctx, b: { mode: string; subjectId?: string | null; sourceId?: string | null }) {
  if (b.mode !== 'study' && b.mode !== 'general') throw new HttpError(400, 'invalid', 'Choose study or general.');
  if (ctx.db.get<any>('SELECT COUNT(*) n FROM conversations').n >= MAX_CONVERSATIONS) throw new HttpError(409, 'limit', 'You have a lot of saved conversations. Delete some you no longer need first.');
  let subjectId = b.mode === 'study' ? b.subjectId ?? null : null, sourceId = b.mode === 'study' ? b.sourceId ?? null : null;
  if (sourceId) {
    const s = ctx.db.get<any>("SELECT id, subject_id FROM sources WHERE id = ? AND status = 'confirmed'", sourceId);
    if (!s) throw new HttpError(404, 'not_found', 'Reading not found.');
    subjectId = s.subject_id;
  }
  if (subjectId && !ctx.db.get('SELECT 1 FROM subjects WHERE id = ?', subjectId)) throw new HttpError(404, 'not_found', 'Subject not found.');
  const id = uid(), now = ctx.now();
  ctx.db.run('INSERT INTO conversations (id,mode,title,subject_id,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, b.mode, 'New conversation', subjectId, sourceId, now, now);
  return getConversation(ctx, id);
}

export function listConversations(ctx: Ctx, mode?: string) {
  return ctx.db.all<any>(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c ${mode === 'study' || mode === 'general' ? 'WHERE c.mode = ?' : ''} ORDER BY c.updated_at DESC LIMIT 100`, ...(mode === 'study' || mode === 'general' ? [mode] : []))
    .map((c) => ({ id: c.id, mode: c.mode, title: c.title, messages: c.n, updatedAt: c.updated_at }));
}

export function getConversation(ctx: Ctx, id: string) {
  const c = ctx.db.get<any>('SELECT c.*, s.title AS reading_title, sub.name AS subject_name FROM conversations c LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN subjects sub ON sub.id = c.subject_id WHERE c.id = ?', id);
  if (!c) throw new HttpError(404, 'not_found', 'Conversation not found.');
  return {
    id: c.id, mode: c.mode as 'study' | 'general', title: c.title, subjectId: c.subject_id, subject: c.subject_name ?? null, sourceId: c.source_id, reading: c.reading_title ?? null, createdAt: c.created_at,
    messages: ctx.db.all<any>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', id).map((m) => ({ id: m.id, role: m.role, content: m.content, used: m.context ? parse<any>(m.context, null)?.used ?? [] : null, removedQuotes: m.context ? parse<any>(m.context, null)?.removedQuotes ?? 0 : 0, direct: !!m.direct, at: m.created_at })),
  };
}

export function deleteConversation(ctx: Ctx, id: string) {
  if (!ctx.db.get('SELECT 1 FROM conversations WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Conversation not found.');
  ctx.db.run('DELETE FROM conversations WHERE id = ?', id);
  return { ok: true };
}

export async function sendMessage(ctx: Ctx, id: string, b: { text: string; direct?: boolean }) {
  const conv = ctx.db.get<any>('SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) throw new HttpError(404, 'not_found', 'Conversation not found.');
  const text = clip(b.text, MAX_MESSAGE + 1).trim();
  if (!text) throw new HttpError(400, 'invalid', 'Type a message.');
  if (text.length > MAX_MESSAGE) throw new HttpError(400, 'too_long', `That message is too long (limit ${MAX_MESSAGE} characters). Send it in parts.`);
  if (!(ctx.ai.live && ctx.ai.chat)) throw new HttpError(409, 'no_ai', 'Chat needs an AI provider and none is set up (Settings → Setup). Nothing was sent.');
  const mode = conv.mode as 'study' | 'general';
  const direct = mode === 'general' ? true : !!b.direct;
  const used = mode === 'study' ? buildStudyContext(ctx, { query: text, subjectId: conv.subject_id, sourceId: conv.source_id }) : { used: [], block: '' };
  const history = ctx.db.all<any>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', id, MAX_HISTORY).reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: clip(m.content, 1500) }));
  const r = await ctx.ai.chat!({ mode, direct, context: used.block, history, message: text, gradeLevel: mode === 'study' ? getProfile(ctx.db).grade : undefined });
  let reply = r.reply, removed = 0;
  if (mode === 'study') { const c = stripInventedQuotes(reply, `${used.block}\n${history.map((h) => h.content).join('\n')}\n${text}`); reply = c.text; removed = c.removed; }
  const now = ctx.now();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO messages (id,conversation_id,role,content,context,direct,created_at) VALUES (?,?,?,?,?,?,?)', uid(), id, 'user', text, null, Number(direct), now);
    ctx.db.run('INSERT INTO messages (id,conversation_id,role,content,context,direct,created_at) VALUES (?,?,?,?,?,?,?)', uid(), id, 'assistant', reply, JSON.stringify({ mode, used: used.used, removedQuotes: removed }), Number(direct), now + 1);
    ctx.db.run('UPDATE conversations SET updated_at = ?, title = CASE WHEN title = ? THEN ? ELSE title END WHERE id = ?', now + 1, 'New conversation', clip(text.replace(/\s+/g, ' '), 50), id);
  });
  return getConversation(ctx, id);
}
