import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrivateStateDeclarationSchema } from '@deft/app-kit';
import { PrivateStateRequestSchema, privateStateValue, assertPrivateStateCas, assertPrivateStateQuota } from '../src/lib/app-private-state-contract.js';
import { AppPrivateStateSecrets } from '../src/lib/app-private-state-secrets.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';

const declaration = PrivateStateDeclarationSchema.parse({ key: 'drafts', label: 'Drafts', schema: {
  type: 'object', properties: { subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 4096 } },
  required: ['subject', 'body'], additionalProperties: false }, max_record_bytes: 16384, max_records: 32, max_total_bytes: 131072, retention_days: 30 });
const context = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(),
  artifact_digest: `sha256:${'1'.repeat(64)}`, declaration_digest: `sha256:${'2'.repeat(64)}`, state_key: 'drafts', record_id: randomUUID(), revision: 1 };
const keys: AppRunKeyProvider = { current: () => ({ key_id: 'state-key', key: Buffer.alloc(32, 5) }),
  read: (_purpose, id) => id === 'state-key' ? { key_id: id, key: Buffer.alloc(32, 5) } : null, keyIds: () => ['state-key'] };

test('private state validates its closed declaration and rejects hidden or oversized values', () => {
  assert.deepEqual(privateStateValue(declaration, { subject: 'Literal <script>', body: 'Private draft' }).value,
    { subject: 'Literal <script>', body: 'Private draft' });
  assert.throws(() => privateStateValue(declaration, { subject: 'Subject', body: 'x'.repeat(4097) }));
  assert.throws(() => privateStateValue(declaration, { subject: 'Subject', body: '', owner_user_id: context.owner_user_id }));
  assert.throws(() => PrivateStateDeclarationSchema.parse({ ...declaration, retention_days: 31 }));
  assert.throws(() => PrivateStateDeclarationSchema.parse({ ...declaration, max_total_bytes: 131073 }));
  assert.equal(PrivateStateRequestSchema.safeParse({ operation: 'put', record_id: context.record_id, expected_revision: 0, value: {}, owner_user_id: context.owner_user_id }).success, false);
});

test('encrypted private state has no plaintext and binds every identity and revision', () => {
  const secrets = new AppPrivateStateSecrets(keys), value = { subject: 'Confidential subject', body: 'Confidential plaintext draft' };
  const envelope = secrets.seal(context, value);
  assert.equal(JSON.stringify(envelope).includes('Confidential'), false);
  assert.deepEqual(secrets.open(context, envelope), value);
  for (const field of ['org_id', 'owner_user_id', 'installation_id', 'record_id'] as const) {
    assert.throws(() => secrets.open({ ...context, [field]: randomUUID() }, envelope));
  }
  for (const field of ['artifact_digest', 'declaration_digest'] as const) {
    assert.throws(() => secrets.open({ ...context, [field]: `sha256:${'3'.repeat(64)}` }, envelope));
  }
  assert.throws(() => secrets.open({ ...context, state_key: 'other' }, envelope));
  assert.throws(() => secrets.open({ ...context, revision: 2 }, envelope));
  assert.throws(() => secrets.open(context, { ...envelope, key_version: 'retired' }));
  assert.throws(() => secrets.open(context, { ...envelope, ciphertext: Buffer.from('changed').toString('base64') }));
});

test('revision and quota checks fence lost updates and tombstone recreation', () => {
  assertPrivateStateCas(0, undefined); assertPrivateStateCas(1, 1);
  assert.throws(() => assertPrivateStateCas(0, 2)); // tombstone revision retained
  assert.throws(() => assertPrivateStateCas(1, 2)); // old save after delete
  assert.throws(() => assertPrivateStateCas(1, undefined)); // expired and purged row
  assertPrivateStateQuota(32, 131072, declaration);
  assert.throws(() => assertPrivateStateQuota(33, 100, declaration));
  assert.throws(() => assertPrivateStateQuota(1, 131073, declaration));
});
