import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRuntimeAppReview } from './runtime-app-review';

const valid = { review: {
  run_id: 'run-1', action_key: 'create_label', app_installation_id: 'install-1',
  app_version_id: 'version-1', grant_snapshot_id: 'grant-1',
  runtime_binding_id: 'binding-1', contract_digest: `sha256:${'a'.repeat(64)}`,
  policy: { risk_class: 'external_write', review_requirement: 'always',
    review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown' },
  input: { shipment_id: 'synthetic-one', quantity: 2, urgent: false },
} };

test('exact Runtime input and host policy admit only matching run and binding', () => {
  assert.deepEqual(parseRuntimeAppReview(valid, 'run-1', 'binding-1'), valid.review);
  assert.equal(parseRuntimeAppReview(valid, 'another-run', 'binding-1'), null);
  assert.equal(parseRuntimeAppReview(valid, 'run-1', 'another-binding'), null);
  assert.equal(parseRuntimeAppReview({ review: { ...valid.review,
    policy: { ...valid.review.policy, review_requirement: 'never' } } }, 'run-1', 'binding-1'), null);
});

test('Runtime input review rejects extra data, nested values and overlarge input', () => {
  assert.equal(parseRuntimeAppReview({ review: { ...valid.review, secret: 'extra' } }, 'run-1', 'binding-1'), null);
  assert.equal(parseRuntimeAppReview({ review: { ...valid.review,
    input: { shipment_id: { nested: 'not scalar' } } } }, 'run-1', 'binding-1'), null);
  assert.equal(parseRuntimeAppReview({ review: { ...valid.review,
    input: { shipment_id: 'x'.repeat(16_385) } } }, 'run-1', 'binding-1'), null);
});
