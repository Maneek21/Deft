import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import { EmailMailboxService, EmailMailboxError, type EmailActor, type EmailScope, type EmailAuthority } from '../src/lib/email-mailbox-service.js';
import { PostgresEmailMailboxStore } from '../src/lib/email-mailbox-store.js';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { ConnectedEmailMailboxAuthority } from '../src/lib/email-mailbox-connected-authority.js';
import { RegisteredEmailMailboxProvider } from '../src/lib/email-mailbox-provider.js';
import { EmailMailboxSearchService } from '../src/lib/email-mailbox-search.js';
import { EmailMessageContentService } from '../src/lib/email-message-content.js';
import { openPreparedEmailMailboxTestDatabase, EMAIL_MAILBOX_TEST_DATABASE_URL } from './fixtures/email-mailbox-database.js';
// Existing executable provider modules have no TypeScript declaration files.
// @ts-ignore
import { createAppConnectionAdapter } from '../../../examples/apps/email/providers/connection-http.mjs';
// @ts-ignore
import { createEncryptedEmailCustody } from '../../../examples/apps/email/providers/custody-encrypted.mjs';
// @ts-ignore
import { createOAuthProvider } from '../../../examples/apps/email/providers/oauth-provider.mjs';
// @ts-ignore
import { logicalMailIdForProviderMessage } from '../../../examples/apps/email/logical-mail-index.mjs';
// @ts-ignore
import { NATIVE_MICROSOFT_STATE_KEY } from '../../../examples/apps/email/providers/native-microsoft.mjs';

const safe = process.env.DATABASE_URL === EMAIL_MAILBOX_TEST_DATABASE_URL && process.env.DEFT_TEST_DATABASE_URL === EMAIL_MAILBOX_TEST_DATABASE_URL;
const copy = <T>(value: T): T => structuredClone(value);
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function memoryCiphertextStore() {
  const rows = new Map<string, { revision: number; value: unknown }>(), queues = new Map<string, Promise<void>>();
  return { async withLock({ key }: { key: string }, callback: (transaction: unknown) => Promise<unknown>) {
    const prior = queues.get(key) ?? Promise.resolve(); let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; }); queues.set(key, next); await prior;
    try { return await callback({ async read() { return copy(rows.get(key) ?? null); }, async compareAndSwap({ expected_revision, value }: { expected_revision: number | null; value: unknown }) {
      const row = rows.get(key); if ((row?.revision ?? null) !== expected_revision) return false;
      rows.set(key, { revision: (row?.revision ?? 0) + 1, value: copy(value) }); return true;
    } }); } finally { release(); if (queues.get(key) === next) queues.delete(key); }
  } };
}

test('actual PG public sync + registered OAuth bridge converges across restart and denies revoked custody cache reads', { skip: !safe, timeout: 60000 }, async t => {
  const prepared = await openPreparedEmailMailboxTestDatabase(); await prepared.end();
  const pool = new pg.Pool({ connectionString: EMAIL_MAILBOX_TEST_DATABASE_URL, max: 6 });
  const db = drizzle(pool, { schema: { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } });
  const org = 'email-provider-db-' + randomUUID(), owner = 'owner-' + randomUUID(), installation = 'installation-' + randomUUID();
  const actor: EmailActor = { user_id: owner, web_session_id: 'fixture-sid-' + randomUUID(), access_expires_at: Date.now() + 60000 };
  await pool.query('INSERT INTO org_members(org_id,user_id) VALUES($1,$2)', [org, owner]);
  t.after(async () => {
    for (const table of ['email_sync_receipts', 'email_provider_states', 'email_memberships', 'email_messages', 'email_checkpoints', 'email_accounts']) await pool.query(`DELETE FROM ${table} WHERE org_id=$1 AND owner_user_id=$2`, [org, owner]);
    await pool.query('DELETE FROM app_resource_bindings WHERE org_id=$1 AND owner_user_id=$2', [org, owner]);
    await pool.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [org, owner]); await pool.end();
  });
  const cipher = new EmailMailboxCrypto({ current: () => ({ key_id: 'joint-fixture', key: Buffer.alloc(32, 24) }),
    read: (_purpose: unknown, key_id: string) => key_id === 'joint-fixture' ? { key_id, key: Buffer.alloc(32, 24) } : null, keyIds: () => ['joint-fixture'] });
  const store = new PostgresEmailMailboxStore(db, cipher), custody = createEncryptedEmailCustody({ encryption_key: new Uint8Array(32).fill(25), key_id: 'joint-custody', store: memoryCiphertextStore(), now: Date.now });
  const adapters = new Map<string, { adapter: ReturnType<typeof createAppConnectionAdapter>; binding: any; principal: string }>();
  const network = { calls: [] as string[], changed: false, delta: false };
  const graph = { moved: false };
  const scopes: EmailScope[] = [];
  async function enroll(account_id: string, provider: 'gmail' | 'microsoft' = 'gmail') {
    const scope: EmailScope = { org_id: org, owner_user_id: owner, account_id }, binding_id = 'binding-' + randomUUID(); scopes.push(scope);
    await pool.query('INSERT INTO app_resource_bindings(org_id,id,owner_user_id) VALUES($1,$2,$3)', [org, binding_id, owner]);
    const provider_subject = 'fixture-principal-' + account_id;
    const principal = createHash('sha256').update(JSON.stringify([org, owner, provider, provider_subject])).digest('hex');
    await db.insert(emailAccounts).values({ ...scope, provider, resource_binding_id: binding_id, principal_digest: principal, state: 'active', authority_revision: 1, consented_at: new Date() });
    const client = { client_id: 'joint-client', client_secret: 'synthetic-fixture-client-secret', redirect_uri: 'https://fixture.invalid/callback', ...(provider === 'microsoft' ? { tenant: 'common' } : {}) };
    const binding = { scope: { org_id: org, owner_id: owner, installation_id: installation }, account_id, provider, connection_target: provider + '_connection', resource_binding_id: binding_id, action_binding_id: null, authority_epoch: 1, capabilities: ['read'] };
    const fetch = async (url: string, init: RequestInit) => {
      network.calls!.push(url); assert.equal(init.method, 'GET'); assert.ok(new Headers(init.headers).get('Authorization')?.startsWith('Bearer '));
      const parsed = new URL(url), id = parsed.pathname.split('/').pop()!;
      if (provider === 'microsoft') {
        assert.ok(new Headers(init.headers).get('Prefer')?.includes('ImmutableId'));
        const path = decodeURIComponent(parsed.pathname), known: Record<string, string> = { inbox: 'g-inbox', sentitems: 'g-sent' };
        const metadata = (message: string) => ({ id: message, conversationId: 'g-conversation', parentFolderId: message === 'graph-one' ? graph.moved ? 'g-sent' : 'g-inbox' : 'g-nested', subject: 'Joint Graph ' + message, receivedDateTime: '2026-10-04T00:00:00.000Z', isRead: true, flag: { flagStatus: 'notFlagged' }, hasAttachments: false });
        const well = /\/mailFolders\/([^/]+)$/.exec(path);
        if (well) return known[well[1]!] ? reply({ id: known[well[1]!] }) : new Response('{}', { status: 404 });
        if (path === '/v1.0/me/mailFolders') { assert.equal(parsed.searchParams.get('includeHiddenFolders'), 'true'); return reply({ value: ['g-inbox', 'g-sent', 'g-hidden'].map(id => ({ id })) }); }
        const folder = /\/mailFolders(?:\/([^/]+)|\('([^']+)'\))\/(childFolders|messages\/delta)$/.exec(path);
        if (folder) {
          const folderId = folder[1] ?? folder[2]!;
          if (folder[3] === 'childFolders') { assert.equal(parsed.searchParams.get('includeHiddenFolders'), 'true'); return reply({ value: folderId === 'g-hidden' ? [{ id: 'g-nested' }] : [] }); }
          const prior = parsed.searchParams.get('$deltatoken'), ids = !prior ? folderId === 'g-inbox' ? ['graph-one'] : folderId === 'g-nested' ? ['graph-nested'] : [] : [];
          const moved = prior && folderId === 'g-inbox' && !graph.moved; if (moved) graph.moved = true;
          return reply({ value: moved ? [{ id: 'graph-one', '@removed': { reason: 'deleted' } }] : ids.map(metadata), '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders('${folderId}')/messages/delta?$deltatoken=retained` });
        }
        const message = /\/messages\/([^/]+)$/.exec(path); if (message) return reply(metadata(message[1]!));
        assert.fail('unexpected Graph joint effect');
      }
      if (id === 'profile') return reply({ historyId: '100' });
      if (id === 'messages') { assert.equal(parsed.searchParams.get('includeSpamTrash'), 'true');
        if(parsed.searchParams.has('q')){assert.equal(parsed.searchParams.get('q'),'subject:"discovered"');return reply({messages:[{id:'discovered'}]});}
        return reply({ messages: [{ id: 'one' }, { id: 'two' }] }); }
      if(parsed.searchParams.get('format')==='raw')return reply({id,threadId:'fixture-thread',raw:Buffer.from('From: fixture@example.test\r\nSubject: Joint private discovered\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSearch opened this source.').toString('base64url')});
      if (id === 'history') {
        if (parsed.searchParams.get('startHistoryId') === '100') { network.changed = true; return reply({ history: [{ id: '101', messagesAdded: [{ message: { id: 'three' } }], messagesDeleted: [{ message: { id: 'two' } }], labelsRemoved: [{ message: { id: 'one' } }] }], historyId: '102' }); }
        if (network.delta && parsed.searchParams.get('startHistoryId') === '102') return reply({ history: [{ id: '103', labelsAdded: [{ message: { id: 'one' } }] }], historyId: '104' });
        return reply({ history: [], historyId: network.delta ? '104' : '102' });
      }
      if (id === 'retained-stale' || id === 'two' && network.changed) return new Response('{}', { status: 404 });
      return reply({ id, threadId: 'fixture-thread', internalDate: '100000', labelIds: id === 'one' && network.changed ? network.delta ? ['INBOX', 'STARRED'] : ['SENT'] : ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Joint private ' + id }] } });
    };
    await custody.withAccount(binding, async (tx: any) => tx.write({ health: 'connected', secret: { access_token: 'synthetic-fixture-access-token', refresh_token: 'synthetic-fixture-refresh-token', expires_at: Date.now() + 3600000,
      scopes: provider === 'gmail' ? ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'] : ['offline_access', 'User.Read', 'Mail.Read'], client_fingerprint: createOAuthProvider({ provider, client, fetch, now: Date.now }).client_fingerprint,
      identity: { provider_subject, primary_address: 'fixture@example.test', display_label: 'Fixture account', verified_sender_identities: ['fixture@example.test'] } } }));
    const { scope: _privateScope, ...deployment } = binding;
    const adapter = await createAppConnectionAdapter({ host: { resolveContext: async () => assert.fail('native must not resolve Experience'), assertCurrent: async () => assert.fail('native must not resolve Experience') },
      options: { origin: 'https://fixture.invalid', ...deployment, clients: { [provider]: client } }, custody, fetch, now: Date.now });
    adapters.set(account_id, { adapter, binding, principal }); return scope;
  }
  // Real SQL account state is the fixture authority seam; full SID/member/App
  // graph semantics remain covered by parent authority tests, not this fixture.
  const base: EmailAuthority = { async current(host, scope, _operation, transaction) {
    assert.deepEqual(host, actor); if (scope.org_id !== org || scope.owner_user_id !== owner) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const read = async (executor: typeof db) => {
      const [row] = await executor.select().from(emailAccounts).where(and(eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id))).limit(1).for('share');
      if (!row || row.state !== 'active' || row.revoked_at) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      return { scope, resource_binding_id: row.resource_binding_id, authority_version: 'fixture:' + row.authority_revision, expires_at: actor.access_expires_at };
    };
    return transaction ? read(transaction as typeof db) : db.transaction(tx => read(tx as unknown as typeof db));
  } };
  function componentsFor(activeStore: PostgresEmailMailboxStore) {
    const bridge = new RegisteredEmailMailboxProvider(async (scope, capability, recheck, signal, purpose) => {
      const entry = adapters.get(scope.account_id); if (!entry) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      const initial = await base.current(actor, scope, 'human_sync');
      const sqlCheck = purpose === 'status' ? recheck : async () => { const current = await base.current(actor, scope, 'human_sync'); if (current.authority_version !== initial.authority_version || current.resource_binding_id !== initial.resource_binding_id) throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
      return { context: { ...scope, installation_id: installation, resource_binding_id: capability.resource_binding_id, authority_version: capability.authority_version, expires_at: capability.expires_at, recheck: sqlCheck, signal,
        provider_state: { read: async key => { await sqlCheck(); const state = await activeStore.readProviderState(scope, key, signal); await sqlCheck(); return state; },
          stale: async (generation, after, limit) => { await sqlCheck(); const records = await activeStore.readStaleRecords(scope, generation, after, limit, signal); await sqlCheck(); return records; } } },
        adapter: { nativeEmailAccount: async context => { const status = await entry.adapter.nativeEmailAccount(context); if (status.principal_digest !== entry.principal) throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); return status; }, nativeEmailPage: entry.adapter.nativeEmailPage.bind(entry.adapter),
          nativeEmailSearch:entry.adapter.nativeEmailSearch.bind(entry.adapter),nativeEmailSource:entry.adapter.nativeEmailSource.bind(entry.adapter)} };
    });
    const authority=new ConnectedEmailMailboxAuthority(base,bridge);
    return {service:new EmailMailboxService(authority,activeStore,bridge),search:new EmailMailboxSearchService(authority,activeStore,bridge,cipher),content:new EmailMessageContentService(authority,activeStore,bridge)};
  }
  const serviceFor=(activeStore:PostgresEmailMailboxStore)=>componentsFor(activeStore).service;
  const scope = await enroll('joint-account-' + randomUUID()), other = await enroll('other-account-' + randomUUID());
  const legacyScope = adapters.get(scope.account_id)!.binding.scope;
  const staleId = logicalMailIdForProviderMessage(legacyScope, scope.account_id, 'gmail', 'retained-stale');
  const staleSource = { account_id: scope.account_id, locator: { kind: 'gmail', message_id: 'retained-stale', thread_id: 'fixture-thread', label_ids: [] } };
  await db.insert(emailMessages).values({ ...scope, logical_message_id: staleId, revision: 'old', storage_revision: 1, sort_at: new Date(0), inventory_generation: 'old',
    summary_envelope: cipher.seal({ data: { subject: 'Old private cache' } }, { ...scope, kind: 'summary', record_id: staleId, revision: 1 }),
    source_envelope: cipher.seal(staleSource, { ...scope, kind: 'provider_source', record_id: staleId, revision: 1 }) });
  let service = serviceFor(store), checkpoint = await store.readCheckpoint(scope);
  const firstRequest = { page_id: 'inventory-first', expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor };
  const first = await service.syncPage(actor, scope, firstRequest); assert.equal(first.complete, false); assert.equal(first.has_more, true);
  const calls = network.calls.length;
  // A new store/service consumes encrypted durable state with the same custody.
  const reopened = new PostgresEmailMailboxStore(db, cipher); service = serviceFor(reopened);
  assert.equal((await service.syncPage(actor, scope, firstRequest)).state, 'duplicate'); assert.equal(network.calls.length, calls);
  let result = first;
  for (let page = 0; result.has_more && page < 20; page++) { checkpoint = await reopened.readCheckpoint(scope); result = await service.syncPage(actor, scope, { page_id: 'resume-' + page, expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor }); }
  assert.equal(result.complete, true); assert.equal(result.has_more, false);
  const list = (folder = 'all', selected = scope) => service.list(actor, selected, { folder, cursor: null, limit: 100 });
  const all = await list(); assert.equal(all.count.exact_total, 2); assert.deepEqual(all.items.map(row => row.data.subject).sort(), ['Joint private one', 'Joint private three']);
  assert.equal((await list('sent')).items.length, 1); assert.equal((await list('inbox')).items.length, 1); assert.equal((await list('all', other)).items.length, 0);
  const stableId = logicalMailIdForProviderMessage(legacyScope, scope.account_id, 'gmail', 'one'); assert.equal((await list('sent')).items[0]!.logical_message_id, stableId);
  const raw = await pool.query('SELECT state_envelope FROM email_provider_states WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(scope));
  assert.equal(raw.rowCount, 1); assert.equal(JSON.stringify(raw.rows).includes('pending'), false);
  assert.equal(JSON.stringify(all).includes('provider_source'), false); assert.equal(JSON.stringify(all).includes('inventory_generation'), false);
  network.delta = true; checkpoint = await reopened.readCheckpoint(scope); result = await service.syncPage(actor, scope, { page_id: 'delta-first', expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor });
  for (let page = 0; result.has_more && page < 10; page++) { checkpoint = await reopened.readCheckpoint(scope); result = await service.syncPage(actor, scope, { page_id: 'delta-resume-' + page, expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor }); }
  assert.equal(result.complete, true); assert.equal((await list('sent')).items.length, 0); assert.equal((await list('starred')).items[0]!.logical_message_id, stableId);
  const beforeDisconnect = network.calls.length;
  await custody.withAccount(adapters.get(scope.account_id)!.binding, async (tx: any) => { const prior = tx.read(); await tx.write({ health: 'revoked', secret: { ...prior.secret, access_token: 'discarded', refresh_token: 'discarded', expires_at: 0 }, advance_setup: true }); });
  await assert.rejects(list(), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(network.calls.length, beforeDisconnect); assert.equal((await list('all', other)).items.length, 0);
  const microsoft = await enroll('joint-microsoft-' + randomUUID(), 'microsoft');
  service = serviceFor(new PostgresEmailMailboxStore(db, cipher)); checkpoint = await store.readCheckpoint(microsoft);
  result = await service.syncPage(actor, microsoft, { page_id: 'graph-first', expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor });
  // Resume Graph encrypted control/queue/folder checkpoints in another service.
  service = serviceFor(new PostgresEmailMailboxStore(db, cipher));
  for (let page = 0; result.has_more && page < 80; page++) { checkpoint = await store.readCheckpoint(microsoft); result = await service.syncPage(actor, microsoft, { page_id: 'graph-resume-' + page, expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor }); }
  assert.equal(result.complete, true); assert.equal(result.has_more, false);
  const graphRows = await list('all', microsoft); assert.equal(graphRows.count.exact_total, 2);
  assert.equal((await list('sent', microsoft)).items[0]!.data.subject, 'Joint Graph graph-one'); assert.equal((await list('inbox', microsoft)).items.length, 0);
  assert.equal((await list('sent', microsoft)).items[0]!.logical_message_id, logicalMailIdForProviderMessage(adapters.get(microsoft.account_id)!.binding.scope, microsoft.account_id, 'microsoft', 'graph-one'));
  const graphPrivate = await pool.query('SELECT state_envelope FROM email_provider_states WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(microsoft));
  assert.ok(graphPrivate.rowCount! >= 6); assert.equal(JSON.stringify(graphPrivate.rows).includes('g-hidden'), false); assert.equal(JSON.stringify(graphPrivate.rows).includes('deltatoken'), false);
  assert.equal((await list('all', other)).items.length, 0);
  const graphGeneration = (await store.readProviderState(microsoft, NATIVE_MICROSOFT_STATE_KEY))!.generation, warmCalls = network.calls.length;
  checkpoint = await store.readCheckpoint(microsoft); result = await service.syncPage(actor, microsoft, { page_id: 'graph-warm-first', expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor });
  for (let page = 0; result.has_more && page < 40; page++) { checkpoint = await store.readCheckpoint(microsoft); result = await service.syncPage(actor, microsoft, { page_id: 'graph-warm-' + page, expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor }); }
  assert.equal(result.complete, true); assert.equal((await store.readProviderState(microsoft, NATIVE_MICROSOFT_STATE_KEY))!.generation, graphGeneration);
  assert.equal(network.calls.slice(warmCalls).filter(url => /^\/v1\.0\/me\/messages\//.test(new URL(url).pathname)).length, 0);
  assert.equal((await list('all', microsoft)).count.exact_total, 2);
  const readerSearch=componentsFor(new PostgresEmailMailboxStore(db,cipher));
  const found=await readerSearch.search.search(actor,other,{query:'subject:discovered',limit:20,cursor:null});
  assert.equal(found.items.length,1);assert.equal(found.coverage,'complete');assert.equal(JSON.stringify(found).includes('provider_source'),false);
  const discovered=found.items[0]!;assert.equal(discovered.data.subject,'Joint private discovered');
  assert.ok(await store.readMessage(other,discovered.logical_message_id));
  const original=await readerSearch.content.readSource(actor,other,discovered.logical_message_id);
  assert.match(Buffer.from(original.mime_bytes).toString(),/Search opened this source/);original.mime_bytes.fill(0);
  assert.equal((await store.readPage(other,{folder:'all',limit:50,cursor:null})).coverage,'partial');
});
