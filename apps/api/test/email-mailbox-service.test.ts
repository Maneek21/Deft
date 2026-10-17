import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailMailboxService, EmailMailboxError, syncEmailMailboxPage, type EmailScope, type EmailActor, type EmailCapability,
  type EmailMessageRecord, type EmailProviderPage, type EmailMailboxStore, type EmailSyncCommit,
  type EmailSyncReceipt, type EmailSyncResult } from '../src/lib/email-mailbox-service.js';

const scope: EmailScope = { org_id: 'org-a', owner_user_id: 'owner-a', account_id: 'account-a' };
const actor: EmailActor = { user_id: 'owner-a', web_session_id: 'sid-a', access_expires_at: 10000 };
const logical = (n: number) => 'mail_' + n.toString(16).padStart(64, '0');
const record = (n = 1): EmailMessageRecord => ({ account_id: scope.account_id, logical_message_id: logical(n), revision: 'r1',
  received_at: new Date(500).toISOString(), folders: ['INBOX'], flags: { seen: false, flagged: false, answered: false },
  data: { subject: 'Private mail', sender: 'sender@example.invalid' }, provider_source: { private_locator: 'provider-message-one' } });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const state = { now: 1000, allowed: true, version: 'authority-1', binding: 'binding-1', authorityCalls: 0, providerCalls: 0,
    rows: [record()], revision: 0, cursor: null as string | null, failCommit: false, commits: 0,
    cachedRead: async () => {}, providerRead: async () => {}, beforeCommit: async () => {}, afterCommit: async () => {},
    providerPage: { account_id: scope.account_id, items: [record()], next_cursor: null, complete: true,
      observed_at: new Date(900).toISOString(), has_more: false, failure_count: 0, tombstones: [], state_updates: [] } as EmailProviderPage,
    cache: { observed_at: new Date(900).toISOString() as string | null, fresh_until: new Date(1500).toISOString() as string | null,
      coverage: 'complete' as 'complete' | 'partial', exact_total: 1 as number | null } };
  const receipts = new Map<string, EmailSyncReceipt & { page_digest: string }>();
  const assertScope = (actual: EmailScope) => assert.deepEqual(actual, scope);
  let tail = Promise.resolve();
  const store: EmailMailboxStore = {
    async readProviderState() { return null; },
    async readStaleRecords() { return []; },
    async readPage(actual) { assertScope(actual); await state.cachedRead(); return { account_id: actual.account_id,
      items: structuredClone(state.rows), next_cursor: null, ...state.cache, sync_state: 'idle', checkpoint_revision: state.revision }; },
    async readCheckpoint(actual) { assertScope(actual); return { revision: state.revision, cursor: state.cursor, has_more: false }; },
    async readSyncReceipt(actual, id) { assertScope(actual); return receipts.get(id) ?? null; },
    async commitPage(actual: EmailScope, input: EmailSyncCommit, guard): Promise<EmailSyncResult> {
      assertScope(actual);
      const previous = tail, lock = deferred(); tail = previous.then(() => lock.promise);
      await previous;
      try {
        await state.beforeCommit(); await guard({ fixture_transaction: true });
        const existing = receipts.get(input.page_id);
        if (existing) {
          if (existing.request_digest !== input.request_digest || existing.page_digest !== input.page_digest) throw new EmailMailboxError('EMAIL_SYNC_REPLAY_CONFLICT');
          return { ...existing.result, state: 'duplicate' };
        }
        if (state.revision !== input.expected_checkpoint_revision || state.cursor !== input.input_cursor) throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
        if (state.failCommit) throw new Error('fixture checkpoint transaction rolled back');
        // Only this block commits. Failures above leave rows/cursor/receipt intact.
        const rows = new Map(state.rows.map(row => [row.logical_message_id, row]));
        for (const id of input.page.tombstones) rows.delete(id);
        for (const row of input.page.items) rows.set(row.logical_message_id, structuredClone(row));
        await guard({ fixture_transaction: true });
        state.rows = [...rows.values()]; state.cursor = input.page.next_cursor; state.revision++; state.commits++;
        const result: EmailSyncResult = { state: 'applied', checkpoint_revision: state.revision, observed_at: input.page.observed_at, complete: input.page.complete, has_more: input.page.has_more };
        receipts.set(input.page_id, { request_digest: input.request_digest, page_digest: input.page_digest, result });
        await state.afterCommit();
        return result;
      } finally { lock.release(); }
    },
  };
  const authority = { async current(actual: EmailActor, account: EmailScope, operation: string, transaction?: unknown): Promise<EmailCapability> {
    state.authorityCalls++; assert.deepEqual(actual, actor); assertScope(account);
    assert.ok(['human_read', 'human_sync'].includes(operation));
    if (transaction) assert.deepEqual(transaction, { fixture_transaction: true });
    if (!state.allowed) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    return { scope: { ...scope }, resource_binding_id: state.binding, authority_version: state.version, expires_at: 9000 };
  } };
  const provider = { async readPage(actual: EmailScope, _request: unknown, _capability: EmailCapability, recheck: () => Promise<void>) {
    assertScope(actual); await recheck(); state.providerCalls++; await state.providerRead(); await recheck(); return structuredClone(state.providerPage);
  } };
  const service = new EmailMailboxService(authority, store, provider, () => state.now);
  const list = () => service.list(actor, scope, { folder: 'inbox', cursor: null, limit: 25 });
  const sync = (overrides: Partial<{ expected_checkpoint_revision: number; cursor: string | null; page_id: string }> = {}) =>
    service.syncPage(actor, scope, { expected_checkpoint_revision: 0, cursor: null, page_id: 'page-one', ...overrides });
  return { state, store, provider, authority, service, list, sync, receipts };
}
const errorCode = (code: string) => (error: unknown) => error instanceof EmailMailboxError && error.code === code;

test('server sync engine accepts a current lease closure without a human actor and freshly fences replay', async () => {
  const f = fixture(), transactions: unknown[] = [];
  const current = async (transaction?: unknown): Promise<EmailCapability> => {
    if (!f.state.allowed) throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); if (transaction) transactions.push(transaction);
    return { scope, resource_binding_id: f.state.binding, authority_version: f.state.version, expires_at: 5000 };
  };
  const run = () => syncEmailMailboxPage(scope, { page_id: 'job-page', expected_checkpoint_revision: 0, cursor: null },
    { current, store: f.store, provider: f.provider, now: () => f.state.now });
  assert.equal((await run()).state, 'applied'); assert.equal(transactions.length, 2);
  assert.equal((await run()).state, 'duplicate'); assert.equal(f.state.providerCalls, 1); assert.equal(f.state.authorityCalls, 0);
  f.state.allowed = false; await assert.rejects(run(), errorCode('EMAIL_ACCESS_DENIED'));
});

test('server sync engine rejects changed lease scope/version or deadline around held work', async () => {
  for (const change of ['scope', 'version', 'deadline']) {
    const f = fixture(); let changed = false;
    const current = async (): Promise<EmailCapability> => ({ scope: changed && change === 'scope' ? { ...scope, account_id: 'another-account' } : scope,
      resource_binding_id: f.state.binding, authority_version: changed && change === 'version' ? 'changed-lease' : 'lease-one',
      expires_at: changed && change === 'deadline' ? f.state.now : 5000 });
    f.state.providerRead = async () => { changed = true; };
    await assert.rejects(syncEmailMailboxPage(scope, { page_id: 'job-page', expected_checkpoint_revision: 0, cursor: null },
      { current, store: f.store, provider: f.provider, now: () => f.state.now }), errorCode('EMAIL_ACCESS_DENIED'));
    assert.equal(f.state.commits, 0);
  }
});

test('cached list exposes metadata and honest freshness without provider locator or provider I/O', async () => {
  const f = fixture(), page = await f.list();
  assert.equal(page.freshness, 'fresh'); assert.equal(page.count.exact_total, 1);
  assert.equal(page.items[0]!.logical_message_id, logical(1));
  assert.equal(JSON.stringify(page).includes('private_locator'), false); assert.equal(f.state.providerCalls, 0);
  f.state.now = 1600; assert.equal((await f.list()).freshness, 'stale');
  f.state.cache.observed_at = null; assert.equal((await f.list()).freshness, 'unknown');
  assert.equal(f.state.authorityCalls, 6);
});
test('every cached read freshly denies revoked authority', async () => {
  const f = fixture(); await f.list(); f.state.allowed = false;
  await assert.rejects(f.list(), errorCode('EMAIL_ACCESS_DENIED'));
});
test('revoke during held cached read prevents metadata exposure', async () => {
  const f = fixture(), entered = deferred(), held = deferred();
  f.state.cachedRead = async () => { entered.release(); await held.promise; };
  const read = f.list(); await entered.promise; f.state.allowed = false; held.release();
  await assert.rejects(read, errorCode('EMAIL_ACCESS_DENIED'));
});
test('changed authority version or resource binding during held cached read is denied', async () => {
  for (const change of ['version', 'binding'] as const) {
    const f = fixture(); f.state.cachedRead = async () => { f.state[change] = 'changed'; };
    await assert.rejects(f.list(), errorCode('EMAIL_ACCESS_DENIED'));
  }
});
test('another owner is denied before store I/O, and cross-account cached records fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.service.list({ ...actor, user_id: 'owner-b' }, scope, { folder: 'inbox', cursor: null, limit: 25 }), errorCode('EMAIL_ACCESS_DENIED'));
  assert.equal(f.state.authorityCalls, 0);
  f.state.rows[0]!.account_id = 'account-b'; await assert.rejects(f.list(), errorCode('EMAIL_PAGE_INVALID'));
});
test('partial cache cannot claim an exact total, and future observations are rejected', async () => {
  const f = fixture(); f.state.cache.coverage = 'partial';
  await assert.rejects(f.list(), errorCode('EMAIL_PAGE_INVALID'));
  f.state.cache.exact_total = null; assert.equal((await f.list()).coverage, 'partial');
  f.state.cache.observed_at = new Date(1001).toISOString(); await assert.rejects(f.list(), errorCode('EMAIL_PAGE_INVALID'));
});
test('sync commits once and exact retry returns a receipt without another provider request', async () => {
  const f = fixture(); assert.equal((await f.sync()).state, 'applied');
  assert.equal((await f.sync()).state, 'duplicate'); assert.equal(f.state.commits, 1); assert.equal(f.state.providerCalls, 1);
  await assert.rejects(f.sync({ cursor: 'edited' }), errorCode('EMAIL_SYNC_REPLAY_CONFLICT'));
  assert.equal(f.state.providerCalls, 1);
});
test('revocation denies receipt replay; a receipt never supplies permission', async () => {
  const f = fixture(); await f.sync(); f.state.allowed = false;
  await assert.rejects(f.sync(), errorCode('EMAIL_ACCESS_DENIED'));
});
test('stale checkpoint is rejected before provider I/O', async () => {
  const f = fixture(); f.state.revision = 1;
  await assert.rejects(f.sync(), errorCode('EMAIL_CHECKPOINT_CONFLICT')); assert.equal(f.state.providerCalls, 0);
});

test('has_more requires an advancing cursor but idle converged history can retain its checkpoint', async () => {
  for (const cursor of [null, 'same-history']) {
    const f = fixture(); f.state.cursor = cursor; f.state.providerPage.complete = false; f.state.providerPage.has_more = true; f.state.providerPage.next_cursor = cursor;
    await assert.rejects(f.sync({ cursor }), errorCode('EMAIL_PAGE_INVALID')); assert.equal(f.state.commits, 0);
  }
  const f = fixture(); f.state.cursor = 'idle-history'; f.state.providerPage.next_cursor = 'idle-history';
  const applied = await f.sync({ cursor: 'idle-history' }); assert.equal(applied.complete, true); assert.equal(applied.has_more, false);
  const replay = await f.sync({ cursor: 'idle-history' }); assert.equal(replay.state, 'duplicate'); assert.equal(replay.has_more, false);
  assert.equal(f.state.providerCalls, 1);
});

test('private provider state is bounded and unique, and inventory generations never enter public metadata', async () => {
  const update = { state_key: 'a'.repeat(64), generation: 'inventory-1', value: { phase: 'inventory', private_history: 'private-provider-history' } };
  for (const updates of [[update, update], [{ ...update, state_key: 'raw-private-folder' }], [{ ...update, value: { pending: 'x'.repeat(65536) } }], Array.from({ length: 9 }, (_, n) => ({ ...update, state_key: n.toString(16).padStart(64, '0') }))]) {
    const f = fixture(); f.state.providerPage.state_updates = updates;
    await assert.rejects(f.sync(), errorCode('EMAIL_PAGE_INVALID')); assert.equal(f.state.commits, 0);
  }
  const f = fixture(); f.state.providerPage.state_updates = [update]; f.state.providerPage.items[0]!.inventory_generation = update.generation;
  await f.sync(); const page = await f.list();
  for (const privateField of ['inventory_generation', 'private-provider-history', 'state_updates']) assert.equal(JSON.stringify(page).includes(privateField), false);
});
test('provider-held revoke cannot commit any private metadata or checkpoint', async () => {
  const f = fixture(), entered = deferred(), held = deferred();
  f.state.providerRead = async () => { entered.release(); await held.promise; };
  const sync = f.sync(); await entered.promise; f.state.allowed = false; held.release();
  await assert.rejects(sync, errorCode('EMAIL_ACCESS_DENIED')); assert.equal(f.state.revision, 0); assert.equal(f.state.commits, 0);
});
test('final transaction guard denies revoke while waiting for commit locks', async () => {
  const f = fixture(); f.state.beforeCommit = async () => { f.state.allowed = false; };
  await assert.rejects(f.sync(), errorCode('EMAIL_ACCESS_DENIED')); assert.equal(f.state.revision, 0); assert.equal(f.receipts.size, 0);
});
test('failed checkpoint transaction leaves data and retry unchanged', async () => {
  const f = fixture(); f.state.providerPage.items = [record(2)]; f.state.providerPage.tombstones = [logical(1)]; f.state.failCommit = true;
  await assert.rejects(f.sync(), /checkpoint transaction rolled back/);
  assert.deepEqual(f.state.rows.map(row => row.logical_message_id), [logical(1)]); assert.equal(f.state.revision, 0); assert.equal(f.receipts.size, 0);
  f.state.failCommit = false; await f.sync(); assert.deepEqual(f.state.rows.map(row => row.logical_message_id), [logical(2)]);
});
test('concurrent pages for one checkpoint commit only one effective page', async () => {
  const f = fixture(), entered = deferred(), held = deferred(); let calls = 0;
  f.state.providerRead = async () => { if (++calls === 2) entered.release(); await held.promise; };
  const results = Promise.allSettled([f.sync(), f.sync({ page_id: 'page-two' })]); await entered.promise; held.release();
  const settled = await results;
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  const failed = settled.find(result => result.status === 'rejected')!;
  assert.ok(failed.status === 'rejected' && errorCode('EMAIL_CHECKPOINT_CONFLICT')(failed.reason));
  assert.equal(f.state.commits, 1); assert.equal(f.state.revision, 1);
});
test('concurrent exact replay has one commit and one duplicate', async () => {
  const f = fixture(), entered = deferred(), held = deferred(); let calls = 0;
  f.state.providerRead = async () => { if (++calls === 2) entered.release(); await held.promise; };
  const results = Promise.all([f.sync(), f.sync()]); await entered.promise; held.release();
  assert.deepEqual((await results).map(result => result.state).sort(), ['applied', 'duplicate']); assert.equal(f.state.commits, 1);
});
test('cross-account provider result, duplicate logical IDs and complete partial-failure page cannot commit', async () => {
  for (const mutate of [(page: EmailProviderPage) => { page.account_id = 'account-b'; },
    (page: EmailProviderPage) => { page.items[0]!.account_id = 'account-b'; },
    (page: EmailProviderPage) => { page.items.push(record()); },
    (page: EmailProviderPage) => { page.failure_count = 1; },
    (page: EmailProviderPage) => { page.complete = false; page.next_cursor = 'next'; page.failure_count = 1; },
    (page: EmailProviderPage) => { page.tombstones = [logical(1)]; }]) {
    const f = fixture(); mutate(f.state.providerPage);
    await assert.rejects(f.sync(), errorCode('EMAIL_PAGE_INVALID')); assert.equal(f.state.commits, 0);
  }
});
test('session expiration and abort after held I/O deny fresh cached output', async () => {
  const f = fixture(); f.state.cachedRead = async () => { f.state.now = actor.access_expires_at; };
  await assert.rejects(f.list(), errorCode('EMAIL_ACCESS_DENIED'));
  const aborted = fixture(), controller = new AbortController(); aborted.state.cachedRead = async () => { controller.abort(); };
  await assert.rejects(aborted.service.list(actor, scope, { folder: 'inbox', cursor: null, limit: 25 }, controller.signal), { name: 'AbortError' });
});
test('postcommit revoke denies result delivery without losing durable receipt', async () => {
  const f = fixture(); f.state.afterCommit = async () => { f.state.allowed = false; };
  await assert.rejects(f.sync(), errorCode('EMAIL_ACCESS_DENIED')); assert.equal(f.state.commits, 1); assert.equal(f.receipts.size, 1);
});
