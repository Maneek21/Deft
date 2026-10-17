import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailUnreadService } from '../src/lib/email-unread.js';
import type { EmailActor, EmailCapability, EmailScope } from '../src/lib/email-mailbox-service.js';

const actor: EmailActor = { user_id: 'owner', web_session_id: 'sid', access_expires_at: 10_000 };
const scope = (account_id: string): EmailScope => ({ org_id: 'org', owner_user_id: 'owner', account_id });
const id = (n: number) => `mail_${n.toString(16).padStart(64, '0')}`;
const data = (account: string, ids: string[], coverage: 'partial'|'complete' = 'complete', overflow = false) => ({
  logical_message_ids: ids, overflow, coverage, checkpoint_revision: 4, observed_at: '2026-10-04T00:00:00.000Z',
  fresh_until: '2026-10-04T00:00:30.000Z', sync_state: 'idle' as const,
});

function harness(options: { rows?: Map<string, ReturnType<typeof data>>; hidden?: Map<string, Set<string>>; revokeFinal?: boolean } = {}) {
  const calls = new Map<string, number>();
  const authority = { async current(_actor: EmailActor, account: EmailScope) {
    const call = (calls.get(account.account_id) ?? 0) + 1; calls.set(account.account_id, call);
    if (options.revokeFinal && call > 1) throw new Error('EMAIL_ACCESS_DENIED');
    const capability: EmailCapability = { scope: account, resource_binding_id: 'binding', authority_version: 'v1', expires_at: 9000 };
    return capability;
  } };
  const store = { async readUnreadCount(account: EmailScope, _folder: string, hiddenIds: readonly string[]) {
    const row = options.rows?.get(account.account_id) ?? data(account.account_id, []);
    return { ...row, cached_unread_count: row.logical_message_ids.filter(id => !hiddenIds.includes(id)).length };
  } };
  const hidden = async (account: EmailScope, _ids: readonly string[]) => options.hidden?.get(account.account_id) ?? new Set<string>();
  return { service: new EmailUnreadService(authority, store, hidden, () => 1000), calls };
}

test('partial coverage reports a bounded cached count and withholds an exact unread count', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1), id(2)], 'partial')]]), hidden: new Map([['a', new Set([id(2)])]]) });
  const result = await h.service.read(actor, scope('a'), 'INBOX');
  assert.equal(result.cached_unread_count, 1);
  assert.equal(result.unread_count, null);
  assert.equal(result.coverage, 'partial');
});

test('complete Inbox excludes future local snoozes and returns exact cached count', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1), id(2)])]]), hidden: new Map([['a', new Set([id(1)])]]) });
  const result = await h.service.read(actor, scope('a'), 'INBOX');
  assert.equal(result.unread_count, 1);
  assert.equal(result.cached_unread_count, 1);
  assert.equal(result.folder, 'inbox');
});

test('canonical provider inbox is lowercase while the legacy uppercase query remains a supported alias', async () => {
  let queried = '';
  const service = new EmailUnreadService(
    { async current(_actor: EmailActor, account: EmailScope) { const capability: EmailCapability = { scope: account, resource_binding_id: 'binding', authority_version: 'v1', expires_at: 9000 }; return capability; } },
    { async readUnreadCount(_account, folder: string) { queried = folder; return { ...data('a', [id(1)]), cached_unread_count: 1 }; } },
    async () => new Set(), () => 1000,
  );
  const result = await service.read(actor, scope('a'), 'INBOX');
  assert.equal(queried, 'inbox');
  assert.equal(result.folder, 'inbox');
});

test('unread count never subtracts unrelated snooze identifiers', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1), id(2)])]]), hidden: new Map([['a', new Set([id(1), 'not-in-this-account'])]]) });
  const result = await h.service.read(actor, scope('a'), 'INBOX');
  assert.equal(result.unread_count, 1);
  assert.equal(result.cached_unread_count, 1);
});

test('unified unread counts deduplicate stable logical IDs across accounts', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1), id(2)])], ['b', data('b', [id(2), id(3)])]]) });
  const result = await h.service.readUnified(actor, [scope('a'), scope('b')], 'all');
  assert.equal(result.unread_count, 4);
  assert.equal(result.cached_unread_count, 4);
  assert.equal(result.coverage, 'complete');
});

test('unified unread withholds the exact count if any selected account is partial', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1)])], ['b', data('b', [id(2)], 'partial')]]) });
  const result = await h.service.readUnified(actor, [scope('a'), scope('b')], 'all');
  assert.equal(result.unread_count, null);
  assert.equal(result.cached_unread_count, 2);
  assert.equal(result.coverage, 'partial');
});

test('authority loss after reading withholds unread counts', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1)])]]), revokeFinal: true });
  await assert.rejects(h.service.read(actor, scope('a'), 'INBOX'), /EMAIL_ACCESS_DENIED/);
});

test('duplicate account nominations preserve partition identity and count each account once', async () => {
  const h = harness({ rows: new Map([['a', data('a', [id(1), id(2)])], ['b', data('b', [id(1)])]]) });
  const result = await h.service.readUnified(actor, [scope('a'), scope('b'), scope('a')], 'all');
  assert.equal(result.unread_count, 3);
  assert.equal(result.accounts.length, 3);
  assert.equal(h.calls.get('a'), 4);
});

test('non-Inbox aggregate skips the local snooze query', async () => {
  const service = new EmailUnreadService(
    { async current(_actor: EmailActor, account: EmailScope) { return { scope: account, resource_binding_id: 'binding', authority_version: 'v1', expires_at: 9000 }; } },
    { async readUnreadCount(_account, folder, hidden) { assert.equal(folder, 'all'); assert.deepEqual(hidden, []); return { ...data('a', []), cached_unread_count: 100002 }; } },
    async () => { throw Error('snoozes must not be queried outside Inbox'); }, () => 1000,
  );
  assert.equal((await service.read(actor, scope('a'), 'all')).unread_count, 100002);
});
