import assert from 'node:assert/strict';
import { test } from 'node:test';

import { terminalModuleActionParams } from '../src/lib/module-action-terminalization.js';

test('terminal module params retain audit identities and digests but no record values or raw key', () => {
  const rawKey = 'terminalization-secret-key';
  const privateValue = 'private-contact@example.test';
  const result = terminalModuleActionParams('module_record_update', {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    record_id: 'contact-123',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    expected_revision: 7,
    patch: {
      email: privateValue,
      notes: 'sensitive notes',
    },
    unset_fields: ['company'],
    idempotency_key: rawKey,
    work_intent_id: 'intent-private-link',
  }, {
    orgId: 'org-123',
    userId: 'shadow-user-123',
    employeeId: 'employee-123',
  });

  assert.deepEqual(result.changed_fields, ['company', 'email', 'notes']);
  assert.equal(result.module_id, 'com.deft.contacts');
  assert.equal(result.collection_key, 'contacts');
  assert.equal(result.record_id, 'contact-123');
  assert.equal(result.expected_revision, 7);
  assert.match(String(result.idempotency_digest), /^sha256:[a-f0-9]{64}$/);
  assert.match(String(result.input_digest), /^sha256:[a-f0-9]{64}$/);
  assert.equal('patch' in result, false);
  assert.equal('unset_fields' in result, false);
  assert.equal('idempotency_key' in result, false);
  assert.equal('work_intent_id' in result, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${privateValue}|${rawKey}|sensitive notes`));
});

test('terminal digests are actor-bound and stable for the same action input', () => {
  const params = {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: 'Private Person' },
    expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
    idempotency_key: 'same-raw-key',
  };
  const first = terminalModuleActionParams('module_record_create', params, {
    orgId: 'org-123',
    userId: 'user-123',
    employeeId: null,
  });
  const replay = terminalModuleActionParams('module_record_create', params, {
    orgId: 'org-123',
    userId: 'user-123',
    employeeId: null,
  });
  const otherActor = terminalModuleActionParams('module_record_create', params, {
    orgId: 'org-123',
    userId: 'user-456',
    employeeId: null,
  });

  assert.equal(first.input_digest, replay.input_digest);
  assert.equal(first.idempotency_digest, replay.idempotency_digest);
  assert.equal(first.input_digest, otherActor.input_digest);
  assert.notEqual(first.idempotency_digest, otherActor.idempotency_digest);
});

test('terminal sanitizer preserves only valid precomputed digests on reconciliation rows', () => {
  const idempotencyDigest = `sha256:${'c'.repeat(64)}`;
  const inputDigest = `sha256:${'d'.repeat(64)}`;
  const result = terminalModuleActionParams('module_record_archive', {
    record_id: 'record-123',
    expected_revision: 2,
    expected_manifest_digest: `sha256:${'e'.repeat(64)}`,
    idempotency_digest: idempotencyDigest,
    input_digest: inputDigest,
    arbitrary_digest: `sha256:${'f'.repeat(64)}`,
    data: { secret: 'must not survive' },
  }, {
    orgId: 'org-123',
    userId: 'user-123',
    employeeId: null,
  });

  assert.equal(result.idempotency_digest, idempotencyDigest);
  assert.equal(result.input_digest, inputDigest);
  assert.equal('arbitrary_digest' in result, false);
  assert.equal('data' in result, false);
});
