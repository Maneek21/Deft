import assert from 'node:assert/strict';
import test from 'node:test';
import { AppRunKeyVersionUnavailableError, parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { EmailMailboxCrypto, type EmailMailboxCryptoContext } from '../src/lib/email-mailbox-crypto.js';

const encodedKey = (byte: number) => Buffer.alloc(32, byte).toString('base64');
function keyring(rotated = false, retainOld = true) {
  return parseEnvironmentAppRunKeyrings(JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: rotated ? 'enc-2' : 'enc-1', keys: {
      ...(retainOld ? { 'enc-1': encodedKey(11) } : {}), ...(rotated ? { 'enc-2': encodedKey(12) } : {}),
    } },
    receipt_signing: { current: 'sig-1', keys: { 'sig-1': encodedKey(21) } },
    fingerprint: { current: 'fp-1', keys: { 'fp-1': encodedKey(31) } },
  }));
}
const context: EmailMailboxCryptoContext = {
  org_id: 'org:acme', owner_user_id: 'user:osheen', account_id: 'acct:gmail:1',
  kind: 'summary', record_id: 'logical-mail:thread/1', revision: 3,
};

test('Email mailbox JSON round-trips under its bound context', (t) => {
  const keys = keyring(); t.after(() => keys.destroy());
  const crypto = new EmailMailboxCrypto(keys);
  const value = { subject: 'Résumé 📨', preview: 'こんにちは', nested: [true, null, 42] };
  const envelope = crypto.seal(value, context);
  assert.deepEqual(crypto.open(envelope, context), value);
  assert.ok(!JSON.stringify(envelope).includes('Résumé'));
  assert.notEqual(crypto.seal(value, context).nonce_b64, envelope.nonce_b64);
});

test('Email mailbox ciphertext rejects owner, account, purpose, record and revision substitution', (t) => {
  const keys = keyring(); t.after(() => keys.destroy());
  const crypto = new EmailMailboxCrypto(keys);
  const envelope = crypto.seal({ private: true }, context);
  for (const changed of [
    { ...context, org_id: 'org:other' }, { ...context, owner_user_id: 'user:other' },
    { ...context, account_id: 'acct:other' }, { ...context, kind: 'provider_source' as const },
    { ...context, kind: 'checkpoint' as const }, { ...context, record_id: 'logical-mail:other' },
    { ...context, revision: 4 },
  ]) assert.throws(() => crypto.open(envelope, changed));
});

test('Email mailbox envelope tampering and missing retained key fail closed', (t) => {
  const keys = keyring(); const retired = keyring(true, false);
  t.after(() => { keys.destroy(); retired.destroy(); });
  const crypto = new EmailMailboxCrypto(keys);
  const envelope = crypto.seal({ cursor: 'opaque-provider-cursor' }, { ...context, kind: 'checkpoint' });
  const bytes = Buffer.from(envelope.ciphertext_b64, 'base64'); bytes[0] = bytes[0]! ^ 1;
  assert.throws(() => crypto.open({ ...envelope, ciphertext_b64: bytes.toString('base64') }, { ...context, kind: 'checkpoint' }));
  bytes.fill(0);
  assert.throws(() => new EmailMailboxCrypto(retired).open(envelope, { ...context, kind: 'checkpoint' }), AppRunKeyVersionUnavailableError);
});

test('Email mailbox keys rotate while retained old ciphertext remains readable', (t) => {
  const oldKeys = keyring(); const rotatedKeys = keyring(true);
  t.after(() => { oldKeys.destroy(); rotatedKeys.destroy(); });
  const original = new EmailMailboxCrypto(oldKeys);
  const rotated = new EmailMailboxCrypto(rotatedKeys);
  const envelope = original.seal({ summary: '保留された要約' }, context);
  assert.equal(envelope.key_version, 'enc-1');
  assert.deepEqual(rotated.open(envelope, context), { summary: '保留された要約' });
  assert.equal(rotated.seal({ ok: true }, context).key_version, 'enc-2');
});

test('Email mailbox JSON budget and context validation reject invalid values', (t) => {
  const keys = keyring(); t.after(() => keys.destroy());
  const crypto = new EmailMailboxCrypto(keys);
  assert.throws(() => crypto.seal('🙂'.repeat(140_000), context));
  assert.throws(() => crypto.seal({ invalid: Number.NaN }, context));
  assert.throws(() => crypto.seal('ok', { ...context, account_id: ' account' }));
  assert.throws(() => crypto.seal('ok', { ...context, account_id: 'a\n' }));
  assert.throws(() => crypto.seal('ok', { ...context, record_id: 'r'.repeat(257) }));
  assert.throws(() => crypto.seal('ok', { ...context, revision: 1.5 }));
  assert.throws(() => crypto.seal('ok', { ...context, unexpected: true } as EmailMailboxCryptoContext));
});
