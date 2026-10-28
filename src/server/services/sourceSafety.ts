import { DETECTOR_VERSION, detectInstructionLike, isOnlyMarkers, maskForModel } from '../../core/sources';
import { uid } from '../db';
import { Ctx, HttpError } from './common';

export interface Exclusion { start: number; end: number }
const chunkLabelAt = (ctx: Ctx, sourceId: string, at: number) =>
  ctx.db.get<{ label: string }>('SELECT label FROM source_chunks WHERE source_id = ? AND char_start <= ? AND char_end > ? ORDER BY idx LIMIT 1', sourceId, at, at)?.label ?? '';

/** Flags are derived from the immutable original; (re)computed lazily so legacy, imported and sample materials get them too. A student's decision survives recomputation. */
export function ensureFlags(ctx: Ctx, sourceId: string) {
  const s = ctx.db.get<{ original_text: string; text: string; flags_version: number }>('SELECT original_text, text, flags_version FROM sources WHERE id = ?', sourceId);
  if (!s || s.flags_version >= DETECTOR_VERSION) return;
  ctx.db.tx(() => {
    const old = ctx.db.all<any>('SELECT char_start, char_end, decision, decided_at FROM source_flags WHERE source_id = ? AND decision IS NOT NULL', sourceId);
    ctx.db.run('DELETE FROM source_flags WHERE source_id = ?', sourceId);
    for (const f of detectInstructionLike(s.text)) {
      const prev = old.find((o) => o.char_start === f.start && o.char_end === f.end);
      ctx.db.run('INSERT INTO source_flags (id,source_id,char_start,char_end,severity,rule,label,excerpt,decision,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        uid(), sourceId, f.start, f.end, f.severity, f.rule, chunkLabelAt(ctx, sourceId, f.start), s.text.slice(f.start, f.end).slice(0, 600), prev?.decision ?? null, prev?.decided_at ?? null);
    }
    ctx.db.run('UPDATE sources SET flags_version = ? WHERE id = ?', DETECTOR_VERSION, sourceId);
  });
}

const isExcluded = (f: { severity: string; decision: string | null }) => f.decision === 'exclude' || (f.severity === 'strong' && f.decision !== 'include');

/** Spans (original offsets) left out of what AI models see, per source. */
export function exclusionsFor(ctx: Ctx, sourceIds: string[]): Map<string, Exclusion[]> {
  const m = new Map<string, Exclusion[]>();
  for (const id of sourceIds) {
    ensureFlags(ctx, id);
    m.set(id, ctx.db.all<any>('SELECT char_start start, char_end end, severity, decision FROM source_flags WHERE source_id = ?', id).filter(isExcluded).map((f) => ({ start: f.start, end: f.end })));
  }
  return m;
}

/** Chunks as a model may see them. Drops chunks that are nothing but excluded passages. */
export function modelChunks<T extends { source_id: string; char_start: number; text: string }>(ctx: Ctx, rows: T[]): (T & { text: string; maskedSpans: number })[] {
  const ex = exclusionsFor(ctx, [...new Set(rows.map((r) => r.source_id))]);
  const out: (T & { maskedSpans: number })[] = [];
  for (const r of rows) {
    const spans = ex.get(r.source_id) ?? [];
    const text = maskForModel(r.text, r.char_start, spans);
    if (isOnlyMarkers(text) && text !== r.text) continue;
    out.push({ ...r, text, maskedSpans: text === r.text ? 0 : 1 });
  }
  return out;
}

export function sourceFlags(ctx: Ctx, sourceId: string) {
  ensureFlags(ctx, sourceId);
  return ctx.db.all<any>('SELECT * FROM source_flags WHERE source_id = ? ORDER BY char_start', sourceId).map((f) => ({
    id: f.id, start: f.char_start, end: f.char_end, severity: f.severity, rule: f.rule, label: f.label, excerpt: f.excerpt, decision: f.decision, excludedFromAi: isExcluded(f),
  }));
}

export function setFlagDecision(ctx: Ctx, sourceId: string, flagId: string, decision: 'include' | 'exclude' | null) {
  const f = ctx.db.get('SELECT 1 FROM source_flags WHERE id = ? AND source_id = ?', flagId, sourceId);
  if (!f) throw new HttpError(404, 'not_found', 'That flagged passage was not found.');
  ctx.db.run('UPDATE source_flags SET decision = ?, decided_at = ? WHERE id = ?', decision, decision ? ctx.now() : null, flagId);
  return sourceFlags(ctx, sourceId);
}
