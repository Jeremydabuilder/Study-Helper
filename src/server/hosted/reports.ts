import { HttpError } from '../services/common';
import { Pool, audit } from './pg';
import { consumeQuota } from './limits';

/**
 * "Report a problem". The student writes a message and may attach ONE piece of text they pick (for example a question that looked wrong).
 * An attachment is shown back to them first and is only stored once they confirm it; nothing is collected automatically.
 */
export async function submitReport(pool: Pool, userId: string, b: { message: string; attach?: { kind: string; text: string }; confirmed?: boolean; previewOnly?: boolean } & Record<string, unknown>, now: number) {
  const message = String(b.message ?? '').trim();
  if (message.length < 5) throw new HttpError(400, 'invalid', 'Tell us briefly what went wrong (at least a few words).');
  const attach = b.attach ? { kind: String(b.attach.kind).slice(0, 30), text: String(b.attach.text).slice(0, 4000) } : null;
  if (attach && !(b as any).confirmed) return { preview: { message, attachment: attach }, sent: false, note: 'This is exactly what would be sent. Nothing has been stored yet.' };
  if (b.previewOnly) return { preview: { message, attachment: attach }, sent: false, note: 'This is exactly what would be sent. Nothing has been stored yet.' };
  await consumeQuota(pool, userId, 'report', { limit: 5, now, message: 'You have sent several reports today. Please try again tomorrow.' });
  await pool.query('INSERT INTO reports (user_id, message, attachment) VALUES ($1,$2,$3)', [userId, message.slice(0, 2000), attach ? JSON.stringify(attach) : null]);
  await audit(pool, 'report_sent', userId, { withAttachment: !!attach });
  return { sent: true };
}
