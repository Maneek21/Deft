import test from 'node:test';
import assert from 'node:assert/strict';
import { lapsedPreparedCredentialRepair } from '../src/lib/app-connection-credential-repair-service.js';

const now = Date.parse('2026-10-20T04:00:00Z');
const lapsed = (overrides: Record<string, unknown> = {}, repair: Record<string, unknown> = {}) => ({
  state: 'repair_reviewed', callback_consumed: false, runtime_session_ref: null,
  credential_repair: { review: { digest: 'sha256:review' }, begin_consumed: false, review_expires_at: '2026-10-20T03:37:16Z', ...repair },
  ...overrides,
}) as never;

test('a reviewed reconnection that lapsed before Begin must be closed in the Runtime', () => {
  assert.equal(lapsedPreparedCredentialRepair(lapsed(), now), true);
  // Records already marked closed without a Runtime closure are recovered too.
  assert.equal(lapsedPreparedCredentialRepair(lapsed({ state: 'not_connected' }), now), true);
});

test('only an unexpired, unreached or already-settled repair is left alone', () => {
  assert.equal(lapsedPreparedCredentialRepair(lapsed({}, { review_expires_at: '2026-10-20T04:05:00Z' }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({}, { begin_consumed: true }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({ callback_consumed: true }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({ runtime_session_ref: 'ref' }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({}, { closure: { reason: 'prepared_cancelled' } }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({}, { receipt: { receipt_digest: 'sha256:r' } }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({}, { review: undefined }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({ state: 'connected' }), now), false);
  assert.equal(lapsedPreparedCredentialRepair(lapsed({ state: 'awaiting_callback' }), now), false);
});
