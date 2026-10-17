import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/verification/document-quality.ts'], bundle: true, write: false, format: 'esm', target: 'es2022' });
const { assessDocumentPixels, inspectDocumentQuality } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const width = 360, height = 220;
function pixels(draw) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = draw(x, y);
    data[offset + 3] = 255;
  }
  return data;
}
const text = (x, y) => y % 30 > 14 && y % 30 < 21 && x % 11 < 6 && x > 25 && x < 320 ? 35 : 252;
const assess = (data, originalWidth = 1440, originalHeight = 880) => assessDocumentPixels(data, width, height, originalWidth, originalHeight);

test('sharp dark text on bright paper gets no false glare or blur warning', () => {
  assert.deepEqual(assess(pixels(text)).issues, []);
});
test('soft gradient with no text edges advises focus without asserting unreadability', () => {
  assert.deepEqual(assess(pixels((x) => 50 + 140 * x / width)).issues, ['detail']);
});
test('almost entirely clipped white image advises reducing reflections', () => {
  assert.deepEqual(assess(pixels(() => 255)).issues, ['highlights']);
});
test('low resolution is independent from sharpness and respects portrait orientation', () => {
  assert.deepEqual(assess(pixels(text), 600, 350).issues, ['resolution']);
  assert.deepEqual(assess(pixels(text), 880, 1440).issues, []);
});
test('unavailable/transparent pixels do not manufacture quality warnings', () => {
  assert.deepEqual(assess(new Uint8ClampedArray(width * height * 4)).issues, []);
});
test('temporary canvas and pixel sample are cleared after inspection', () => {
  const samplePixels = pixels(text);
  const sample = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: samplePixels }) }) };
  globalThis.document = { createElement: () => sample };
  try {
    inspectDocumentQuality({ width: 720, height: 440 });
    assert.equal(sample.width, 0); assert.equal(sample.height, 0);
    assert.ok(samplePixels.every(value => value === 0));
  } finally { delete globalThis.document; }
});
