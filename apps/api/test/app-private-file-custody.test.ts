import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { AppPrivateFileSecrets } from '../src/lib/app-private-file-custody.js';
import { PrivateFileUploadSchema, ActionPayloadBindingSchema, PRIVATE_FILE_LIMITS } from '../src/lib/app-private-file-contract.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';

const keys: AppRunKeyProvider = { current: () => ({ key_id: 'custody-test', key: Buffer.alloc(32, 4) }),
  read: (_purpose, id) => id === 'custody-test' ? { key_id: id, key: Buffer.alloc(32, 4) } : null,
  keyIds: () => ['custody-test'] };
const binding = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(),
  app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), resource_target_key: 'account_one', state_key: 'drafts',
  draft_id: randomUUID(), draft_revision: 2, artifact_digest: `sha256:${'1'.repeat(64)}`,
  declaration_digest: `sha256:${'2'.repeat(64)}`, runtime_binding_id: randomUUID(), action_key: 'send',
  action_contract_digest: `sha256:${'3'.repeat(64)}`, input_digest: `sha256:${'4'.repeat(64)}` };

test('private ciphertext authenticates every payload identity and cannot cross binary domains', () => {
  const secrets = new AppPrivateFileSecrets(keys), context = { ...ActionPayloadBindingSchema.parse(binding),
    snapshot_id: randomUUID(), digest: 'a'.repeat(64) }, bytes = Buffer.from('private exact synthetic MIME');
  const encrypted = secrets.seal('payload_bytes', context, bytes);
  assert.notDeepEqual(encrypted.ciphertext, bytes);
  assert.deepEqual(secrets.open('payload_bytes', context, encrypted), bytes);
  for (const field of ['org_id', 'owner_user_id', 'installation_id', 'app_version_id', 'grant_snapshot_id', 'draft_id', 'runtime_binding_id', 'snapshot_id']) {
    assert.throws(() => secrets.open('payload_bytes', { ...context, [field]: randomUUID() }, encrypted));
  }
  for (const field of ['artifact_digest', 'declaration_digest', 'action_contract_digest', 'input_digest', 'digest']) {
    assert.throws(() => secrets.open('payload_bytes', { ...context, [field]: `sha256:${'e'.repeat(64)}` }, encrypted));
  }
  for (const change of [{ draft_revision: 3 }, { resource_target_key: 'account_two' }, { state_key: 'other' }, { action_key: 'other' }]) {
    assert.throws(() => secrets.open('payload_bytes', { ...context, ...change }, encrypted));
  }
  assert.throws(() => secrets.open('file_bytes', context, encrypted));
  assert.throws(() => secrets.open('payload_metadata', context, encrypted));
  assert.throws(() => secrets.open('payload_bytes', context, { ...encrypted, key_version: 'missing' }));
  assert.throws(() => secrets.open('payload_bytes', context, { ...encrypted, auth_tag_b64: Buffer.alloc(16).toString('base64') }));
  encrypted.ciphertext.fill(0);
});

test('file metadata remains encrypted and cannot be substituted across files or payloads', () => {
  const secrets = new AppPrivateFileSecrets(keys), context = { org_id: binding.org_id, file_id: randomUUID() };
  const metadata = { filename: 'Synthetic Private.pdf', digest: createHash('sha256').update('pdf').digest('hex') };
  const encrypted = secrets.sealMetadata('file_metadata', context, metadata);
  assert.equal(JSON.stringify(encrypted).includes(metadata.filename), false);
  assert.deepEqual(secrets.openMetadata('file_metadata', context, encrypted), metadata);
  assert.throws(() => secrets.openMetadata('file_metadata', { ...context, file_id: randomUUID() }, encrypted));
  assert.throws(() => secrets.openMetadata('payload_metadata', context, encrypted));
  assert.throws(() => secrets.openMetadata('file_metadata', context, { ...encrypted, ciphertext_b64: encrypted.ciphertext_b64 + '=' }));
});

test('binary budgets and closed upload metadata prevent scalar or filename workarounds', () => {
  const secrets = new AppPrivateFileSecrets(keys);
  assert.throws(() => secrets.seal('file_bytes', {}, Buffer.alloc(PRIVATE_FILE_LIMITS.file_bytes + 1)));
  assert.throws(() => secrets.seal('payload_bytes', {}, Buffer.alloc(PRIVATE_FILE_LIMITS.payload_bytes + 1)));
  assert.throws(() => secrets.sealMetadata('file_metadata', {}, { name: 'x'.repeat(PRIVATE_FILE_LIMITS.metadata_bytes) }));
  const valid = { expected_revision: 1, upload_operation_id: randomUUID(), filename: 'Private.pdf', media_type: 'application/pdf' };
  assert.ok(PrivateFileUploadSchema.safeParse(valid).success);
  for (const filename of ['../secret.pdf', '..', 'a\\b.pdf', 'a\n.pdf', 'x'.repeat(201)]) {
    assert.equal(PrivateFileUploadSchema.safeParse({ ...valid, filename }).success, false);
  }
  assert.equal(PrivateFileUploadSchema.safeParse({ ...valid, object_id: randomUUID() }).success, false);
  assert.equal(PrivateFileUploadSchema.safeParse({ ...valid, bytes_b64: 'AA==' }).success, false);
});
