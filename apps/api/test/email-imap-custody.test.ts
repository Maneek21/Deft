import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppRunKeyProvider, AppRunKeyPurpose } from '../src/lib/app-run-keyrings.js';
import {
  EmailImapCredentialCustody, EmailImapCustodyError,
  type EmailImapCredentialRecord, type EmailImapCredentialStore, type EmailImapScope,
} from '../src/lib/email-imap-custody.js';
import type {NativeEmailAccount, NativeEmailConnectionContext} from '../src/lib/email-native-adapter-contract.js';

const scope: EmailImapScope = { org_id: 'org-imap', owner_user_id: 'owner-imap', account_id: 'acct-imap' };
const input = { host: 'IMAP.Example.Test.', port: 993, transport: 'implicit_tls' as const,
  username: 'Mailbox.User@example.test', password: 'synthetic-secret-password' };

function keys(materials: Record<string, Buffer>, current = Object.keys(materials)[0]!) : AppRunKeyProvider {
  const key = (id: string) => materials[id] ? Buffer.from(materials[id]!) : null;
  return {
    current: (purpose: AppRunKeyPurpose) => {
      assert.equal(purpose, 'run_encryption');
      const value = key(current); if (!value) throw new Error('missing current key'); return { key_id: current, key: value };
    },
    read: (purpose: AppRunKeyPurpose, keyId: string) => {
      assert.equal(purpose, 'run_encryption'); const value = key(keyId); return value ? { key_id: keyId, key: value } : null;
    },
    keyIds: (purpose: AppRunKeyPurpose) => { assert.equal(purpose, 'run_encryption'); return Object.keys(materials); },
  };
}

function memoryStore() {
  const rows = new Map<string, EmailImapCredentialRecord>();
  const keyFor = (value: EmailImapScope) => JSON.stringify([value.org_id, value.owner_user_id, value.account_id]);
  let failNextCas = false;
  const store: EmailImapCredentialStore = {
    read: async value => structuredClone(rows.get(keyFor(value)) ?? null),
    compareAndSwap: async ({ scope: value, expected_revision, record }) => {
      if (failNextCas) { failNextCas = false; return false; }
      const key = keyFor(value), prior = rows.get(key), revision = prior?.connection_revision ?? 0;
      if (revision !== expected_revision) return false;
      rows.set(key, structuredClone(record)); return true;
    },
  };
  return { store, rows, failCas: () => { failNextCas = true; } };
}

function context(overrides: Partial<NativeEmailConnectionContext> = {}) {
  let checks = 0;
  const value: NativeEmailConnectionContext = { ...scope, installation_id: 'install-imap', resource_binding_id: 'binding-imap',
    authority_version: 'authority-imap', expires_at: Date.now() + 60_000,
    recheck: async () => { checks += 1; }, ...overrides };
  return { value, checks: () => checks };
}

function account(ref: { connection_revision: number; principal_digest: string }): NativeEmailAccount {
  return { account_id: scope.account_id, provider: 'imap_smtp', resource_binding_id: 'binding-imap', authority_epoch: 1,
    connection_revision: ref.connection_revision, principal_digest: ref.principal_digest, health: 'connected', capabilities: ['read'],
    primary_address: 'imap@example.test', display_label: 'Fixture IMAP' };
}

function isCode(code: string) {
  return (error: unknown) => error instanceof EmailImapCustodyError && error.code === code;
}

test('Sent-copy preference defaults server-managed and CAS changes no credential or principal',async()=>{
 const storage=memoryStore(),custody=new EmailImapCredentialCustody(keys({'settings-key':Buffer.alloc(32,7)}),storage.store),verified={...input,identity:{primary_address:'configured@example.test',display_label:'Configured'},verified_at:new Date().toISOString()};
 const first=await custody.saveProfile(scope,0,verified,async()=>{});assert.equal((await custody.describe(context().value)).sent_copy_mode,'server_managed');
 const updated=await custody.updateSentCopyMode(scope,first.connection_revision,'append',async()=>{});assert.equal(updated.revision,2);assert.equal((await custody.describe(context().value)).sent_copy_mode,'append');
 assert.equal((await custody.describe(context().value)).principal_digest,first.principal_digest);assert.equal(JSON.stringify(storage.rows).includes(input.password),false);
 await custody.withVerifiedProfile(context().value,account({...first,connection_revision:2}),async profile=>{assert.equal(profile.password,input.password);assert.equal(profile.username,input.username);});
 await assert.rejects(custody.updateSentCopyMode(scope,1,'server_managed',async()=>{}),isCode('EMAIL_IMAP_CUSTODY_CONFLICT'));storage.failCas();await assert.rejects(custody.updateSentCopyMode(scope,2,'server_managed',async()=>{}),isCode('EMAIL_IMAP_CUSTODY_CONFLICT'));
 await assert.rejects(custody.updateSentCopyMode(scope,2,'server_managed',async()=>{throw Error('revoked');}),isCode('EMAIL_ACCESS_DENIED'));assert.equal((await custody.describe(context().value)).sent_copy_mode,'append');
});

test('credential profile is normalized, encrypted, and only exposed briefly to verified connector callback', async () => {
  const storage = memoryStore(), custody = new EmailImapCredentialCustody(keys({ 'enc-v1': Buffer.alloc(32, 9) }), storage.store);
  const checks: string[] = [];
  const ref = await custody.saveProfile(scope, 0, input, async () => { checks.push('checked'); });
  assert.equal(ref.connection_revision, 1);
  assert.match(ref.principal_digest, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify([...storage.rows.values()]);
  assert.equal(serialized.includes(input.password), false);
  assert.equal(serialized.includes(input.username), false);
  const request = context();
  let received!: { host: string; username: string; password: string; tls: { mode: string; minVersion: string; rejectUnauthorized: boolean } };
  await custody.withVerifiedProfile(request.value, account(ref), async profile => {
    received = profile;
    assert.equal(profile.host, 'imap.example.test');
    assert.equal(profile.username, input.username);
    assert.equal(profile.password, input.password);
    assert.deepEqual(profile.tls, { mode: 'implicit_tls', minVersion: 'TLSv1.2', rejectUnauthorized: true });
  });
  assert.equal(received.password, '');
  assert.equal(request.checks(), 2);
  assert.equal(checks.length, 2);
});

test('password rotation increments connection generation; server principal stays immutable', async () => {
  const storage = memoryStore(), custody = new EmailImapCredentialCustody(keys({ 'enc-v1': Buffer.alloc(32, 4) }), storage.store);
  const first = await custody.saveProfile(scope, 0, input, async () => {});
  const changed = await custody.saveProfile(scope, first.connection_revision, { ...input, password: 'next-synthetic-password' }, async () => {});
  assert.equal(changed.connection_revision, 2);
  assert.equal(changed.principal_digest, first.principal_digest);
  await assert.rejects(custody.saveProfile(scope, changed.connection_revision, { ...input, host: 'other.example.test' }, async () => {}), isCode('EMAIL_IMAP_PRINCIPAL_IMMUTABLE'));
  await assert.rejects(custody.saveProfile(scope, changed.connection_revision, { ...input, username: 'different@example.test' }, async () => {}), isCode('EMAIL_IMAP_PRINCIPAL_IMMUTABLE'));
  await assert.rejects(custody.withVerifiedProfile(context().value, account(first), async () => assert.fail('stale generation connected')), isCode('EMAIL_ACCESS_DENIED'));
  let currentPassword = '';
  await custody.withVerifiedProfile(context().value, account(changed), async profile => { currentPassword = profile.password; });
  assert.equal(currentPassword, 'next-synthetic-password');
});

test('scope, current authority, cancellation and CAS fence credential access', async () => {
  const storage = memoryStore(), custody = new EmailImapCredentialCustody(keys({ 'enc-v1': Buffer.alloc(32, 6) }), storage.store);
  const ref = await custody.saveProfile(scope, 0, input, async () => {});
  await assert.rejects(custody.withVerifiedProfile(context({ account_id: 'other-account' }).value, account(ref), async () => {}), isCode('EMAIL_ACCESS_DENIED'));
  let work = false, checks = 0;
  await assert.rejects(custody.withVerifiedProfile(context({ recheck: async () => { checks += 1; if (checks === 2) throw new Error('revoked'); } }).value,
    account(ref), async () => { work = true; }), isCode('EMAIL_ACCESS_DENIED'));
  assert.equal(work, false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(custody.withVerifiedProfile(context({ signal: abort.signal }).value, account(ref), async () => {}), /aborted/i);
  storage.failCas();
  await assert.rejects(custody.saveProfile(scope, ref.connection_revision, { ...input, password: 'lost-update' }, async () => {}), isCode('EMAIL_IMAP_CUSTODY_CONFLICT'));
});

test('envelope tampering and unavailable old key fail closed without disclosing profile data', async () => {
  const oldKey = Buffer.alloc(32, 10), newKey = Buffer.alloc(32, 11), storage = memoryStore();
  const first = new EmailImapCredentialCustody(keys({ 'enc-v1': oldKey }), storage.store);
  const ref = await first.saveProfile(scope, 0, input, async () => {});
  const rotated = new EmailImapCredentialCustody(keys({ 'enc-v1': oldKey, 'enc-v2': newKey }, 'enc-v2'), storage.store);
  let read = false;
  await rotated.withVerifiedProfile(context().value, account(ref), async profile => { read = profile.password === input.password; });
  assert.equal(read, true);
  const record = [...storage.rows.values()][0]!;
  const index = 8, replacement = record.envelope.ciphertext_b64[index] === 'A' ? 'B' : 'A';
  (record.envelope as { ciphertext_b64: string }).ciphertext_b64 = record.envelope.ciphertext_b64.slice(0, index) + replacement + record.envelope.ciphertext_b64.slice(index + 1);
  await assert.rejects(rotated.withVerifiedProfile(context().value, account(ref), async () => assert.fail('tampered credentials connected')),
    error => error instanceof EmailImapCustodyError && error.code === 'EMAIL_IMAP_CUSTODY_UNAVAILABLE'
      && !error.message.includes(input.password));
  const missingHistory = new EmailImapCredentialCustody(keys({ 'enc-v2': newKey }, 'enc-v2'), storage.store);
  await assert.rejects(missingHistory.withVerifiedProfile(context().value, account(ref), async () => {}), isCode('EMAIL_IMAP_CUSTODY_KEY_UNAVAILABLE'));
});

test('invalid or cleartext endpoints are rejected before storage', async () => {
  const storage = memoryStore(), custody = new EmailImapCredentialCustody(keys({ 'enc-v1': Buffer.alloc(32, 3) }), storage.store);
  await assert.rejects(custody.saveProfile(scope, 0, { ...input, host: 'localhost' }, async () => {}), isCode('EMAIL_IMAP_PROFILE_INVALID'));
  await assert.rejects(custody.saveProfile(scope, 0, { ...input, transport: 'plaintext', port: 143 }, async () => {}), isCode('EMAIL_IMAP_PROFILE_INVALID'));
  await assert.rejects(custody.saveProfile(scope, 0, { ...input, transport: 'starttls_required', port: 993 }, async () => {}), isCode('EMAIL_IMAP_PROFILE_INVALID'));
  assert.equal(storage.rows.size, 0);
});

test('SMTP profile shares encrypted custody and revision while keeping IMAP principal fixed',async()=>{
 const storage=memoryStore(),custody=new EmailImapCredentialCustody(keys({'enc-v1':Buffer.alloc(32,9)}),storage.store);
 const first=await custody.saveProfile(scope,0,input,async()=>{});
 const smtp={host:'SMTP.Example.Test.',port:587,transport:'starttls_required',username:'sender@example.test',password:'synthetic-smtp-password'};
 const next=await custody.saveProfile(scope,1,{...input,smtp},async()=>{});
 assert.equal(next.principal_digest,first.principal_digest);assert.equal(next.connection_revision,2);
 assert.equal(JSON.stringify([...storage.rows.values()]).includes(smtp.password),false);
 const expected={...account(next),capabilities:['read','send']};let profile:any;
 assert.equal(await custody.withVerifiedSmtpProfile(context().value,expected,async value=>{profile=value;assert.equal(value.host,'smtp.example.test');assert.equal(value.password,smtp.password);return 'ok';}),'ok');
 assert.equal(profile.password,'');
 await assert.rejects(custody.withVerifiedSmtpProfile(context().value,account(next),async()=>{}),isCode('EMAIL_ACCESS_DENIED'));
 await assert.rejects(custody.saveProfile(scope,2,{...input,smtp:{...smtp,port:25}},async()=>{}),isCode('EMAIL_IMAP_PROFILE_INVALID'));
});
