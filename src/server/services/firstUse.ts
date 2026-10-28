import { Ctx, aiInfo, getSchedulerParams } from './common';

const HOUR = 3_600_000;
export type StepState = 'done' | 'todo' | 'waiting' | 'problem' | 'skipped';
export interface FirstUseStep { id: string; title: string; state: StepState; detail: string; action: string | null }

/**
 * A checklist derived only from what is recorded in this database. Nothing here is a claim that a live service works:
 * the AI steps read the recorded verification evidence, and an app run against mocks or a custom endpoint says so.
 */
export function firstUse(ctx: Ctx) {
  const ai = aiInfo(ctx);
  const steps: FirstUseStep[] = [];
  const customEndpoint = ctx.cfg.aiProvider === 'anthropic' && ctx.cfg.anthropicBaseUrl !== 'https://api.anthropic.com';

  // 1-2. AI (optional: math and basic templates work offline)
  if (!ai.live) {
    steps.push({ id: 'ai', title: 'Choose how questions are written', state: 'skipped', detail: 'No API key is set, so the app runs offline: math is fully supported, other subjects get basic template questions. Add a key in .env (never in this app or in chat) to get better questions and grading.', action: 'settings' });
    steps.push({ id: 'ai_output', title: 'Check that the AI returns usable study output', state: 'skipped', detail: 'Not applicable offline.', action: null });
  } else {
    const bad = ai.mode === 'verify_failed' || ai.mode === 'output_problem';
    steps.push({ id: 'ai', title: 'Choose how questions are written', state: bad ? 'problem' : 'done', detail: bad ? ai.detail : `A key is configured for ${ai.label}.`, action: bad ? 'settings' : null });
    const ok = ai.mode === 'output_verified';
    steps.push({
      id: 'ai_output', title: 'Check that the AI returns usable study output', state: ok ? 'done' : bad ? 'problem' : 'todo',
      detail: ok ? `Each task returned schema-valid output.${customEndpoint ? ' Note: you use a custom API address, so this proves that endpoint, not Anthropic itself.' : ''}` : ai.detail, action: ok ? null : 'settings',
    });
  }

  // 3. material
  const sources = ctx.db.get<{ n: number; files: number }>("SELECT COUNT(*) n, SUM(file_id IS NOT NULL) files FROM sources WHERE status = 'confirmed'") ?? { n: 0, files: 0 };
  const drafts = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM sources WHERE status = 'draft'")?.n ?? 0;
  steps.push({
    id: 'material', title: 'Add one packet, notes or a screenshot', state: sources.n ? 'done' : drafts ? 'waiting' : 'todo',
    detail: sources.n ? `${sources.n} material${sources.n > 1 ? 's' : ''} saved${sources.files ? ` (${sources.files} from a file)` : ''}.` : drafts ? 'An uploaded file is waiting for you to check its text page by page and confirm it.' : 'Open a subject and add your own material. Check the extracted text before relying on it.', action: sources.n ? null : 'subjects',
  });

  // 4. review
  const confirmed = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM concepts WHERE status = 'confirmed'")?.n ?? 0;
  const proposed = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM concepts WHERE status = 'proposed'")?.n ?? 0;
  const held = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE on_hold = 1")?.n ?? 0;
  steps.push({
    id: 'review', title: 'Review the topics and questions', state: confirmed ? (held ? 'waiting' : 'done') : proposed ? 'waiting' : 'todo',
    detail: confirmed ? (held ? `${held} question${held > 1 ? 's are' : ' is'} held back because the source did not clearly support the answer key. Accept or discard each one.` : `${confirmed} topic${confirmed > 1 ? 's' : ''} confirmed.`) : proposed ? `${proposed} suggested topic${proposed > 1 ? 's' : ''} wait for you to confirm, rename or reject.` : 'Topics appear after you add material.', action: confirmed && !held ? null : 'subjects',
  });

  // 5. a session of about 20 minutes
  const sess = ctx.db.get<{ id: string; planned: number; active: number }>("SELECT id, planned_minutes planned, active_ms active FROM sessions WHERE status = 'completed' ORDER BY ended_at LIMIT 1");
  const attempts = ctx.db.get<{ n: number; first: number | null }>('SELECT COUNT(*) n, MIN(created_at) first FROM attempts')!;
  steps.push({
    id: 'session', title: 'Finish a 20-minute session', state: sess ? 'done' : 'todo',
    detail: sess ? `Completed a ${sess.planned}-minute session with ${Math.round(sess.active / 60_000)} minutes of recorded activity.` : attempts.n ? 'You have started practising. Finish a session to get a summary of what it can and cannot say about you.' : 'Start from Today and pick 20 minutes.', action: sess ? null : 'today',
  });

  // 6. later independent check
  const delay = getSchedulerParams(ctx.db).delayHours * HOUR;
  const later = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM attempts a WHERE a.hints_used = 0 AND a.saw_answer = 0 AND a.idk = 0 AND a.grade_status = 'graded'
      AND a.created_at >= (SELECT MIN(b.created_at) FROM attempts b WHERE b.concept_id = a.concept_id) + ?`, delay)?.n ?? 0;
  const dueAt = attempts.first == null ? null : attempts.first + delay;
  steps.push({
    id: 'later', title: 'Come back later for an independent check', state: later ? 'done' : attempts.n ? 'waiting' : 'todo',
    detail: later ? 'You answered at least one question without help on a later day than your first attempt. Only such answers count as evidence that something stuck.' : attempts.n ? `Not before ${new Date(dueAt!).toISOString().slice(0, 16).replace('T', ' ')} UTC (about ${getSchedulerParams(ctx.db).delayHours} hours after your first attempt). Answers sooner than that are encouraging but are not counted as lasting improvement.` : 'After your first session, come back the next day.', action: later || !attempts.n ? null : 'today',
  });

  const done = steps.filter((s) => s.state === 'done').length, skipped = steps.filter((s) => s.state === 'skipped').length;
  return { steps, done, skipped, total: steps.length, complete: steps.every((s) => s.state === 'done' || s.state === 'skipped'), liveVerified: ai.mode === 'output_verified', note: 'This list reflects what is recorded in this database. It does not test any outside service; use “Verify study output” in Setup for that.' };
}
