import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailRuleService } from '../src/lib/email-rule-service.js';
import type { EmailRuleContent } from '../src/lib/email-rule-types.js';

const actor = { user_id: 'owner-1', web_session_id: 'session-1', access_expires_at: Date.now() + 60_000 };
const scope = { org_id: 'org-1', owner_user_id: 'owner-1', account_id: 'account-1' };
const content: EmailRuleContent = { name: 'Unread invoices', match: 'all',
  conditions: [{ field: 'from', operator: 'contains', value: 'example.test' }, { field: 'folder', operator: 'equals', value: 'INBOX' }],
  exceptions: [{ field: 'subject', operator: 'contains', value: 'ignore' }], actions: ['mark_read'], stop_processing: true,
  execution_location: 'deft_service' };
const message = (id: string, from: string, subject: string) => ({ account_id: scope.account_id, logical_message_id: `mail_${id.padStart(64, '0')}`,
  revision: 'r1', received_at: null, folders: ['INBOX'], flags: { seen: false, flagged: false, answered: false },
  data: { sender: from, recipients: 'owner@example.test', cc: '', subject }, provider_source: { account_id: scope.account_id } });

function fixture({ revoked = false }: { revoked?: boolean } = {}) {
  let authorityCalls = 0;
  const authority = { async current(_actor: unknown, _scope: unknown, _op: unknown) {
    authorityCalls++;
    if (revoked && authorityCalls > 1) throw new Error('revoked');
    return { scope, resource_binding_id: 'binding-1', authority_version: 'v1', expires_at: Date.now() + 60_000 };
  } };
  const store = { async active() { return [{ rule_id: 'rule-1', account_id: scope.account_id, revision: 3, state: 'active', order_index: 0,
    content, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]; } };
  const page = { account_id: scope.account_id, items: [message('1', '  Billing@Example.Test ', 'Invoice'), message('2', 'other@example.test', 'Ignore invoice')],
    next_cursor: 'opaque-next', observed_at: new Date().toISOString(), fresh_until: null, coverage: 'partial' as const, exact_total: null,
    sync_state: 'queued' as const, checkpoint_revision: 4 };
  const mailbox = { async list() { return page; } };
  return { service: new EmailRuleService(authority as never, store as never, mailbox as never), page, getAuthorityCalls: () => authorityCalls };
}

test('preview evaluates only bounded cached page, exceptions and stop order; exposes honest partial coverage', async () => {
  const { service, getAuthorityCalls } = fixture();
  const result = await service.preview(actor, scope, { folder: 'INBOX', cursor: null, limit: 2 });
  assert.equal(result.scope, 'current_cached_page'); assert.equal(result.mailbox_coverage, 'partial');
  assert.equal(result.next_cursor, 'opaque-next'); assert.equal(result.has_more, true);
  assert.deepEqual(result.items.map(item => item.matches.length), [1, 0]);
  assert.deepEqual(result.items[0]?.matches[0]?.actions, ['mark_read']);
  assert.equal(Object.hasOwn(result.items[0]!,'subject'),false,'older clients retain their exact closed response shape');
  assert.ok(getAuthorityCalls() >= 3, 'permission is rechecked around cache and rules reads');
});

test('preview labels are bounded escaped text from the same authorized record, with no private locator',async()=>{
 const {service,page}=fixture();page.items[0]!.data.subject='x'.repeat(600)+'\u0000';page.items[0]!.data.sender='Sender\r\nexample.test';
 const result=await service.preview(actor,scope,{folder:'inbox',cursor:null,limit:2,include_labels:true});
 assert.equal(result.items[0]?.subject?.length,512);assert.equal(result.items[0]?.sender,'Sender  example.test');assert.equal(Object.hasOwn(result.items[0]!,'provider_source'),false);
});

test('preview fails closed on revoked authority or foreign account records', async () => {
  const revoked = fixture({ revoked: true });
  await assert.rejects(revoked.service.preview(actor, scope, { folder: 'INBOX', cursor: null, limit: 2 }), error =>
    (error as { code?: string }).code === 'EMAIL_RULE_ACCESS_DENIED');
  const foreign = fixture();
  (foreign.page.items[0] as { account_id: string }).account_id = 'other-account';
  await assert.rejects(foreign.service.preview(actor, scope, { folder: 'INBOX', cursor: null, limit: 2 }), error =>
    (error as { code?: string }).code === 'EMAIL_RULE_UNAVAILABLE');
});

test('preview rejects excess cached pages and does not accept browser-generated scope', async () => {
  const { service } = fixture();
  await assert.rejects(service.preview(actor, scope, { folder: 'INBOX', cursor: null, limit: 1 }), error =>
    (error as { code?: string }).code === 'EMAIL_RULE_UNAVAILABLE');
  await assert.rejects(service.list({ ...actor, user_id: 'other' }, scope, null, 10), error =>
    (error as { code?: string }).code === 'EMAIL_RULE_ACCESS_DENIED');
});
