/**
 * Retrieval practice and review, entirely in the browser. Cards come from the student's own notes by plain rules (so practice works with the assistant off);
 * the assistant can add better questions when available. Misses come back sooner (a five-box schedule).
 */
import { addDaysKey } from '../time';
import { clean, newId, norm } from './extract';
import { NoteItem, PracticeCard, Profile } from './types';

export const BOX_DAYS = [0, 1, 3, 7, 14];
const STOP = new Set('the and for are was were that this with from have has had not but you your which what when where who how into their there they them these those been being than then also can will would should could may might its our out one two about over under between because while'.split(' '));
const keywords = (s: string) => norm(s).split(' ').filter((w) => w.length > 3 && !STOP.has(w));

/** The few passages of the notes that matter for ONE question: this is all that is ever sent on a later AI call, never the whole notes. */
export function selectExcerpts(notes: { text: string; title?: string }[], query: string, o: { maxChars?: number; n?: number } = {}): { label: string; text: string }[] {
  const maxChars = o.maxChars ?? 900, n = o.n ?? 3;
  const q = new Set(keywords(query)); if (!q.size) return [];
  const scored: { label: string; text: string; score: number }[] = [];
  for (const note of notes) {
    const paras = note.text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim()).filter((x) => x.length > 20);
    for (let i = 0; i < paras.length; i++) {
      const window = (paras[i] + (paras[i].length < 300 && paras[i + 1] ? ' ' + paras[i + 1] : '')).slice(0, maxChars);
      const w = new Set(keywords(window)); let hit = 0; for (const k of q) if (w.has(k)) hit++;
      if (hit) scored.push({ label: note.title || 'Notes', text: window, score: hit / Math.sqrt(q.size) });
    }
  }
  const out: { label: string; text: string }[] = []; const used = new Set<string>();
  for (const s of scored.sort((a, b) => b.score - a.score)) { const k = norm(s.text).slice(0, 60); if (used.has(k)) continue; used.add(k); out.push({ label: s.label, text: s.text }); if (out.length >= n) break; }
  return out;
}

/** Plain-rule question cards from notes: "Term: definition" lines, "X is …" sentences, and fill-in-the-blank on key terms. */
export function cardsFromNotes(note: NoteItem, today: string, max = 12): PracticeCard[] {
  const cards: PracticeCard[] = []; const seen = new Set<string>();
  const add = (prompt: string, answer: string) => { const k = norm(prompt); if (seen.has(k) || answer.trim().length < 2 || cards.length >= max) return; seen.add(k); cards.push({ id: newId('p'), noteId: note.id, prompt: clean(prompt, 300), answer: clean(answer, 240), box: 1, due: today, lastResult: null, seen: 0 }); };
  const lines = note.text.split(/\n+/).map((l) => l.replace(/^[\s•*\-\d.)]+/, '').trim()).filter(Boolean);
  for (const l of lines) { const m = l.match(/^([A-Za-z][^:]{2,50}):\s+(.{8,240})$/); if (m && !/^(note|http|due)/i.test(m[1])) add(`What is “${m[1].trim()}”?`, m[2].trim()); }
  const sentences = note.text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 40 && s.length <= 240);
  for (const s of sentences) {
    const def = s.match(/^([A-Z][A-Za-z -]{2,40}) (?:is|are|means|refers to) (?:the |a |an )?(.{10,200}?)\.?$/);
    if (def && !/^(It|This|That|There|These|Those|He|She|They)\b/.test(def[1])) { add(`What ${/ are /.test(s.slice(def[1].length, def[1].length + 6)) ? 'are' : 'is'} ${def[1]}?`, def[2]); continue; }
    const term = s.match(/\b(\d{3,4}|[A-Z][a-z]{3,}(?: [A-Z][a-z]{3,})?|[a-z]{6,})\b(?=[^A-Za-z]*(?:[,.;]|$))/g)?.filter((t, i) => i > 0 || /^\d/.test(t))?.at(-1);
    if (term && !STOP.has(term.toLowerCase())) add(`Fill in the blank: ${s.replace(term, '_____')}`, term);
  }
  return cards;
}
export const dueCards = (p: Profile, today: string) => p.cards.filter((c) => c.due <= today).sort((a, b) => a.due.localeCompare(b.due) || a.box - b.box);
/** Record how a card went. Right: up a box (later). Wrong: back to box 1 (tomorrow-ish, and asked again in this session). */
export function gradeCard(c: PracticeCard, right: boolean, today: string): PracticeCard {
  const box = right ? Math.min(5, c.box + 1) : 1;
  return { ...c, box, due: right ? addDaysKey(today, BOX_DAYS[box - 1]) : today, lastResult: right ? 'right' : 'wrong', seen: c.seen + 1 };
}
