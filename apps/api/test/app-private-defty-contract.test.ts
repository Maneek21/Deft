import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { PrivateDeftySecretService } from '../src/lib/app-private-defty-secrets.js';
import { PrivateDeftyTurnInput, PrivateDeftyMessageMetadata } from '../src/lib/app-private-defty-contract.js';

const keys = () => parseEnvironmentAppRunKeyrings(JSON.stringify({
  schema_version: 'deft.app_run_keyring.v1',
  run_encryption: { current: 'e1', keys: { e1: Buffer.alloc(32, 1).toString('base64') } },
  receipt_signing: { current: 's1', keys: { s1: Buffer.alloc(32, 2).toString('base64') } },
  fingerprint: { current: 'f1', keys: { f1: Buffer.alloc(32, 3).toString('base64') } },
}));
const context = { org_id: randomUUID(), space_id: randomUUID(), message_id: randomUUID(),
  owner_user_id: randomUUID(), defty_user_id: randomUUID(), seal_id: randomUUID(),
  grant_id: randomUUID(), role: 'user' as const };

test('private Defty envelope binds every destination identity and rejects Run replay', t => {
  const ring = keys(); t.after(() => ring.destroy());
  const service = new PrivateDeftySecretService(ring);
  const plain = { role: 'user' as const, text: 'private-selected-sentinel' };
  const envelope = service.seal(plain, context);
  assert.deepEqual(service.open(envelope, context), plain);
  for (const name of ['org_id', 'space_id', 'message_id', 'owner_user_id', 'defty_user_id', 'seal_id', 'grant_id'] as const) {
    assert.throws(() => service.open(envelope, { ...context, [name]: randomUUID() }));
  }
  assert.throws(() => service.open(envelope, { ...context, role: 'assistant' }));
  assert.throws(() => new AppRunSecretService(ring).openJson(envelope,
    { org_id: context.org_id, run_id: context.message_id, payload_kind: 'input' }));
  assert.equal(JSON.stringify(envelope).includes(plain.text), false);
});

test('private Defty strict inputs enforce UTF-8 limits and reject authority/metadata additions', t => {
  const ring = keys(); t.after(() => ring.destroy());
  const service = new PrivateDeftySecretService(ring);
  const turn = { schema_version: 'deft.app_private_defty_turn.v1', request_id: randomUUID(), prompt: 'x'.repeat(16384) };
  assert.doesNotThrow(() => PrivateDeftyTurnInput.parse(turn));
  assert.throws(() => PrivateDeftyTurnInput.parse({ ...turn, prompt: 'x'.repeat(16385) }));
  assert.throws(() => PrivateDeftyTurnInput.parse({ ...turn, actor: 'defty' }));
  assert.throws(() => PrivateDeftyTurnInput.parse({ ...turn, prompt: '\ud800' }));
  const envelope = service.seal({ role: 'user', text: 'safe' }, context);
  const metadata = { schema_version: 'deft.private_defty_message.v1', seal_id: context.seal_id,
    grant_id: context.grant_id, request_id: randomUUID(), role: 'user', envelope };
  assert.doesNotThrow(() => PrivateDeftyMessageMetadata.parse(metadata));
  assert.throws(() => PrivateDeftyMessageMetadata.parse({ ...metadata, plaintext: 'leak' }));
  assert.throws(() => service.seal({ role: 'assistant', text: 'x'.repeat(65537) }, { ...context, role: 'assistant' }));
});
