import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createEmailRuleRoutes } from '../src/routes/email-rules.js';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailRuleExecutionService } from '../src/lib/email-rule-execution.js';
import type { EmailActor } from '../src/lib/email-mailbox-service.js';
import type { EmailRuleScope } from '../src/lib/email-rule-types.js';
import type { EmailRuleService } from '../src/lib/email-rule-service.js';

const ruleId = 'c7e0372e-1fd7-4fb5-8667-5a5290da78a4';
const content = { name: 'Invoices', match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }],
  exceptions: [], actions: ['mark_read'], stop_processing: false, execution_location: 'deft_service' };
function fixture() {
  const calls: unknown[][] = [];
  const mockRules: Pick<EmailRuleService, 'create' | 'read' | 'list' | 'update' | 'archive' | 'reorder' | 'preview'> = {
    async create(actor: EmailActor, scope: EmailRuleScope, id: string, value: unknown, signal?:AbortSignal, state?:'active'|'paused') { calls.push(['create', actor, scope, id, value, signal, state]); return { rule_id: id, account_id: scope.account_id, revision: 1, content: value, state } as never; },
    async read(actor: EmailActor, scope: EmailRuleScope, id: string) { calls.push(['read', actor, scope, id]); return null as never; },
    async list(actor: EmailActor, scope: EmailRuleScope, cursor: string | null, limit: number) { calls.push(['list', actor, scope, cursor, limit]); return { items: [], next_cursor: null, has_more: false }; },
    async update() { throw new Error('unused'); }, async archive() { throw new Error('unused'); }, async reorder() { return []; }, async preview() { throw new Error('unused'); },
  };
  const routes = createEmailRuleRoutes({ verify: async token => { if (token !== 'good') throw new Error('invalid');
    return { id: 'owner-1', org_id: 'org-1', sid: 'sid-1', exp: Date.now() / 1000 + 60 }; },
  rules: async () => mockRules });
  const app = new Hono(); app.route('/api/email', routes); return { app, calls };
}
const post = (body: unknown, token = 'good') => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('create preserves the selected initial paused state in the single authorized operation',async()=>{
 const {app,calls}=fixture();
 const result=await app.request('/api/email/accounts/account-1/rules',post({rule_id:ruleId,content,state:'paused'}));
 assert.equal(result.status,201);assert.equal((await result.json()).state,'paused');assert.equal(calls.length,1);assert.equal(calls[0]?.[6],'paused');assert.ok(calls[0]?.[5] instanceof AbortSignal);
 assert.equal((await app.request('/api/email/accounts/account-1/rules',post({rule_id:ruleId,content,state:'archived'}))).status,400);
});

test('rules HTTP routes derive owner scope from verified session and reject untrusted input', async () => {
  const { app, calls } = fixture();
  const unauthorized = await app.request('/api/email/accounts/account-1/rules', { headers: { authorization: 'Bearer bad' } });
  assert.equal(unauthorized.status, 401);
  const created = await app.request('/api/email/accounts/account-1/rules', post({ rule_id: ruleId, content }));
  assert.equal(created.status, 201);
  assert.deepEqual(calls[0]?.slice(0, 4), ['create', { user_id: 'owner-1', web_session_id: 'sid-1', access_expires_at: (calls[0]?.[1] as { access_expires_at: number }).access_expires_at },
    { org_id: 'org-1', owner_user_id: 'owner-1', account_id: 'account-1' }, ruleId]);
  const list = await app.request('/api/email/accounts/account-1/rules?limit=2');
  assert.equal(list.status, 401, 'missing bearer does not query service');
  const scopedList = await app.request('/api/email/accounts/account-1/rules?limit=2', { headers: { authorization: 'Bearer good' } });
  assert.equal(scopedList.status, 200); assert.deepEqual(calls.at(-1)?.slice(0, 5).slice(0, 4), ['list', calls.at(-1)?.[1],
    { org_id: 'org-1', owner_user_id: 'owner-1', account_id: 'account-1' }, null]);
  const injectedScope = await app.request('/api/email/accounts/account-1/rules', post({ ...{ rule_id: ruleId, content }, owner_user_id: 'victim' }));
  assert.equal(injectedScope.status, 400);
  const badContent = await app.request('/api/email/accounts/account-1/rules', post({ rule_id: ruleId, content: { ...content, actions: ['send'] } }));
  assert.equal(badContent.status, 400);
  assert.equal((await app.request('/api/email/accounts/account-1/rules?owner=victim', { headers: { authorization: 'Bearer good' } })).status, 400);
});

test('production-shaped review route passes a real AbortSignal separately from its SQL transaction', async () => {
  const logicalId = `mail_${'a'.repeat(64)}`;
  const record = { account_id: 'account-1', logical_message_id: logicalId, revision: 'r1', received_at: null,
    folders: ['INBOX'], flags: { seen: false, flagged: false, answered: false }, data: { subject: 'invoice due', sender: 'billing@example.test' },
    provider_source: { schema_version: 'deft.email_provider_source.v1', account_id: 'account-1', logical_message_id: logicalId,
      locator: { id: 'private-test-locator' } } };
  const rule = { rule_id: ruleId, account_id: 'account-1', revision: 1, state: 'active', order_index: 0, content,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const authorityCalls: Array<{ transaction: unknown; signal?: AbortSignal }> = [];
  const authority = { async current(_actor: unknown, scope: unknown, operation: unknown, transaction?: unknown, signal?: AbortSignal) {
    assert.equal(operation, 'human_modify');
    assert.equal(transaction, undefined, 'a real Request AbortSignal must never enter the transaction slot');
    assert.ok(signal instanceof AbortSignal);
    authorityCalls.push({ transaction, signal });
    return { scope, resource_binding_id: 'binding-1', authority_version: 'authority-1', expires_at: Date.now() + 60_000 };
  } };
  const crypto = new EmailMailboxCrypto({ current: () => ({ key_id: 'test-rule-key', key: Buffer.alloc(32, 37) }),
    read: (_purpose: unknown, keyId: string) => keyId === 'test-rule-key' ? { key_id: keyId, key: Buffer.alloc(32, 37) } : null,
    keyIds: () => ['test-rule-key'] } as never);
  const execution = new EmailRuleExecutionService(authority as never,
    { async list() { return { items: [rule], next_cursor: null, has_more: false }; }, async preview() { throw new Error('unused'); } } as never,
    { async list() { return { account_id: 'account-1', items: [record], next_cursor: null, coverage: 'partial', sync_state: 'idle' }; },
      async readMessage() { return record; } } as never,
    { async prepare() { throw new Error('unused'); }, async transition() { throw new Error('unused'); } } as never,
    crypto, { async apply() { throw new Error('unused'); } } as never);
  const app = new Hono();
  app.route('/api/email', createEmailRuleRoutes({
    verify: async () => ({ id: 'owner-1', org_id: 'org-1', sid: 'sid-1', exp: Date.now() / 1000 + 60 }),
    rules: async () => ({ async create() { throw new Error('unused'); }, async read() { throw new Error('unused'); },
      async list() { return { items: [], next_cursor: null, has_more: false }; }, async update() { throw new Error('unused'); },
      async archive() { throw new Error('unused'); }, async reorder() { return []; }, async preview() { throw new Error('unused'); } }),
    execution: async () => execution,
  }));
  const controller = new AbortController();
  const response = await app.request(`/api/email/accounts/account-1/rules/${ruleId}/review`, {
    method: 'POST', signal: controller.signal,
    headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: 1, folder: 'INBOX', cursor: null, limit: 25, logical_message_ids: [logicalId] }),
  });
  assert.equal(response.status, 200);
  assert.equal(authorityCalls.length, 4, 'initial, page/source, and final fences use current authority');
  assert.ok(authorityCalls.every(call => call.signal instanceof AbortSignal));
});
