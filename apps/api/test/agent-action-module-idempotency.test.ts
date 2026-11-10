import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureModuleWriteIdempotencyKeys } from '../src/lib/agent-action-proposals.js';

const sourceMessageId = '00000000-0000-4000-8000-000000000001';

test('two module writes without keys get distinct, stable idempotency keys', () => {
  const actions = [
    { action: 'module_record_update', params: { record_id: 'record-1', patch: { stage: 'negotiation' } } },
    { action: 'module_record_create', params: { module_id: 'com.deft.contacts', collection_key: 'activities', data: { subject: 'Note' } } },
  ];
  const first = ensureModuleWriteIdempotencyKeys(actions, sourceMessageId);
  const second = ensureModuleWriteIdempotencyKeys(actions, sourceMessageId);

  for (const [index, action] of first.entries()) {
    assert.equal(typeof action.params.idempotency_key, 'string');
    assert.match(action.params.idempotency_key, /^defty_[a-f0-9]{32}$/);
  }
  // Deterministic for a genuine retry.
  assert.deepEqual(first.map((action) => action.params.idempotency_key), second.map((action) => action.params.idempotency_key));
  // Distinct for two same-turn mutations.
  assert.notEqual(first[0].params.idempotency_key, first[1].params.idempotency_key);
});

test('an existing idempotency key is never overwritten', () => {
  const actions = [
    { action: 'module_record_update', params: { record_id: 'record-1', patch: { stage: 'negotiation' }, idempotency_key: 'model-key-1' } },
    { action: 'module_record_create', params: { module_id: 'com.deft.contacts', collection_key: 'activities', data: {}, idempotency_key: 'model-key-2' } },
  ];
  const result = ensureModuleWriteIdempotencyKeys(actions, sourceMessageId);
  assert.equal(result[0].params.idempotency_key, 'model-key-1');
  assert.equal(result[1].params.idempotency_key, 'model-key-2');
});

test('non-module actions pass through untouched', () => {
  const actions = [
    { action: 'create_task', params: { title: 'Write rollback script', project_name: 'Deft v1' } },
    { action: 'module_record_update', params: { record_id: 'record-1', patch: { stage: 'negotiation' } } },
  ];
  const result = ensureModuleWriteIdempotencyKeys(actions, sourceMessageId);
  assert.deepEqual(result[0], actions[0]);
  assert.equal(typeof result[1].params.idempotency_key, 'string');
});
