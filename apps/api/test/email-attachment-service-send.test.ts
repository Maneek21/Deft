import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EmailAttachmentService } from '../src/lib/email-attachment-service.js';

const scope = { org_id: 'org', owner_user_id: 'owner', account_id: 'account' };
const actor = { user_id: 'owner', web_session_id: 'session', access_expires_at: Date.now() + 60_000 };
const metadata = { file_id: randomUUID(), filename: 'notes.txt', media_type: 'text/plain', size_bytes: 4, sha256: 'a'.repeat(64) };

test('public attachment reads stay human_draft while internal send reads require human_send', async () => {
  const operations: string[] = [];
  const authority = { async current(_actor: unknown, actualScope: any, operation: string) {
    operations.push(operation);
    return { scope: actualScope, resource_binding_id: 'binding', authority_version: 'version', expires_at: Date.now() + 30_000 };
  } } as any;
  const store = { async read(_scope: unknown, _draft: string, _file: string, _expected: unknown, guard: (tx: unknown) => Promise<void>) {
    await guard({ tx: true }); return { ...metadata, bytes: Buffer.from('test') };
  } } as any;
  const service = new EmailAttachmentService(authority, store);

  const publicRead = await service.read(actor, scope, randomUUID(), metadata.file_id, metadata);
  publicRead.bytes.fill(0);
  assert.deepEqual(operations, ['human_draft', 'human_draft']);
  operations.length = 0;

  const sendRead = await service.readForSend(actor, scope, randomUUID(), metadata.file_id, metadata);
  sendRead.bytes.fill(0);
  assert.deepEqual(operations, ['human_send', 'human_send']);
});

test('internal send attachment read denies when current human_send authority is missing', async () => {
  const authority = { async current(_actor: unknown, _scope: unknown, operation: string) {
    assert.equal(operation, 'human_send'); throw Error('EMAIL_ACCESS_DENIED');
  } } as any;
  const store = { async read() { assert.fail('denied access must not read bytes'); } } as any;
  const service = new EmailAttachmentService(authority, store);
  await assert.rejects(service.readForSend(actor, scope, randomUUID(), metadata.file_id, metadata), /EMAIL_ACCESS_DENIED/);
});
