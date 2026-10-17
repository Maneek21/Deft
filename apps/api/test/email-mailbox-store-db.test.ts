import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import { EmailMailboxService, EmailMailboxError, type EmailScope, type EmailProviderPage, type EmailMessageRecord, type EmailActor } from '../src/lib/email-mailbox-service.js';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { PostgresEmailMailboxStore } from '../src/lib/email-mailbox-store.js';
import { openPreparedCurrentEmailMailboxTestDatabase, EMAIL_MAILBOX_TEST_DATABASE_URL } from './fixtures/email-mailbox-database.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === EMAIL_MAILBOX_TEST_DATABASE_URL && process.env.DATABASE_URL === EMAIL_MAILBOX_TEST_DATABASE_URL;
const logical = (n: number) => 'mail_' + n.toString(16).padStart(64, '0');
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('actual PostgreSQL native mailbox service/store atomicity, isolation and revocation', { skip: !safe, timeout: 120000 }, async t => {
  // Retained migration63 base plus opt-in current account/notification setup. This test only inserts
  // rows under a newly generated namespace and never touches another database.
  const prepared = await openPreparedCurrentEmailMailboxTestDatabase(); await prepared.end();
  const pool = new pg.Pool({ connectionString: target, max: 6 });
  const schema = { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts };
  const db = drizzle(pool, { schema });
  const org = 'email-store-test-' + randomUUID(), owner = 'owner-' + randomUUID(), binding = 'binding-' + randomUUID();
  const actor: EmailActor = { user_id: owner, web_session_id: 'sid-' + randomUUID(), access_expires_at: Date.now() + 120000 };
  await pool.query('INSERT INTO org_members(org_id,user_id) VALUES($1,$2)', [org, owner]);
  await pool.query('INSERT INTO app_resource_bindings(org_id,id,owner_user_id) VALUES($1,$2,$3)', [org, binding, owner]);
  t.after(async () => {
    // Exact generated namespace, leaf-first because production FKs restrict.
    for (const table of ['email_notification_events', 'email_notification_states', 'email_provider_states', 'email_sync_receipts', 'email_memberships', 'email_messages', 'email_checkpoints', 'email_accounts']) {
      await pool.query(`DELETE FROM ${table} WHERE org_id=$1 AND owner_user_id=$2`, [org, owner]);
    }
    await pool.query('DELETE FROM app_resource_bindings WHERE org_id=$1 AND owner_user_id=$2', [org, owner]);
    await pool.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [org, owner]);
    await pool.end();
  });
  const keys = { current: () => ({ key_id: 'email-db-test', key: Buffer.alloc(32, 17) }),
    read: (_purpose: unknown, key: string) => key === 'email-db-test' ? { key_id: key, key: Buffer.alloc(32, 17) } : null, keyIds: () => ['email-db-test'] };
  const cipher = new EmailMailboxCrypto(keys), store = new PostgresEmailMailboxStore(db, cipher);
  const where = (account: EmailScope) => and(eq(emailAccounts.org_id, account.org_id), eq(emailAccounts.owner_user_id, account.owner_user_id), eq(emailAccounts.account_id, account.account_id));
  async function fixture() {
    const scope: EmailScope = { org_id: org, owner_user_id: owner, account_id: 'account-' + randomUUID() };
    await db.insert(emailAccounts).values({ ...scope, provider: 'gmail', resource_binding_id: binding, principal_digest: 'a'.repeat(64), state: 'active', authority_revision: 1, consented_at: new Date() });
    const record = (n: number): EmailMessageRecord => ({ account_id: scope.account_id, logical_message_id: logical(n), revision: 'revision-' + n,
      received_at: new Date(1000 + n).toISOString(), folders: ['inbox'], flags: { seen: false, flagged: false, answered: false },
      data: { subject: 'Fixture hidden subject ' + n }, provider_source: { account_id: scope.account_id, locator: 'fixture-hidden-locator-' + n } });
    const state = { calls: 0, page: { account_id: scope.account_id, items: [record(1), record(2)], next_cursor: null,
      complete: true, has_more: false, observed_at: new Date().toISOString(), failure_count: 0, tombstones: [], state_updates: [] } as EmailProviderPage,
      providerHeld: async () => {}, commitGuards: 0, failFinalGuard: false };
    const authority = { async current(host: EmailActor, selected: EmailScope, _operation: unknown, transaction?: unknown) {
      assert.deepEqual(host, actor); assert.deepEqual(selected, scope);
      const read = async (executor: typeof db) => {
        const [account] = await executor.select().from(emailAccounts).where(where(scope)).limit(1).for('share');
        if (!account || account.state !== 'active' || account.revoked_at) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
        if (transaction && ++state.commitGuards === 2 && state.failFinalGuard) throw new Error('fixture final commit fence failed');
        return { scope: { ...scope }, resource_binding_id: account.resource_binding_id,
          authority_version: 'account:' + account.authority_revision, expires_at: actor.access_expires_at };
      };
      return transaction ? read(transaction as typeof db) : db.transaction(tx => read(tx as unknown as typeof db));
    } };
    const provider = { async readPage(_scope: EmailScope, _input: unknown, _capability: unknown, recheck: () => Promise<void>) {
      state.calls++; await state.providerHeld(); await recheck(); return structuredClone(state.page);
    } };
    const service = new EmailMailboxService(authority, store, provider);
    const sync = (page_id = 'page-one', revision = 0) => service.syncPage(actor, scope, { page_id, expected_checkpoint_revision: revision, cursor: null });
    const list = (cursor: string | null = null, limit = 100) => service.list(actor, scope, { folder: 'all', cursor, limit });
    return { scope, state, service, sync, list, record, authority };
  }
  await t.test('durable encrypted metadata survives a new store instance; scopes and exact retry stay separate', async () => {
    const f = await fixture(); await f.sync();
    assert.equal((await f.sync()).state, 'duplicate'); assert.equal(f.state.calls, 1);
    const page = await f.list(); assert.equal(page.items.length, 2); assert.equal(page.count.exact_total, 2);
    assert.equal(JSON.stringify(page).includes('fixture-hidden-locator'), false);
    const reopened = new PostgresEmailMailboxStore(db, cipher);
    assert.equal((await reopened.readPage(f.scope, { folder: 'inbox', cursor: null, limit: 100 })).items.length, 2);
    assert.deepEqual(await reopened.readMessage(f.scope,logical(1)),f.record(1));
    assert.equal(await reopened.readMessage({...f.scope,owner_user_id:randomUUID()},logical(1)),null);
    const raw = await pool.query('SELECT summary_envelope,source_envelope FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(f.scope));
    assert.equal(JSON.stringify(raw.rows).includes('Fixture hidden subject'), false); assert.equal(JSON.stringify(raw.rows).includes('fixture-hidden-locator'), false);
    const other = await fixture(); assert.equal((await other.list()).items.length, 0);
    assert.equal(await reopened.readMessage(other.scope,logical(1)),null);await other.sync();
    assert.equal((await f.list()).items.length, 2); assert.equal((await other.list()).items.length, 2);
    await assert.rejects(f.service.syncPage(actor, f.scope, { page_id: 'page-one', expected_checkpoint_revision: 0, cursor: 'altered' }),
      (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_SYNC_REPLAY_CONFLICT');
  });
  await t.test('Starred uses the common message flag even when provider folder membership has no starred role',async()=>{
    const f=await fixture();f.state.page.items[0]!.flags.flagged=true;await f.sync();
    const page=await f.service.list(actor,f.scope,{folder:'starred',cursor:null,limit:50});
    assert.deepEqual(page.items.map(row=>row.logical_message_id),[logical(1)]);assert.equal(page.count.exact_total,1);
  });
  await t.test('search inserts are encrypted and openable, preserve newer cache and never revive tombstones',async()=>{
    const f=await fixture();await f.sync();
    f.state.page.items=[];f.state.page.tombstones=[logical(2)];await f.sync('delete-before-search',1);
    const changed={...f.record(1),revision:'stale-search',flags:{seen:true,flagged:true,answered:true},data:{subject:'Stale search value'}};
    const result=await store.persistSearchResults(f.scope,[changed,f.record(2),f.record(3)],async tx=>{await f.authority.current(actor,f.scope,'human_read',tx);});
    assert.equal(result.dropped,1);assert.deepEqual(result.records.map(row=>row.logical_message_id),[logical(1),logical(3)]);
    assert.deepEqual(result.records[0],f.record(1));assert.deepEqual(await store.readMessage(f.scope,logical(3)),f.record(3));
    assert.equal(await store.readMessage(f.scope,logical(2)),null);
    const checkpoint=await store.readCheckpoint(f.scope);assert.equal(checkpoint.revision,3);
    const page=await f.list();assert.equal(page.coverage,'partial');assert.equal(page.count.exact_total,null);
    const raw=await pool.query('SELECT source_envelope,summary_envelope FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',[...Object.values(f.scope)]);
    assert.equal(JSON.stringify(raw.rows).includes('Fixture hidden'),false);
  });
  await t.test('late search authorization failure rolls back new records and coverage changes',async()=>{
    const f=await fixture();await f.sync();let guards=0;
    await assert.rejects(store.persistSearchResults(f.scope,[f.record(9)],async tx=>{
      await f.authority.current(actor,f.scope,'human_read',tx);if(++guards===2)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    }),/EMAIL_ACCESS_DENIED/);
    assert.equal(await store.readMessage(f.scope,logical(9)),null);assert.equal((await f.list()).coverage,'complete');
  });
  await t.test('throw after message, generation, provider-state, checkpoint and receipt writes rolls back atomically', async () => {
    const f = await fixture(), state_key = 'd'.repeat(64), generation = 'inventory-rollback';
    f.state.page.items[0]!.inventory_generation = generation;
    f.state.page.state_updates = [{ state_key, generation, value: { cursor: 'private-state-cursor' } }];
    f.state.failFinalGuard = true;
    await assert.rejects(f.sync(), /fixture final commit fence failed/);
    assert.deepEqual(await store.readCheckpoint(f.scope), { revision: 0, cursor: null, has_more: false }); assert.equal(await store.readSyncReceipt(f.scope, 'page-one'), null);
    assert.equal((await f.list()).items.length, 0);
    assert.equal(await store.readProviderState(f.scope, state_key), null);
    assert.deepEqual(await store.readStaleRecords(f.scope, generation, null, 100), []);
    f.state.failFinalGuard = false; f.state.commitGuards = 0; await f.sync(); assert.equal((await f.list()).items.length, 2);
    assert.deepEqual(await store.readProviderState(f.scope, state_key), { state_key, generation, value: { cursor: 'private-state-cursor' }, storage_revision: 1 });
  });
  await t.test('concurrent competing pages have one durable winner', async () => {
    const f = await fixture(), entered = barrier(), held = barrier();
    f.state.providerHeld = async () => { if (f.state.calls === 2) entered.release(); await held.promise; };
    const results = Promise.allSettled([f.sync('page-a'), f.sync('page-b')]); await entered.promise; held.release();
    const settled = await results; assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = settled.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof EmailMailboxError && rejected.reason.code === 'EMAIL_CHECKPOINT_CONFLICT');
    assert.equal((await store.readCheckpoint(f.scope)).revision, 1); assert.equal((await f.list()).items.length, 2);
  });
  await t.test('concurrent identical pages produce one durable commit and a duplicate receipt', async () => {
    const f = await fixture(), entered = barrier(), held = barrier();
    f.state.providerHeld = async () => { if (f.state.calls === 2) entered.release(); await held.promise; };
    const results = Promise.all([f.sync(), f.sync()]); await entered.promise; held.release();
    assert.deepEqual((await results).map(result => result.state).sort(), ['applied', 'duplicate']);
    assert.equal((await store.readCheckpoint(f.scope)).revision, 1);
  });
  await t.test('tombstone clears durable private envelopes and folder memberships atomically', async () => {
    const f = await fixture(); await f.sync(); f.state.page.items = []; f.state.page.tombstones = [logical(1)]; f.state.page.observed_at = new Date().toISOString();
    await f.sync('delete-page', 1); const page = await f.list(); assert.equal(page.items.length, 1); assert.equal(page.count.exact_total, 1);
    const deleted = await pool.query('SELECT summary_envelope,source_envelope,deleted_at FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 AND logical_message_id=$4', [...Object.values(f.scope), logical(1)]);
    assert.equal(deleted.rows[0].summary_envelope, null); assert.equal(deleted.rows[0].source_envelope, null); assert.ok(deleted.rows[0].deleted_at);
    const membership = await pool.query('SELECT COUNT(*) AS n FROM email_memberships WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 AND logical_message_id=$4', [...Object.values(f.scope), logical(1)]);
    assert.equal(Number(membership.rows[0].n), 0);
    assert.equal(await store.readMessage(f.scope,logical(1)),null);
  });
  await t.test('keyset cursor survives background sync and rejects another account', async () => {
    const f = await fixture(); await f.sync(); const cursor = (await f.list(null, 1)).next_cursor!;
    assert.equal((await f.list(cursor, 1)).items[0]!.logical_message_id, logical(1));
    const other = await fixture(); await other.sync();
    await assert.rejects(other.list(cursor, 1), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_PAGE_INVALID');
    f.state.page.items = [f.record(3)]; f.state.page.complete = false; f.state.page.observed_at = new Date().toISOString();
    await f.sync('refresh-page', 1);
    assert.equal((await f.list(cursor,1)).items[0]!.logical_message_id,logical(1));
    assert.equal((await f.list()).count.exact_total, null);
  });
  await t.test('held provider read is denied after durable account revocation without checkpoint advancement', async () => {
    const f = await fixture(), entered = barrier(), held = barrier();
    f.state.providerHeld = async () => { entered.release(); await held.promise; };
    const result = f.sync(); await entered.promise;
    await db.update(emailAccounts).set({ state: 'revoked', revoked_at: new Date(), authority_revision: 2 }).where(where(f.scope));
    held.release(); await assert.rejects(result, (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED');
    assert.equal((await store.readCheckpoint(f.scope)).revision, 0); assert.equal(await store.readSyncReceipt(f.scope, 'page-one'), null);
    await assert.rejects(f.list(), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED');
  });
  await t.test('has_more and retained idle history cursor survive durable commit and receipt replay independently from coverage', async () => {
    const f = await fixture(); f.state.page.complete = false; f.state.page.has_more = true; f.state.page.next_cursor = 'fixture-history';
    const first = await f.sync(); assert.equal(first.has_more, true); assert.equal(first.complete, false);
    assert.deepEqual(await store.readCheckpoint(f.scope), { revision: 1, cursor: 'fixture-history', has_more: true });
    f.state.page.complete = true; f.state.page.has_more = false; f.state.page.items = []; f.state.page.observed_at = new Date().toISOString();
    const request = { page_id: 'idle-history', expected_checkpoint_revision: 1, cursor: 'fixture-history' };
    assert.equal((await f.service.syncPage(actor, f.scope, request)).has_more, false);
    assert.deepEqual(await store.readCheckpoint(f.scope), { revision: 2, cursor: 'fixture-history', has_more: false });
    const replay = await f.service.syncPage(actor, f.scope, request); assert.equal(replay.state, 'duplicate'); assert.equal(replay.has_more, false); assert.equal(replay.complete, true);
  });
  await t.test('enrolled principal is immutable and active accounts cannot omit the principal binding', async () => {
    const f = await fixture();
    await assert.rejects(pool.query('UPDATE email_accounts SET principal_digest=$4,authority_revision=2 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [...Object.values(f.scope), 'b'.repeat(64)]),
      (error: unknown) => error instanceof Error && error.message === 'EMAIL_ACCOUNT_PRINCIPAL_IMMUTABLE');
    const account = await db.select().from(emailAccounts).where(where(f.scope)); assert.equal(account[0]!.principal_digest, 'a'.repeat(64));
    const pending = { ...f.scope, account_id: 'principal-unbound-' + randomUUID() };
    await db.insert(emailAccounts).values({ ...pending, provider: 'gmail', resource_binding_id: binding, state: 'disconnected', authority_revision: 1 });
    await assert.rejects(pool.query('UPDATE email_accounts SET state=$4,consented_at=now(),authority_revision=2 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [...Object.values(pending), 'active']),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514');
    await assert.rejects(pool.query('UPDATE email_accounts SET principal_digest=$4 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [...Object.values(pending), 'a'.repeat(64)]),
      (error: unknown) => error instanceof Error && error.message === 'EMAIL_ACCOUNT_REVISION_REQUIRED');
    await pool.query('UPDATE email_accounts SET principal_digest=$4,state=$5,consented_at=now(),authority_revision=2 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [...Object.values(pending), 'a'.repeat(64), 'active']);
  });
  await t.test('reconnect preserves account identity while requiring a revision and same-owner replacement binding', async () => {
    const f = await fixture(), replacement = 'binding-' + randomUUID(), wrong = 'binding-wrong-owner-' + randomUUID();
    await pool.query('INSERT INTO app_resource_bindings(org_id,id,owner_user_id) VALUES($1,$2,$3)', [org, replacement, owner]);
    await pool.query('INSERT INTO app_resource_bindings(org_id,id,owner_user_id) VALUES($1,$2,$3)', [org, wrong, owner + '-other']);
    const parameters = [...Object.values(f.scope), replacement];
    await assert.rejects(pool.query('UPDATE email_accounts SET resource_binding_id=$4 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', parameters),
      (error: unknown) => error instanceof Error && error.message === 'EMAIL_ACCOUNT_REVISION_REQUIRED');
    await pool.query('UPDATE email_accounts SET resource_binding_id=$4,authority_revision=2 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', parameters);
    const account = await pool.query('SELECT account_id,resource_binding_id,authority_revision FROM email_accounts WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(f.scope));
    assert.equal(account.rows[0].account_id, f.scope.account_id); assert.equal(account.rows[0].resource_binding_id, replacement); assert.equal(account.rows[0].authority_revision, 2);
    await assert.rejects(pool.query('UPDATE email_accounts SET resource_binding_id=$4,authority_revision=3 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [...Object.values(f.scope), wrong]),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === '23503');
    await pool.query('DELETE FROM app_resource_bindings WHERE org_id=$1 AND id=$2 AND owner_user_id=$3', [org, wrong, owner + '-other']);
  });
  await t.test('provider state is encrypted and scoped; stale reconciliation keyset excludes current and tombstoned rows', async () => {
    const f = await fixture(), state_key = 'e'.repeat(64), generation = 'inventory-current';
    f.state.page.items[0]!.inventory_generation = generation;
    f.state.page.state_updates = [{ state_key, generation, value: { cursor: 'private-stale-scan-position' } }];
    await f.sync();
    assert.deepEqual(await store.readProviderState(f.scope, state_key), { state_key, generation,
      value: { cursor: 'private-stale-scan-position' }, storage_revision: 1 });
    assert.equal((await store.readStaleRecords(f.scope, generation, null, 100)).length, 1);
    assert.deepEqual(await store.readStaleRecords(f.scope, generation, logical(2), 100), []);
    const other = await fixture(); assert.equal(await store.readProviderState(other.scope, state_key), null);
    assert.deepEqual(await store.readStaleRecords(other.scope, generation, null, 100), []);
    f.state.page.items = []; f.state.page.tombstones = [logical(2)]; f.state.page.state_updates = [];
    f.state.page.complete = false; f.state.page.observed_at = new Date().toISOString();
    await f.sync('stale-tombstone', 1);
    const stale = await store.readStaleRecords(f.scope, 'inventory-next', null, 100);
    assert.deepEqual(stale.map(record => record.logical_message_id), [logical(1)]);
    const raw = await pool.query('SELECT state_envelope FROM email_provider_states WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 AND state_key=$4', [...Object.values(f.scope), state_key]);
    assert.equal(JSON.stringify(raw.rows).includes('private-stale-scan-position'), false);
  });
});
