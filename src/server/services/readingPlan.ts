import { localDateKey } from '../../core/time';
import { Ctx, getProfile, getSetting, setSetting } from './common';

const DAY = 24 * 3600_000;
export interface ReadingTask { sourceId: string; title: string; subjectName: string; itemId: string; itemTitle: string; daysLeft: number; annotations: number }

/**
 * A reading worth annotating next. This is an inference, and says so: the reading is in the SAME SUBJECT as an assignment the student entered or confirmed that is due
 * within two weeks, and it has fewer than three highlights. The app does not know that the teacher assigned this reading to that assignment. Nothing is invented: both
 * the reading and the assignment are records the student created.
 */
export function readingTask(ctx: Ctx): ReadingTask | null {
  const now = ctx.now(), today = localDateKey(new Date(now), getProfile(ctx.db).timezone);
  const items = ctx.db.all<any>(`SELECT i.id, i.title, i.subject_id, i.due_kind, i.due_at, i.due_date, s.name AS subject_name FROM academic_items i JOIN subjects s ON s.id = i.subject_id
    WHERE i.status = 'confirmed' AND i.completed_at IS NULL AND i.sync_state != 'source_cancelled' AND i.subject_id IS NOT NULL AND s.archived = 0`)
    .map((i) => ({ ...i, at: i.due_kind === 'datetime' ? i.due_at : i.due_kind === 'date' ? Date.parse(`${i.due_date}T12:00:00Z`) : null }))
    .filter((i) => i.at !== null && i.at >= now - DAY && i.at - now <= 14 * DAY).sort((a, b) => a.at - b.at);
  for (const i of items) {
    const r = ctx.db.all<any>(`SELECT s.id, s.title, (SELECT COUNT(*) FROM annotations a WHERE a.source_id = s.id) AS n FROM sources s
      WHERE s.subject_id = ? AND s.status = 'confirmed' AND s.kind IN ('passage','textbook') ORDER BY s.created_at`, i.subject_id).find((x) => x.n < 3 && getSetting<string | null>(ctx.db, `reading_skip:${x.id}`, null) !== today);
    if (r) return { sourceId: r.id, title: r.title, subjectName: i.subject_name, itemId: i.id, itemTitle: i.title, daysLeft: Math.max(0, Math.round((i.at - now) / DAY)), annotations: r.n };
  }
  return null;
}

export function skipReadingToday(ctx: Ctx, sourceId: string) {
  setSetting(ctx.db, `reading_skip:${sourceId}`, localDateKey(new Date(ctx.now()), getProfile(ctx.db).timezone), ctx.now());
  return { ok: true };
}
