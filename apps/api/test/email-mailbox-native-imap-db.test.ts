import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import { EmailMailboxService, EmailMailboxError, type EmailActor, type EmailAuthority, type EmailScope } from '../src/lib/email-mailbox-service.js';
import { PostgresEmailMailboxStore } from '../src/lib/email-mailbox-store.js';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { ConnectedEmailMailboxAuthority } from '../src/lib/email-mailbox-connected-authority.js';
import { RegisteredEmailMailboxProvider } from '../src/lib/email-mailbox-provider.js';
import { openPreparedCurrentEmailMailboxTestDatabase, EMAIL_MAILBOX_TEST_DATABASE_URL } from './fixtures/email-mailbox-database.js';
// Existing executable provider modules have no TypeScript declarations.
// @ts-ignore
import { createNativeImapBridge, NATIVE_IMAP_STATE_KEY } from '../../../examples/apps/email/providers/native-imap.mjs';

const safe = process.env.DATABASE_URL === EMAIL_MAILBOX_TEST_DATABASE_URL && process.env.DEFT_TEST_DATABASE_URL === EMAIL_MAILBOX_TEST_DATABASE_URL;
test('actual PG public IMAP sync persists encrypted folder/UID state across restart and denies revoked host custody', { skip: !safe, timeout: 120000 }, async t => {
  const prepared = await openPreparedCurrentEmailMailboxTestDatabase(); await prepared.end();
  const pool = new pg.Pool({ connectionString: EMAIL_MAILBOX_TEST_DATABASE_URL, max: 5 });
  const db = drizzle(pool, { schema: { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } });
  const org = 'imap-native-db-' + randomUUID(), owner = 'owner-' + randomUUID(), installation = 'install-' + randomUUID();
  const scope: EmailScope = { org_id: org, owner_user_id: owner, account_id: 'imap-' + randomUUID() };
  const binding = 'binding-' + randomUUID(), other = { ...scope, account_id: 'other-' + randomUUID() }, principal = 'c'.repeat(64);
  const actor: EmailActor = { user_id: owner, web_session_id: 'fixture-sid-' + randomUUID(), access_expires_at: Date.now() + 120000 };
  await pool.query('INSERT INTO org_members(org_id,user_id) VALUES($1,$2)', [org, owner]);
  await pool.query('INSERT INTO app_resource_bindings(org_id,id,owner_user_id) VALUES($1,$2,$3)', [org, binding, owner]);
  await db.insert(emailAccounts).values([scope, other].map(value => ({ ...value, provider: 'imap_smtp' as const, resource_binding_id: binding, principal_digest: principal, state: 'active' as const, authority_revision: 1, consented_at: new Date() })));
  t.after(async () => {
    for (const table of ['email_notification_events', 'email_notification_states', 'email_sync_receipts', 'email_provider_states', 'email_memberships', 'email_messages', 'email_checkpoints', 'email_accounts']) await pool.query(`DELETE FROM ${table} WHERE org_id=$1 AND owner_user_id=$2`, [org, owner]);
    await pool.query('DELETE FROM app_resource_bindings WHERE org_id=$1 AND owner_user_id=$2', [org, owner]);
    await pool.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [org, owner]); await pool.end();
  });
  const crypto = new EmailMailboxCrypto({ current: () => ({ key_id: 'imap-db-fixture', key: Buffer.alloc(32, 33) }),
    read: (_purpose: unknown, id: string) => id === 'imap-db-fixture' ? { key_id: id, key: Buffer.alloc(32, 33) } : null, keyIds: () => ['imap-db-fixture'] });
  const box = (uid: number, subject: string) => ({ uid, modseq: 1, flags: new Set<string>(), envelope: { subject, messageId: 'same@example.test' }, internalDate: new Date('2026-10-01T00:00:00Z') });
  const folders = new Map([['INBOX', { validity: '7', next: 2, modseq: 1, specialUse: undefined as string | undefined, rows: [box(1, 'Private IMAP inbox')] }],
    ['Private Localized Sent', { validity: '8', next: 2, modseq: 1, specialUse: '\\Sent', rows: [box(1, 'Private IMAP sent')] }]]);
  const descriptor = { ...scope, installation_id: installation, provider: 'imap_smtp', resource_binding_id: binding, authority_epoch: 1, connection_revision: 1,
    principal_digest: principal, health: 'connected', capabilities: ['read'], primary_address: 'fixture@example.test', display_label: 'Fixture IMAP' };
  let connects = 0, fetches = 0;
  // This synthetic trusted client port proves provider/store composition only.
  // Production encrypted-profile setup, TLS network and full actor graph are
  // separate parent-owned integration seams; no real credential is used here.
  const client: any = { secureConnection: true, authenticated: 'synthetic-principal', enabled: new Set(['CONDSTORE']),
    async list() { return [...folders].map(([path, value]) => ({ path, specialUse: value.specialUse, flags: new Set() })); },
    async getMailboxLock(path: string, options: unknown) { assert.deepEqual(options, { readOnly: true }); const value = folders.get(path)!;
      this.mailbox = { path, uidValidity: BigInt(value.validity), uidNext: value.next, exists: value.rows.length, highestModseq: BigInt(value.modseq), readOnly: true }; return { release() {} }; },
    async search(query: { uid: string; modseq?: bigint }, options: unknown) { assert.deepEqual(options, { uid: true });
      const ranges = query.uid.split(',').map(value => value.split(':').map(Number)); return folders.get(this.mailbox.path)!.rows.filter(row => ranges.some(([a, b]) => row.uid >= a! && row.uid <= (b ?? a)!) && (!query.modseq || BigInt(row.modseq) >= query.modseq)).map(row => row.uid); },
    async *fetch(range: string, query: unknown, options: unknown) { fetches++; assert.deepEqual(options, { uid: true }); assert.equal(Object.hasOwn(query as object, 'source'), false);
      const ids = range.split(',').map(Number); for (const row of folders.get(this.mailbox.path)!.rows.filter(row => ids.includes(row.uid))) yield structuredClone(row); }, close() {},
  };
  const adapter = createNativeImapBridge({ host: { async current(context: any) { return { ...structuredClone(descriptor), account_id: context.account_id }; },
    async withAuthorizedClient(_context: unknown, expected: any, work: (client: unknown) => Promise<unknown>) { assert.equal(expected.principal_digest, principal); connects++; return work(client); } } });
  const base: EmailAuthority = { async current(human, selected, _operation, transaction) {
    assert.deepEqual(human, actor); if (selected.org_id !== org || selected.owner_user_id !== owner) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const read = async (executor: typeof db) => { const [row] = await executor.select().from(emailAccounts).where(and(eq(emailAccounts.org_id, org), eq(emailAccounts.owner_user_id, owner), eq(emailAccounts.account_id, selected.account_id))).limit(1).for('share');
      if (!row || row.state !== 'active' || row.revoked_at || row.principal_digest !== principal) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      return { scope: selected, resource_binding_id: row.resource_binding_id, authority_version: 'fixture:' + row.authority_revision, expires_at: actor.access_expires_at }; };
    return transaction ? read(transaction as typeof db) : db.transaction(tx => read(tx as unknown as typeof db));
  } };
  function compose(store: PostgresEmailMailboxStore) {
    const bridge = new RegisteredEmailMailboxProvider(async (selected, capability, recheck, signal, purpose) => {
      const initial = await base.current(actor, selected, 'human_sync');
      const sqlCheck = purpose === 'status' ? recheck : async () => { const current = await base.current(actor, selected, 'human_sync'); if (current.authority_version !== initial.authority_version || current.resource_binding_id !== initial.resource_binding_id) throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
      return { adapter, context: { ...selected, installation_id: installation, resource_binding_id: capability.resource_binding_id, authority_version: capability.authority_version,
        expires_at: capability.expires_at, signal, recheck: sqlCheck, provider_state: {
          read: async key => { await sqlCheck(); const result = await store.readProviderState(selected, key, signal); await sqlCheck(); return result; },
          stale: async (generation, after, limit) => { await sqlCheck(); const result = await store.readStaleRecords(selected, generation, after, limit, signal); await sqlCheck(); return result; },
        } } };
    });
    return new EmailMailboxService(new ConnectedEmailMailboxAuthority(base, bridge), store, bridge);
  }
  let store = new PostgresEmailMailboxStore(db, crypto), service = compose(store), checkpoint = await store.readCheckpoint(scope);
  const firstRequest = { page_id: 'imap-first', expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor };
  let result = await service.syncPage(actor, scope, firstRequest); assert.equal(result.complete, false);
  const beforeReplay = connects; store = new PostgresEmailMailboxStore(db, crypto); service = compose(store);
  assert.equal((await service.syncPage(actor, scope, firstRequest)).state, 'duplicate'); assert.equal(connects, beforeReplay);
  for (let page = 0; result.has_more && page < 40; page++) { checkpoint = await store.readCheckpoint(scope); result = await service.syncPage(actor, scope, { page_id: 'imap-resume-' + page, expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor }); }
  assert.equal(result.complete, true); assert.equal((await service.list(actor, scope, { folder: 'all', cursor: null, limit: 100 })).count.exact_total, 2);
  const list = () => service.list(actor, scope, { folder: 'sent', cursor: null, limit: 100 }); const sent = await list(); assert.equal(sent.items[0]!.data.subject, 'Private IMAP sent');
  assert.equal(JSON.stringify(sent).includes('provider_source'), false); assert.equal(JSON.stringify(sent).includes('Private Localized Sent'), false);
  assert.equal((await service.list(actor, other, { folder: 'all', cursor: null, limit: 100 })).items.length, 0);
  const envelopes = await pool.query('SELECT state_envelope FROM email_provider_states WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', Object.values(scope));
  assert.equal(envelopes.rowCount, 3); assert.equal(JSON.stringify(envelopes.rows).includes('Private Localized Sent'), false);
  const generation = (await store.readProviderState(scope, NATIVE_IMAP_STATE_KEY))!.generation, warmFetches = fetches;
  checkpoint = await store.readCheckpoint(scope); result = await service.syncPage(actor, scope, { page_id: 'imap-warm', expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor });
  for (let page = 0; result.has_more && page < 10; page++) { checkpoint = await store.readCheckpoint(scope); result = await service.syncPage(actor, scope, { page_id: 'imap-warm-' + page, expected_checkpoint_revision: checkpoint.revision, cursor: checkpoint.cursor }); }
  assert.equal(result.complete, true); assert.equal(fetches, warmFetches); assert.equal((await store.readProviderState(scope, NATIVE_IMAP_STATE_KEY))!.generation, generation);
  const beforeRevoked = connects; descriptor.health = 'revoked'; descriptor.connection_revision++;
  await assert.rejects(list(), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED'); assert.equal(connects, beforeRevoked);
});
