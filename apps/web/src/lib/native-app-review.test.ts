import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeAppReview } from './native-app-review';
const run = '00000000-0000-4000-8000-000000000001';
const binding = '00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000003';
const operation = 'calendar.events.create.v1';
const valid = { schema_version: 'deft.app_native_run_review.v1', run_id: run, native_binding_id: binding,
  owner_user_id: owner, operation_name: operation, action_label: 'Reserve Calendar slot', consent_digest: `sha256:${'a'.repeat(64)}`,
  host_policy: { risk_class: 'internal_write', review_requirement: 'always', review_scope: 'per_invocation',
    retry_class: 'idempotent_with_key', retention_class: 'standard', automation_allowed: false },
  input: { title: 'Private reviewed title', start: '2055-11-07T01:30:00-04:00', end: '2055-11-07T01:45:00-04:00' } };
test('native exact input review requires matching owner Run binding operation and closed host policy', () => {
  assert.deepEqual(parseNativeAppReview(valid, run, binding, operation, owner), valid);
  assert.equal(parseNativeAppReview(valid, binding, binding, operation, owner), null);
  assert.equal(parseNativeAppReview(valid, run, run, operation, owner), null);
  assert.equal(parseNativeAppReview(valid, run, binding, operation, run), null);
  assert.equal(parseNativeAppReview(valid, run, binding, 'calendar.events.cancel.v1', owner), null);
  assert.equal(parseNativeAppReview({ ...valid, host_policy: { ...valid.host_policy, review_requirement: 'never' } }, run, binding, operation, owner), null);
});
test('native exact input review rejects private extras malformed Calendar input and substituted cancellation references', () => {
  assert.equal(parseNativeAppReview({ ...valid, secret: 'extra' }, run, binding, operation, owner), null);
  for (const input of [{ ...valid.input, internal: 'extra' }, { ...valid.input, start: '2055-11-07' },
    { ...valid.input, end: valid.input.start }, { ...valid.input, description: 'x'.repeat(4097) }]) {
    assert.equal(parseNativeAppReview({ ...valid, input }, run, binding, operation, owner), null);
  }
  const cancel = { ...valid, operation_name: 'calendar.events.cancel.v1', input: { create_run_id: run,
    event_ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'core', provider_instance_id: 'calendar_events' },
      resource_type: 'calendar_event', resource_id: run } } };
  assert.deepEqual(parseNativeAppReview(cancel, run, binding, 'calendar.events.cancel.v1', owner), cancel);
  assert.equal(parseNativeAppReview({ ...cancel, input: { ...cancel.input, event_ref: { ...cancel.input.event_ref,
    provider: { kind: 'core', provider_instance_id: 'private_other' } } } }, run, binding, 'calendar.events.cancel.v1', owner), null);
});
