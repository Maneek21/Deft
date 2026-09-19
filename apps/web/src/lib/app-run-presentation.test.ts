import assert from 'node:assert/strict';
import test from 'node:test';
import { appRunPresentation } from './app-run-presentation';

test('sandbox success reports acceptance without claiming delivery', () => {
  const result = appRunPresentation({
    state: 'succeeded', environment: 'sandbox', providerCallAttempted: true, outcomeSuccess: true,
  });
  assert.equal(result.label, 'Sandbox accepted');
  assert.match(result.detail, /No external message was delivered/);
});

test('unknown bindings keep generic execution language', () => {
  const result = appRunPresentation({
    state: 'succeeded', environment: 'unknown', providerCallAttempted: true, outcomeSuccess: true,
  });
  assert.equal(result.label, 'Execution succeeded');
  assert.doesNotMatch(`${result.label} ${result.detail}`, /delivered/i);
});

test('prepared and submitted states are not conflated', () => {
  const result = appRunPresentation({
    state: 'pending_approval', environment: 'sandbox', providerCallAttempted: false, outcomeSuccess: null,
  });
  assert.equal(result.label, 'Awaiting approval');
  assert.match(result.detail, /submitted/);
});

test('explicit uncertainty and cancellation outrank stale failure facts', () => {
  assert.equal(appRunPresentation({
    state: 'unknown_outcome', environment: 'sandbox', providerCallAttempted: true, outcomeSuccess: false,
  }).label, 'Outcome unknown');
  assert.equal(appRunPresentation({
    state: 'cancelled', environment: 'sandbox', providerCallAttempted: true, outcomeSuccess: false,
  }).label, 'Cancelled');
  assert.equal(appRunPresentation({
    state: 'expired', environment: 'sandbox', providerCallAttempted: false, outcomeSuccess: false,
  }).label, 'Expired');
});
