import assert from 'node:assert/strict';
import test from 'node:test';
import { hermesBundleAvailability } from '../src/lib/hermes-release.js';

test('core, missing, and invalid release profiles do not advertise a Hermes archive', () => {
  for (const scope of ['core', null, 'invalid']) {
    const result = hermesBundleAvailability('0.3.0-preview.122', scope, '');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.url, null);
    assert.match(result.detail, /onboarding is blocked/);
  }
});

test('certified release profile advertises only its version-matched archive', () => {
  const result = hermesBundleAvailability('0.3.0-preview.122', 'hermes-certified', '');
  assert.equal(result.status, 'release_certified');
  assert.equal(result.url, 'https://github.com/Maneek21/Deft/releases/download/v0.3.0-preview.122/deft-hermes-integration-0.3.0-preview.122.tar.gz');
});

test('explicit operator bundle remains visibly unverified even on a certified release', () => {
  for (const scope of ['core', 'hermes-certified']) {
    const result = hermesBundleAvailability('0.3.0-preview.122', scope, 'https://operator.example/candidate.tar.gz');
    assert.equal(result.status, 'operator_provided');
    assert.equal(result.url, 'https://operator.example/candidate.tar.gz');
    assert.match(result.detail, /does not establish certification/);
  }
});
