import test from 'node:test';
import assert from 'node:assert/strict';
import { experienceRunReviewTarget } from './app-experience-run-review';
const id = '12345678-1234-4234-8234-123456789012';
const value = { schema_version: 'deft.experience_run_review_target.v1', run_id: id, run_state: 'pending_approval', runtime_binding_id: id, approval_id: id };
test('Run review targets are exact metadata for one requested Run, never input or navigation URLs', () => {
  assert.deepEqual(experienceRunReviewTarget(value, id), { runId: id, state: 'pending_approval', bindingId: id, approvalId: id });
  for (const changed of [{ ...value, input: 'private' }, { ...value, run_id: 'different' }, { ...value, runtime_binding_id: 'https://example.test' },
    { ...value, approval_id: null }, { ...value, run_state: 'succeeded' }, { ...value, run_state: 'unknown', approval_id: null }]) {
    assert.throws(() => experienceRunReviewTarget(changed, id));
  }
  assert.equal(experienceRunReviewTarget({ ...value, run_state: 'unknown_outcome', approval_id: null }, id).state, 'unknown_outcome');
});
