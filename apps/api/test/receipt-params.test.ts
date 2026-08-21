/**
 * Run: pnpm --filter @deft/api test -- receipt-params
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeActionParamsForReceipt,
  sanitizeModuleActionParamsForReceipt,
} from '../src/lib/receipt-params.js';

test('module receipts retain field names and concurrency metadata but no record values', () => {
  const create = sanitizeModuleActionParamsForReceipt('module_record_create', {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: 'Alice Example', notes: 'Private CRM note' },
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    idempotency_key: 'alice@example.com',
  });
  assert.deepEqual(create, {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    changed_fields: ['name', 'notes'],
  });
  assert.equal(JSON.stringify(create).includes('Alice Example'), false);
  assert.equal(JSON.stringify(create).includes('Private CRM note'), false);
  assert.equal(JSON.stringify(create).includes('alice@example.com'), false);

  const update = sanitizeModuleActionParamsForReceipt('module_record_update', {
    record_id: 'record_1',
    patch: { email: 'private@example.com', company: 'Acme' },
    unset_fields: ['notes', 'company'],
    relations: { company_id: ['private-company-record'] },
    expected_revision: 4,
    expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
    idempotency_key: 'private@example.com',
  });
  assert.deepEqual(update, {
    record_id: 'record_1',
    expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
    expected_revision: 4,
    changed_fields: ['company', 'company_id', 'email', 'notes'],
  });
  assert.equal(JSON.stringify(update).includes('private@example.com'), false);
  assert.equal(JSON.stringify(update).includes('Acme'), false);
  assert.equal(JSON.stringify(update).includes('private-company-record'), false);
});

test('receipt sanitization redacts exact secret keys and keeps audit fields', () => {
  const original = {
    title: 'Rotate connector',
    token_count: 12,
    secretary: 'Ada',
    password: 'hunter2',
    new_password: 'hunter3',
    current_password: 'hunter1',
    token: 'tok_live',
    access_token: 'at_live',
    refresh_token: 'rt_live',
    api_key: 'k_live',
    apiKey: 'camelKey',
    authorization: 'Bearer abc',
    cookie: 'sid=1',
    client_secret: 'cs_live',
    secret: 'shh',
    credentials: { user: 'a', pass: 'b' },
    nested: { Authorization: 'Bearer nested' },
  };
  const sanitized = sanitizeActionParamsForReceipt('task_create', original);

  assert.equal(original.password, 'hunter2');
  assert.equal(sanitized.title, 'Rotate connector');
  assert.equal(sanitized.token_count, 12);
  assert.equal(sanitized.secretary, 'Ada');
  assert.equal(sanitized.password, '[redacted]');
  assert.equal(sanitized.new_password, '[redacted]');
  assert.equal(sanitized.current_password, '[redacted]');
  assert.equal(sanitized.token, '[redacted]');
  assert.equal(sanitized.access_token, '[redacted]');
  assert.equal(sanitized.refresh_token, '[redacted]');
  assert.equal(sanitized.api_key, '[redacted]');
  assert.equal(sanitized.apiKey, '[redacted]');
  assert.equal(sanitized.authorization, '[redacted]');
  assert.equal(sanitized.cookie, '[redacted]');
  assert.equal(sanitized.client_secret, '[redacted]');
  assert.equal(sanitized.secret, '[redacted]');
  assert.equal(sanitized.credentials, '[redacted]');
  assert.deepEqual(sanitized.nested, { Authorization: '[redacted]' });
});
