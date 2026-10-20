import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

// Run the production page entry, UI, document worker orchestration, date parser,
// age policy and result transport. Only hardware/inference/continuation are replaced.
// The OCR reader returns synthetic text; these are journey tests, not optical-accuracy tests.
const replacements = {
  camera: `
    const fixture = window.__flowFixture;
    function image() { const canvas=document.createElement('canvas'); canvas.width=800; canvas.height=500; fixture.images.push(canvas); return canvas; }
    export class Camera {
      constructor() { this.video=document.createElement('video'); }
      async start(facing) { fixture.cameras.push(facing); if(fixture.denyCamera) throw new Error('Synthetic camera denied'); }
      async switch() { fixture.switches++; }
      capture() { fixture.captures++; return image(); }
      stop() { fixture.stops++; }
    }
    export function disposeImage(canvas) { if(canvas) canvas.width=canvas.height=0; }
    export async function readImage() { fixture.uploads++; return image(); }
  `,
  face: `
    export async function loadFaceModels() { window.__flowFixture.modelLoads++; }
    export async function inspectFaces() { window.__flowFixture.faceInspections++; throw new Error('Document path must not inspect faces'); }
    export async function matchDocumentFace() { window.__flowFixture.faceInspections++; throw new Error('Document path must not compare portraits'); }
  `,
  ocr: `
    export function straighten() { return null; }
    export function createOCRReader() {
      const fixture = window.__flowFixture;
      return {
        async load() { fixture.readerLoads++; },
        async recognize(image) { fixture.recognizedImages.push(image); const text = fixture.text; return { data: { text: Array.isArray(text) ? text[Math.min(fixture.recognizedImages.length - 1, text.length - 1)] : text } }; },
        terminate() { fixture.terminated++; },
      };
    }
  `,
  selfie: `
    export async function collectSelfie() { const f=window.__flowFixture; f.selfies++; return { estimate:f.estimate }; }
  `,
  continuation: `
    export class Continuation {
      async recoverDesktop() { return false; }
      async startDesktop() { throw new Error('Not part of this document-flow fixture'); }
      async startPhone() { throw new Error('Not part of this document-flow fixture'); }
      async finishPhone() { throw new Error('Not part of this document-flow fixture'); }
      stop() {}
    }
  `,
};
const bundle = await build({
  entryPoints: ['web/verification/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'synthetic-document-hardware', setup(builder) {
    builder.onResolve({ filter: /^\.\/(camera|face|selfie|continuation|ocr)$/ }, args => ({ path: args.path.slice(2), namespace: 'flow-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'flow-fixture' }, args => ({ contents: replacements[args.path], loader: 'js' }));
  } }],
});

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false; this._text = '';
    this.style = { setProperty() {}, removeProperty() {} };
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, force) { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() {}
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) ?? []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  dispatch(name) { for (const callback of this.listeners.get(name) ?? []) callback({ target: this, type: name }); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(child => selector.split(',').some(tag => child.tagName.toLowerCase() === tag.trim())); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getContext() {
    return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4).fill(this.qualityWhite ? 255 : 0) }), putImageData() {} };
  }
}

async function fixture(t, { methods = ['document'], text = '3 DOB 08/24/1988\n4a ISS 01/02/2020\n4b EXP 08/24/2030', estimate = 24, denyCamera = false, initialMethod, qualityWhite = false } = {}) {
  const state = { modelLoads: 0, faceInspections: 0, selfies: 0, captures: 0, uploads: 0, switches: 0, stops: 0, terminated: 0,
    estimate, denyCamera, qualityWhite, cameras: [], images: [], submissions: [], navigations: [], readerLoads: 0, text, recognizedImages: [] };
  const root = new Element('main');
  const config = new Element('script');
  config.textContent = JSON.stringify({ mode: 'desktop', sessionId: 'synthetic-session', capability: 'synthetic-capability', requiredAge: 18, siteName: 'Fixture Merchant', methods, initialMethod });
  const body = new Element('body'); body.append(root);
  const document = { body, documentElement: new Element('html'), createElement: tag => { const node = new Element(tag); node.qualityWhite = state.qualityWhite; return node; }, querySelector: selector => selector === '#verification' ? root : selector === '#verification-config' ? config : null };
  const windowEvents = new Map();
  const window = {
    __flowFixture: state,
    location: { origin: 'https://trustbunny.example', assign: value => state.navigations.push(value) },
    addEventListener: (name, callback) => windowEvents.set(name, callback),
  };
  const context = vm.createContext({
    window, document, navigator: { mediaDevices: { enumerateDevices: async () => [] } },
    AbortController, DOMException, URL, setTimeout, clearTimeout, console,
    fetch: async (path, options) => {
      assert.ok(path === '/result/success' || path === '/result/fail', `Unexpected fixture request ${path}`);
      state.submissions.push({ path, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ content: { completionUrl: '/complete/synthetic-session?handoff=synthetic-handoff' } }) };
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  t.after(() => windowEvents.get('pagehide')?.());
  const find = (tag, label) => root.descendants().find(node => node.tagName === tag.toUpperCase() && node._text === label);
  async function settled() { await new Promise(resolve => setImmediate(resolve)); }
  async function until(predicate, message) {
    for (let attempt = 0; attempt < 20; attempt++) { if (predicate()) return; await settled(); }
    assert.fail(`${message}: ${root.textContent}`);
  }
  async function click(label) {
    await until(() => Boolean(find('button', label)), `Missing button ${label}`);
    const node = find('button', label); assert.equal(node.disabled, false, `${label} is disabled`);
    node.dispatch('click'); await settled();
  }
  async function select(label, value) {
    const container = find('label', label); assert.ok(container, `Missing selector ${label}`); assert.equal(container.hidden, false, `${label} is hidden`);
    const control = container.querySelector('select'); assert.ok(control.children.some(option => option.value === value), `${value} is not an option for ${label}`);
    control.value = value; control.dispatch('change'); await settled();
  }
  async function florida() {
    await select('Issuing country', 'US'); await select('Document type', 'driver-license');
    assert.equal(find('button', 'Continue to document scan').disabled, true, 'Issuing region is required');
    await select('Issuing state, province or territory', 'FL');
    assert.equal(find('label', 'Document language').querySelector('select').value, 'eng');
    assert.equal(find('label', 'Printed date order'), undefined, 'Visitors are never asked to choose a date format');
    await click('Continue to document scan');
  }
  await settled();
  return { state, root, click, select, florida, until, find, settled };
}

test('document-only Florida journey reads a non-face fixture and completes without any selfie or face model', async t => {
  const app = await fixture(t);
  await app.click('Document ID'); await app.florida(); await app.click('Capture document');
  await app.until(() => app.state.navigations.length === 1, 'Document result did not complete');
  assert.deepEqual(app.state.cameras, ['environment']);
  assert.equal(app.state.modelLoads, 0); assert.equal(app.state.faceInspections, 0); assert.equal(app.state.selfies, 0);
  assert.equal(app.state.captures, 1); assert.equal(app.state.terminated, 1);
  assert.equal(app.state.readerLoads, 1);
  assert.deepEqual(app.state.submissions, [{ path: '/result/success', body: { token: 'synthetic-capability', sessionId: 'synthetic-session', stepId: 5 } }]);
  assert.ok(app.state.images.every(image => image.width === 0 && image.height === 0));
  assert.ok(app.state.recognizedImages.every(image => image.width === 0 && image.height === 0));
});

test('document-only underage DOB never submits success; finishing inconclusive uses the document result', async t => {
  const year = new Date().getUTCFullYear() - 10;
  const app = await fixture(t, { text: `3 DOB 08/24/${year}\n4a ISS 01/02/2020\n4b EXP 08/24/2030` });
  await app.click('Document ID'); await app.florida(); await app.click('Capture document');
  await app.until(() => Boolean(app.find('button', 'Finish without verification')), 'Underage document did not remain inconclusive');
  assert.equal(app.state.submissions.length, 0);
  assert.equal(app.state.modelLoads, 0); assert.equal(app.state.selfies, 0); assert.equal(app.state.faceInspections, 0);
  await app.click('Finish without verification');
  await app.until(() => app.state.submissions.length === 1, 'Inconclusive result was not submitted');
  assert.equal(app.state.submissions[0].path, '/result/fail'); assert.equal(app.state.submissions[0].body.stepId, 5);
});

test('hybrid estimate below25 moves to document without first persisting a selfie outcome', async t => {
  const app = await fixture(t, { methods: ['selfie', 'document'], estimate: 24 });
  await app.click('Live AI Age Check'); await app.click('I’m ready');
  await app.until(() => Boolean(app.find('label', 'Issuing country')), 'Hybrid flow did not open document setup');
  assert.equal(app.state.submissions.length, 0, 'A fallback is not a terminal selfie result');
  assert.equal(app.state.navigations.length, 0);
  assert.equal(app.state.modelLoads, 1); assert.equal(app.state.selfies, 1); assert.equal(app.state.faceInspections, 0);
  await app.florida(); await app.click('Capture document');
  await app.until(() => app.state.navigations.length === 1, 'Document fallback did not complete');
  assert.deepEqual(app.state.cameras, ['user', 'environment']);
  assert.equal(app.state.modelLoads, 1); assert.equal(app.state.selfies, 1); assert.equal(app.state.faceInspections, 0);
  assert.deepEqual(app.state.submissions, [{ path: '/result/success', body: { token: 'synthetic-capability', sessionId: 'synthetic-session', stepId: 5 } }]);
});

test('document image selection works after camera denial and still never invokes face processing', async t => {
  const app = await fixture(t, { denyCamera: true });
  await app.click('Document ID'); await app.florida();
  const upload = app.root.descendants().find(node => node.tagName === 'INPUT' && node.type === 'file');
  assert.ok(upload); upload.files = [{ name: 'synthetic-date.png', type: 'image/png' }]; upload.dispatch('change');
  await app.until(() => app.state.navigations.length === 1, 'Selected image did not complete');
  assert.equal(app.state.uploads, 1); assert.equal(app.state.captures, 0);
  assert.equal(app.state.modelLoads, 0); assert.equal(app.state.selfies, 0); assert.equal(app.state.faceInspections, 0);
  assert.equal(app.state.submissions[0].path, '/result/success'); assert.equal(app.state.submissions[0].body.stepId, 5);
});


test('identification opens two paths without starting a camera; Document ID skips the selfie', async t => {
  const app = await fixture(t, { methods: ['selfie', 'document'] });
  assert.ok(app.find('button', 'Live AI Age Check'));
  assert.ok(app.find('button', 'Document ID'));
  assert.deepEqual(app.state.cameras, []);
  await app.click('Document ID'); await app.florida(); await app.click('Capture document');
  await app.until(() => app.state.navigations.length === 1, 'Direct document did not complete');
  assert.equal(app.state.selfies, 0); assert.equal(app.state.modelLoads, 0);
  assert.equal(app.state.submissions[0].body.stepId, 5);
});

test('a selected Document ID link opens document setup without another chooser', async t => {
  const app = await fixture(t, { methods: ['selfie', 'document'], initialMethod: 'document' });
  assert.ok(app.find('label', 'Issuing country'));
  assert.equal(app.find('button', 'Live AI Age Check'), undefined);
  assert.deepEqual(app.state.cameras, []);
  assert.equal(app.state.selfies, 0);
});

test('a document-only policy ignores a disallowed selfie link', async t => {
  const app = await fixture(t, { initialMethod: 'selfie' });
  assert.ok(app.find('button', 'Document ID'));
  assert.equal(app.find('button', 'Live AI Age Check'), undefined);
  assert.deepEqual(app.state.cameras, []);
});

test('live estimate at25 completes as selfie without requesting a document', async t => {
  const app = await fixture(t, { methods: ['selfie', 'document'], estimate: 25, initialMethod: 'selfie' });
  await app.click('I’m ready');
  await app.until(() => app.state.submissions.length === 1, 'Live result did not complete');
  assert.equal(app.find('label', 'Issuing country'), undefined);
  assert.equal(app.state.submissions[0].path, '/result/success');
  assert.notEqual(app.state.submissions[0].body.stepId, 5);
  assert.equal(app.state.terminated, 0);
});

test('legacy selfie-only configuration soft-fails to document without submitting a failure', async t => {
  const app = await fixture(t, { methods: ['selfie'], estimate: 24.99, initialMethod: 'selfie' });
  await app.click('I’m ready');
  await app.until(() => Boolean(app.find('label', 'Issuing country')), 'Missing required document reinforcement');
  assert.equal(app.state.submissions.length, 0);
  assert.equal(app.state.navigations.length, 0);
  await app.florida(); await app.click('Capture document');
  await app.until(() => app.state.navigations.length === 1, 'Document reinforcement did not complete');
  assert.equal(app.state.submissions[0].path, '/result/success');
  assert.equal(app.state.submissions[0].body.stepId, 5);
});


test('poor capture quality offers an explicit bypass before OCR and never submits a failure', async t => {
  const app = await fixture(t, { qualityWhite: true });
  await app.click('Document ID'); await app.florida(); await app.click('Capture document');
  await app.until(() => Boolean(app.find('button', 'Use this image anyway')), 'Quality advice did not appear');
  assert.equal(app.state.recognizedImages.length, 0, 'OCR should wait for the visitor to choose');
  assert.equal(app.state.submissions.length, 0, 'Quality advice must not record a failed result');
  assert.match(app.root.textContent, /very bright/);
  await app.click('Use this image anyway');
  await app.until(() => app.state.navigations.length === 1, 'Quality warning bypass did not continue OCR');
  assert.equal(app.state.submissions[0].path, '/result/success');
  assert.ok(app.state.images.every(image => image.width === 0 && image.height === 0));
});

test('retaking a poor capture clears old pixels and allows a fresh capture', async t => {
  const app = await fixture(t, { qualityWhite: true });
  await app.click('Document ID'); await app.florida(); await app.click('Capture document');
  await app.until(() => Boolean(app.find('button', 'Retake or choose another image')), 'Quality retake did not appear');
  const previous = app.state.images[0];
  app.state.qualityWhite = false;
  await app.click('Retake or choose another image');
  assert.equal(previous.width, 0); assert.equal(previous.height, 0);
  assert.equal(app.state.submissions.length, 0);
  assert.equal(app.state.recognizedImages.length, 0);
  await app.click('Capture document');
  await app.until(() => app.state.navigations.length === 1, 'Retaken image did not complete');
  assert.equal(app.state.captures, 2);
  assert.deepEqual(app.state.cameras, ['environment', 'environment']);
});

test('leaving quality advice clears the captured image without starting OCR', async t => {
  const app = await fixture(t, { qualityWhite: true });
  await app.click('Document ID'); await app.florida(); await app.click('Capture document');
  await app.until(() => Boolean(app.find('button', 'Use this image anyway')), 'Quality advice did not appear');
  await app.click('Back to verification options');
  assert.ok(app.find('button', 'Document ID'));
  assert.equal(app.state.recognizedImages.length, 0);
  assert.equal(app.state.submissions.length, 0);
  assert.ok(app.state.images.every(image => image.width === 0 && image.height === 0));
});

test('unreadable document opens manual box selection after exactly two automatic OCR attempts', async t => {
  const app = await fixture(t, { text: 'unreadable document', initialMethod: 'document' });
  await app.florida(); await app.click('Capture document');
  await app.until(() => Boolean(app.find('button', 'Read selected area')), 'Manual box selection did not open');
  assert.equal(app.state.recognizedImages.length, 2);
  assert.equal(app.state.submissions.length, 0);
  assert.equal(app.state.navigations.length, 0);
  assert.ok(app.find('label', 'Left edge'));
  assert.ok(app.find('label', 'Selection width'));
  await app.settled();
  assert.equal(app.state.recognizedImages.length, 2, 'No hidden third OCR attempt while awaiting the visitor');
});


test('manual recovery needs explicit box selection and can read a date without its label', async t => {
  const app = await fixture(t, { text: ['unreadable', 'unreadable', '08/24/1988'], initialMethod: 'document' });
  await app.florida(); await app.click('Capture document');
  await app.until(() => Boolean(app.find('button', 'Read selected area')), 'Manual selection did not open');
  assert.equal(app.find('button', 'Read selected area').disabled, true);
  assert.equal(app.state.recognizedImages.length, 2);
  const left = app.find('label', 'Left edge').querySelector('input');
  left.value = '40'; left.dispatch('input'); await app.settled();
  assert.equal(app.find('button', 'Read selected area').disabled, false);
  await app.click('Read selected area');
  await app.until(() => app.state.navigations.length === 1, 'Date-only manual recovery did not complete');
  assert.equal(app.state.recognizedImages.length, 3, 'Two automatic calls plus one explicit human-selected read');
  assert.equal(app.state.submissions[0].path, '/result/success');
  assert.equal(app.state.submissions[0].body.stepId, 5);
});
