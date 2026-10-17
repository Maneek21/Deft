import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { EmailMessageContentService, EmailMessageContentError } from '../src/lib/email-message-content.js';
import type { EmailActor, EmailCapability, EmailMessageRecord, EmailScope } from '../src/lib/email-mailbox-service.js';

const scope: EmailScope = { org_id: 'org-source-fixture', owner_user_id: 'owner-source-fixture', account_id: 'mailbox-source-fixture' };
const actor: EmailActor = { user_id: scope.owner_user_id, web_session_id: 'session-source-fixture', access_expires_at: Date.now() + 60_000 };
const logicalId = 'mail_' + 'b'.repeat(64);
const originalBytes = Buffer.from('From: Sender <sender@example.test>\r\nSubject: Fixture\r\n\r\nHello ✓\r\n', 'utf8');
const digest = createHash('sha256').update(originalBytes).digest('hex');
const record = (): EmailMessageRecord => ({ account_id: scope.account_id, logical_message_id: logicalId, revision: 'imap:42:3',
  received_at: '2026-10-04T12:00:00.000Z', folders: ['inbox'], flags: { seen: false, flagged: false, answered: false },
  data: { subject: 'Fixture' }, provider_source: { schema_version: 'deft.email_provider_source.v1', account_id: scope.account_id,
    logical_message_id: logicalId, provider: 'imap_smtp', uid: 42, mailbox: 'INBOX' } });
const capability: EmailCapability = { scope, resource_binding_id: 'binding-source-fixture', authority_version: 'authority-v1', expires_at: Date.now() + 60_000 };

function fixture(options: { denyAt?: number; invalidExpiry?: boolean; mutateRecord?: (current: EmailMessageRecord) => EmailMessageRecord | null;
  missing?: boolean; initialSource?: EmailMessageRecord['provider_source'];
  sourceChange?: Partial<{ account_id: string; byte_length: number; digest: string; provider: 'gmail' | 'microsoft' | 'imap_smtp' }>;
  abortAfterProvider?: AbortController } = {}) {
  let authorityCalls = 0, storeCalls = 0, providerCalls = 0, lastBytes: Uint8Array | undefined;
  const authority = { async current() {
    if (++authorityCalls === options.denyAt) throw new Error('revoked');
    return options.invalidExpiry ? { ...capability, expires_at: Number.NaN } : structuredClone(capability);
  } };
  const store = { async readMessage() {
    storeCalls++;
    if (options.missing) return null;
    const next = record();
    if (options.initialSource) next.provider_source = options.initialSource;
    return storeCalls > 1 && options.mutateRecord ? options.mutateRecord(next) : next;
  } };
  const provider = { async readSource(_scope: EmailScope, request: { source: Readonly<Record<string, unknown>> }, _cap: EmailCapability,
    recheck: () => Promise<void>) {
    providerCalls++;
    assert.deepEqual(request.source, options.initialSource ?? record().provider_source);
    lastBytes = Uint8Array.from(originalBytes);
    options.abortAfterProvider?.abort(new Error('cancelled'));
    return { schema_version: 'deft.email_source.v1' as const, account_id: options.sourceChange?.account_id ?? scope.account_id,
      provider: options.sourceChange?.provider ?? 'imap_smtp' as const, source_kind: 'provider_original' as const,
      media_type: 'message/rfc822' as const, byte_length: options.sourceChange?.byte_length ?? lastBytes.byteLength,
      digest: options.sourceChange?.digest ?? digest, mime_bytes: lastBytes };
  } };
  return { service: new EmailMessageContentService(authority as any, store as any, provider as any), get lastBytes() { return lastBytes; },
    get counts() { return { authorityCalls, storeCalls }; } };
}

test('returns validated original MIME bytes after fresh authority and source fingerprint checks', async () => {
  const f = fixture();
  const result = await f.service.readSource(actor, scope, logicalId);
  assert.equal(result.account_id, scope.account_id); assert.equal(result.logical_message_id, logicalId);
  assert.equal(result.byte_length, originalBytes.byteLength); assert.equal(result.digest, digest);
  assert.deepEqual(Buffer.from(result.mime_bytes), originalBytes); assert.equal(f.counts.storeCalls, 2); assert.ok(f.counts.authorityCalls >= 4);
});

test('held revocation after provider bytes zeroizes and denies the source', async () => {
  const f = fixture({ denyAt: 3 });
  await assert.rejects(f.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.ok(f.lastBytes); assert.ok(f.lastBytes!.every(byte => byte === 0));
});

test('removed source or changed provider locator after retrieval zeroizes and denies', async () => {
  for (const mutateRecord of [() => null, (current: EmailMessageRecord) => ({ ...current, provider_source: { uid: 43, mailbox: 'INBOX' } })]) {
    const f = fixture({ mutateRecord });
    await assert.rejects(f.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_ACCESS_DENIED');
    assert.ok(f.lastBytes); assert.ok(f.lastBytes!.every(byte => byte === 0));
  }
});

test('scope swaps, false byte counts and digest mismatches fail closed and clear bytes', async () => {
  const wrongRecord = fixture({ mutateRecord: current => ({ ...current, account_id: 'foreign-account' }) });
  await assert.rejects(wrongRecord.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_ACCESS_DENIED');
  const foreignSource = fixture({ sourceChange: { account_id: 'foreign-account' } });
  await assert.rejects(foreignSource.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_SOURCE_UNAVAILABLE');
  for (const sourceChange of [{ byte_length: 1 }, { digest: '0'.repeat(64) }]) {
    const f = fixture({ sourceChange });
    await assert.rejects(f.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_SOURCE_UNAVAILABLE');
    assert.ok(f.lastBytes); assert.ok(f.lastBytes!.every(byte => byte === 0));
  }
});

test('rejects mismatched cached source identity before provider access and mismatched provider identity after', async () => {
  const invalidLocator = fixture({ initialSource: { ...record().provider_source, logical_message_id: 'mail_' + 'c'.repeat(64) } });
  await assert.rejects(invalidLocator.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(invalidLocator.counts.storeCalls, 1);
  const wrongProvider = fixture({ sourceChange: { provider: 'gmail' } });
  await assert.rejects(wrongProvider.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_SOURCE_UNAVAILABLE');
  assert.ok(wrongProvider.lastBytes); assert.ok(wrongProvider.lastBytes!.every(byte => byte === 0));
});

test('cancellation after provider bytes zeroizes and propagates abort', async () => {
  const controller = new AbortController(), f = fixture({ abortAfterProvider: controller });
  await assert.rejects(f.service.readSource(actor, scope, logicalId, controller.signal), /cancel/i);
  assert.ok(f.lastBytes); assert.ok(f.lastBytes!.every(byte => byte === 0));
});

test('missing messages and non-owner callers never reach the provider', async () => {
  const missing = fixture({ missing: true });
  await assert.rejects(missing.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_MESSAGE_NOT_FOUND');
  assert.equal(missing.counts.storeCalls, 1);
  const notOwner = fixture();
  await assert.rejects(notOwner.service.readSource({ ...actor, user_id: 'other-user' }, scope, logicalId));
  assert.deepEqual(notOwner.counts, { authorityCalls: 0, storeCalls: 0 });
  const invalidExpiry = fixture({ invalidExpiry: true });
  await assert.rejects(invalidExpiry.service.readSource(actor, scope, logicalId), error => error instanceof EmailMessageContentError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(invalidExpiry.counts.storeCalls, 0);
});
