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

function dateCandidates(text: string, order?: DateOrder): Array<BirthDate | null> {
  const candidates: Array<BirthDate | null> = [];
  const numeric = /\b(\d{4}|\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4}|\d{1,2})\b/g;
  for (const match of text.matchAll(numeric)) {
    const [, a, b, c] = match;
    if (a.length === 4 && c.length <= 2) candidates.push({ year: +a, month: +b, day: +c });
    else if (c.length === 4 && a.length <= 2 && order !== 'YMD') {
      const resolvedOrder = order ?? (+a > 12 ? 'DMY' : +b > 12 ? 'MDY' : +a === +b ? 'MDY' : undefined);
      candidates.push(resolvedOrder ? { year: +c, month: +(resolvedOrder === 'MDY' ? a : b), day: +(resolvedOrder === 'MDY' ? b : a) } : null);
    } else candidates.push(null); // Never infer a century from a two-digit year.
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})[\\s./-]+(${monthPattern})\\.?[\\s,/-]+(\\d{4})\\b`, 'g');
  const monthFirst = new RegExp(`\\b(${monthPattern})\\.?[\\s./-]+(\\d{1,2})(?:st|nd|rd|th)?[\\s,/-]+(\\d{4})\\b`, 'g');
  for (const [, day, month, year] of text.matchAll(dayFirst)) candidates.push({ year: +year, month: months.get(month)!, day: +day });
  for (const [, month, day, year] of text.matchAll(monthFirst)) candidates.push({ year: +year, month: months.get(month)!, day: +day });
  return candidates;
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
