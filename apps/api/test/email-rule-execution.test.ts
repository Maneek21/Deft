import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailRuleExecutionService } from '../src/lib/email-rule-execution.js';
import { emailNativeTriageSourceFingerprint } from '../src/lib/email-native-triage.js';
import type { EmailMessageRecord } from '../src/lib/email-mailbox-service.js';

const actor = { user_id: 'owner-1', web_session_id: 'sid-1', access_expires_at: Date.now() + 120_000 };
const scope = { org_id: 'org-1', owner_user_id: 'owner-1', account_id: 'account-1' };
const ruleId = 'cc12b92c-5ffe-4da0-8619-f4f03e4635c4';
const content = { name: 'Invoice triage', match: 'all' as const, conditions: [{ field: 'subject' as const, operator: 'contains' as const, value: 'invoice' }],
  exceptions: [], actions: ['mark_read' as const, 'star' as const], stop_processing: true, execution_location: 'deft_service' as const };
const record: EmailMessageRecord = { account_id: scope.account_id, logical_message_id: `mail_${'a'.repeat(64)}`, revision: 'r1', received_at: null,
  folders: ['INBOX'], flags: { seen: false, flagged: false, answered: false }, data: { subject: 'Invoice due', sender: 'billing@example.test' },
  provider_source: { schema_version: 'deft.email_provider_source.v1', account_id: scope.account_id, logical_message_id: `mail_${'a'.repeat(64)}`, locator: { id: 'private-provider-locator' } } };

function fixture() {
  let now = Date.now(), authorityRevision = 1, triageCalls = 0;
  const keys = { current: () => ({ key_id: 'execution-test-key', key: Buffer.alloc(32, 59) }),
    read: (_purpose: unknown, key: string) => key === 'execution-test-key' ? { key_id: key, key: Buffer.alloc(32, 59) } : null,
    keyIds: () => ['execution-test-key'] };
  const cipher = new EmailMailboxCrypto(keys);
  const authority = { async current(_actor: unknown, _scope: unknown, _op: unknown) { return { scope, resource_binding_id: 'binding', authority_version: `v${authorityRevision}`, expires_at: now + 60_000 }; } };
  let currentRule = { rule_id: ruleId, account_id: scope.account_id, revision: 1, state: 'active' as const, order_index: 0, content,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() };
  const rules = { async list(_actor: unknown, _scope: unknown, cursor: string | null) { return { items: cursor ? [] : [currentRule], next_cursor: null, has_more: false }; },
    async preview() { throw new Error('unused'); } };
  let currentRecord = structuredClone(record);
  const mailbox = { async list() { return { account_id: scope.account_id, items: [{ logical_message_id: currentRecord.logical_message_id, revision: currentRecord.revision,
      folders: currentRecord.folders, data: currentRecord.data }], next_cursor: null }; }, async readMessage() { return structuredClone(currentRecord); } };
  const rows = new Map<string, any>();
  const receipts = {
    async prepare(_scope: unknown, key: { rule_id: string; rule_revision: number; logical_message_id: string; action_index: number }, source_digest: string, action: string) {
      const mapKey = `${key.rule_id}:${key.rule_revision}:${key.logical_message_id}:${key.action_index}`;
      let row = rows.get(mapKey);
      if (row) { if (row.value.source_digest !== source_digest || row.value.action !== action) throw Object.assign(new Error(), { code: 'EMAIL_RULE_CONFLICT' }); return row; }
      row = { rule_id: key.rule_id, rule_revision: key.rule_revision, target_digest: 'd'.repeat(64), action_index: key.action_index,
        operation_id: randomUUID(), storage_revision: 1, state: 'planned', value: { logical_message_id: key.logical_message_id, source_digest, action } };
      rows.set(mapKey, row); return row;
    },
    async transition(_scope: unknown, old: any, state: string, result: unknown) {
      const key = `${old.rule_id}:${old.rule_revision}:${old.value.logical_message_id}:${old.action_index}`;
      const row = { ...old, state, storage_revision: old.storage_revision + 1, value: { ...old.value, ...(result ? { result } : {}) } };
      rows.set(key, row); return row;
    },
  };
  const triage = { async apply(_actor: unknown, _scope: unknown, input: { operation_id: string; kind: string; logical_message_ids: string[]; expected_source_digests: Record<string, string> }) {
    triageCalls++;
    assert.equal(input.expected_source_digests[record.logical_message_id], emailNativeTriageSourceFingerprint(record));
    return { items: [{ logical_message_id: record.logical_message_id, state: 'succeeded' as const, undo_supported: false }], operation_id: input.operation_id };
  } };
  const service = new EmailRuleExecutionService(authority as never, rules as never, mailbox as never, receipts as never, cipher, triage as never,
    () => now);
  return { service, rows, setRevision(value: number) { authorityRevision = value; }, setRule(value: typeof currentRule) { currentRule = value; },
    setSource(value: EmailMessageRecord) { currentRecord = structuredClone(value); }, advance(ms: number) { now += ms; },
    get calls() { return triageCalls; }, cipher };
}

test('manual rule review binds exact revision, account, selected target, source and action; replay uses receipt operation IDs', async () => {
  const f = fixture();
  const review = await f.service.review(actor, scope, ruleId, { expected_revision: 1, folder: 'INBOX', cursor: null, limit: 25,
    logical_message_ids: [record.logical_message_id] });
  assert.equal(review.scope, 'selected_current_cached_page');
  assert.deepEqual(review.targets[0]?.actions, ['mark_read', 'star']);
  const applied = await f.service.execute(actor, scope, review.review_token);
  assert.deepEqual(applied.items.map(item => item.state), ['applied', 'applied']); assert.equal(f.calls, 2);
  const replay = await f.service.execute(actor, scope, review.review_token);
  assert.deepEqual(replay.items.map(item => item.state), ['applied', 'applied']); assert.equal(f.calls, 2, 'durable applied receipts suppress duplicate provider calls');
});

test('manual review is invalidated by rule edits, mailbox source changes and expiry', async () => {
  const f = fixture();
  const review = await f.service.review(actor, scope, ruleId, { expected_revision: 1, folder: 'INBOX', cursor: null, limit: 25,
    logical_message_ids: [record.logical_message_id] });
  f.setRule({ ...({ ...({ rule_id: ruleId, account_id: scope.account_id, revision: 2, state: 'active' as const, order_index: 0, content,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) }) });
  await assert.rejects(f.service.execute(actor, scope, review.review_token), error => (error as { code?: string }).code === 'EMAIL_RULE_CONFLICT');
  const f2 = fixture(), review2 = await f2.service.review(actor, scope, ruleId, { expected_revision: 1, folder: 'INBOX', cursor: null, limit: 25,
    logical_message_ids: [record.logical_message_id] });
  f2.setSource({ ...record, provider_source: { ...record.provider_source, locator: { id: 'changed-private-locator' } } });
  await assert.rejects(f2.service.execute(actor, scope, review2.review_token), error => (error as { code?: string }).code === 'EMAIL_RULE_CONFLICT');
  const f3 = fixture(), longActor = { ...actor, access_expires_at: Date.now() + 10 * 60_000 };
  const review3 = await f3.service.review(longActor, scope, ruleId, { expected_revision: 1, folder: 'INBOX', cursor: null, limit: 25,
    logical_message_ids: [record.logical_message_id] });
  f3.advance(5 * 60_000 + 1);
  await assert.rejects(f3.service.execute(longActor, scope, review3.review_token), error => (error as { code?: string }).code === 'EMAIL_RULE_INVALID');
});
