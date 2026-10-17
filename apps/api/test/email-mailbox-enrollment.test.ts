import test from 'node:test';
import assert from 'node:assert/strict';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PostgresEmailMailboxEnrollment } from '../src/lib/email-mailbox-enrollment.js';
import type { EmailAuthorityDatabase } from '../src/lib/email-mailbox-authority.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
import type { LiveAttachmentSyncBindingAuthority } from '../src/lib/app-attachment-sync-authority.js';
import type { AppConnectionRegistry } from '../src/lib/app-connection-registry.js';
import type {NativeEmailConnectionContext} from '../src/lib/email-native-adapter-contract.js';
import { EmailMailboxError } from '../src/lib/email-mailbox-service.js';

const actor = { user_id: 'owner', web_session_id: 'sid', access_expires_at: 20000 };
const nomination = { account_id: 'mail-account', resource_binding_id: 'binding' };
const denied = (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED';
function fixture() {
  const binding = { id: 'binding', org_id: 'org', owner_user_id: 'owner', app_installation_id: 'app',
    app_version_id: 'version', grant_snapshot_id: 'grant', runtime_registration_id: 'registration',
    target_key: 'personal', resource_key: 'inbox', reviewed_at: new Date(0), consent_expires_at: new Date(10000), descriptor_digest: 'descriptor' };
  const state = { now: 1000, events: [] as string[], predicates: [] as { table: string; params: unknown[] }[],
    account: null as Record<string, unknown> | null, binding, oldBinding: { ...binding, id: 'old-binding' },
    live: { binding, installation: { id: 'app', org_id: 'org', active_version_id: 'version', lifecycle_epoch: 1 },
      registration: { id: 'registration', org_id: 'org', operator_user_id: 'operator', runtime_epoch: 1 },
      version: { id: 'version', manifest_digest: 'manifest' }, grant: { id: 'grant', snapshot_digest: 'grant-digest' },
      descriptor_digest: 'descriptor', provider_snapshot: { id: 'provider', snapshot_digest: 'provider-digest' } },
    session: { id: 'sid', org_id: 'org', user_id: 'owner', expires_at: new Date(30000), revoked_at: null as Date | null },
    members: ['owner', 'operator'].map(user_id => ({ org_id: 'org', user_id, role: 'member', active: true, version: 1, kind: 'human', is_agent: false })),
    status: { account_id: 'mail-account', resource_binding_id: 'binding', provider: 'gmail' as string, principal_digest: 'a'.repeat(64),
      authority_epoch: 1, connection_revision: 1, health: 'connected', capabilities: ['read'], primary_address: 'private@example.test', display_label: 'Private' },
    pins: { org_id: 'org', owner_user_id: 'owner', installation_id: 'app', app_version_id: 'version', grant_snapshot_id: 'grant',
      target_key: 'personal', resource_key: 'inbox', resource_binding_id: 'binding', action_key: null, action_binding_id: null },
    available: true, calls: 0, writes: 0, committed: false, prelocked: [] as (readonly string[])[],
    priorState: {} as Record<string, Record<string, unknown>[]>,
    credential:null as Record<string,unknown>|null,
    verifyImap:undefined as (()=>Promise<void>)|undefined,
    custody: undefined as ((context: NativeEmailConnectionContext) => Promise<void>) | undefined,
    afterWrite: undefined as (() => void) | undefined,
    atSid: undefined as (() => void) | undefined,
    atAdvisory: undefined as (() => void) | undefined,
  };
  const dialect = new PgDialect();
  const tx = {
    execute: async (query: SQL) => { const sql = dialect.sqlToQuery(query); state.events.push('lock:advisory');
      assert.match(sql.sql, /pg_advisory_xact_lock/); assert.equal(sql.params.length, 1); assert.match(String(sql.params[0]), /^-?\d+$/);
      assert.equal(String(sql.params[0]).includes('owner'), false); state.atAdvisory?.(); return []; },
    select: () => {
      let table = '', params: unknown[] = [];
      const q = { from(t: Parameters<typeof getTableName>[0]) { table = getTableName(t); return q; }, innerJoin() { return q; },
        where(query: SQL) { params = dialect.sqlToQuery(query).params; state.predicates.push({ table, params }); return q; }, limit() { return q; },
        for(mode: string) { state.events.push(`lock:${table}:${mode}`); if (table === 'web_sessions') state.atSid?.(); return q; },
        then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          const rows = table === 'email_accounts' ? state.account ? [structuredClone(state.account)] : []
            : table === 'app_resource_bindings' ? [structuredClone(params.includes('old-binding') ? state.oldBinding : state.binding)]
            : table === 'web_sessions' ? [structuredClone(state.session)] : table==='email_imap_credentials'?state.credential?[structuredClone(state.credential)]:[] : table.startsWith('email_') ? structuredClone(state.priorState[table] ?? []) : state.members.map(m => ({ ...m }));
          return Promise.resolve(rows).then(resolve, reject);
        } };
      return q;
    },
    insert: (t: Parameters<typeof getTableName>[0]) => ({ values: (values: Record<string, unknown>) => {
      if(getTableName(t)==='email_imap_credentials')return {onConflictDoUpdate:async()=>{state.credential=structuredClone(values);}};
      assert.equal(getTableName(t), 'email_accounts'); assert.equal(state.account, null); state.events.push('write:insert'); state.writes++;
      state.account = {provider_draft_sync_enabled:false,...structuredClone(values)}; state.afterWrite?.();
    } }),
    update: (t: Parameters<typeof getTableName>[0]) => ({ set: (values: Record<string, unknown>) => ({ where: async (query: SQL) => {
      assert.equal(getTableName(t), 'email_accounts'); assert.deepEqual(dialect.sqlToQuery(query).params, ['org', 'owner', 'mail-account']);
      state.events.push('write:update'); state.writes++; state.account = { ...state.account, ...structuredClone(values) }; state.afterWrite?.();
    } }) }),
  } as unknown as AppRunTransaction;
  const database = { transaction: async (run: (tx: AppRunTransaction) => Promise<unknown>) => {
    const original = structuredClone(state.account),credential=structuredClone(state.credential);
    try { const result = await run(tx); state.committed = true; return result; }
    catch (error) { state.account = original;state.credential=credential; throw error; }
  } } as unknown as EmailAuthorityDatabase;
  const enrollment = new PostgresEmailMailboxEnrollment(database, { now: () => new Date(state.now),
    verifyImap:async input=>{await input.context.recheck();await state.verifyImap?.();await input.context.recheck();return {...input.profile as any,verified_at:new Date(state.now).toISOString()};},
    loadBinding: async (actual, input) => { assert.equal(actual, tx); assert.equal(input.org_id, 'org'); assert.equal(input.resource_binding_id, 'binding');
      state.events.push(input.prelocked_participant_ids ? 'legacy:held' : 'legacy:participants', 'legacy:App', 'legacy:registration', 'legacy:binding');
      if (input.prelocked_participant_ids) state.prelocked.push(input.prelocked_participant_ids);
      return state.available ? structuredClone(state.live) as unknown as LiveAttachmentSyncBindingAuthority : null;
    },
    getRegistry: async () => ({ select: (input: Parameters<AppConnectionRegistry['select']>[0]) => { assert.deepEqual(input, { org_id: 'org', owner_user_id: 'owner', installation_id: 'app', target_key: 'personal' });
      return { pins: state.pins, adapter: { handle: async () => new Response(), nativeEmailAccount: async (context: NativeEmailConnectionContext) => {
        state.calls++; state.events.push('custody'); assert.equal(context.org_id, 'org'); assert.equal(context.owner_user_id, 'owner');
        assert.equal(context.account_id, 'mail-account'); assert.equal(context.installation_id, 'app'); assert.equal(context.resource_binding_id, 'binding');
        assert.match(context.authority_version, /^[a-f0-9]{64}$/); await context.recheck(); await state.custody?.(context); await context.recheck();
        return structuredClone(state.status);
      } } };
    } } as unknown as Pick<AppConnectionRegistry, 'select'>),
  });
  const existing = () => { state.account = { org_id: 'org', owner_user_id: 'owner', account_id: 'mail-account', provider: 'gmail',
    principal_digest: 'a'.repeat(64), resource_binding_id: 'binding', state: 'paused', authority_revision: 4,
    consented_at: new Date(0), revoked_at: null, created_at: new Date(0), updated_at: new Date(0) }; };
  return { state, enrollment, existing };
}

test('explicit new adoption checks live graph, exact SID and connected custody before writing; callback stays SQL-only', async () => {
  const f = fixture(); const result = await f.enrollment.adopt(actor, 'org', nomination);
  assert.deepEqual(result, { account_id: 'mail-account', provider: 'gmail', state: 'active', authority_revision: 1 });
  assert.equal(f.state.calls, 1); assert.equal(f.state.writes, 1); assert.equal(f.state.committed, true);
  assert.deepEqual(f.state.events.slice(0, 7), ['legacy:participants', 'legacy:App', 'legacy:registration', 'legacy:binding', 'lock:advisory', 'lock:email_accounts:update', 'lock:web_sessions:share']);
  assert.ok(f.state.events.indexOf('custody') < f.state.events.indexOf('write:insert'));
  assert.ok(f.state.prelocked.every(ids => JSON.stringify(ids) === JSON.stringify(['operator', 'owner'])));
  assert.deepEqual(f.state.account?.consented_at, new Date(0)); assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  assert.ok(f.state.predicates.filter(q => q.table === 'email_accounts').every(q => JSON.stringify(q.params) === JSON.stringify(['org', 'owner', 'mail-account'])));
  assert.ok(f.state.predicates.filter(q => q.table === 'web_sessions').every(q => JSON.stringify(q.params) === JSON.stringify(['sid', 'org', 'owner'])));
});

test('same-principal resume and same-installation rebind preserve account identity and increment authority revision', async () => {
  for (const kind of ['paused', 'disconnected', 'revoked', 'active', 'rebind', 'unverified-paused']) {
    const f = fixture(); f.existing(); f.state.account!.state = kind === 'rebind' || kind === 'unverified-paused' ? 'paused' : kind;
    if (kind === 'revoked') f.state.account!.revoked_at = new Date(500);
    if (kind === 'rebind') f.state.account!.resource_binding_id = 'old-binding';
    if (kind === 'unverified-paused') f.state.account!.principal_digest = null;
    assert.equal((await f.enrollment.adopt(actor, 'org', nomination)).authority_revision, 5, kind);
    assert.equal(f.state.account!.resource_binding_id, 'binding', kind); assert.equal(f.state.account!.state, 'active', kind);
    assert.equal(f.state.account!.revoked_at, null, kind); assert.equal(f.state.account!.created_at instanceof Date, true, kind);
  }
});

test('different principal, provider, installation and active accounts without a digest cannot be adopted in place', async () => {
  for (const kind of ['principal', 'provider', 'installation', 'active-null', 'unverified-rebind', 'invalid-digest', 'max-revision']) {
    const f = fixture(); f.existing(); const before = structuredClone(f.state.account);
    if (kind === 'principal') f.state.status.principal_digest = 'b'.repeat(64);
    if (kind === 'provider') f.state.status.provider = 'microsoft';
    if (kind === 'installation') { f.state.account!.resource_binding_id = 'old-binding'; f.state.oldBinding.app_installation_id = 'different-app'; }
    if (kind === 'active-null') { f.state.account!.state = 'active'; f.state.account!.principal_digest = null; }
    if (kind === 'unverified-rebind') { f.state.account!.resource_binding_id = 'old-binding'; f.state.account!.principal_digest = null; }
    if (kind === 'invalid-digest') f.state.account!.principal_digest = 'bad';
    if (kind === 'max-revision') f.state.account!.authority_revision = 2147483647;
    await assert.rejects(f.enrollment.adopt(actor, 'org', nomination), denied, kind); assert.equal(f.state.writes, 0, kind);
    assert.equal(f.state.committed, false, kind); if (kind === 'principal' || kind === 'provider') assert.deepEqual(f.state.account, before);
  }
});

test('null-principal first verification requires the exact original binding and no prior native mailbox state, including tombstones', async () => {
  for (const kind of ['message', 'tombstone', 'receipt', 'provider-state', 'checkpoint', 'held-message']) {
    const f = fixture(); f.existing(); f.state.account!.principal_digest = null;
    const addState = () => {
      if (kind === 'message' || kind === 'held-message') f.state.priorState.email_messages = [{ id: 'message', deleted_at: null }];
      if (kind === 'tombstone') f.state.priorState.email_messages = [{ id: 'deleted', deleted_at: new Date(0) }];
      if (kind === 'receipt') f.state.priorState.email_sync_receipts = [{ id: 'receipt' }];
      if (kind === 'provider-state') f.state.priorState.email_provider_states = [{ id: 'state' }];
      if (kind === 'checkpoint') f.state.priorState.email_checkpoints = [{ revision: 1 }];
    };
    if (kind === 'held-message') f.state.custody = async () => { addState(); }; else addState();
    await assert.rejects(f.enrollment.adopt(actor, 'org', nomination), denied, kind); assert.equal(f.state.writes, 0, kind);
    assert.equal(f.state.account!.principal_digest, null, kind);
  }
  const empty = fixture(); empty.existing(); empty.state.account!.principal_digest = null; empty.state.priorState.email_checkpoints = [{ revision: 0 }];
  assert.equal((await empty.enrollment.adopt(actor, 'org', nomination)).state, 'active');
  for (const query of empty.state.predicates.filter(q => ['email_messages', 'email_sync_receipts', 'email_provider_states', 'email_checkpoints'].includes(q.table))) {
    assert.deepEqual(query.params, ['org', 'owner', 'mail-account']);
  }
});

test('cross-scope nomination and registry pin mismatches never authorize custody or writes', async () => {
  for (const kind of ['owner', 'org', 'binding-id', 'session-id', 'session-org', 'session-owner', 'pins-version', 'pins-binding', 'pins-owner']) {
    const f = fixture();
    if (kind === 'owner') f.state.binding.owner_user_id = 'other';
    if (kind === 'org') f.state.binding.org_id = 'other';
    if (kind === 'binding-id') f.state.binding.id = 'other';
    if (kind === 'session-id') f.state.session.id = 'other';
    if (kind === 'session-org') f.state.session.org_id = 'other';
    if (kind === 'session-owner') f.state.session.user_id = 'other';
    if (kind === 'pins-version') f.state.pins.app_version_id = 'other';
    if (kind === 'pins-binding') f.state.pins.resource_binding_id = 'other';
    if (kind === 'pins-owner') f.state.pins.owner_user_id = 'other';
    await assert.rejects(f.enrollment.adopt(actor, 'org', nomination), denied, kind);
    assert.equal(f.state.calls, 0, kind); assert.equal(f.state.writes, 0, kind);
  }
});

test('held SID/advisory waits and custody expiry, revocation or graph changes deny with rollback', async () => {
  for (const kind of ['sid-wait', 'advisory-wait', 'custody-expiry', 'legacy-revoke', 'sid-revoke', 'member-revoke', 'member-agent', 'member-version', 'graph', 'descriptor', 'grant', 'ancestry', 'account']) {
    const f = fixture();
    if (kind === 'sid-wait') f.state.atSid = () => { f.state.now = 10000; };
    else if (kind === 'advisory-wait') f.state.atAdvisory = () => { f.state.now = 10000; };
    else f.state.custody = async () => {
      if (kind === 'custody-expiry') f.state.now = 10000;
      if (kind === 'legacy-revoke') f.state.available = false;
      if (kind === 'sid-revoke') f.state.session.revoked_at = new Date(1000);
      if (kind === 'member-revoke') f.state.members[0]!.active = false;
      if (kind === 'member-agent') f.state.members[0]!.is_agent = true;
      if (kind === 'member-version') f.state.members[0]!.version++;
      if (kind === 'graph') f.state.live.registration.runtime_epoch++;
      if (kind === 'descriptor') f.state.live.descriptor_digest = 'changed';
      if (kind === 'grant') f.state.live.grant.snapshot_digest = 'changed';
      if (kind === 'ancestry') { f.state.events.push('changed:ancestry'); f.state.binding.app_installation_id = 'different-app'; }
      if (kind === 'account') { f.existing(); }
    };
    await assert.rejects(f.enrollment.adopt(actor, 'org', nomination), denied, kind); assert.equal(f.state.account, null, kind);
    assert.equal(f.state.writes, 0, kind); assert.equal(f.state.committed, false, kind);
    if (kind === 'ancestry') assert.equal(f.state.events.slice(f.state.events.indexOf('changed:ancestry') + 1).some(e => e.startsWith('legacy:')), false);
  }
});

test('custody failure remains a failure without enrollment or automatic retry', async () => {
  const f = fixture(); f.state.custody = async () => { throw Error('Custody unavailable'); };
  await assert.rejects(f.enrollment.adopt(actor, 'org', nomination), /Custody unavailable/);
  assert.equal(f.state.calls, 1); assert.equal(f.state.writes, 0); assert.equal(f.state.account, null); assert.equal(f.state.committed, false);
});

test('disconnected, foreign, unsupported or malformed provider status cannot create consent', async () => {
  for (const kind of ['health', 'account', 'binding', 'provider', 'principal', 'epoch', 'revision', 'read']) {
    const f = fixture();
    if (kind === 'health') f.state.status.health = 'disconnected';
    if (kind === 'account') f.state.status.account_id = 'other';
    if (kind === 'binding') f.state.status.resource_binding_id = 'other';
    if (kind === 'provider') f.state.status.provider = 'other';
    if (kind === 'principal') f.state.status.principal_digest = 'bad';
    if (kind === 'epoch') f.state.status.authority_epoch = 0;
    if (kind === 'revision') f.state.status.connection_revision = -1;
    if (kind === 'read') f.state.status.capabilities = [];
    await assert.rejects(f.enrollment.adopt(actor, 'org', nomination), denied, kind); assert.equal(f.state.account, null, kind);
  }
});

test('expiry or cancellation after the account write rolls the transaction back', async () => {
  for (const kind of ['expiry', 'abort']) {
    const f = fixture(), controller = new AbortController(); f.state.afterWrite = () => {
      if (kind === 'expiry') f.state.now = 10000; else controller.abort();
    };
    await assert.rejects(f.enrollment.adopt(actor, 'org', nomination, controller.signal), kind === 'expiry' ? denied : { name: 'AbortError' });
    assert.equal(f.state.writes, 1); assert.equal(f.state.account, null); assert.equal(f.state.committed, false);
  }
});

const imapProfile={host:'imap.example.test',port:993,transport:'implicit_tls' as const,username:'owner@example.test',password:'synthetic-secret',
 identity:{primary_address:'owner@example.test',display_label:'Personal'}};
const imapKeys={current:()=>({key_id:'fixture',key:Buffer.alloc(32,41)}),read:()=>({key_id:'fixture',key:Buffer.alloc(32,41)}),keyIds:()=>['fixture']};
test('IMAP setup commits tested credentials encrypted with native account and supports exact-revision password update',async()=>{
 const f=fixture();const result=await f.enrollment.setupImap(actor,'org',nomination,imapProfile,0,imapKeys);
 assert.equal(result.provider,'imap_smtp');assert.equal(f.state.calls,0);assert.equal(f.state.account?.state,'active');
 assert.equal(f.state.credential?.connection_revision,1);assert.equal(JSON.stringify(f.state.credential).includes('synthetic-secret'),false);
 assert.equal(f.state.credential?.principal_digest,f.state.account?.principal_digest);assert.equal(JSON.stringify(result).includes('password'),false);
 f.state.now=2000;await f.enrollment.setupImap(actor,'org',nomination,{...imapProfile,password:'changed-secret'},1,imapKeys);
 assert.equal(f.state.credential?.connection_revision,2);assert.equal(f.state.account?.authority_revision,2);
 await assert.rejects(f.enrollment.setupImap(actor,'org',nomination,imapProfile,1,imapKeys));
 assert.equal(f.state.credential?.connection_revision,2);
});
test('IMAP setup failure, late revoke, identity change and client verification claims leave credentials unchanged',async()=>{
 for(const kind of ['authentication','late-revoke','after-write']){
  const f=fixture();if(kind==='authentication')f.state.verifyImap=async()=>{throw Error('synthetic auth failed');};
  if(kind==='late-revoke')f.state.verifyImap=async()=>{f.state.session.revoked_at=new Date(1);};
  if(kind==='after-write')f.state.afterWrite=()=>{f.state.session.revoked_at=new Date(1);};
  await assert.rejects(f.enrollment.setupImap(actor,'org',nomination,imapProfile,0,imapKeys));
  assert.equal(f.state.account,null);assert.equal(f.state.credential,null);
 }
 const f=fixture();await f.enrollment.setupImap(actor,'org',nomination,imapProfile,0,imapKeys);const before=structuredClone(f.state.credential);
 await assert.rejects(f.enrollment.setupImap(actor,'org',nomination,{...imapProfile,username:'someone-else'},1,imapKeys));assert.deepEqual(f.state.credential,before);
 await assert.rejects(f.enrollment.setupImap(actor,'org',nomination,{...imapProfile,verified_at:new Date().toISOString()},1,imapKeys));
});
