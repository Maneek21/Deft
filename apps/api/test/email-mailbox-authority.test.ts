import test from 'node:test';
import assert from 'node:assert/strict';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PostgresEmailMailboxAuthority, type EmailAuthorityDatabase } from '../src/lib/email-mailbox-authority.js';
import { EmailMailboxError, type EmailActor, type EmailScope } from '../src/lib/email-mailbox-service.js';
import type { LiveAttachmentSyncBindingAuthority } from '../src/lib/app-attachment-sync-authority.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
import {createEmailSearchDiagnostics} from '../src/lib/email-search-diagnostics.js';

const scope: EmailScope = { org_id: 'org', owner_user_id: 'owner', account_id: 'native-account' };
const actor: EmailActor = { user_id: 'owner', web_session_id: 'sid', access_expires_at: 20000 };
function fixture() {
  const f = { now: 1000, events: [] as string[], predicates: [] as { table: string; values: unknown[] }[], transactions: 0,
    account: { ...scope, provider: 'gmail', provider_draft_sync_enabled:false, resource_binding_id: 'binding', principal_digest:'a'.repeat(64), state: 'active', authority_revision: 1,
      consented_at: new Date(0), revoked_at: null as Date | null },
    session: { id: 'sid', org_id: 'org', user_id: 'owner', expires_at: new Date(30000), revoked_at: null as Date | null },
    job:{id:'job',org_id:'org',queue:'scheduled-jobs',name:'native-email-sync',status:'running',lock_token:'lease-token',locked_by:'worker',
      lock_expires_at:new Date(15000),data:{...scope,authority_revision:1}},
    members: ['owner', 'operator'].map(user_id => ({ org_id: 'org', user_id, role: 'member', active: true,
      kind: 'human', is_agent: false, authorization_version: 1 })),
    live: { installation: { id: 'app', org_id: 'org', active_version_id: 'version', active_grant_snapshot_id: 'grant', lifecycle_epoch: 1, grant_epoch: 2 },
      version: { id: 'version', manifest_digest: 'manifest-digest', package_digest: 'package-digest' },
      grant: { id: 'grant', snapshot_digest: 'grant-digest' }, registration: { id: 'registration', org_id: 'org', operator_user_id: 'operator', runtime_epoch: 3 },
      binding: { id: 'binding', org_id: 'org', owner_user_id: 'owner', target_key: 'personal', resource_key: 'inbox',
        app_installation_id: 'app', runtime_registration_id: 'registration', descriptor_digest: 'descriptor-digest',
        provider_instance_id: 'registration', consent_expires_at: new Date(10000) }, descriptor_digest: 'descriptor-digest',
      provider_snapshot: { id: 'snapshot', provider_kind: 'app_runtime', provider_instance_id: 'registration', snapshot_digest: 'provider-digest' } },
    legacyAvailable: true, beforeLegacy: undefined as (() => void) | undefined,
    beforeSession: undefined as (() => void) | undefined, beforeJob: undefined as (() => void) | undefined, prelocked: undefined as readonly string[] | undefined };
  const dialect = new PgDialect();
  const tx = { execute: async () => [], select: (selection?: unknown) => {
    let table = '';
    const q = { from(t: Parameters<typeof getTableName>[0]) { table = getTableName(t); return q; },
      where(sql: SQL) { f.predicates.push({ table, values: dialect.sqlToQuery(sql).params }); return q; },
      innerJoin() { return q; }, limit() { return q; },
      for(mode: string) { f.events.push(`lock:${table}:${mode}`); if (table === 'web_sessions') f.beforeSession?.(); if(table==='job_queue')f.beforeJob?.(); return q; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        const result = table === 'email_accounts' ? [selection ? { resource_binding_id: f.account.resource_binding_id } : { ...f.account }]
          : table === 'web_sessions' ? [{ ...f.session }] : table==='job_queue' ? [{...f.job,data:{...f.job.data}}]
          : table === 'app_resource_bindings' ? [{ ...f.live.binding }] : f.members.map(member => ({ ...member }));
        return Promise.resolve(result).then(resolve, reject);
      } };
    return q;
  } } as unknown as AppRunTransaction;
  const db = { transaction: async (run: (tx: AppRunTransaction) => Promise<unknown>) => { f.transactions++; return run({ ...tx } as AppRunTransaction); } } as unknown as EmailAuthorityDatabase;
  const authority = new PostgresEmailMailboxAuthority(db, { now: () => new Date(f.now), loadBinding: async (actual, input) => {
    assert.equal(typeof actual.select, 'function'); assert.equal(input.org_id, scope.org_id); assert.equal(input.resource_binding_id, 'binding');
    f.prelocked = input.prelocked_participant_ids;
    f.events.push('legacy:participants', 'legacy:App', 'legacy:registration', 'legacy:binding'); f.beforeLegacy?.();
    return f.legacyAvailable ? structuredClone(f.live) as unknown as LiveAttachmentSyncBindingAuthority : null;
  } });
  return { ...f, state: f, tx, authority };
}
const denied = (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED';

test('M29 actual SQL authority instrumented pass retains lock order, transaction reuse and late denial',async()=>{
 const off=fixture(),on=fixture(),reports:any[]=[];const c=createEmailSearchDiagnostics({enabled:()=>true,emit:r=>reports.push(r)});
 const expected=await off.authority.current(actor,scope,'human_read');const actual=await c.run(scope.account_id,()=>on.authority.current(actor,scope,'human_read'));
 assert.deepEqual(actual,expected);assert.deepEqual(on.state.events,off.state.events);assert.deepEqual(on.state.predicates,off.state.predicates);assert.equal(on.state.transactions,off.state.transactions);assert.deepEqual(reports[0].intervals.map((r:any)=>r.phase),['authority_sql_pass']);
 await c.run(scope.account_id,()=>on.authority.current(actor,scope,'human_read',on.tx));assert.equal(on.state.transactions,1);
 on.state.beforeSession=()=>{on.state.session.revoked_at=new Date(1000);};await assert.rejects(c.run(scope.account_id,()=>on.authority.current(actor,scope,'human_read')),denied);assert.equal(reports[2].outcome,'error');
 const foreign=fixture();await assert.rejects(c.run(scope.account_id,()=>foreign.authority.current({...actor,user_id:'foreign'},scope,'human_read')),denied);assert.equal(foreign.state.transactions,0);assert.equal(reports[3].intervals.length,0);
});

test('fresh human native consent uses legacy then native account then exact SID locks; ordinary members remain supported', async () => {
  const f = fixture(); const result = await f.authority.current(actor, scope, 'human_read');
  assert.equal(result.expires_at, 10000); assert.equal(result.resource_binding_id, 'binding'); assert.match(result.authority_version, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.state.events, ['legacy:participants', 'legacy:App', 'legacy:registration', 'legacy:binding', 'lock:email_accounts:share', 'lock:web_sessions:share']);
  assert.deepEqual(f.state.predicates.filter(p => p.table === 'email_accounts').map(p => p.values), [['org', 'owner', 'native-account'], ['org', 'owner', 'native-account']]);
  assert.deepEqual(f.state.predicates.find(p => p.table === 'web_sessions')?.values, ['sid', 'org', 'owner']); assert.equal(f.state.transactions, 1);
});
test('cross-owner, cross-account, cross-org and foreign exact SID cannot confer authority', async () => {
  for (const change of ['actor', 'owner', 'account', 'org', 'sid-org', 'sid-user', 'sid-id']) {
    const f = fixture(); let caller = actor;
    if (change === 'actor') caller = { ...actor, user_id: 'other' };
    if (change === 'owner') f.state.account.owner_user_id = 'other';
    if (change === 'account') f.state.account.account_id = 'other';
    if (change === 'org') f.state.account.org_id = 'other';
    if (change === 'sid-org') f.state.session.org_id = 'other';
    if (change === 'sid-user') f.state.session.user_id = 'other';
    if (change === 'sid-id') f.state.session.id = 'other';
    await assert.rejects(f.authority.current(caller, scope, 'human_sync'), denied, change);
  }
});
test('paused/revoked native consent and revoked legacy binding fail fresh on every invocation', async () => {
  for (const change of ['paused', 'revoked', 'consent', 'legacy', 'binding']) {
    const f = fixture(); await f.authority.current(actor, scope, 'human_read');
    f.state.beforeLegacy = () => {
      if (change === 'paused') f.state.account.state = 'paused';
      if (change === 'revoked') f.state.account.revoked_at = new Date(500);
      if (change === 'consent') f.state.account.consented_at = new Date(NaN);
      if (change === 'legacy') f.state.legacyAvailable = false;
      if (change === 'binding') f.state.account.resource_binding_id = 'changed';
    };
    await assert.rejects(f.authority.current(actor, scope, 'human_sync'), denied, change);
  }
});
test('expiry is sampled after the SID wait and final membership read; invalid clocks deny', async () => {
  for (const expired of ['access', 'sid', 'legacy', 'clock']) {
    const f = fixture(); const caller = expired === 'access' ? { ...actor, access_expires_at: 1500 } : actor;
    f.state.beforeSession = () => { f.state.now = expired === 'clock' ? NaN : 2000;
      if (expired === 'sid') f.state.session.expires_at = new Date(2000);
      if (expired === 'legacy') f.state.live.binding.consent_expires_at = new Date(2000);
    };
    // Loader output is a snapshot; passage of time must invalidate its deadline.
    if (expired === 'legacy') f.state.live.binding.consent_expires_at = new Date(2000);
    await assert.rejects(f.authority.current(caller, scope, 'human_read'), denied, expired);
  }
});
test('session revocation, inactive/guest membership and human-to-agent changes deny after waits', async () => {
  for (const change of ['session', 'inactive', 'guest', 'agent', 'kind', 'operator-agent']) {
    const f = fixture(); f.state.beforeSession = () => {
      if (change === 'session') f.state.session.revoked_at = new Date(1000);
      if (change === 'inactive') f.state.members[0]!.active = false;
      if (change === 'guest') f.state.members[0]!.role = 'guest';
      if (change === 'agent') f.state.members[0]!.is_agent = true;
      if (change === 'kind') f.state.members[0]!.kind = 'employee';
      if (change === 'operator-agent') f.state.members[1]!.is_agent = true;
    }; await assert.rejects(f.authority.current(actor, scope, 'human_read'), denied, change);
  }
});
test('native revision, legacy epochs/descriptors/provider identity and membership authversion change capability digest', async () => {
  for (const change of ['native', 'lifecycle', 'grant', 'runtime', 'descriptor', 'target', 'provider', 'member']) {
    const f = fixture(); const before = await f.authority.current(actor, scope, 'human_read');
    if (change === 'native') f.state.account.authority_revision++;
    if (change === 'lifecycle') f.state.live.installation.lifecycle_epoch++;
    if (change === 'grant') f.state.live.installation.grant_epoch++;
    if (change === 'runtime') f.state.live.registration.runtime_epoch++;
    if (change === 'descriptor') f.state.live.descriptor_digest = 'changed';
    if (change === 'target') f.state.live.binding.target_key = 'other';
    if (change === 'provider') f.state.live.provider_snapshot.snapshot_digest = 'changed';
    if (change === 'member') f.state.members[0]!.authorization_version++;
    const after = await f.authority.current(actor, scope, 'human_sync'); assert.notEqual(after.authority_version, before.authority_version, change);
  }
});
test('commit rechecks in caller transaction acquire no new participant locks and reject changed binding locator', async () => {
  const f = fixture(); const first = await f.authority.current(actor, scope, 'human_sync', f.tx);
  const second = await f.authority.current(actor, scope, 'human_sync', f.tx);
  assert.equal(first.authority_version, second.authority_version); assert.deepEqual(f.state.prelocked, ['operator', 'owner']); assert.equal(f.state.transactions, 0);
  f.state.account.resource_binding_id = 'changed'; const count = f.state.events.length;
  await assert.rejects(f.authority.current(actor, scope, 'human_sync', f.tx), denied); assert.equal(f.state.events.length, count);
});
test('a repeated guard rejects changed legacy ancestry and another scope before any new lock', async () => {
  for (const change of ['installation', 'registration', 'target', 'resource', 'scope']) {
    const f = fixture(); await f.authority.current(actor, scope, 'human_sync', f.tx);
    if (change === 'installation') f.state.live.binding.app_installation_id = 'changed';
    if (change === 'registration') f.state.live.binding.runtime_registration_id = 'changed';
    if (change === 'target') f.state.live.binding.target_key = 'changed';
    if (change === 'resource') f.state.live.binding.resource_key = 'changed';
    const count = f.state.events.length;
    await assert.rejects(f.authority.current(actor, change === 'scope' ? { ...scope, account_id: 'other' } : scope, 'human_sync', f.tx), denied, change);
    assert.equal(f.state.events.length, count, change);
  }
});
test('cancellation after authority waits prevents any capability return', async () => {
  const f = fixture(), controller = new AbortController(); f.state.beforeSession = () => controller.abort();
  await assert.rejects(f.authority.current(actor, scope, 'human_read', undefined, controller.signal), error => error instanceof Error && error.name === 'AbortError');
});

const lease={job_id:'job',lock_token:'lease-token'};
test('background sync uses an exact queue lease and current consent after the human logs out',async()=>{
  const f=fixture();f.state.session.revoked_at=new Date(500);
  const capability=await f.authority.currentService(scope,lease);
  assert.equal(capability.expires_at,10000);
  assert.deepEqual(f.state.events,['legacy:participants','legacy:App','legacy:registration','legacy:binding','lock:email_accounts:share','lock:job_queue:share']);
  assert.equal(f.state.predicates.some(p=>p.table==='web_sessions'),false);
  assert.deepEqual(f.state.predicates.find(p=>p.table==='job_queue')?.values,['job','org']);
});
test('service authority rejects changed job identity, scope, revision, ownership and expired leases',async()=>{
  for(const change of ['id','org','queue','name','status','token','worker','owner','account','revision','expiry','paused','member','principal']){
    const f=fixture();
    if(change==='id')f.state.job.id='other';
    if(change==='org')f.state.job.org_id='other';
    if(change==='queue')f.state.job.queue='other';
    if(change==='name')f.state.job.name='other';
    if(change==='status')f.state.job.status='pending';
    if(change==='token')f.state.job.lock_token='other';
    if(change==='worker')f.state.job.locked_by='';
    if(change==='owner')f.state.job.data.owner_user_id='other';
    if(change==='account')f.state.job.data.account_id='other';
    if(change==='revision')f.state.job.data.authority_revision=2;
    if(change==='expiry')f.state.beforeJob=()=>{f.state.now=15000;};
    if(change==='paused')f.state.account.state='paused';
    if(change==='member')f.state.members[0]!.active=false;
    if(change==='principal')f.state.account.principal_digest='';
    await assert.rejects(f.authority.currentService(scope,lease),denied,change);
  }
});
test('service commit fences cannot switch lease or principal in a held transaction',async()=>{
  const f=fixture();await f.authority.currentService(scope,lease,f.tx);
  await f.authority.currentService(scope,lease,f.tx);
  assert.deepEqual(f.state.prelocked,['operator','owner']);
  const count=f.state.events.length;
  await assert.rejects(f.authority.currentService(scope,{...lease,lock_token:'other'},f.tx),denied);
  await assert.rejects(f.authority.current(actor,scope,'human_read',f.tx),denied);
  assert.equal(f.state.events.length,count);
});

test('draft mirroring needs its exact leased draft/revision plus current account opt-in; sync lease cannot be substituted',async()=>{
 const draftLease={...lease,job_name:'native-email-draft-sync' as const,draft_id:'00000000-0000-4000-8000-000000000001',revision:3};
 const f=fixture();f.state.job.name='native-email-draft-sync';Object.assign(f.state.job.data,{draft_id:draftLease.draft_id,revision:3});
 await assert.rejects(f.authority.currentService(scope,draftLease),denied);
 f.state.account.provider_draft_sync_enabled=true;
 const result=await f.authority.currentService(scope,draftLease);assert.equal(result.scope.account_id,scope.account_id);
 await assert.rejects(f.authority.currentService(scope,lease),denied);
 await assert.rejects(f.authority.currentService(scope,{...draftLease,revision:4}),denied);
 await assert.rejects(f.authority.currentService(scope,{...draftLease,draft_id:'00000000-0000-4000-8000-000000000002'}),denied);
 const before=(await f.authority.current(actor,scope,'human_read')).authority_version;
 f.state.account.provider_draft_sync_enabled=false;
 assert.notEqual((await f.authority.current(actor,scope,'human_read')).authority_version,before);
 await assert.rejects(f.authority.currentService(scope,draftLease),denied);
});
test('explicit draft reconciliation pins mode and mirror generation on its real queue lease',async()=>{
 const f=fixture(),delivery={...lease,job_name:'native-email-draft-sync' as const,draft_id:'00000000-0000-4000-8000-000000000001',revision:3,mode:'reconcile' as const,generation:7};
 f.state.account.provider_draft_sync_enabled=true;f.state.job.name=delivery.job_name;Object.assign(f.state.job.data,{draft_id:delivery.draft_id,revision:3,mode:'reconcile',generation:7});
 await f.authority.currentService(scope,delivery);
 for(const other of [{...delivery,mode:'sync' as const},{...delivery,generation:8},{...delivery,generation:undefined}])await assert.rejects(f.authority.currentService(scope,other),denied);
});
test('Outbox service authority requires the exact durable intent and operation with a current lease',async()=>{
 const f=fixture(),delivery={...lease,job_name:'native-email-outbox' as const,outbox_id:'00000000-0000-4000-8000-000000000001',operation_id:'00000000-0000-4000-8000-000000000002'};
 f.state.job.name=delivery.job_name;Object.assign(f.state.job.data,{outbox_id:delivery.outbox_id,operation_id:delivery.operation_id});
 await f.authority.currentService(scope,delivery);
 await assert.rejects(f.authority.currentService(scope,{...delivery,operation_id:delivery.outbox_id}),denied);
 await assert.rejects(f.authority.currentService(scope,{...delivery,outbox_id:delivery.operation_id}),denied);
 await assert.rejects(f.authority.currentService(scope,{...delivery,operation_id:'invalid'}),denied);
 f.state.job.status='pending';await assert.rejects(f.authority.currentService(scope,delivery),denied);
});
test('Sent-copy authority needs its own actual IMAP job lease and exact accepted-intent nomination',async()=>{
 const f=fixture(),delivery={...lease,job_name:'native-email-sent-copy' as const,outbox_id:'00000000-0000-4000-8000-000000000001',operation_id:'00000000-0000-4000-8000-000000000002'};
 f.state.account.provider='imap_smtp';f.state.job.name=delivery.job_name;Object.assign(f.state.job.data,{outbox_id:delivery.outbox_id,operation_id:delivery.operation_id,mime_digest:'a'.repeat(64)});
 await f.authority.currentService(scope,delivery);assert.equal(f.events.includes('lock:web_sessions:share'),false);
 for(const changed of [{...delivery,job_name:'native-email-outbox' as const},{...delivery,operation_id:delivery.outbox_id},{...delivery,outbox_id:delivery.operation_id},{...delivery,lock_token:'not-current'}])await assert.rejects(f.authority.currentService(scope,changed),denied);
 f.state.account.provider='gmail';await assert.rejects(f.authority.currentService(scope,delivery),denied);f.state.account.provider='imap_smtp';Object.assign(f.state.job.data,{mime_digest:'not-a-digest'});await assert.rejects(f.authority.currentService(scope,delivery),denied);
 Object.assign(f.state.job.data,{mime_digest:'a'.repeat(64)});f.state.job.lock_expires_at=new Date(0);await assert.rejects(f.authority.currentService(scope,delivery),denied);
});
test('accepted-draft cleanup lease pins its send operation, exact revision, generation and permitted mode',async()=>{
 const f=fixture(),delivery={...lease,job_name:'native-email-draft-cleanup' as const,draft_id:'00000000-0000-4000-8000-000000000001',operation_id:'00000000-0000-4000-8000-000000000002',revision:3,generation:4,mode:'delete' as const};
 f.state.account.provider_draft_sync_enabled=true;f.state.job.name=delivery.job_name;Object.assign(f.state.job.data,{draft_id:delivery.draft_id,operation_id:delivery.operation_id,revision:3,generation:4,mode:'delete'});
 await f.authority.currentService(scope,delivery);
 for(const changed of [{...delivery,mode:'reconcile' as const},{...delivery,generation:5},{...delivery,revision:4},{...delivery,operation_id:delivery.draft_id}])await assert.rejects(f.authority.currentService(scope,changed),denied);
 f.state.account.provider_draft_sync_enabled=false;await assert.rejects(f.authority.currentService(scope,delivery),denied);
});
