import { ageOnDate, isValidBirthDate, type BirthDate } from './dates';

/** Independently implemented from ICAO Doc 9303 Parts 3–6; see docs/DOCUMENT_COVERAGE.md. */
export type MRZInspection =
  | { status: 'absent' | 'invalid' | 'conflict' }
  | { status: 'valid'; birthDate: BirthDate; format: 'TD1' | 'TD2' | 'TD3' };

/** ICAO modulus-10 weighted checksum. It checks transcription, not document authenticity. */
export function mrzCheckDigit(value: string): string | null {
  if (!/^[A-Z0-9<]+$/.test(value)) return null;
  let sum = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index);
    const number = character === 60 ? 0 : character <= 57 ? character - 48 : character - 55;
    sum += number * [7, 3, 1][index % 3];
  }
  return String(sum % 10);
}

/** Select the youngest possible non-future DOB. Required age is deliberately not an input. */
export function resolveMRZBirthDate(value: string, now = new Date()): BirthDate | null {
  if (!/^\d{6}$/.test(value) || !Number.isFinite(now.getTime())) return null;
  let year = Math.floor(now.getUTCFullYear() / 100) * 100 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (year > now.getUTCFullYear() || (year === now.getUTCFullYear() && (month > now.getUTCMonth() + 1 || (month === now.getUTCMonth() + 1 && day > now.getUTCDate())))) year -= 100;
  const birthDate = { year, month, day };
  if (!isValidBirthDate(birthDate, now) || ageOnDate(birthDate, now) >= 100) return null;
  return birthDate;
}

// Correct only a character forbidden by a numeric field's grammar, and only to one digit.
// Alphanumeric document numbers, optional data, names and country codes are never guessed.
const digitConfusions: Record<string, string> = { O: '0', I: '1', L: '1', Z: '2', S: '5', B: '8' };

function checkedRecord(input: string[], format: 'TD1' | 'TD2' | 'TD3', now: Date): { birthDate: BirthDate; signature: string } | null {
  const width = format === 'TD1' ? 30 : format === 'TD2' ? 36 : 44;
  if (input.length !== (format === 'TD1' ? 3 : 2) || input.some(line => line.length !== width || !/^[A-Z0-9<]+$/.test(line))) return null;
  const lines = input.map(line => line.split(''));
  let corrections = 0;
  const numeric = (line: number, start: number, length: number): boolean => {
    for (let index = start; index < start + length; index++) {
      const char = lines[line][index];
      if (/^\d$/.test(char)) continue;
      if (!digitConfusions[char] || ++corrections > 4) return false;
      lines[line][index] = digitConfusions[char];
    }
    return true;
  };
  const field = (line: number, start: number, end: number) => lines[line].slice(start, end).join('');
  const check = (line: number, start: number, end: number, checkIndex: number) => mrzCheckDigit(field(line, start, end)) === field(line, checkIndex, checkIndex + 1);
  const validName = (value: string) => /^[A-Z<]+$/.test(value) && /[A-Z]/.test(value);
  if (!/^[A-Z<]{3}$/.test(field(0, 2, 5)) || !/[A-Z]/.test(field(0, 2, 5))) return null;
  if (format === 'TD3') {
    if (!/^P[A-Z<]/.test(input[0]) || !validName(field(0, 5, width))) return null;
  } else {
    if (!/^[ACI][A-Z0-9<]/.test(input[0]) || input[0][1] === 'V' || (format === 'TD1' && input[0].startsWith('AI')) || (format === 'TD2' && input[0].startsWith('AC'))) return null;
    if (!validName(format === 'TD1' ? input[2] : field(0, 5, width))) return null;
  }

  const documentLine = format === 'TD1' ? 0 : 1;
  const documentStart = format === 'TD1' ? 5 : 0;
  const documentCheck = documentStart + 9;
  const birthStart = format === 'TD1' ? 0 : 13;
  const expiryStart = format === 'TD1' ? 8 : 21;
  const nationalityStart = format === 'TD1' ? 15 : 10;
  const sexIndex = format === 'TD1' ? 7 : 20;
  const compositeIndex = format === 'TD1' ? 29 : width - 1;
  if (!/^[A-Z<]{3}$/.test(field(1, nationalityStart, nationalityStart + 3)) || !/^[MF<]$/.test(field(1, sexIndex, sexIndex + 1))) return null;
  if (!/[A-Z0-9]/.test(field(documentLine, documentStart, documentCheck))) return null;
  if (!numeric(1, birthStart, 7) || !numeric(1, expiryStart, 7) || !numeric(1, compositeIndex, 1)) return null;
  const expiry = field(1, expiryStart, expiryStart + 6);
  if (!isValidBirthDate({ year: 2000 + Number(expiry.slice(0, 2)), month: Number(expiry.slice(2, 4)), day: Number(expiry.slice(4, 6)) }, new Date('2099-12-31T00:00:00Z'))) return null;

  if (field(documentLine, documentCheck, documentCheck + 1) === '<') {
    // TD1/TD2 extend a long document number into the start of the optional field.
    if (format === 'TD3' || !/^[A-Z0-9]{9}$/.test(field(documentLine, documentStart, documentCheck))) return null;
    const optionalStart = format === 'TD1' ? 15 : 28;
    const optionalEnd = format === 'TD1' ? 30 : 35;
    const extension = field(documentLine, optionalStart, optionalEnd).match(/^([A-Z0-9]+)([0-9OILZSB])</);
    if (!extension) return null;
    const extendedCheck = optionalStart + extension[1].length;
    if (!numeric(documentLine, extendedCheck, 1)) return null;
    if (mrzCheckDigit(field(documentLine, documentStart, documentCheck) + extension[1]) !== field(documentLine, extendedCheck, extendedCheck + 1)) return null;
  } else {
    if (!numeric(documentLine, documentCheck, 1) || !check(documentLine, documentStart, documentCheck, documentCheck)) return null;
  }
  if (!check(1, birthStart, birthStart + 6, birthStart + 6) || !check(1, expiryStart, expiryStart + 6, expiryStart + 6)) return null;

  if (format === 'TD3') {
    const optional = field(1, 28, 42);
    const optionalCheck = field(1, 42, 43);
    if (!(/^<+$/.test(optional) && optionalCheck === '<')) {
      if (!numeric(1, 42, 1) || !check(1, 28, 42, 42)) return null;
    }
  }
  const composite = format === 'TD1'
    ? field(0, 5, 30) + field(1, 0, 7) + field(1, 8, 15) + field(1, 18, 29)
    : field(1, 0, 10) + field(1, 13, 20) + field(1, 21, width - 1);
  if (mrzCheckDigit(composite) !== field(1, compositeIndex, compositeIndex + 1)) return null;
  const birthDate = resolveMRZBirthDate(field(1, birthStart, birthStart + 6), now);
  return birthDate ? { birthDate, signature: lines.map(line => line.join('')).join('\n') } : null;
}

/** Full rows are required; no substring search, missing-character insertion or century guessing. */
export function inspectMRZ(text: string, now = new Date()): MRZInspection {
  if (typeof text !== 'string' || text.length > 100_000 || !Number.isFinite(now.getTime())) return { status: 'invalid' };
  const lines = text.toUpperCase().split(/\r?\n/).map(line => line.replace(/[ \t]/g, '')).filter(Boolean);
  if (lines.length > 2000) return { status: 'invalid' };
  let detected = 0;
  let invalid = false;
  const records: Array<{ birthDate: BirthDate; signature: string; format: 'TD1' | 'TD2' | 'TD3' }> = [];
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index];
    const format = header.length === 44 && /^P[A-Z<][A-Z<]{3}/.test(header) ? 'TD3'
      : header.length === 36 && /^[ACI][A-Z0-9<][A-Z<]{3}/.test(header) ? 'TD2'
      : header.length === 30 && /^[ACI][A-Z0-9<][A-Z<]{3}/.test(header) ? 'TD1' : null;
    if (!format) continue;
    if (++detected > 10) return { status: 'invalid' };
    const record = checkedRecord(lines.slice(index, index + (format === 'TD1' ? 3 : 2)), format, now);
    if (!record) invalid = true;
    else records.push({ ...record, format });
    index += format === 'TD1' ? 2 : 1;
  }
  if (!detected) return { status: 'absent' };
  if (new Set(records.map(record => record.signature)).size > 1) return { status: 'conflict' };
  if (invalid || records.length === 0) return { status: 'invalid' };
  const { birthDate, format } = records[0];
  return { status: 'valid', birthDate, format };
}

export function parseMRZBirthDate(text: string, now = new Date()): BirthDate | null {
  const result = inspectMRZ(text, now);
  return result.status === 'valid' ? result.birthDate : null;
}
