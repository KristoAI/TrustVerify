import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/verification/email.ts'], bundle: true, write: false, format: 'iife', globalName: 'EmailUI', platform: 'browser', target: 'es2022' });
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this._text = ''; this.value = ''; this.disabled = false; this.checked = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute() {}
  focus() {}
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  dispatch(name) { for (const callback of this.listeners.get(name) || []) callback(); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function fixture(t, responder, override = {}) {
  const root = new Element('section'); const footer = new Element('footer'); footer.textContent = 'Original on-device privacy disclosure';
  const document = { createElement: tag => new Element(tag), querySelector: selector => selector === '#verification' ? root : selector === 'footer' ? footer : null };
  const calls = []; const timers = new Map(); let timerId = 0; let backCount = 0;
  const context = vm.createContext({ document, window: {}, AbortController, DOMException, URL, console,
    setTimeout(callback, milliseconds) { const id = ++timerId; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (path, options) => {
      const call = { path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
      calls.push(call);
      return { ok: true, json: async () => responder(call, calls.length) };
    },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const config = { emailExperiment: true, sessionId: 'session-123', capability: 'private-capability', methods: ['selfie', 'document'], requiredAge: 18, siteName: 'Example', ...override };
  const controller = new AbortController();
  context.EmailUI.launchEmail(config, () => { backCount++; controller.abort(); root.textContent = 'Age verification options'; }, controller.signal);
  t.after(() => controller.abort());
  const find = (tag, label) => root.descendants().find(node => node.tagName === tag.toUpperCase() && (label === undefined || node._text === label));
  const input = type => root.descendants().find(node => node.tagName === 'INPUT' && node.type === type);
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  async function click(label) { const button = find('button', label); assert.ok(button, `Missing ${label}: ${root.textContent}`); assert.equal(button.disabled, false); button.dispatch('click'); await settle(); }
  function fillEmail(consent = true) { input('email').value = 'visitor@example.org'; input('email').dispatch('input'); input('checkbox').checked = consent; input('checkbox').dispatch('change'); }
  async function tickPolling() { const scheduled = [...timers.entries()].filter(([, timer]) => timer.milliseconds === 2000); for (const [id, timer] of scheduled) { timers.delete(id); timer.callback(); } await settle(); }
  return { root, footer, calls, controller, find, input, settle, click, fillEmail, tickPolling, backCount: () => backCount, context, config };
}

test('email experiment is gated and never available on the phone flow', t => {
  for (const override of [{ emailExperiment: false }, { emailExperiment: undefined }, { mode: 'phone' }]) {
    const app = fixture(t, () => { throw new Error('Must not fetch'); }, override);
    assert.equal(app.root.textContent, ''); assert.equal(app.calls.length, 0);
    assert.equal(app.footer.textContent, 'Original on-device privacy disclosure');
  }
});

test('explicit consent precedes lookup; sending a code is separately requested; verified is not an age result', async t => {
  const app = fixture(t, call => ({ id: 'check-1', status: call.path.endsWith('/send') ? 'sent' : call.path.endsWith('/verify') ? 'verified' : 'eligible' }));
  assert.match(app.footer.textContent, /XposedOrNot/);
  app.fillEmail(false);
  assert.equal(app.find('button', 'Check email history').disabled, true);
  app.find('button', 'Check email history').dispatch('click'); await app.settle();
  assert.equal(app.calls.length, 0);
  app.fillEmail(); await app.click('Check email history');
  assert.deepEqual(app.calls[0].body, { capability: 'private-capability', email: 'visitor@example.org', consent: true });
  assert.equal(app.calls.length, 1, 'Eligibility must not automatically send email');
  await app.click('Send me a verification code');
  assert.deepEqual(app.calls[1].body, { capability: 'private-capability' });
  const code = app.input('text'); code.value = '123456'; code.dispatch('input');
  await app.click('Confirm inbox access');
  assert.match(app.root.textContent, /does not confirm your age/);
  assert.match(app.root.textContent, /Email history and inbox access checked/);
  assert.equal(app.calls.some(call => call.path.startsWith('/result/')), false);
  assert.equal(code.value, '', 'Verification clears the code input');
  await app.click('Back to age verification');
  assert.equal(app.footer.textContent, 'Original on-device privacy disclosure');
  assert.equal(app.backCount(), 1);
});

test('queued lookup polls status after two seconds and does not send without a click', async t => {
  const app = fixture(t, call => ({ id: 'check-1', status: call.method === 'GET' ? 'eligible' : 'queued' }));
  app.fillEmail(); await app.click('Check email history');
  assert.equal(app.calls.length, 1);
  await app.tickPolling();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].path, '/api/verification/session-123/email/check-1?capability=private-capability');
  assert.ok(app.find('button', 'Send me a verification code'));
  assert.equal(app.calls.filter(call => call.path.endsWith('/send')).length, 0);
  await app.click('Back to age verification');
  await app.tickPolling();
  assert.equal(app.calls.length, 2, 'Leaving the experiment must stop polling');
});

test('back during a pending lookup aborts transport and suppresses late rendering', async t => {
  let release;
  const app = fixture(t, () => new Promise(resolve => { release = resolve; }));
  app.fillEmail(); await app.click('Check email history');
  await app.click('Back to age verification');
  assert.equal(app.calls[0].signal.aborted, true);
  release({ id: 'late-check', status: 'eligible' }); await app.settle();
  assert.equal(app.root.textContent, 'Age verification options');
  assert.equal(app.footer.textContent, 'Original on-device privacy disclosure');
  assert.equal(app.find('button', 'Send me a verification code'), undefined);
});

test('terminal checks offer age fallback or a fresh verification session, never a same-session restart', async t => {
  for (const status of ['expired', 'unavailable', 'locked', 'not_eligible']) {
    const app = fixture(t, () => ({ id: 'check-1', status }));
    app.fillEmail(); await app.click('Check email history');
    assert.match(app.root.textContent, /start a fresh verification session/);
    assert.equal(app.find('button', 'Start a new email check'), undefined);
    assert.equal(app.find('button', 'Send me a verification code'), undefined);
    assert.equal(app.calls.length, 1);
    await app.click('Back to age verification');
    const renewed = new AbortController(); t.after(() => renewed.abort());
    app.context.EmailUI.launchEmail(app.config, () => {}, renewed.signal);
    assert.match(app.root.textContent, /start a fresh verification session/);
    assert.equal(app.input('email'), undefined, 'Returning to the experiment must retain the existing challenge');
    assert.equal(app.calls.length, 1);
  }
});

test('email history threshold is displayed from configuration with a ten-year default', t => {
  const fallback = fixture(t, () => {});
  assert.match(fallback.root.textContent, /at least 10 years old/);
  const configured = fixture(t, () => {}, { emailHistoryYears: 15 });
  assert.match(configured.root.textContent, /at least 15 years old/);
});

test('an ambiguous create response locks the email address and retries the same consented request', async t => {
  const app = fixture(t, (_call, count) => { if (count === 1) throw new Error('Lost response'); return { id: 'check-1', status: 'eligible' }; });
  app.fillEmail(); await app.click('Check email history');
  assert.equal(app.input('email').disabled, true);
  assert.equal(app.input('checkbox').disabled, true);
  // Even scripted edits cannot switch the address on this retry path.
  app.input('email').value = 'different@example.org';
  await app.click('Retry this email check');
  assert.equal(app.calls.length, 2);
  assert.deepEqual(app.calls[0].body, app.calls[1].body);
});


test('wrong code explains the mismatch and a later correct code completes the inbox check', async t => {
  const app = fixture(t, call => ({ id: 'check-1', status: call.path.endsWith('/verify') && call.body.code === '123456' ? 'verified' : call.path.endsWith('/send') || call.path.endsWith('/verify') || call.method === 'GET' ? 'sent' : 'eligible' }));
  app.fillEmail(); await app.click('Check email history'); await app.click('Send me a verification code');
  const code = app.input('text'); code.value = '000000'; code.dispatch('input');
  await app.click('Confirm inbox access');
  assert.match(app.root.textContent, /That code did not match\. Try again\./);
  assert.equal(code.value, ''); assert.equal(code.disabled, false);
  assert.equal(app.find('button', 'Confirm inbox access').disabled, true);
  await app.tickPolling();
  assert.match(app.root.textContent, /That code did not match/, 'Unchanged status polling must preserve mismatch feedback');
  code.value = '123456'; code.dispatch('input'); await app.click('Confirm inbox access');
  assert.match(app.root.textContent, /Email history and inbox access checked/);
  assert.equal(app.calls.filter(call => call.path.endsWith('/send')).length, 1);
  assert.equal(app.calls.filter(call => call.path.endsWith('/verify')).length, 2);
  assert.equal(app.calls.some(call => call.path.startsWith('/result/')), false);
});
