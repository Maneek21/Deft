import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EmailNativeSendService } from '../src/lib/email-native-send-service.js';

const scope = { org_id: 'org', owner_user_id: 'owner', account_id: 'mailbox' };
const actor = { user_id: 'owner', web_session_id: 'session', access_expires_at: Date.now() + 60_000 };
const mime = Buffer.from('From: owner@example.test\r\nTo: visible@example.test\r\nSubject: SMTP fixture\r\n\r\nbody\r\n');
const mimeDigest = createHash('sha256').update(mime).digest('hex');
const envelope = { from: 'owner@example.test', to: ['visible@example.test', 'blind@example.test'] };

test('SMTP Send forwards only the trusted sealed envelope alongside MIME to the registered provider', async () => {
  let providerInput: any;
  const capability = { scope, resource_binding_id: 'binding', authority_version: 'authority', expires_at: actor.access_expires_at - 1 };
  const authority = { async current() { return capability; } } as any;
  const draftId = 'e4fdb030-330b-4fd6-81fb-e7973865de22';
  const draft = { draft_id: draftId, revision: 1, content_revision: 1, status: 'draft', content: {}, origin: {},
    last_edited_by_user_id: 'owner', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const drafts = { async read() { return draft; } } as any;
  const store = { async status() { return null; }, async reserve(_scope: any, _draft: any, revision: number, _user: any, operationId: string, digest: string) {
    return { replay: false, operation: { operation_id: operationId, state: 'reserved', draft_revision: revision, operation_digest: digest } };
  }, async verifyReservation() { return true; }, async finish(_scope: any, operationId: string, state: string) { return { operation_id: operationId, state }; } } as any;
  const snapshots = { async prepareAndBind(input: any) {
    const identity = { operation_id: input.operation_id, snapshot_id: 'snapshot', snapshot_digest: 'a'.repeat(64), mime_digest: mimeDigest,
      scope: { org_id: scope.org_id, owner_id: scope.owner_user_id, installation_id: 'install' }, account_id: scope.account_id,
      authority_epoch: 1, draft_id: draftId, draft_revision: 1 };
    await input.reserve(identity);
    return { state: 'reserved', mime_bytes: Buffer.from(mime), mime_digest: mimeDigest, transport: { ...identity,
      from_address: envelope.from, transport_kind: 'smtp_raw', envelope } };
  } } as any;
  const provider = { async send(input: any, context: any) {
    providerInput = { ...input, mime_bytes: Buffer.from(input.mime_bytes) };
    assert.equal(await context.send_before_reserve({ operation_id: input.operation_id, account_id: scope.account_id, authority_epoch: 1, mime_digest: mimeDigest }), true);
    return { schema_version: 'deft.email_send_result.v1', account_id: scope.account_id, provider: 'imap_smtp', operation_id: input.operation_id,
      provider_message_id: null, transport_outcome: 'provider_accepted', sent_copy_outcome: 'pending', delivery_status: 'unknown' };
  } } as any;
  const service = new EmailNativeSendService(authority, drafts, store, snapshots, provider);
  const result = await service.send(actor, scope, draftId, 1);
  assert.equal(result.state, 'accepted');
  assert.deepEqual(providerInput.envelope, envelope);
  assert.deepEqual(providerInput.mime_bytes, mime);
  assert.equal('bcc' in providerInput, false, 'the provider receives only the trusted serialized envelope, not browser draft fields');
  providerInput.mime_bytes.fill(0);
});
