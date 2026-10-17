import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/verification/crop-review.ts'], bundle: true, write: false, format: 'iife', globalName: 'cropModule', platform: 'browser', target: 'es2022' });

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, values = {}) { this.listeners.get(name)?.({ button: 0, pointerId: 1, preventDefault() {}, ...values }); }
  setPointerCapture(id) { this.captured = id; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 1000, height: 500 }; }
}

function fixture() {
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) } });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const changes = [];
  const root = context.cropModule.cropReview(new Element('canvas'), (crop, edited) => changes.push({ crop: { ...crop }, edited }));
  const [preview, controls] = root.children;
  return { preview, controls, overlay: preview.children[1], changes };
}

test('manual crop starts without a suggested DOB box or an edited selection', () => {
  const { preview, overlay, changes } = fixture();
  assert.equal(overlay.hidden, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].edited, false);
  preview.dispatch('pointerdown', { clientX: 510, clientY: 270 });
  preview.dispatch('pointermove', { clientX: 511, clientY: 271 });
  preview.dispatch('pointerup');
  assert.equal(overlay.hidden, true, 'A click or small pointer jitter is not a defined box');
  assert.equal(changes.length, 1);
});

test('keyboard sliders explicitly define the selection and keep its dimensions inside the image', () => {
  const { controls, overlay, changes } = fixture();
  assert.deepEqual(controls.children.map(label => label.textContent), ['Left edge', 'Top edge', 'Selection width', 'Selection height']);
  const left = controls.children[0].children[0];
  left.value = '95'; left.dispatch('input');
  assert.equal(overlay.hidden, false);
  assert.equal(changes.at(-1).edited, true);
  assert.equal(changes.at(-1).crop.x, .95);
  assert.ok(Math.abs(changes.at(-1).crop.width - .05) < 1e-10);
  const width = controls.children[2].children[0];
  assert.equal(width.value, '5');
  assert.equal(width.attributes.get('aria-valuetext'), '5 percent');
  width.value = '90'; width.dispatch('input');
  assert.ok(changes.at(-1).crop.x + changes.at(-1).crop.width <= 1);
});

test('dragging in either direction creates the requested box and ignores another pointer', () => {
  const { preview, overlay, changes } = fixture();
  preview.dispatch('pointerdown', { clientX: 810, clientY: 420 });
  preview.dispatch('pointermove', { pointerId: 2, clientX: 10, clientY: 20 });
  assert.equal(changes.length, 1);
  preview.dispatch('pointermove', { clientX: 210, clientY: 120 });
  const crop = changes.at(-1).crop;
  assert.equal(crop.x, .2); assert.equal(crop.y, .2);
  assert.ok(Math.abs(crop.width - .6) < 1e-10); assert.ok(Math.abs(crop.height - .6) < 1e-10);
  assert.equal(changes.at(-1).edited, true); assert.equal(overlay.hidden, false);
  preview.dispatch('pointercancel');
  const count = changes.length;
  preview.dispatch('pointermove', { clientX: 400, clientY: 200 });
  assert.equal(changes.length, count, 'Cancelled gestures must stop changing the box');
});

test('pointer capture loss ends editing, and a new drag is bounded to the image', () => {
  const { preview, changes } = fixture();
  preview.dispatch('pointerdown', { clientX: 210, clientY: 120 });
  preview.dispatch('lostpointercapture');
  preview.dispatch('pointermove', { clientX: 810, clientY: 420 });
  assert.equal(changes.length, 1);
  preview.dispatch('pointerdown', { clientX: -100, clientY: -100 });
  preview.dispatch('pointermove', { clientX: 3000, clientY: 3000 });
  assert.deepEqual(changes.at(-1), { crop: { x: 0, y: 0, width: .99, height: .99 }, edited: true });
});
