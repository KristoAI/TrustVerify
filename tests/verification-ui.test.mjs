import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const bundle = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const { safeCompletionUrl, request, REQUEST_TIMEOUT_MS } = await load('web/verification/ui.ts');
const { bounded } = await load('web/verification/async.ts');
const { faceDistance } = await load('web/verification/face.ts');
const { selfieThreshold, consistentSample, SELFIE_MATCH_LIMIT } = await load('web/verification/selfie.ts');

test('completion navigation accepts only this service completion handoff', () => {
  assert.equal(safeCompletionUrl('/complete/session-123?handoff=bound-token', 'https://trustbunny.example'), 'https://trustbunny.example/complete/session-123?handoff=bound-token');
  for (const url of ['https://evil.example/complete/session?handoff=token', '//evil.example/complete/session?handoff=token', 'javascript:alert(1)', '/complete/session', '/dashboard?handoff=token', '/complete/../dashboard?handoff=token']) {
    assert.throws(() => safeCompletionUrl(url, 'https://trustbunny.example'));
  }
});

test('selfie threshold and within-selfie consistency boundary remain explicit', () => {
  assert.equal(selfieThreshold(16), 25);
  assert.equal(selfieThreshold(18), 25);
  assert.equal(selfieThreshold(21), 25);
  assert.equal(selfieThreshold(30), 30);
  assert.equal(SELFIE_MATCH_LIMIT, .5);
  const face = { descriptor: new Float32Array([0, 0]), age: 30, happy: .1, score: .9 };
  assert.equal(consistentSample(face, { ...face, descriptor: new Float32Array([.49, 0]) }), true);
  assert.equal(consistentSample(face, { ...face, descriptor: new Float32Array([.5, 0]) }), false);
  assert.equal(consistentSample(face, { ...face, age: 43 }), false);
  assert.equal(consistentSample(face, { ...face, age: NaN }), false);
  assert.equal(consistentSample(face, { ...face, score: .49 }), false);
  assert.equal(faceDistance([], []), Infinity);
  assert.equal(faceDistance([0], [0, 0]), Infinity);
});

test('aborted uncancellable inference destroys its eventual result', async () => {
  const controller = new AbortController();
  let release;
  const descriptor = new Float32Array([1, 2, 3]);
  const pending = bounded(new Promise((resolve) => { release = resolve; }), controller.signal, 1000, (late) => late.fill(0));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release(descriptor);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...descriptor], [0, 0, 0]);
});

test('timeouts reject promptly and still clean up a late camera stream', async () => {
  let release;
  let stopped = false;
  const pending = bounded(new Promise((resolve) => { release = resolve; }), undefined, 5, (stream) => stream.stop());
  await assert.rejects(pending, /OPERATION_TIMEOUT/);
  release({ stop: () => { stopped = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
});

test('completed tasks remove their abort listener and are not late-cleaned', async () => {
  const controller = new AbortController();
  let cleanup = false;
  const value = await bounded(Promise.resolve(42), controller.signal, 1000, () => { cleanup = true; });
  controller.abort();
  assert.equal(value, 42);
  assert.equal(cleanup, false);
});

test('permission cancellation stops a stream that arrives after the UI has left', async () => {
  const oldDocument = globalThis.document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let release;
  let tracksStopped = 0;
  globalThis.document = { createElement: () => ({ setAttribute() {}, pause() {}, classList: { toggle() {} } }) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { release = resolve; }) } } });
  try {
    const { Camera } = await load('web/verification/camera.ts');
    const controller = new AbortController();
    const camera = new Camera();
    const pending = camera.start('user', controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    release({ getTracks: () => [{ stop: () => { tracksStopped += 1; } }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tracksStopped, 1);
  } finally {
    globalThis.document = oldDocument;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  }
});

test('selfie requires relaxed, smile, relaxed samples and clears inference descriptors', async () => {
  const oldWindow = globalThis.window;
  const samples = [.1, .1, .1, .9, .9, .9, .1, .1].map((happy) => ({ age: 32, expressions: { happy }, descriptor: new Float32Array([.1, .2]), detection: { score: .9 } }));
  const consumed = [];
  const net = { loadFromUri: async () => {} };
  globalThis.window = { faceapi: {
    tf: { ready: async () => {} },
    nets: { tinyFaceDetector: net, faceLandmark68Net: net, faceRecognitionNet: net, faceExpressionNet: net, ageGenderNet: net },
    TinyFaceDetectorOptions: class {},
    detectAllFaces() {
      const chain = { withFaceLandmarks: () => chain, withFaceDescriptors: () => chain, withFaceExpressions: () => chain,
        withAgeAndGender: () => { const sample = samples.shift(); consumed.push(sample); return Promise.resolve([sample]); } };
      return chain;
    },
  } };
  try {
    const { collectSelfie } = await load('web/verification/selfie.ts');
    const prompts = [];
    const result = await collectSelfie({ capture: () => ({ width: 100, height: 100 }) }, new AbortController().signal, (message) => prompts.push(message));
    assert.equal(samples.length, 0);
    assert.equal(result.estimate, 32);
    assert.equal(prompts.includes('Now give us a smile.'), true);
    assert.equal(prompts.includes('Relax your expression again.'), true);
    assert.ok(consumed.every((face) => [...face.descriptor].every((value) => value === 0)));
    assert.equal('descriptor' in result, false);
  } finally { globalThis.window = oldWindow; }
});


test('request deadline includes a response body that never arrives', async (context) => {
  const originalFetch = globalThis.fetch;
  let transportSignal;
  let readingBody = false;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async (_path, options) => {
    transportSignal = options.signal;
    return { ok: true, json: () => { readingBody = true; return new Promise(() => {}); } };
  };
  try {
    const pending = request('/status');
    await Promise.resolve();
    assert.equal(readingBody, true);
    context.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, /^Error: REQUEST_TIMEOUT$/);
    assert.equal(transportSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    context.mock.timers.reset();
  }
});

test('caller cancellation rejects and aborts a hung request transport', async () => {
  const originalFetch = globalThis.fetch;
  let transportSignal;
  globalThis.fetch = (_path, options) => { transportSignal = options.signal; return new Promise(() => {}); };
  try {
    const controller = new AbortController();
    const pending = request('/status', undefined, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(transportSignal.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('request errors never expose response parsing or transport details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('sensitive body value'); } });
  try { await assert.rejects(request('/status'), /^Error: REQUEST_FAILED$/); }
  finally { globalThis.fetch = originalFetch; }
});


test('a superseded camera cannot stop the current stream on late failure or abort', async () => {
  const oldDocument = globalThis.document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let rejectFirstPlay;
  let reachedFirstPlay;
  const playing = new Promise((resolve) => { reachedFirstPlay = resolve; });
  let plays = 0;
  let allocations = 0;
  const stopped = [];
  globalThis.document = { createElement: () => ({
    setAttribute() {}, pause() {}, classList: { toggle() {} }, videoWidth: 100, readyState: 2,
    play() {
      if (++plays === 1) { reachedFirstPlay(); return new Promise((_, reject) => { rejectFirstPlay = reject; }); }
      return Promise.resolve();
    },
  }) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: async () => { const id = ++allocations; return { getTracks: () => [{ stop: () => stopped.push(id) }] }; },
  } } });
  try {
    const { Camera } = await load('web/verification/camera.ts');
    const camera = new Camera();
    const oldController = new AbortController();
    const currentController = new AbortController();
    const oldStart = camera.start('user', oldController.signal);
    const rejected = assert.rejects(oldStart, /first camera failed/);
    await playing;
    await camera.start('environment', currentController.signal);
    rejectFirstPlay(new Error('first camera failed'));
    await rejected;
    oldController.abort();
    assert.deepEqual(stopped, [1]);
    currentController.abort();
    assert.deepEqual(stopped, [1, 2]);
  } finally {
    globalThis.document = oldDocument;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  }
});


const { verificationMethods, selfieOutcome } = await load('web/verification/flow.ts');

test('document-only policy never permits a selfie', () => {
  assert.deepEqual(verificationMethods(['document']), ['document']);
  assert.deepEqual(verificationMethods([]), []);
  assert.throws(() => selfieOutcome(['document'], 18, 30), /SELFIE_NOT_PERMITTED/);
});

test('Live AI uses document reinforcement below25 and respects higher required ages', () => {
  assert.deepEqual(verificationMethods(['selfie', 'document']), ['selfie', 'document']);
  assert.equal(selfieOutcome(['selfie', 'document'], 18, 24.99), 'document-backup');
  assert.equal(selfieOutcome(['selfie', 'document'], 18, 25), 'passed');
  assert.equal(selfieOutcome(['selfie', 'document'], 21, 25), 'passed');
  assert.equal(selfieOutcome(['selfie', 'document'], 30, 29.99), 'document-backup');
  assert.equal(selfieOutcome(['selfie', 'document'], 30, 30), 'passed');
});

test('legacy selfie policy includes document reinforcement and invalid estimates cannot pass', () => {
  assert.deepEqual(verificationMethods(['selfie']), ['selfie', 'document']);
  assert.equal(selfieOutcome(['selfie'], 18, 24.99), 'document-backup');
  assert.equal(selfieOutcome(['selfie'], 18, 25), 'passed');
  for (const estimate of [NaN, Infinity, -Infinity]) {
    assert.equal(selfieOutcome(['selfie'], 18, estimate), 'document-backup');
    assert.equal(selfieOutcome(['selfie', 'document'], 18, estimate), 'document-backup');
  }
});
