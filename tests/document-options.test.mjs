import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/verification/document-options.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const { documentCountries, documentProfile, documentRegions, requiresDocumentRegion } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('document issuer selection rejects missing or stale state before capture', () => {
  assert.equal(documentProfile({ country: 'US', kind: 'driver-license' }), null);
  assert.equal(documentProfile({ country: 'CA', region: 'FL', kind: 'driver-license' }), null);
  assert.equal(documentProfile({ country: 'AU', region: 'ON', kind: 'identity-card' }), null);
  assert.equal(documentProfile({ country: 'XX', kind: 'passport' }), null);
  const florida = documentProfile({ country: 'US', region: 'FL', kind: 'driver-license' });
  assert.equal(florida.dateOrder, 'MDY');
  assert.equal(florida.language, 'eng');
  assert.match(florida.captureInstruction, /Florida/);
  const quebec = documentProfile({ country: 'CA', region: 'QC', kind: 'identity-card' });
  assert.equal(quebec.language, 'fra');
  assert.equal(quebec.dateOrder, undefined, 'Do not guess an unconfirmed numeric date format');
});

test('passport selection needs no state and supplies passport-specific capture guidance', () => {
  const selection = { country: 'US', region: 'FL', kind: 'passport' };
  assert.equal(requiresDocumentRegion(selection), false);
  const profile = documentProfile(selection);
  assert.match(profile.captureInstruction, /personal-details page/);
  assert.doesNotMatch(profile.captureInstruction, /Florida/);
  assert.match(profile.captureInstruction, /machine-readable lines/);
  assert.equal(documentProfile({ country: 'FR', kind: 'passport' }).language, 'fra');
  assert.equal(documentRegions('US').length, 51);
  assert.equal(documentRegions('CA').length, 13);
  assert.equal(documentRegions('AU').length, 8);
  assert.equal(documentCountries.length, 37);
  assert.ok(documentCountries.some(item => item.code === 'GB'));
  assert.ok(documentCountries.some(item => item.code === 'GR'));
});
