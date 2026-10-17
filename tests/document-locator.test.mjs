import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/verification/document-locator.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const { locateBirthDateRegion: locate } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const word = (text, x, y, width = text.length * 10, h = 20) => ({ text, confidence: 85, bbox: { x0: x, y0: y, x1: x + width, y1: y + h } });
const contains = (crop, x, y) => crop.x * 1000 <= x && (crop.x + crop.width) * 1000 >= x && crop.y * 600 <= y && (crop.y + crop.height) * 600 >= y;

test('locates DOB to the right independently of OCR word order and neighboring columns', () => {
  const words = [word('EXP', 550, 100), word('08/24/2030', 610, 100), word('08/24/1988', 170, 100), word('DOB', 100, 100)];
  const result = locate(words, 1000, 600, 'MDY');
  assert.ok(result);
  assert.ok(contains(result.crop, 100, 100));
  assert.ok(contains(result.crop, 270, 120));
  assert.equal(contains(result.crop, 550, 100), false);
});

test('assembles a split English label and date underneath it', () => {
  const words = [word('birth', 205, 100), word('Date', 100, 100), word('of', 160, 101), word('24', 100, 140), word('Aug', 132, 140), word('1988', 180, 140)];
  const result = locate(words, 1000, 600);
  assert.ok(result);
  assert.ok(contains(result.crop, 100, 100));
  assert.ok(contains(result.crop, 220, 160));
});

test('assembles French labels and allows a damaged numeric field for rereading', () => {
  const words = [word('Date', 100, 100), word('de', 150, 100), word('naissance', 185, 100), word('O8/24/1988', 100, 135)];
  assert.ok(locate(words, 1000, 600, 'MDY'));
  assert.ok(locate([word('D.', 100, 100), word('O.', 130, 100), word('B.', 160, 100), word('24/08/1988', 220, 100)], 1000, 600, 'DMY'));
});

test('refuses competing issue or expiration fields near an unreadable birth date', () => {
  assert.equal(locate([word('DOB', 100, 100), word('EXP', 170, 100), word('08/24/2030', 220, 100)], 1000, 600, 'MDY'), null);
  assert.equal(locate([word('DOB', 100, 100), word('ISS', 100, 140), word('08/24/2000', 160, 140)], 1000, 600, 'MDY'), null);
});

test('refuses multiple DOB regions and multiple adjacent candidate dates', () => {
  assert.equal(locate([word('DOB', 100, 100), word('08/24/1988', 170, 100), word('DOB', 100, 300), word('08/24/1988', 170, 300)], 1000, 600, 'MDY'), null);
  assert.equal(locate([word('DOB', 100, 100), word('08/24/1988', 170, 100), word('08/24/1990', 100, 140)], 1000, 600, 'MDY'), null);
});

test('refuses unrelated text inside the proposed DOB region', () => {
  assert.equal(locate([word('DOB', 100, 100), word('OTHER', 155, 100), word('08/24/1988', 225, 100)], 1000, 600, 'MDY'), null);
});

test('does not join distant words into a label or associate a remote date', () => {
  assert.equal(locate([word('Date', 100, 100), word('of', 500, 100), word('birth', 550, 100), word('08/24/1988', 650, 100)], 1000, 600, 'MDY'), null);
  assert.equal(locate([word('DOB', 100, 100), word('08/24/1988', 170, 350)], 1000, 600, 'MDY'), null);
});

test('validates geometry and bounds processing before examining OCR output', () => {
  const good = [word('DOB', 0, 0), word('08/24/1988', 60, 0)];
  const crop = locate(good, 1000, 600, 'MDY').crop;
  assert.equal(crop.x, 0);
  assert.equal(crop.y, 0);
  for (const bbox of [{ x0: NaN, y0: 0, x1: 90, y1: 20 }, { x0: -1, y0: 0, x1: 90, y1: 20 }, { x0: 60, y0: 0, x1: 60, y1: 20 }, { x0: 60, y0: 0, x1: 1001, y1: 20 }]) {
    assert.equal(locate([good[0], { ...good[1], bbox }], 1000, 600, 'MDY'), null);
  }
  assert.equal(locate(good, 0, 600), null);
  assert.equal(locate(null, 1000, 600), null);
  assert.equal(locate(Array.from({ length: 1501 }, () => good[0]), 1000, 600), null);
});


test('includes separate and joined field numbers in the DOB region', () => {
  for (const label of [[word('3', 88, 100), word('DOB', 100, 100)], [word('3DOB', 88, 100)], [word('3.DOB', 88, 100)]]) {
    const result = locate([...label, word('08/24/1988', 170, 100)], 1000, 600, 'MDY');
    assert.ok(result);
    assert.equal(result.provisional, undefined);
    assert.ok(contains(result.crop, 88, 100));
    assert.ok(contains(result.crop, 270, 120));
  }
});

test('numbered issue and expiration labels still prevent false DOB crops', () => {
  for (const label of [[word('4', 158, 100), word('ISS', 170, 100)], [word('4aISS', 158, 100)], [word('4b.EXP', 158, 100)]]) {
    assert.equal(locate([word('3DOB', 80, 100), ...label, word('08/24/2000', 240, 100)], 1000, 600, 'MDY'), null);
  }
});

test('locates a colon-joined DOB and date without guessing internal word bounds', () => {
  const result = locate([word('3DOB:08/24/1988', 100, 100), word('4bEXP:08/24/2030', 500, 100)], 1000, 600, 'MDY');
  assert.ok(result);
  assert.equal(result.provisional, undefined);
  assert.ok(contains(result.crop, 100, 100));
  assert.ok(contains(result.crop, 240, 120));
  assert.equal(contains(result.crop, 500, 100), false);
  assert.equal(locate([word('DOB', 100, 100), word('4aISS:08/24/2000', 170, 100)], 1000, 600, 'MDY'), null);
});

test('does not find DOB labels inside arbitrary words or joined trailing content', () => {
  for (const label of ['ADOBE', '3ADOB', 'DOBBY', 'DOB:08/24/1988X', 'ADOB:08/24/1988']) {
    assert.equal(locate([word(label, 100, 100), word('08/24/1988', 350, 100)], 1000, 600, 'MDY'), null);
  }
});

test('proposes a bounded label region when small date glyphs were not recognized', () => {
  const result = locate([word('3', 88, 100), word('DOB', 100, 100), word('??/??/19??', 170, 100)], 1000, 600, 'MDY');
  assert.equal(result.provisional, true);
  assert.ok(contains(result.crop, 88, 100));
  assert.ok(contains(result.crop, 260, 120));
  assert.equal(contains(result.crop, 800, 100), false);
});

test('provisional crop stops before neighboring issue/expiry labels and their values', () => {
  const result = locate([
    word('DOB', 100, 100), word('??/??/19??', 160, 100),
    word('4bEXP', 300, 100), word('??/??/20??', 360, 100),
    word('4aISS', 100, 150), word('??/??/20??', 160, 150),
  ], 1000, 600, 'MDY');
  assert.equal(result.provisional, true);
  assert.ok(contains(result.crop, 250, 120));
  for (const [x, y] of [[300, 100], [360, 100], [100, 150], [160, 150]]) assert.equal(contains(result.crop, x, y), false);
});

test('never uses provisional fallback for competing or ambiguous recognized dates', () => {
  assert.equal(locate([word('DOB', 100, 100), word('4aISS', 170, 100), word('08/24/2000', 240, 100)], 1000, 600, 'MDY'), null);
  assert.equal(locate([word('DOB', 100, 100), word('08/24/1988', 170, 100), word('08/24/1990', 100, 140)], 1000, 600, 'MDY'), null);
  assert.equal(locate([word('DOB', 100, 100), word('DOB', 100, 300)], 1000, 600, 'MDY'), null);
});

test('does not propose a speculative crop for a DOB label without visible value text', () => {
  assert.equal(locate([word('DOB', 100, 100)], 1000, 600, 'MDY'), null);
});
