/**
 * Dates found in pasted text. Everything here is a GUESS that a person must confirm: a date that needed any assumption comes back as 'uncertain',
 * with the reason in plain words, and is shown flagged in the preview. Dates are day keys ("2026-11-05"); the caller supplies today's key
 * (the browser's own calendar day), so nothing here depends on a server clock or time zone.
 */
import { addDaysKey, diffDaysKeys, dowOfKey } from '../time';

export interface DueInfo { date: string | null; certainty: 'exact' | 'uncertain' | 'none'; reason: string | null; raw: string | null }
export const NO_DATE: DueInfo = { date: null, certainty: 'none', reason: null, raw: null };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
export const weekdayIndex = (s: string) => { const k = s.slice(0, 3).toLowerCase(); return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(k); };
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const monthNo = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

/** A month and day with no year: this year, unless that is long past (then next year). A date that already passed is flagged either way. */
function yearless(m: number, d: number, today: string, raw: string): DueInfo {
  const y = Number(today.slice(0, 4));
  if (!valid(y, m, d)) return { date: null, certainty: 'none', reason: `“${raw}” is not a real date.`, raw };
  let k = key(y, m, d);
  const back = diffDaysKeys(today, k); // negative: in the past
  if (back < -30) { k = valid(y + 1, m, d) ? key(y + 1, m, d) : k; return { date: k, certainty: 'uncertain', reason: `No year was given, and ${raw} already passed this year, so next year was assumed.`, raw }; }
  if (back < 0) return { date: k, certainty: 'uncertain', reason: `${raw} has already passed. Is the date right?`, raw };
  return { date: k, certainty: 'exact', reason: null, raw };
}

export function resolveDate(text: string, today: string): DueInfo {
  const s = text.replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/))) { const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; return valid(y, mo, d) ? { date: key(y, mo, d), certainty: 'exact', reason: null, raw: m[0] } : { date: null, certainty: 'none', reason: `“${m[0]}” is not a real date.`, raw: m[0] }; }
  if ((m = s.match(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`, 'i')))) {
    const mo = monthNo(m[1]), d = Number(m[2]);
    if (m[3]) return valid(Number(m[3]), mo, d) ? { date: key(Number(m[3]), mo, d), certainty: 'exact', reason: null, raw: m[0] } : { date: null, certainty: 'none', reason: `“${m[0]}” is not a real date.`, raw: m[0] };
    return yearless(mo, d, today, m[0]);
  }
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b\\.?(?:,?\\s+(20\\d\\d))?`, 'i')))) {
    const mo = monthNo(m[2]), d = Number(m[1]);
    if (m[3]) return valid(Number(m[3]), mo, d) ? { date: key(Number(m[3]), mo, d), certainty: 'exact', reason: null, raw: m[0] } : NO_DATE;
    return yearless(mo, d, today, m[0]);
  }
  if ((m = s.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\b/))) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 31) {
      const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
      // month/day is assumed (US style). If both numbers could be a month, say so.
      const ambiguous = a <= 12 && b <= 12 && a !== b;
      let mo = a, d = b, swapped = false;
      if (a > 12 && b <= 12) { mo = b; d = a; swapped = true; }
      if (!valid(yr ?? Number(today.slice(0, 4)), mo, d)) return { date: null, certainty: 'none', reason: `“${m[0]}” is not a real date.`, raw: m[0] };
      const base = yr ? { date: key(yr, mo, d), certainty: 'exact' as const, reason: null, raw: m[0] } : yearless(mo, d, today, m[0]);
      if (ambiguous) return { ...base, certainty: 'uncertain', reason: `“${m[0]}” could be month/day or day/month. Read as ${MONTHS[mo - 1]} ${d}.` };
      if (swapped) return { ...base, certainty: 'uncertain', reason: `“${m[0]}” was read as day/month (${MONTHS[mo - 1]} ${d}).` };
      return base;
    }
  }
  if (/\bday after tomorrow\b/i.test(s)) return { date: addDaysKey(today, 2), certainty: 'exact', reason: null, raw: 'day after tomorrow' };
  if (/\btomorrow\b/i.test(s)) return { date: addDaysKey(today, 1), certainty: 'exact', reason: null, raw: 'tomorrow' };
  if (/\b(today|tonight|this evening)\b/i.test(s)) return { date: today, certainty: 'exact', reason: null, raw: 'today' };
  if ((m = s.match(/\bin (\d{1,2}) (day|days|week|weeks)\b/i))) return { date: addDaysKey(today, Number(m[1]) * (m[2].toLowerCase().startsWith('w') ? 7 : 1)), certainty: 'exact', reason: null, raw: m[0] };
  if ((m = s.match(new RegExp(`\\b(next|this|by|on|due)?\\s*${DAY_RE}\\b`, 'i'))) && weekdayIndex(m[2]) >= 0) {
    const want = weekdayIndex(m[2]); let n = (want - dowOfKey(today) + 7) % 7;
    const mod = (m[1] ?? '').toLowerCase();
    if (n === 0) n = 7;
    return { date: addDaysKey(today, n), certainty: 'uncertain', reason: mod === 'next' ? `“${m[0].trim()}” can mean the nearest ${WEEKDAYS[want]} or the one after. The nearest was assumed.` : `Only a weekday was given (${m[2]}). The next ${WEEKDAYS[want]} was assumed.`, raw: m[0].trim() };
  }
  if (/\b(next week|end of (the )?week|this week|end of (the )?month|soon|eventually)\b/i.test(s)) return { date: null, certainty: 'uncertain', reason: 'Only a rough time was given, so no exact date was set.', raw: s.match(/\b(next week|end of (the )?week|this week|end of (the )?month|soon|eventually)\b/i)![0] };
  return NO_DATE;
}

/** The text with the date phrase taken out, for use as a title. */
export function withoutDate(text: string, due: DueInfo): string {
  let t = text;
  if (due.raw) t = t.replace(due.raw, ' ');
  return t.replace(/\b(due|by|on|before|until|turn(?:ed)? in|submit|deadline|is|are)\b\s*[:\-–]?\s*$/i, '').replace(/\s*[-–:,;]\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}
