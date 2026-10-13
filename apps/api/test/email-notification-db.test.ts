import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailMailboxService, type EmailActor, type EmailMessageRecord, type EmailProviderPage, type EmailScope } from '../src/lib/email-mailbox-service.js';
import { PostgresEmailMailboxStore } from '../src/lib/email-mailbox-store.js';
import { EmailUnreadService } from '../src/lib/email-unread.js';
import { EmailNativeTriageService } from '../src/lib/email-native-triage.js';
import { repairNativeEmailNotificationsBatch } from '../src/lib/email-notification-scheduler-runtime.js';
import { emailNativeTriageSourceFingerprint } from '../src/lib/email-native-triage.js';

const TARGET = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_notifications_87';
const safe = process.env.DATABASE_URL === TARGET && process.env.DEFT_TEST_DATABASE_URL === TARGET;
const logical = (n: number) => 'mail_' + n.toString(16).padStart(64, '0');

test('migration87 idempotence and PostgreSQL new-mail outbox baseline/dedupe/rollback', { skip: !safe, timeout: 120_000 }, async t => {
  const url = process.env.DATABASE_URL!;
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const identity = await pool.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port,host(inet_server_addr()) AS host');
  assert.deepEqual(identity.rows[0], { db: 'email_stage34_notifications_87', role: 'gate_g_test', port: 55435, host: '127.0.0.1' });
  const migration = readFileSync(fileURLToPath(new URL('../../../packages/db/upgrades/0.3.0-preview.87-email-notifications-unread.sql', import.meta.url)), 'utf8');
  await pool.query(migration); // Actual DDL is deliberately idempotent.
  const drizzleDb = drizzle(pool, { schema: { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } });
  const org = 'email-notification-' + randomUUID(), owner = 'owner-' + randomUUID(), binding = 'binding-' + randomUUID();
  const actor: EmailActor = { user_id: owner, web_session_id: 'sid-' + randomUUID(), access_expires_at: Date.now() + 60_000 };
  await pool.query('INSERT INTO org_members(org_id,user_id) VALUES($1,$2)', [org, owner]);
  await pool.query('INSERT INTO app_resource_bindings(org_id,id,owner_user_id) VALUES($1,$2,$3)', [org, binding, owner]);
  t.after(async () => {
    for (const table of ['email_notification_events','email_notification_states','email_sync_receipts','email_provider_states','email_memberships','email_messages','email_checkpoints','email_accounts']) {
      await pool.query(`DELETE FROM ${table} WHERE org_id=$1 AND owner_user_id=$2`, [org, owner]);
    }
    await pool.query('DELETE FROM job_queue WHERE org_id=$1', [org]);
    await pool.query('DELETE FROM app_resource_bindings WHERE org_id=$1 AND owner_user_id=$2', [org, owner]);
    await pool.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [org, owner]);
    await pool.end();
  });
  const scope: EmailScope = { org_id: org, owner_user_id: owner, account_id: 'account-' + randomUUID() };
  await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [scope.org_id, scope.owner_user_id, scope.account_id, 'gmail', binding, 'a'.repeat(64), 'active', 1, new Date()]);
  const key = Buffer.alloc(32, 17), keys = { current: () => ({ key_id: 'email-notification-test', key: Buffer.from(key) }),
    read: (_purpose: unknown, id: string) => id === 'email-notification-test' ? { key_id: id, key: Buffer.from(key) } : null,
    keyIds: () => ['email-notification-test'] };
  const store = new PostgresEmailMailboxStore(drizzleDb, new EmailMailboxCrypto(keys));
  const state = { page: null as EmailProviderPage | null, calls: 0, txGuards: 0, failFinal: false };
  const authority = { async current(host: EmailActor, selected: EmailScope, _operation: unknown, transaction?: unknown) {
    assert.deepEqual(host, actor); assert.deepEqual(selected, scope);
    if (transaction && state.failFinal && ++state.txGuards === 2) throw new Error('notification atomic rollback fixture');
    return { scope, resource_binding_id: binding, authority_version: 'authority:1', expires_at: actor.access_expires_at };
  } };
  const provider = { async readPage(_scope: EmailScope, _input: unknown, _cap: unknown, recheck: () => Promise<void>) {
    state.calls++; await recheck(); if (!state.page) throw new Error('missing fixture page'); return structuredClone(state.page);
  } };
  const service = new EmailMailboxService(authority, store, provider);
  const record = (n: number, flags = { seen: false, flagged: false, answered: false }, folders = ['inbox']): EmailMessageRecord => ({
    account_id: scope.account_id, logical_message_id: logical(n), revision: `source-${n}`,
    received_at: new Date(Date.now() - 1000).toISOString(), folders, flags, data: { subject: `private subject ${n}` },
    provider_source: { schema_version: 'deft.email_provider_source.v1', account_id: scope.account_id, logical_message_id: logical(n),
      provider: 'gmail', locator: `private-locator-${n}` },
  });
  const page = (items: EmailMessageRecord[], complete = true, tombstones: string[] = []): EmailProviderPage => ({
    account_id: scope.account_id, items, next_cursor: null, complete, has_more: false, observed_at: new Date().toISOString(),
    failure_count: 0, tombstones, state_updates: [],
  });
  const sync = (page_id: string, expected_checkpoint_revision: number) => service.syncPage(actor, scope, { page_id, expected_checkpoint_revision, cursor: null });

  await t.test('initial inventory is quiet; only new unread Inbox arrivals create one event and one queue row', async () => {
    state.page = page([record(1)]); await sync('baseline', 0);
    assert.equal((await pool.query('SELECT initial_inventory_complete FROM email_notification_states WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(scope))).rows[0].initial_inventory_complete, true);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM email_notification_events WHERE org_id=$1', [org])).rows[0].n), 0);
    state.page = page([record(2), record(3, { seen: true, flagged: false, answered: false }), record(4, { seen: false, flagged: false, answered: false }, ['Archive'])]);
    await sync('arrivals', 1);
    const events = await pool.query('SELECT logical_message_id,state FROM email_notification_events WHERE org_id=$1 ORDER BY logical_message_id', [org]);
    assert.deepEqual(events.rows, [{ logical_message_id: logical(2), state: 'pending' }]);
    const queued = await pool.query("SELECT name,data,dedupe_key FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch'", [org]);
    assert.equal(queued.rowCount, 1); assert.equal(queued.rows[0].data.notification_id.length, 36);
    assert.equal(queued.rows[0].data.authority_revision, 1); assert.equal(queued.rows[0].dedupe_key, `email-notification:${queued.rows[0].data.notification_id}:1`);
    assert.equal(JSON.stringify(queued.rows).includes('private subject'), false); assert.equal(JSON.stringify(queued.rows).includes('private-locator'), false);
    assert.equal((await sync('arrivals', 1)).state, 'duplicate');
    assert.equal((await pool.query("SELECT count(*) n FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch'", [org])).rows[0].n, '1');
  });

  await t.test('bounded repair recreates one missing delivery under concurrent scans and suppresses disconnected accounts', async () => {
    const event = await pool.query('SELECT notification_id,revision FROM email_notification_events WHERE org_id=$1 AND logical_message_id=$2', [org, logical(2)]);
    assert.equal(event.rowCount, 1);
    const notificationId = event.rows[0].notification_id as string;
    await pool.query("DELETE FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch' AND dedupe_key=$2",
      [org, `email-notification:${notificationId}:${event.rows[0].revision}`]);
    await Promise.all([repairNativeEmailNotificationsBatch(null, 20), repairNativeEmailNotificationsBatch(null, 20)]);
    const requeued = await pool.query("SELECT id,status FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch' AND dedupe_key=$2",
      [org, `email-notification:${notificationId}:${event.rows[0].revision}`]);
    assert.equal(requeued.rowCount, 1);
    assert.equal(requeued.rows[0].status, 'pending');

    const staleId = randomUUID();
    await pool.query(`INSERT INTO email_notification_events(org_id,owner_user_id,account_id,notification_id,logical_message_id,revision,authority_revision,state)
      VALUES($1,$2,$3,$4,$5,1,1,'pending')`, [scope.org_id, scope.owner_user_id, scope.account_id, staleId, logical(990)]);
    await pool.query("UPDATE email_accounts SET state='paused',authority_revision=authority_revision+1 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3", Object.values(scope));
    await repairNativeEmailNotificationsBatch(null, 20);
    assert.equal((await pool.query('SELECT state FROM email_notification_events WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 AND notification_id=$4',
      [...Object.values(scope), staleId])).rows[0].state, 'suppressed');
    assert.equal((await pool.query("SELECT count(*) n FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch' AND data->>'notification_id'=$2",
      [org, staleId])).rows[0].n, '0');
    await pool.query("UPDATE email_accounts SET state='active',authority_revision=authority_revision+1 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3", Object.values(scope));
  });

  await t.test('tombstone resurrection does not create a second new-mail event', async () => {
    state.page = page([], true, [logical(2)]); await sync('remove', 2);
    state.page = page([record(2)]); await sync('resurrect', 3);
    assert.equal((await pool.query('SELECT count(*) n FROM email_notification_events WHERE org_id=$1 AND logical_message_id=$2', [org, logical(2)])).rows[0].n, '1');
    assert.equal((await pool.query("SELECT count(*) n FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch'", [org])).rows[0].n, '1');
  });

  await t.test('final authority failure rolls back event, queue row, cache page and receipt together', async () => {
    state.page = page([record(5)]); state.failFinal = true; state.txGuards = 0;
    await assert.rejects(sync('rollback', 4), /notification atomic rollback fixture/);
    assert.equal(await store.readSyncReceipt(scope, 'rollback'), null);
    assert.equal(await store.readMessage(scope, logical(5)), null);
    assert.equal((await pool.query('SELECT count(*) n FROM email_notification_events WHERE org_id=$1 AND logical_message_id=$2', [org, logical(5)])).rows[0].n, '0');
    assert.equal((await pool.query("SELECT count(*) n FROM job_queue WHERE org_id=$1 AND name='native-email-notification-dispatch'", [org])).rows[0].n, '1');
    state.failFinal = false; state.txGuards = 0; await sync('rollback', 4);
    assert.equal((await pool.query('SELECT count(*) n FROM email_notification_events WHERE org_id=$1 AND logical_message_id=$2', [org, logical(5)])).rows[0].n, '1');
  });

  await t.test('unread counts are scope/folder accurate, exclude local Inbox snooze, and go unknown on partial coverage', async () => {
    const unread = new EmailUnreadService(authority, store, async () => new Set([logical(1)]));
    const inbox = await unread.read(actor, scope, 'INBOX');
    assert.equal(inbox.folder, 'inbox', 'legacy uppercase alias is normalized to the provider-native canonical folder');
    assert.equal(inbox.coverage, 'complete'); assert.equal(inbox.unread_count, 2);
    assert.equal(inbox.cached_unread_count, 2);
    const all = await unread.read(actor, scope, 'all');
    assert.equal(all.unread_count, 4, 'the Archive row is counted once in all mail; the read row is excluded');
    state.page = { ...page([]), complete: false, has_more: true, next_cursor: 'next-provider-page' };
    await sync('partial-unread', 5);
    const partial = await unread.read(actor, scope, 'INBOX');
    assert.equal(partial.unread_count, null); assert.equal(partial.cached_unread_count, 2); assert.equal(partial.coverage, 'partial');
  });

  await t.test('confirmed cache flags fence an in-flight page, then a newer provider revision reconciles normally', async () => {
    const before = await store.readMessage(scope, logical(1)); assert.ok(before);
    const sourceDigest = emailNativeTriageSourceFingerprint(before);
    const checkpoint = await store.readCheckpoint(scope);
    const providerResult = { schema_version: 'deft.email_native_triage_result.v1' as const, account_id: scope.account_id,
      operation_id: randomUUID(), operation: 'mark_read' as const, items: [{ logical_message_id: before.logical_message_id, state: 'succeeded' as const,
        undo_supported: false, confirmed_flags: { seen: true, flagged: null, answered: null } }], undo_available: false, automatic_retry: false as const };
    const triage = new EmailNativeTriageService(authority, store, { async invoke(_scope, _request, _capability, recheck, beforeReserve) {
      await recheck(); await beforeReserve(); return providerResult;
    } });
    const applied = await triage.apply(actor, scope, { operation_id: providerResult.operation_id, kind: 'mark_read', logical_message_ids: [before.logical_message_id] });
    assert.equal(applied.items[0]?.state, 'succeeded');
    assert.equal(Object.hasOwn(applied.items[0] ?? {}, 'confirmed_flags'), false, 'cache acknowledgment remains internal');
    assert.equal((await store.readMessage(scope, logical(1)))?.flags.seen, true);
    const stalePage = (pageId: string, expected: number, cursor: string | null, item: EmailMessageRecord) => ({ request_digest: 'a'.repeat(64), page_digest: 'b'.repeat(64),
      page_id: pageId, expected_checkpoint_revision: expected, input_cursor: cursor, authority_version: 'authority:1', resource_binding_id: binding,
      page: page([item], false) });
    await assert.rejects(store.commitPage(scope, stalePage('before-ack-page', checkpoint.revision, checkpoint.cursor, before), async () => {}), /EMAIL_CHECKPOINT_CONFLICT/);

    const external = record(1); external.revision = 'source-1-external'; external.flags.seen = false;
    external.provider_source = { ...external.provider_source, locator: 'provider-newer-revision' };
    const afterAck = await store.readCheckpoint(scope);
    await store.commitPage(scope, stalePage('after-ack-refresh', afterAck.revision, afterAck.cursor, external), async () => {});
    const afterRefresh = await store.readMessage(scope, logical(1)); assert.ok(afterRefresh);
    assert.equal(afterRefresh.revision, 'source-1-external'); assert.equal(afterRefresh.flags.seen, false);
    const staleAck = await store.acknowledgeFlags(scope, [{ logical_message_id: before.logical_message_id, expected_revision: before.revision,
      expected_source_digest: sourceDigest, flags: { seen: true, flagged: null, answered: null } }], async () => {});
    assert.deepEqual(staleAck, { acknowledged: 0, stale: 1 });
    assert.equal((await store.readMessage(scope, logical(1)))?.flags.seen, false);
  });
});
