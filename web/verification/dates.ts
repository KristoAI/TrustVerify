/** Calendar and OCR date handling written from the application's behavior requirements. */
export type BirthDate = { year: number; month: number; day: number };
export type DateOrder = 'MDY' | 'DMY' | 'YMD';

const monthNames = [
  ['jan', 'january', 'janv', 'janvier'], ['feb', 'february', 'fev', 'fevr', 'fevrier'],
  ['mar', 'march', 'mars'], ['apr', 'april', 'avr', 'avril'], ['may', 'mai'],
  ['jun', 'june', 'juin'], ['jul', 'july', 'juil', 'juillet'], ['aug', 'august', 'aou', 'aout'],
  ['sep', 'sept', 'september', 'septembre'], ['oct', 'october', 'octobre'],
  ['nov', 'november', 'novembre'], ['dec', 'december', 'decembre'],
];
const months = new Map(monthNames.flatMap((names, index) => names.map(name => [name, index + 1] as const)));
const monthPattern = Array.from(months.keys()).sort((a, b) => b.length - a.length).join('|');
const birthLabel = /\b(?:\d{1,2}\.?[ \t]*)?(?:d\.?\s*o\.?\s*b\.?|date\s+of\s+birth|birth\s*date|date\s+de\s+naissance|ne(?:e)?\s+le)\b[ \t:.-]*/gi;
const otherLabel = /\b(?:\d{1,2}[a-z]?\.?[ \t]*)?(?:date\s+(?:of\s+)?(?:issue|expiry|expiration)|issued?|issuance|expires?|expiry|expiration|exp|iss|invoice|receipt|delivre|delivrance|valid(?:ity)?|valable|autorite|address|adresse|name|nom)\b/i;

function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2010-\u2015]/g, '-').toLowerCase();
}

/** Uses UTC calendar dates, avoiding timezone and daylight-saving changes. */
export function isValidBirthDate(value: BirthDate, now = new Date()): boolean {
  if (!value || ![value.year, value.month, value.day].every(Number.isInteger) || value.year < 1000 || value.year > 9999 || !Number.isFinite(now.getTime())) return false;
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  if (date.getUTCFullYear() !== value.year || date.getUTCMonth() + 1 !== value.month || date.getUTCDate() !== value.day) return false;
  return date.getTime() <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function ageOnDate(birthDate: BirthDate, now = new Date()): number {
  if (!isValidBirthDate(birthDate, now)) throw new RangeError('A valid birth date is required.');
  const beforeBirthday = now.getUTCMonth() + 1 < birthDate.month || (now.getUTCMonth() + 1 === birthDate.month && now.getUTCDate() < birthDate.day);
  return now.getUTCFullYear() - birthDate.year - Number(beforeBirthday);
}

export function meetsRequiredAge(birthDate: BirthDate, requiredAge: number, now = new Date()): boolean {
  if (!Number.isInteger(requiredAge) || requiredAge < 0) throw new RangeError('A valid required age is required.');
  return ageOnDate(birthDate, now) >= requiredAge;
}

const isCalendarDate = (date: BirthDate) => {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return date.year >= 1000 && value.getUTCFullYear() === date.year && value.getUTCMonth() + 1 === date.month && value.getUTCDate() === date.day;
};
const dateTime = (date: BirthDate) => Date.UTC(date.year, date.month - 1, date.day);

/** Day/month order is read from the digits when only one order is a real date. When both are,
 * the document's known order wins; with none known, the later date is used so an unknown
 * format can only understate an age, never overstate it.
 */
function numericDate(first: string, second: string, year: string, order?: DateOrder): BirthDate | null {
  const monthFirst = { year: +year, month: +first, day: +second };
  const dayFirst = { year: +year, month: +second, day: +first };
  const valid = [monthFirst, dayFirst].filter(isCalendarDate);
  if (valid.length < 2) return valid[0] ?? null;
  if (order === 'MDY') return monthFirst;
  if (order === 'DMY') return dayFirst;
  return dateTime(monthFirst) >= dateTime(dayFirst) ? monthFirst : dayFirst;
}

/** Every common printed form: 1988-08-24, 08/24/1988, 24.08.1988, 19880824, 24 AUG 1988,
 * 24AUG1988, AUG 24, 1988 and 1988 AUG 24 (English or French month names). Two-digit years
 * are never expanded, because a wrong century can turn a child into an adult.
 */
function dateCandidates(text: string, order?: DateOrder): Array<BirthDate | null> {
  const found: Array<{ start: number; end: number; date: BirthDate | null }> = [];
  const add = (match: RegExpMatchArray, date: BirthDate | null) => {
    const start = match.index!, end = start + match[0].length;
    // One printed date can fit several patterns; count it once.
    if (!found.some(item => start < item.end && item.start < end)) found.push({ start, end, date });
  };
  const numeric = /\b(\d{4}|\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4}|\d{1,2})\b/g;
  for (const match of text.matchAll(numeric)) {
    const [, a, b, c] = match;
    if (a.length === 4 && c.length <= 2) add(match, { year: +a, month: +b, day: +c });
    else if (c.length === 4 && a.length <= 2) add(match, numericDate(a, b, c, order));
    else add(match, null); // Never infer a century from a two-digit year.
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})[\\s./-]*(${monthPattern})\\.?[\\s,/-]*(\\d{4})\\b`, 'g');
  const monthFirst = new RegExp(`\\b(${monthPattern})\\.?[\\s./-]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,/-]+(\\d{4})\\b`, 'g');
  const yearFirst = new RegExp(`\\b(\\d{4})[\\s./-]*(${monthPattern})\\.?[\\s./-]*(\\d{1,2})\\b`, 'g');
  for (const match of text.matchAll(dayFirst)) add(match, { year: +match[3], month: months.get(match[2])!, day: +match[1] });
  for (const match of text.matchAll(monthFirst)) add(match, { year: +match[3], month: months.get(match[1])!, day: +match[2] });
  for (const match of text.matchAll(yearFirst)) add(match, { year: +match[1], month: months.get(match[2])!, day: +match[3] });
  // Compact year-month-day only; compact day/month orders are too easily a document number.
  for (const match of text.matchAll(/\b((?:19|20)\d{2})(\d{2})(\d{2})\b/g)) add(match, { year: +match[1], month: +match[2], day: +match[3] });
  return found.sort((a, b) => a.start - b.start).map(item => item.date);
}

function labelledRegions(normalized: string): string[] {
  const labels = Array.from(normalized.matchAll(birthLabel));
  return labels.map((label, index) => {
    const start = label.index! + label[0].length;
    const end = labels[index + 1]?.index ?? normalized.length;
    return normalized.slice(start, end).split('\n').slice(0, 2).join('\n').slice(0, 160).split(otherLabel)[0];
  });
}

/** Allows a checksum reader to reject contradictory printed DOB fields instead of hiding them. */
export function hasConflictingBirthDates(text: string, options: { dateOrder?: DateOrder; now?: Date } = {}): boolean {
  if (typeof text !== 'string' || text.length > 100_000) return true;
  const dates = labelledRegions(normalizeText(text)).flatMap(region => dateCandidates(region, options.dateOrder));
  return new Set(dates.filter(date => date && isValidBirthDate(date, options.now ?? new Date())).map(date => `${date!.year}-${date!.month}-${date!.day}`)).size > 1;
}

// Labels that mark a printed date as a later licence event rather than the birth date.
const laterEventLabel = /\b(?:replaced|reissued?|renewed?|rev(?:ised)?)\b/i;
// A whole printed field: never preceded by a letter, digit or separator (a licence or document
// number), never followed by more digits. OCR may glue stray marks or the next word on after it.
const standaloneDate = /(?<![\p{L}\p{N}_/.:-])(\d{1,2}([/.-])\d{1,2}\2\d{4}|\d{4}([/.-])\d{1,2}\3\d{1,2})(?![\p{N}]|[/.:-]\p{N})/gu;
const UNLABELLED_MIN_DATES = 2;
const UNLABELLED_MIN_GAP_YEARS = 10;
const UNLABELLED_MIN_AGE = 10;
const UNLABELLED_MAX_AGE = 120;

/** For full-page OCR whose DOB label is unreadable: the earliest printed date, only when it is
 * unambiguous. A birth date precedes every other date on an identity document, so if the
 * birth date itself was missed, the earliest remaining date (issue, replacement) gives a
 * younger age and the check fails rather than passing someone underage. Fails closed when
 * any DOB label is present (the labelled rules own that), fewer than two past dates are
 * whole printed fields, the earliest is labelled as another field, another date falls
 * within ten years of it, or the resulting age is outside 10–120.
 */
export function parseUnlabelledBirthDate(text: string, options: { dateOrder?: DateOrder; now?: Date } = {}): BirthDate | null {
  if (typeof text !== 'string' || text.length > 100_000 || (options.dateOrder && !['MDY', 'DMY', 'YMD'].includes(options.dateOrder))) return null;
  const normalized = normalizeText(text);
  if (labelledRegions(normalized).length > 0) return null;
  const now = options.now ?? new Date();
  const found: Array<{ date: BirthDate; labelled: boolean }> = [];
  for (const line of normalized.split('\n')) {
    for (const match of line.matchAll(standaloneDate)) {
      const [date] = dateCandidates(match[1], options.dateOrder);
      if (!date) return null; // An impossible date-shaped field fails closed.
      if (!isValidBirthDate(date, now)) continue; // Future dates (expiry) are never the birth date.
      const before = line.slice(0, match.index).trim().split(/\s+/).slice(-2).join(' ');
      found.push({ date, labelled: otherLabel.test(before) || laterEventLabel.test(before) });
    }
  }
  const distinct = [...new Map(found.map(item => [dateTime(item.date), item])).values()].sort((a, b) => dateTime(a.date) - dateTime(b.date));
  if (distinct.length < UNLABELLED_MIN_DATES) return null;
  const [earliest, next] = distinct;
  // A duplicate earliest date with any other label means its field is uncertain.
  if (found.some(item => dateTime(item.date) === dateTime(earliest.date) && item.labelled)) return null;
  const gap = new Date(dateTime(earliest.date));
  gap.setUTCFullYear(gap.getUTCFullYear() + UNLABELLED_MIN_GAP_YEARS);
  if (dateTime(next.date) < gap.getTime()) return null;
  const age = ageOnDate(earliest.date, now);
  return age >= UNLABELLED_MIN_AGE && age <= UNLABELLED_MAX_AGE ? earliest.date : null;
}

/** Every real calendar date printed anywhere in OCR text; used only to confirm a date read in another pass. */
export function printedDates(text: string, options: { dateOrder?: DateOrder } = {}): BirthDate[] {
  if (typeof text !== 'string' || text.length > 100_000) return [];
  return dateCandidates(normalizeText(text), options.dateOrder).filter((date): date is BirthDate => Boolean(date) && isCalendarDate(date!));
}

/** Full-page OCR must identify a DOB label. A selected region may hold one unlabelled date. */
export function parseBirthDate(text: string, options: { dateOrder?: DateOrder; selectedRegion?: boolean; now?: Date } = {}): BirthDate | null {
  if (typeof text !== 'string' || text.length > 100_000 || (options.dateOrder && !['MDY', 'DMY', 'YMD'].includes(options.dateOrder))) return null;
  const normalized = normalizeText(text);
  const regions = labelledRegions(normalized);
  const now = options.now ?? new Date();
  // Human selection identifies the field. Require one date in the entire box,
  // even if a DOB label is present; never silently ignore a second date/field.
  if (options.selectedRegion) {
    if (otherLabel.test(normalized)) return null;
    const candidates = dateCandidates(normalized, options.dateOrder);
    return candidates.length === 1 && candidates[0] && isValidBirthDate(candidates[0], now) ? candidates[0] : null;
  }
  if (regions.length > 0) {
    const found: BirthDate[] = [];
    for (const adjacent of regions) {
      const candidates = dateCandidates(adjacent, options.dateOrder);
      if (candidates.length !== 1 || !candidates[0] || !isValidBirthDate(candidates[0], now)) return null;
      found.push(candidates[0]);
    }
    const first = found[0];
    return found.every(date => date.year === first.year && date.month === first.month && date.day === first.day) ? first : null;
  }
  return null;
}
