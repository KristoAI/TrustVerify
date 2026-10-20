import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// The ONNX reader is replaced by a synthetic one; tests/browser covers real OCR.
const syntheticReader = { name: 'synthetic-ocr-reader', setup(builder) {
  builder.onResolve({ filter: /^\.\/ocr$/ }, () => ({ path: 'ocr', namespace: 'synthetic-ocr' }));
  builder.onLoad({ filter: /.*/, namespace: 'synthetic-ocr' }, () => ({ contents: 'export function createOCRReader() { return globalThis.__ocrFixture.create(); } export function straighten() { return null; }', loader: 'js' }));
} };
async function loadModule(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', plugins: [syntheticReader] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { parseBirthDate, parseUnlabelledBirthDate, ageOnDate, meetsRequiredAge, isValidBirthDate } = await loadModule('web/verification/dates.ts');
const { normalizeCrop, cropToPixels } = await loadModule('web/verification/crop.ts');
const { readDocument, OCR_TIMEOUT_MS } = await loadModule('web/verification/document.ts');
const { inspectMRZ, parseMRZBirthDate, mrzCheckDigit, resolveMRZBirthDate } = await loadModule('web/verification/mrz.ts');
const now = new Date('2026-09-19T00:00:00Z');
const parse = (text, options = {}) => parseBirthDate(text, { now, ...options });

// ICAO Part 4 Appendix A data rows, plus Part 3 Appendix A checksum examples.
// Name rows for the TD1/TD2 checksum examples are synthetic and contain no real identity.
const td3 = ['PPUTOERIKSSON<<ANNA<MARIA'.padEnd(44, '<'), 'L898902C36UTO7408122F3404159ZE184226B<<<<<16'];
const td1 = ['I<YTOD231458907'.padEnd(30, '<'), '3407127M9507122YTO<<<<<<<<<<<2', 'EXAMPLE<<ALICE'.padEnd(30, '<')];
const td2 = ['I<YTOEXAMPLE<<ALICE'.padEnd(36, '<'), 'HA672242<6YTO5802254M9601086<<<<<<<8'];
const childMRZ = ['PPUTOEXAMPLE<<ALICE'.padEnd(44, '<'), 'TB12345674UTO0909192F3501014<<<<<<<<<<<<<<04'];
const mutate = (text, index, replacement) => text.slice(0, index) + replacement + text.slice(index + replacement.length);
function refreshTD3Composite(line) { return line.slice(0, 43) + mrzCheckDigit(line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43)); }

test('ICAO TD1/TD2/TD3 examples validate individual and composite check digits', () => {
  assert.equal(mrzCheckDigit('L898902C3'), '6');
  assert.equal(mrzCheckDigit('740812'), '2');
  assert.equal(mrzCheckDigit('<'.repeat(14)), '0');
  assert.equal(mrzCheckDigit('private!'), null);
  for (const [lines, format, birthDate] of [[td1, 'TD1', { year: 1934, month: 7, day: 12 }], [td2, 'TD2', { year: 1958, month: 2, day: 25 }], [td3, 'TD3', { year: 1974, month: 8, day: 12 }]]) {
    assert.deepEqual(inspectMRZ(lines.join('\n'), now), { status: 'valid', format, birthDate });
  }
});

test('MRZ century selection never ages a child into an adult to pass a threshold', () => {
  const dob = parseMRZBirthDate(childMRZ.join('\n'), now);
  assert.deepEqual(dob, { year: 2009, month: 9, day: 19 });
  assert.equal(meetsRequiredAge(dob, 18, now), false);
  assert.deepEqual(resolveMRZBirthDate('250101', now), { year: 2025, month: 1, day: 1 }, 'centenarian ambiguity resolves to youngest possible person');
  assert.deepEqual(resolveMRZBirthDate('260919', now), { year: 2026, month: 9, day: 19 });
  assert.deepEqual(resolveMRZBirthDate('260920', now), { year: 1926, month: 9, day: 20 });
  assert.deepEqual(resolveMRZBirthDate('000229', now), { year: 2000, month: 2, day: 29 });
  for (const bad of ['250229', '991301', '990000', '<<<<<<', '000230']) assert.equal(resolveMRZBirthDate(bad, now), null);
});

test('MRZ fails altered individual checks even when the composite checksum is recomputed', () => {
  for (const position of [9, 19, 27, 42]) {
    const bad = mutate(td3[1], position, td3[1][position] === '0' ? '1' : '0');
    assert.equal(parseMRZBirthDate([td3[0], refreshTD3Composite(bad)].join('\n'), now), null);
  }
  assert.equal(parseMRZBirthDate([td3[0], mutate(td3[1], 43, '0')].join('\n'), now), null);
  assert.equal(parseMRZBirthDate([mutate(td1[0], 20, 'B'), ...td1.slice(1)].join('\n'), now), null, 'TD1 upper optional data is covered by the composite');
  assert.equal(parseMRZBirthDate([td2[0], mutate(td2[1], 30, 'B')].join('\n'), now), null, 'TD2 optional data is covered by the composite');
});

test('MRZ corrects only bounded, numeric-field OCR confusions that pass all checks', () => {
  const confused = mutate(mutate(td3[1], 15, 'O'), 17, 'I');
  assert.deepEqual(parseMRZBirthDate([td3[0], confused].join('\n'), now), { year: 1974, month: 8, day: 12 });
  assert.equal(parseMRZBirthDate([td3[0], mutate(td3[1], 15, 'Q')].join('\n'), now), null);
  assert.equal(parseMRZBirthDate([td3[0], mutate(td3[1], 1, 'B')].join('\n'), now), null, 'document-number corrections are not attempted');
  const excessive = 'TB12345674UTOO9O9192F35O1O14<<<<<<<<<<<<<<O4';
  assert.equal(parseMRZBirthDate([childMRZ[0], excessive].join('\n'), now), null);
});

test('MRZ requires complete rows and rejects distinct competing records', () => {
  assert.equal(inspectMRZ('DOB 7408122', now).status, 'absent');
  assert.equal(inspectMRZ(td3[0], now).status, 'invalid');
  assert.equal(inspectMRZ([td3[0], td3[1].slice(1)].join('\n'), now).status, 'invalid');
  assert.equal(inspectMRZ([...td3, ...childMRZ].join('\n'), now).status, 'conflict');
  assert.equal(inspectMRZ([...td3, mutate(td3[0], 5, 'A'), td3[1]].join('\n'), now).status, 'conflict');
  assert.equal(inspectMRZ([...td3, ...td3].join('\n'), now).status, 'valid', 'identical OCR duplication is harmless');
  const spaced = td3.map(line => line.toLowerCase().match(/.{1,4}/g).join(' ')).join('\n\n');
  assert.deepEqual(parseMRZBirthDate(spaced, now), { year: 1974, month: 8, day: 12 });
});

test('TD1/TD2 long document numbers use the extended check digit and record checksum', () => {
  const extendedTD1 = ['I<UTOAB1234567<8904<<<<<<<<<<<', '0101011F3501014UTO<<<<<<<<<<<6', 'ALICE<<EXAMPLE'.padEnd(30, '<')];
  const extendedTD2 = ['I<UTOALICE<<EXAMPLE'.padEnd(36, '<'), 'AB1234567<UTO0101011F35010148904<<<2'];
  for (const lines of [extendedTD1, extendedTD2]) assert.deepEqual(parseMRZBirthDate(lines.join('\n'), now), { year: 2001, month: 1, day: 1 });
  assert.equal(parseMRZBirthDate([mutate(extendedTD1[0], 18, '0'), ...extendedTD1.slice(1)].join('\n'), now), null);
  assert.equal(parseMRZBirthDate([extendedTD2[0], mutate(extendedTD2[1], 31, '0')].join('\n'), now), null);
});

test('labelled DOB is distinguished from issue and expiry dates', () => {
  assert.deepEqual(parse('ISS 01/01/2020\nDOB 09/19/2000\nEXP 09/19/2030', { dateOrder: 'MDY' }), { year: 2000, month: 9, day: 19 });
  assert.deepEqual(parse('Date of birth:\n19 SEP 2000\nDate of issue 01/01/2020'), { year: 2000, month: 9, day: 19 });
  assert.deepEqual(parse('DATE DE NAISSANCE : 19 février 2000'), { year: 2000, month: 2, day: 19 });
  assert.equal(parse('ISS 09/19/2000', { dateOrder: 'MDY' }), null);
  assert.equal(parse('DOB\nDate of issue 09/19/2000', { dateOrder: 'MDY' }), null);
  assert.equal(parse('DOB\n\n\n09/19/2000', { dateOrder: 'MDY' }), null);
  assert.equal(parse('DOB 09/19/2000 09/20/2000', { dateOrder: 'MDY' }), null);
  assert.equal(parse('DOB 09/19/2000\nDOB 09/20/2000', { dateOrder: 'MDY' }), null);
});

test('region selection accepts exactly one date and never chooses among conflicting dates', () => {
  assert.equal(parse('2000-09-19'), null);
  assert.deepEqual(parse('2000-09-19', { selectedRegion: true }), { year: 2000, month: 9, day: 19 });
  assert.equal(parse('2000-09-19 2001-09-19', { selectedRegion: true }), null);
  assert.equal(parse('EXP 2000-09-19', { selectedRegion: true }), null);
  assert.equal(parse('2000-09-19 2025-02-31', { selectedRegion: true }), null);
});

test('every common printed date format is read without the visitor choosing an order', () => {
  const august24 = { year: 1988, month: 8, day: 24 };
  for (const text of ['DOB 1988-08-24', 'DOB 1988/08/24', 'DOB 08/24/1988', 'DOB 24.08.1988', 'DOB 24-08-1988', 'DOB 19880824',
    'DOB 24 AUG 1988', 'DOB 24AUG1988', 'DOB 24-Aug-1988', 'DOB AUG 24, 1988', 'DOB August 24th 1988', 'DOB 1988 AUG 24', 'DOB 1988-AUG-24', 'Né le 24 août 1988']) {
    assert.deepEqual(parse(text), august24, text);
    assert.deepEqual(parse(text.replace(/^(?:DOB|Né le) /, ''), { selectedRegion: true }), august24, `selected ${text}`);
  }
  // A known order only settles dates that are real either way; it never forces an impossible one.
  assert.deepEqual(parse('DOB 24/08/1988', { dateOrder: 'MDY' }), august24);
  assert.deepEqual(parse('DOB 08/24/1988', { dateOrder: 'DMY' }), august24);
});

test('ambiguous day/month dates use the known order, else the later date, so age is never overstated', () => {
  assert.deepEqual(parse('DOB 01/02/2000', { dateOrder: 'MDY' }), { year: 2000, month: 1, day: 2 });
  assert.deepEqual(parse('DOB 01/02/2000', { dateOrder: 'DMY' }), { year: 2000, month: 2, day: 1 });
  assert.deepEqual(parse('DOB 01/02/2000'), { year: 2000, month: 2, day: 1 });
  assert.deepEqual(parse('DOB 01/02/2000', { dateOrder: 'YMD' }), { year: 2000, month: 2, day: 1 });
  assert.deepEqual(parse('DOB 2000/02/01', { dateOrder: 'YMD' }), { year: 2000, month: 2, day: 1 });
  // 10 Sep 2008 would be 18 on the test date, 9 Oct 2008 would not: an unknown order must not pass.
  assert.equal(meetsRequiredAge(parse('DOB 10/09/2008'), 18, now), false);
});

test('two-digit years and short compact numbers are never expanded into a century', () => {
  for (const text of ['DOB 01/02/00', 'DOB 010200', 'DOB 24AUG88', 'DOB 24 AUG 88', 'DOB 01022000']) assert.equal(parse(text, { dateOrder: 'MDY' }), null, text);
});

test('an unreadable DOB label falls back to the earliest printed date only when unambiguous', () => {
  const card = 'FLORIDA DRIVER LICENSE\nD123-456-78-901-0\n2.00s 08/24/1988 ssex M\n46xp 08/24/2030\nan iss 01/02/2020\nREPLACED. 03/04/2021';
  const unlabelled = (text, options = {}) => parseUnlabelledBirthDate(text, { now, dateOrder: 'MDY', ...options });
  assert.deepEqual(unlabelled(card), { year: 1988, month: 8, day: 24 });
  assert.deepEqual(unlabelled('D12-05-1950 08/24/1988 01/02/2020'), { year: 1988, month: 8, day: 24 }, 'a date-shaped run inside a number is ignored');
  assert.deepEqual(unlabelled('2.0on 08/24/1988-issEx M\n4aiss 01/02/2020'), { year: 1988, month: 8, day: 24 }, 'OCR may glue the next word onto the date');
  assert.deepEqual(unlabelled('12-05-1950-7 08/24/1988 01/02/2020'), { year: 1988, month: 8, day: 24 }, 'a date followed by more digits is a number');
  assert.deepEqual(unlabelled('eroos 08/24/1988-+ssEx M.\n4εх» 08/24/2030\n4a ss 01/02/2020\n«EP_ACED 03/04/202t'), { year: 1988, month: 8, day: 24 }, 'phone OCR glues stray marks after the date');
  assert.deepEqual(unlabelled('X12-05-1950 08/24/1988 01/02/2020'), { year: 1988, month: 8, day: 24 }, 'a date after a letter is part of a code');
  assert.equal(unlabelled('3 DOB ?? \n' + card), null, 'a recognised DOB label leaves the decision to the labelled rules');
  assert.equal(unlabelled('2.00s 08/24/1988 ssex M\n4b EXP 08/24/2030'), null, 'needs two past dates');
  assert.equal(unlabelled('ISS 08/24/1988\n01/02/2020'), null, 'earliest date labelled as another field');
  assert.equal(unlabelled('REPLACED 08/24/1988\n01/02/2020'), null);
  assert.equal(unlabelled('08/24/2015\n01/02/2020'), null, 'dates closer than ten years');
  assert.equal(unlabelled('01/01/1900\n01/02/2020'), null, 'implausible age');
  assert.equal(unlabelled('08/24/1988\n13/45/2020'), null, 'an impossible date-shaped field fails closed');
  assert.deepEqual(unlabelled('04/05/1991\n01/02/2020', { dateOrder: undefined }), { year: 1991, month: 5, day: 4 }, 'unknown order uses the later reading');
});

test('earliest-date fallback needs both full-image passes to have read the chosen date', async t => {
  const card = (dob) => ({ data: { text: `2.00s ${dob} ssex M\nan iss 01/02/2020\nREPLACED. 03/04/2021`, words: [] } });
  let attempts = 0;
  let fixture = browserFixture(t, { async recognize() { attempts++; return card('08/24/1988'); } });
  assert.deepEqual(await readDocument({ image: fixture.image, dateOrder: 'MDY' }), { birthDate: { year: 1988, month: 8, day: 24 }, source: 'earliest-date' });
  assert.equal(attempts, 2);
  attempts = 0;
  fixture = browserFixture(t, { async recognize() { return card(++attempts === 1 ? '08/24/1988' : '08/24/1986'); } });
  await assert.rejects(readDocument({ image: fixture.image, dateOrder: 'MDY' }), { code: 'DATE_UNREADABLE' });
  attempts = 0;
  fixture = browserFixture(t, { async recognize() { return ++attempts === 1 ? { data: { text: 'unreadable', words: [] } } : card('08/24/1988'); } });
  await assert.rejects(readDocument({ image: fixture.image, dateOrder: 'MDY' }), { code: 'DATE_UNREADABLE' });
  // One pass may choose the date when the other pass also printed it, even if that pass was too garbled to choose.
  const garbled = () => ({ data: { text: '2 0os 08/24/1988 issex\n4a ss 0l/02/2O2O', words: [] } });
  for (const order of [[card('08/24/1988'), garbled()], [garbled(), card('08/24/1988')]]) {
    attempts = 0;
    fixture = browserFixture(t, { async recognize() { return order[attempts++]; } });
    assert.deepEqual(await readDocument({ image: fixture.image, dateOrder: 'MDY' }), { birthDate: { year: 1988, month: 8, day: 24 }, source: 'earliest-date' });
  }
  attempts = 0;
  fixture = browserFixture(t, { async recognize() { return ++attempts === 1 ? card('08/24/1988') : { data: { text: '2 0os 08/24/1986 issex', words: [] } }; } });
  await assert.rejects(readDocument({ image: fixture.image, dateOrder: 'MDY' }), { code: 'DATE_UNREADABLE' }, 'the other pass must show the same date');
  fixture = browserFixture(t, { async recognize() { return card('08/24/1988'); } });
  await assert.rejects(readDocument({ image: fixture.image, dateOrder: 'MDY', crop: { x: 0, y: 0, width: 1, height: 1 } }), { code: 'DATE_UNREADABLE' }, 'never for a selected region');
});

test('calendar validation rejects rollover, future dates and invalid required ages', () => {
  for (const value of ['DOB 2025-02-29', 'DOB 2000-13-01', 'DOB 2000-00-01', 'DOB 2000-01-00', 'DOB 2026-09-20']) assert.equal(parse(value), null);
  assert.deepEqual(parse('DOB 2000-02-29'), { year: 2000, month: 2, day: 29 });
  assert.equal(isValidBirthDate({ year: 2000, month: 1, day: 1 }, new Date(NaN)), false);
  assert.throws(() => meetsRequiredAge({ year: 2000, month: 1, day: 1 }, NaN, now), RangeError);
  assert.throws(() => ageOnDate({ year: 2000, month: 2, day: 30 }, now), RangeError);
});

test('age gates change on the UTC birthday, with conservative leap-day treatment', () => {
  assert.equal(meetsRequiredAge({ year: 2008, month: 9, day: 19 }, 18, now), true);
  assert.equal(meetsRequiredAge({ year: 2008, month: 9, day: 20 }, 18, now), false);
  assert.equal(ageOnDate({ year: 2004, month: 2, day: 29 }, new Date('2022-02-28T23:59:59Z')), 17);
  assert.equal(ageOnDate({ year: 2004, month: 2, day: 29 }, new Date('2022-03-01T00:00:00Z')), 18);
});

test('normalized crops preserve intersections and map to native pixels', () => {
  assert.deepEqual(normalizeCrop({ x: -.2, y: .2, width: .5, height: 1 }), { x: 0, y: .2, width: .3, height: .8 });
  assert.deepEqual(cropToPixels({ x: .1, y: .2, width: .3, height: .4 }, 1920, 1080), { x: 192, y: 216, width: 576, height: 432 });
  assert.deepEqual(cropToPixels({ x: 0, y: 0, width: 1, height: 1 }, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
  for (const bad of [{ x: 1, y: 0, width: .1, height: .1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) assert.throws(() => normalizeCrop(bad), RangeError);
  assert.throws(() => cropToPixels({ x: 0, y: 0, width: 1, height: 1 }, 0, 200), RangeError);
});

function browserFixture(t, overrides = {}) {
  const canvases = [];
  const calls = [];
  const results = [];
  let created = 0;
  let progress;
  let terminated = 0;
  let recognized = 0;
  const worker = {
    async load() {},
    async recognize(image, onProgress) { progress = onProgress; recognized++; const result = { data: { text: 'DOB 2000-09-19' } }; results.push(result); return result; },
    terminate() { terminated++; }, ...overrides,
  };
  const fakeDocument = {
    createElement() {
      const canvas = { width: 0, height: 0, getContext() { return {
        drawImage(...args) { calls.push(args); },
        getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
        putImageData() {},
      }; } };
      canvases.push(canvas); return canvas;
    },
  };
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = {};
  globalThis.document = fakeDocument;
  globalThis.__ocrFixture = { create() { created++; return worker; } };
  t.after(() => { globalThis.window = oldWindow; globalThis.document = oldDocument; delete globalThis.__ocrFixture; });
  return { image: { width: 100, height: 60 }, worker, canvases, calls, results, get created() { return created; }, get progress() { return progress; }, get terminated() { return terminated; }, get recognized() { return recognized; } };
}

test('reader uses local assets, returns only DOB, wipes temporary canvases and terminates', async t => {
  const fixture = browserFixture(t);
  const progress = [];
  assert.deepEqual(await readDocument({ image: fixture.image, onProgress: (...event) => progress.push(event) }), { birthDate: { year: 2000, month: 9, day: 19 }, source: 'label' });
  assert.equal(fixture.terminated, 1);
  assert.equal(fixture.recognized, 1);
  assert.equal(fixture.results[0].data.text, '');
  assert.ok(fixture.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal(fixture.created, 1);
  assert.ok(!JSON.stringify(progress).includes('2000'));
  const count = progress.length;
  fixture.progress(.9);
  assert.equal(progress.length, count, 'late progress is ignored');
});

test('two bounded attempts keep the selected native crop stable and then request recovery', async t => {
  let attempts = 0;
  const fixture = browserFixture(t, { async recognize() { attempts++; return { data: { text: 'unreadable' } }; } });
  await assert.rejects(readDocument({ image: fixture.image, crop: { x: .1, y: .2, width: .5, height: .5 } }), { code: 'DATE_UNREADABLE' });
  assert.equal(attempts, 2);
  assert.equal(fixture.terminated, 1);
  assert.equal(fixture.calls.length, 2);
  for (const args of fixture.calls) assert.deepEqual(args.slice(1, 5), [10, 12, 50, 30]);
  assert.ok(fixture.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('human-selected region accepts one date with or without its label', async t => {
  const fixture = browserFixture(t, { async recognize() { return { data: { text: '19 SEPTEMBRE 2000' } }; } });
  assert.deepEqual(await readDocument({ image: fixture.image, language: 'fra', crop: { x: 0, y: 0, width: .5, height: .5 } }), { birthDate: { year: 2000, month: 9, day: 19 }, source: 'selected-region' });
  fixture.worker.recognize = async () => ({data:{text:'DATE DE NAISSANCE 19 SEPTEMBRE 2000'}});
  assert.deepEqual(await readDocument({ image: fixture.image, language: 'fra', crop: { x: 0, y: 0, width: .5, height: .5 } }), { birthDate: { year: 2000, month: 9, day: 19 }, source: 'selected-region' });
});

test('full-image OCR reads a checked MRZ and returns no name/document-number fields', async t => {
  const fixture = browserFixture(t, { async recognize() { return { data: { text: td3.join('\n') } }; } });
  assert.deepEqual(await readDocument({ image: fixture.image }), { birthDate: { year: 1974, month: 8, day: 12 }, source: 'mrz' });
  assert.equal(fixture.terminated, 1);
});

test('full-image OCR rejects conflicting printed DOB/MRZ and selected crops never interpret MRZ', async t => {
  const fixture = browserFixture(t, { async recognize() { return { data: { text: 'DOB 2000-01-01\n' + td3.join('\n') } }; } });
  await assert.rejects(readDocument({ image: fixture.image }), { code: 'DATE_UNREADABLE' });
  fixture.worker.recognize = async () => ({ data: { text: 'DOB 2000-01-01\nDOB 1974-08-12\n' + td3.join('\n') } });
  await assert.rejects(readDocument({ image: fixture.image }), { code: 'DATE_UNREADABLE' });
  fixture.worker.recognize = async () => ({ data: { text: td3.join('\n') } });
  await assert.rejects(readDocument({ image: fixture.image, crop: { x: 0, y: 0, width: 1, height: 1 } }), { code: 'DATE_UNREADABLE' });
});

test('reader failures produce fixed messages with no exception data', async t => {
  const fixture = browserFixture(t, { async load() { throw new Error('private OCR text 2000-01-01'); } });
  await assert.rejects(readDocument({ image: fixture.image }), error => error.code === 'OCR_FAILED' && !error.message.includes('2000'));
  assert.equal(fixture.terminated, 1);
});

test('abort terminates stalled recognition and late OCR cannot complete the flow', async t => {
  const controller = new AbortController();
  let finish;
  const fixture = browserFixture(t, { recognize() { queueMicrotask(() => controller.abort()); return new Promise(resolve => { finish = resolve; }); } });
  await assert.rejects(readDocument({ image: fixture.image, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fixture.terminated, 1);
  assert.ok(fixture.canvases.every(canvas => canvas.width === 0));
  finish({ data: { text: 'DOB 2000-01-01' } });
  await Promise.resolve();
  assert.equal(fixture.terminated, 1);
});

test('reader timeout terminates a stalled reader rather than waiting forever', async t => {
  const fixture = browserFixture(t, { load() { return new Promise(() => {}); } });
  const previous = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => { assert.equal(delay, OCR_TIMEOUT_MS); queueMicrotask(callback); return 0; };
  t.after(() => { globalThis.setTimeout = previous; });
  await assert.rejects(readDocument({ image: fixture.image }), { code: 'TIMEOUT' });
  assert.equal(fixture.terminated, 1);
});

test('pre-cancelled input starts no reader, and invalid crops do not start OCR', async t => {
  const fixture = browserFixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readDocument({ image: fixture.image, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(readDocument({ image: fixture.image, crop: { x: 2, y: 0, width: 1, height: 1 } }), { code: 'INVALID_IMAGE' });
  assert.equal(fixture.created, 0);
});

const layoutWords = () => [
  { text: 'DOB', confidence: 95, bbox: { x0: 80, y0: 80, x1: 160, y1: 110 } },
  { text: '08/24/1988', confidence: 90, bbox: { x0: 80, y0: 130, x1: 290, y1: 160 } },
  { text: 'ISS', confidence: 95, bbox: { x0: 600, y0: 80, x1: 650, y1: 110 } },
  { text: '01/02/2020', confidence: 95, bbox: { x0: 600, y0: 130, x1: 810, y1: 160 } },
];

test('automatic second attempt locates DOB by geometry and rereads original pixels with its label', async t => {
  let attempts = 0;
  const outputs = [];
  const fixture = browserFixture(t, { async recognize() {
    const result = ++attempts === 1
      ? { data: { text: 'DOB ISS\n08/24/1988 01/02/2020', words: layoutWords(), hocr: 'private OCR layout' } }
      : { data: { text: 'DOB\n08/24/1988', words: [] } };
    outputs.push(result); return result;
  } });
  fixture.image.width = 1000; fixture.image.height = 600;
  assert.deepEqual(await readDocument({ image: fixture.image, dateOrder: 'MDY' }), { birthDate: { year: 1988, month: 8, day: 24 }, source: 'label' });
  assert.equal(attempts, 2);
  const focused = fixture.calls[1];
  assert.equal(focused[0], fixture.image, 'Crop rereads original pixels, not an upscaled OCR canvas');
  assert.ok(focused[1] <= 80 && focused[2] <= 80, 'DOB label retained');
  assert.ok(focused[1] + focused[3] >= 290 && focused[2] + focused[4] >= 160, 'DOB value retained');
  assert.ok(focused[1] + focused[3] < 600, 'Issue-date column excluded');
  assert.ok(outputs.every(result => result.data.text === '' && !result.data.words && !result.data.hocr));
});

test('automatic focused crop cannot accept an unlabelled date or contradictory second reading', async t => {
  let attempts = 0;
  let secondText = '08/24/1988';
  const fixture = browserFixture(t, { async recognize() {
    return ++attempts % 2 === 1
      ? { data: { text: 'DOB 08/24/1988', words: layoutWords() } }
      : { data: { text: secondText } };
  } });
  fixture.image.width = 1000; fixture.image.height = 600;
  await assert.rejects(readDocument({ image: fixture.image, dateOrder: 'MDY' }), { code: 'DATE_UNREADABLE' });
  assert.equal(attempts, 2);
  secondText = 'DOB 08/24/1989';
  await assert.rejects(readDocument({ image: fixture.image, dateOrder: 'MDY' }), { code: 'DATE_UNREADABLE' });
  assert.equal(attempts, 4);
});

test('unlocated automatic images stop after two OCR calls and never choose an arbitrary date', async t => {
  let attempts = 0;
  const fixture = browserFixture(t, { async recognize() { attempts++; return { data: { text: '08/24/1988', words: [] } }; } });
  await assert.rejects(readDocument({ image: fixture.image }), { code: 'DATE_UNREADABLE' });
  assert.equal(attempts, 2);
});

test('invalid MRZ cannot disappear on the second pass and be replaced by a printed date', async t => {
  let attempts = 0;
  const fixture = browserFixture(t, { async recognize() {
    return { data: { text: ++attempts === 1 ? td3[0] + '\n' + mutate(td3[1], 43, '0') : 'DOB 1974-08-12' } };
  } });
  await assert.rejects(readDocument({ image: fixture.image }), { code: 'DATE_UNREADABLE' });
  assert.equal(attempts, 2);
});

test('numbered printed DOB labels remain distinct from numbered issue and expiry labels', () => {
  assert.deepEqual(parse('3DOB 08/24/1988\n4aISS 01/02/2020\n4bEXP 08/24/2030', { dateOrder: 'MDY' }), { year: 1988, month: 8, day: 24 });
  assert.equal(parse('3DOB\n4aISS 08/24/1988', { dateOrder: 'MDY' }), null);
  assert.equal(parse('SOMEDOB 08/24/1988', { dateOrder: 'MDY' }), null);
});

test('DOB first becoming legible on the second full-image attempt completes without a third call', async t => {
  let attempts = 0;
  const fixture = browserFixture(t, { async recognize(image) {
    attempts++;
    return attempts === 1 ? { data: { text: 'unreadable', words: [] } }
      : { data: { text: 'DOB ISS\n08/24/1988 01/02/2020', words: layoutWords().map(word => ({...word, bbox: Object.fromEntries(Object.entries(word.bbox).map(([key,value]) => [key, value * image.width / 1000])) })) } };
  } });
  fixture.image.width = 1000; fixture.image.height = 600;
  assert.deepEqual(await readDocument({image: fixture.image, dateOrder: 'MDY'}), { birthDate: {year:1988,month:8,day:24}, source:'label' });
  assert.equal(attempts, 2);
  assert.deepEqual(fixture.calls[1].slice(1,5), [0,0,1000,600]);
});

test('recognized DOB label can trigger focused rereading before its date digits are legible', async t => {
  let attempts = 0;
  const fixture = browserFixture(t, { async recognize() {
    return ++attempts === 1 ? { data: { text: 'DOB\nunclear', words: [
      {text:'DOB',bbox:{x0:100,y0:100,x1:155,y1:125}},
      {text:'unclear',bbox:{x0:170,y0:100,x1:310,y1:125}},
      {text:'ISS',bbox:{x0:600,y0:100,x1:645,y1:125}},
      {text:'01/02/2020',bbox:{x0:650,y0:100,x1:800,y1:125}},
    ] } } : { data: { text: 'DOB 08/24/1988' } };
  } });
  fixture.image.width = 1000; fixture.image.height = 600;
  const result = await readDocument({ image:fixture.image,dateOrder:'MDY' });
  assert.deepEqual(result, {birthDate:{year:1988,month:8,day:24},source:'label'});
  assert.equal(attempts, 2);
  assert.ok(fixture.calls[1][3] < 1000);
  assert.ok(fixture.calls[1][1] + fixture.calls[1][3] < 600);
});


test('manually cropped invoice and expiry dates never complete document verification', async t => {
  const fixture = browserFixture(t);
  for (const text of ['INVOICE DATE 08/24/1988', 'ISS 08/24/1988', 'EXP 08/24/1988']) {
    fixture.worker.recognize = async () => ({data:{text}});
    await assert.rejects(readDocument({image:fixture.image,dateOrder:'MDY',crop:{x:0,y:0,width:1,height:1}}),{code:'DATE_UNREADABLE'});
  }
});


test('manual crop rejects multiple dates even when a DOB label could identify one', async t => {
  const fixture = browserFixture(t);
  for (const text of ['DOB 08/24/1988 EXP 08/24/2030', 'DOB 08/24/1988 01/02/2020', '08/24/1988 01/02/2020']) {
    fixture.worker.recognize = async () => ({data:{text}});
    await assert.rejects(readDocument({image:fixture.image,dateOrder:'MDY',crop:{x:0,y:0,width:1,height:1}}),{code:'DATE_UNREADABLE'});
  }
});

test('manual field selection does not depend on English/French DOB label spelling', () => {
  for (const label of ['', 'D0B', 'Geburtsdatum', 'Fecha de nacimiento', '3']) {
    // Synthetic ISO-order date, not a real document or a claim of OCR language coverage.
    assert.deepEqual(parse(`${label} 1988-08-24`,{dateOrder:'YMD',selectedRegion:true}),{year:1988,month:8,day:24});
  }
  assert.deepEqual(parse('01/02/1988',{selectedRegion:true}),{year:1988,month:2,day:1},'unknown order takes the later reading');
});
