import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailDrafts, emailProviderDraftMirrors } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailDraftError, EmailDraftService, type EmailDraftContent } from '../src/lib/email-draft-service.js';
import { EmailDraftStore } from '../src/lib/email-draft-store.js';
import { signatureIdentityKey } from '../src/lib/email-signature-types.js';
import { EmailProviderDraftMirrorStore } from '../src/lib/email-provider-draft-mirror-store.js';
import { EmailProviderDraftMirrorService,EmailProviderDraftMirrorStatusService } from '../src/lib/email-provider-draft-mirror-service.js';
import { createEmailProviderDraftMimeBuilder } from '../src/lib/email-provider-draft-mime.js';
const {serializeNativeDraft}=await import(new URL('../../../examples/apps/email/outgoing-snapshot.mjs',import.meta.url).href);
const {simpleParser}=createRequire(new URL('../../../examples/apps/email/package.json',import.meta.url))('mailparser');

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_upgrade';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
const draftId = () => randomUUID();
const content = (body = 'Synthetic owner draft only'): EmailDraftContent => ({ mode: 'reply', to: 'person@example.test', cc: '', bcc: '',
  subject: 'Synthetic reply', body, body_html: '', reply_record_id: 'mail_' + 'a'.repeat(64), attachments: [
    { file_id: 'fixture-file-1', filename: 'notes.txt', media_type: 'text/plain', size_bytes: 12, sha256: 'b'.repeat(64) },
  ] });

test('durable native drafts use encrypted scope/revision CAS and owner authority inside PostgreSQL', { skip: !safe, timeout: 45000 }, async t => {
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  const fixtureSchema = 'email_draft_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${fixtureSchema}`);
  const pool = new pg.Pool({ connectionString: target, max: 8, options: `-c search_path=${fixtureSchema},public` });
  const db = drizzle(pool, { schema: { emailAccounts, emailDrafts, emailProviderDraftMirrors } });
  await pool.query(`CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL DEFAULT 'gmail',
      PRIMARY KEY(org_id,owner_user_id,account_id))`);
  const migration = readFileSync(resolve(process.cwd(), 'packages/db/upgrades/0.3.0-preview.66-email-native-drafts.sql'), 'utf8');
  await pool.query(migration); await pool.query(migration);
  const mirrorMigration = readFileSync(resolve(process.cwd(), 'packages/db/upgrades/0.3.0-preview.70-email-provider-draft-mirrors.sql'), 'utf8');
  await pool.query(mirrorMigration); await pool.query(mirrorMigration);
  const org = 'draft-fixture-' + randomUUID(), owner = 'owner-' + randomUUID(), binding = 'binding-' + randomUUID();
  const scope = { org_id: org, owner_user_id: owner, account_id: 'account-' + randomUUID() };
  const actor = { user_id: owner, web_session_id: 'sid-' + randomUUID(), access_expires_at: Date.now() + 120000 };
  await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES($1,$2,$3)', [org, owner, scope.account_id]);
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${fixtureSchema} CASCADE`); await admin.end(); });
  const keys = { current: () => ({ key_id: 'email-draft-db-test', key: Buffer.alloc(32, 29) }),
    read: (_purpose: unknown, key: string) => key === 'email-draft-db-test' ? { key_id: key, key: Buffer.alloc(32, 29) } : null,
    keyIds: () => ['email-draft-db-test'] };
  const cipher = new EmailMailboxCrypto(keys), store = new EmailDraftStore(db, cipher);
  let calls = 0, denyAt = -1;
  const authority = { async current(actual: typeof actor, selected: typeof scope, operation: string, tx?: unknown) {
    assert.deepEqual(actual, actor); assert.deepEqual(selected, scope); assert.equal(operation, 'human_draft');
    calls++;
    if (calls === denyAt) throw new Error('revoked session');
    return { scope: { ...scope }, resource_binding_id: binding, authority_version: 'account-revision-1', expires_at: actor.access_expires_at };
  } };
  const service = new EmailDraftService(authority as any, store);

  await t.test('encrypted create/reopen preserves reply and attachment nominations without exposing plaintext', async () => {
    const id = draftId(), created = await service.create(actor, scope, id, content());
    assert.equal(created.revision, 1); assert.equal(created.origin.kind, 'human'); assert.equal(created.origin.created_by_user_id, owner);
    assert.equal(created.last_edited_by_user_id, owner);
    assert.equal((await service.create(actor, scope, id, content())).revision, 1, 'lost create acknowledgement can be retried safely');
    await assert.rejects(service.create(actor, scope, id, content('different retry payload')),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_CONFLICT');
    assert.deepEqual(created.content.attachments, content().attachments); assert.equal(created.content.reply_record_id, content().reply_record_id);
    const row = await pool.query('SELECT content_envelope FROM email_drafts WHERE org_id=$1 AND owner_user_id=$2 AND draft_id=$3', [org, owner, id]);
    assert.equal(JSON.stringify(row.rows).includes('Synthetic reply'), false); assert.equal(JSON.stringify(row.rows).includes('fixture-file-1'), false);
    const reopened = new EmailDraftService(authority as any, new EmailDraftStore(db, cipher));
    assert.deepEqual((await reopened.read(actor, scope, id)).content, content());
    await assert.rejects(reopened.read({ ...actor, user_id: 'other-owner' }, scope, id),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_ACCESS_DENIED');
    await assert.rejects(reopened.read(actor, { ...scope, account_id: 'foreign-account' }, id),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_ACCESS_DENIED');
  });

  await t.test('PostgreSQL encrypted drafts preserve sender/signature provenance and detach edited suffix without changing body', async () => {
    const address='owner@example.test',suffix='\n\nBest,\nOwner',id=draftId();
    const marked:EmailDraftContent={...content('Hello'+suffix),from_identity:{address},managed_signature:{schema_version:'deft.email_signature_region.v1',
      identity_key:signatureIdentityKey(address),preference_revision:2,plain:{start:5,text:suffix},rich:null}};
    const created=await service.create(actor,scope,id,marked),reopened=await service.read(actor,scope,id);
    assert.deepEqual(reopened.content.from_identity,{address});assert.deepEqual(reopened.content.managed_signature,marked.managed_signature);
    assert.equal(reopened.content.body,'Hello'+suffix);
    const edited=await service.update(actor,scope,id,created.revision,{...marked,body:'Hello\n\nManual signature edit'});
    assert.equal(edited.content.body,'Hello\n\nManual signature edit');assert.equal('managed_signature'in edited.content,false);
    assert.deepEqual(edited.content.from_identity,{address});
  });

  await t.test('provider mirror is opt-in and desired revisions commit with local CAS', async () => {
    const disabledId = draftId();
    await service.create(actor, scope, disabledId, content());
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_provider_draft_mirrors WHERE draft_id=$1', [disabledId])).rows[0].n, 0);
    await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [org, owner, scope.account_id]);
    const id = draftId();
    await service.create(actor, scope, id, content());
    let mirror = (await pool.query('SELECT desired_revision,generation,state,provider_envelope FROM email_provider_draft_mirrors WHERE draft_id=$1', [id])).rows[0];
    assert.deepEqual(mirror, { desired_revision: 1, generation: 1, state: 'queued', provider_envelope: null });
    await service.update(actor, scope, id, 1, content('Revision 2'));
    mirror = (await pool.query('SELECT desired_revision,generation,state FROM email_provider_draft_mirrors WHERE draft_id=$1', [id])).rows[0];
    assert.deepEqual(mirror, { desired_revision: 2, generation: 2, state: 'queued' });
    await pool.query("UPDATE email_provider_draft_mirrors SET state='unknown' WHERE draft_id=$1", [id]);
    await service.update(actor, scope, id, 2, content('Revision 3'));
    mirror = (await pool.query('SELECT desired_revision,generation,state FROM email_provider_draft_mirrors WHERE draft_id=$1', [id])).rows[0];
    assert.deepEqual(mirror, { desired_revision: 3, generation: 3, state: 'unknown' }, 'unknown remote effects are never blindly retried');
  });

  await t.test('mirror claims and finishes are fenced by queue token and desired generation', async () => {
    await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [org, owner, scope.account_id]);
    const id=draftId();await service.create(actor,scope,id,content());
    const mirrors=new EmailProviderDraftMirrorStore(db,cipher);
    const guard=async(tx:unknown)=>{await authority.current(actor,scope,'human_draft',tx);};
    const stale=await mirrors.claim(scope,id,1,'queue-lock-token-00000001',guard);
    assert.ok(stale);assert.equal(stale?.provider_state,null);
    await service.update(actor,scope,id,1,content('new desired revision'));
    assert.equal(await mirrors.finish(scope,id,stale!,'queue-lock-token-00000001',{state:'synced',provider_state:{provider_draft_ref:'private-ref',baseline_digest:'a'.repeat(64)}},guard),'queued',
      'late success retains provider identity while scheduling the newer desire');
    const current=await mirrors.claim(scope,id,2,'queue-lock-token-00000002',guard);
    assert.ok(current);assert.equal(current?.generation,2);
    assert.equal(current?.provider_state?.provider_draft_ref,'private-ref');
    assert.equal(await mirrors.finish(scope,id,current!,'queue-lock-token-00000002',{state:'synced',provider_state:{provider_draft_ref:'private-ref',baseline_digest:'a'.repeat(64),provider_version:'v1'}},guard),'synced');
    const raw=(await pool.query('SELECT state,provider_envelope::text AS envelope FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0];
    assert.equal(raw.state,'synced');assert.doesNotMatch(raw.envelope,/private-ref|a{32}/u);
    const repeated=await mirrors.claim(scope,id,2,'queue-lock-token-00000003',guard);assert.equal(repeated,null);

    const uncertainId=draftId();await service.create(actor,scope,uncertainId,content());
    const uncertainClaim=await mirrors.claim(scope,uncertainId,1,'queue-lock-token-00000004',guard);assert.ok(uncertainClaim);
    const active=await mirrors.readActiveClaim(scope,uncertainId,guard);assert.deepEqual(active,{draft_id:uncertainId,generation:1,desired_revision:1,operation_id:uncertainClaim!.operation_id});
    assert.equal(await mirrors.recoverToUnknown(scope,uncertainId,active!,guard),true);
    assert.equal(await mirrors.claim(scope,uncertainId,1,'queue-lock-token-00000005',guard),null,'expired effect reservation is never blindly replayed');
  });

  await t.test('provider effect observes the durable PostgreSQL mirror claim before returning create', async () => {
    await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [org, owner, scope.account_id]);
    const id=draftId();await service.create(actor,scope,id,content());
    const bytes=Buffer.from('synthetic MIME bytes'),mimeDigest=createHash('sha256').update(bytes).digest('hex');
    const capability={scope,resource_binding_id:binding,authority_version:'mirror-service-authority',expires_at:Date.now()+60_000};
    const lease={job_id:randomUUID(),lock_token:'mirror-service-lease-token-1234',job_name:'native-email-draft-sync' as const,draft_id:id,revision:1};
    let effectCalls=0;
    const provider={async sync(request:any,host:any){
      assert.equal(request.operation,'create');assert.equal(request.operation_id,(await pool.query('SELECT claim_operation_id FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0].claim_operation_id);
      const reserved=(await pool.query('SELECT state,claim_token_hash,claim_generation,claim_revision FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0];
      assert.equal(reserved.state,'syncing');assert.match(reserved.claim_token_hash,/^[a-f0-9]{64}$/u);assert.equal(reserved.claim_generation,1);assert.equal(reserved.claim_revision,1);
      effectCalls++;assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'create',account_id:scope.account_id,
        authority_epoch:9,provider_draft_ref:null,baseline_digest:null,desired_digest:mimeDigest}),true);
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'created',provider_draft_ref:'provider-private-test-id',baseline_digest:mimeDigest,provider_version:'version-1',limitations:[],mime_bytes:Buffer.from(bytes)};
    }};
    const current=async(actualScope:any,actualLease:any)=>{assert.deepEqual(actualScope,scope);assert.equal(actualLease.job_id,lease.job_id);return capability;};
    const processor=new EmailProviderDraftMirrorService(current as any,store,new EmailProviderDraftMirrorStore(db,cipher),
      {async prepareDesired(input:any){assert.equal(input.draft.revision,1);return {provider:'gmail',authority_epoch:9,mime_bytes:bytes,mime_digest:mimeDigest};}} as any,provider as any);
    assert.deepEqual(await processor.sync(scope,id,1,lease as any),{state:'synced',revision:1});
    assert.equal(effectCalls,1);assert.ok(bytes.every(value=>value===0));
    const saved=(await pool.query('SELECT state,provider_envelope::text AS envelope FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0];
    assert.equal(saved.state,'synced');assert.doesNotMatch(saved.envelope,/provider-private-test-id|version-1/u);
  });

  await t.test('in-flight create retains its provider reference but reports queued when a newer edit wins', async () => {
    await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',[org,owner,scope.account_id]);
    const id=draftId();await service.create(actor,scope,id,content('Revision one'));
    const bytes=Buffer.from('revision one mime'),mimeDigest=createHash('sha256').update(bytes).digest('hex');
    const capability={scope,resource_binding_id:binding,authority_version:'mirror-race-authority',expires_at:Date.now()+60_000};
    const lease={job_id:randomUUID(),lock_token:'mirror-race-lease-token-123456',job_name:'native-email-draft-sync' as const,draft_id:id,revision:1};
    const provider={async sync(request:any,host:any){
      assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'create',account_id:scope.account_id,
        authority_epoch:9,provider_draft_ref:null,baseline_digest:null,desired_digest:mimeDigest}),true);
      await service.update(actor,scope,id,1,content('Revision two wins'));
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'created',provider_draft_ref:'private-created-ref',baseline_digest:mimeDigest,provider_version:'version-one',limitations:[],mime_bytes:Buffer.from(bytes)};
    }};
    const current=async()=>capability;
    const processor=new EmailProviderDraftMirrorService(current as any,store,new EmailProviderDraftMirrorStore(db,cipher),
      {async prepareDesired(input:any){assert.equal(input.draft.revision,1);return {provider:'gmail',authority_epoch:9,mime_bytes:bytes,mime_digest:mimeDigest};}} as any,provider as any);
    assert.deepEqual(await processor.sync(scope,id,1,lease as any),{state:'queued',revision:1});
    assert.deepEqual((await pool.query('SELECT state,desired_revision,synced_revision FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0],
      {state:'queued',desired_revision:2,synced_revision:1});
    const claim=await new EmailProviderDraftMirrorStore(db,cipher).claim(scope,id,2,'mirror-race-next-lease-123456',async()=>{});
    assert.equal(claim?.provider_state?.provider_draft_ref,'private-created-ref','late creation is retained for update/inspection, never orphaned');
    assert.ok(bytes.every(value=>value===0));
  });

  await t.test('PostgreSQL draft content joins the native MIME builder before the reserved provider effect',async()=>{
    await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',[org,owner,scope.account_id]);
    const id=draftId(),draftContent:EmailDraftContent={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Database-backed draft',
      body:'Body from encrypted PostgreSQL',body_html:'',reply_record_id:'',attachments:[],from_identity:{address:'team@example.test'}};
    await service.create(actor,scope,id,draftContent);
    const nativeAccount={account_id:scope.account_id,provider:'gmail' as const,resource_binding_id:binding,authority_epoch:9,connection_revision:1,
      principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',verified_sender_identities:['owner@example.test','team@example.test'],display_label:'Owner'};
    const builder=createEmailProviderDraftMimeBuilder({resolve:async()=>({account:nativeAccount as any,verified_sender_identities:nativeAccount.verified_sender_identities,
      installation_id:'fixture-installation',serialize:serializeNativeDraft}),
      readFile:async()=>{throw new Error('Unexpected attachment');},readReply:async()=>{throw new Error('Unexpected reply');}});
    const lease={job_id:randomUUID(),lock_token:'native-mime-fixture-lease-token',job_name:'native-email-draft-sync' as const,draft_id:id,revision:1};
    const capability={scope,resource_binding_id:binding,authority_version:'mime-fixture-authority',expires_at:Date.now()+60_000};
    const captured:Uint8Array[]=[];
    const provider={async sync(request:any,host:any){
      assert.equal(request.operation,'create');assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'create',account_id:scope.account_id,
        authority_epoch:9,provider_draft_ref:null,baseline_digest:null,desired_digest:request.desired.mime_digest}),true);
       const parsed=await simpleParser(request.desired.mime_bytes);assert.equal(parsed.subject,'Database-backed draft');assert.equal(parsed.from.value[0].address,'team@example.test');
      assert.equal(parsed.text?.trim(),'Body from encrypted PostgreSQL');captured.push(request.desired.mime_bytes);
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'created',provider_draft_ref:'private-builder-joined-ref',baseline_digest:request.desired.mime_digest,provider_version:'provider-version',limitations:[],
        mime_bytes:new Uint8Array(request.desired.mime_bytes)};
    }};
    const processor=new EmailProviderDraftMirrorService(async()=>capability,store,new EmailProviderDraftMirrorStore(db,cipher),{prepareDesired:builder},provider as any);
    assert.deepEqual(await processor.sync(scope,id,1,lease as any),{state:'synced',revision:1});
    assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0].state,'synced');
    assert.ok(captured[0]?.every(value=>value===0),'processor clears the serialized MIME buffer after the provider call');
  });

  await t.test('Graph unknown update keeps its immutable operation and only explicit reconciliation may resume the journal',async()=>{
    await pool.query("UPDATE email_accounts SET provider_draft_sync_enabled=true,provider='microsoft' WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3",[org,owner,scope.account_id]);
    const id=draftId();await service.create(actor,scope,id,{...content('Pinned Graph MIME'),mode:'compose',reply_record_id:'',to:'recipient@example.test'});
    const mirrors=new EmailProviderDraftMirrorStore(db,cipher),guard=async(tx:unknown)=>{await authority.current(actor,scope,'human_draft',tx);};
    const bytes=Buffer.from('same deterministic Graph MIME'),wantedDigest=createHash('sha256').update(bytes).digest('hex');
    const originalOperationId=randomUUID(),oldState={schema_version:'deft.email_provider_draft_state.v1',account_id:scope.account_id,provider:'microsoft',
      provider_draft_ref:'immutable-graph-draft',baseline_digest:'b'.repeat(64),provider_version:'graph-change-key-1',
      recovery:{operation_id:originalOperationId,desired_revision:1,desired_digest:wantedDigest,provider_draft_ref:'immutable-graph-draft',
        baseline_digest:'b'.repeat(64),provider_version:'graph-change-key-1'}};
    const initial=await mirrors.claim(scope,id,1,'graph-initial-lease-token-123456',guard);assert.ok(initial);
    assert.equal(await mirrors.finish(scope,id,initial!,'graph-initial-lease-token-123456',{state:'unknown',provider_state:oldState},guard),'unknown');
    assert.equal(await mirrors.claim(scope,id,1,'graph-blind-retry-token-123456789',guard),null,'ordinary scheduler path never retries unknown');
    const statusService=new EmailProviderDraftMirrorStatusService(authority as any,mirrors),unknownStatus=await statusService.read(actor,org,scope.account_id,id);
    assert.equal(unknownStatus.recovery_available,true);assert.deepEqual(Object.keys(unknownStatus).sort(),
      ['account_id','desired_revision','draft_id','draft_revision','enabled','generation','recovery_available','state','synced_revision','updated_at'].sort());
    const payloads:any[]=[];
    const provider={async sync(request:any,host:any){payloads.push(request);
      assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'update',account_id:scope.account_id,authority_epoch:9,
        provider_draft_ref:'immutable-graph-draft',baseline_digest:'b'.repeat(64),desired_digest:wantedDigest}),true);
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'microsoft',operation_id:request.operation_id,outcome:'updated',
        provider_draft_ref:'immutable-graph-draft',baseline_digest:'c'.repeat(64),provider_version:'graph-change-key-2',limitations:[],mime_bytes:new Uint8Array(bytes)};
    }};
    const capability={scope,resource_binding_id:binding,authority_version:'graph-recovery-authority',expires_at:Date.now()+60_000};
    const lease={job_id:randomUUID(),lock_token:'graph-recovery-lease-token-123456',job_name:'native-email-draft-sync' as const,draft_id:id,revision:1,
      mode:'reconcile' as const,generation:1};
    const processor=new EmailProviderDraftMirrorService(async()=>capability,store,mirrors,{prepareDesired:async()=>({provider:'microsoft',authority_epoch:9,mime_bytes:bytes,mime_digest:wantedDigest})},provider as any);
    assert.deepEqual(await processor.reconcileUnknown(scope,id,1,lease as any),{state:'synced',revision:1});
    assert.equal(payloads.length,1);assert.equal(payloads[0].operation_id,originalOperationId);assert.equal(payloads[0].provider_version,'graph-change-key-1');
    assert.equal((await statusService.read(actor,org,scope.account_id,id)).recovery_available,false);
    const verified=await mirrors.claim(scope,id,1,'graph-verify-lease-token-123456',guard);assert.equal(verified?.provider_state?.recovery,undefined);
    assert.ok(bytes.every(value=>value===0));
  });

  await t.test('Graph update pins its original saga tuple in the encrypted mirror before any provider effect',async()=>{
    await pool.query("UPDATE email_accounts SET provider_draft_sync_enabled=true,provider='microsoft' WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3",[org,owner,scope.account_id]);
    const id=draftId(),compose:EmailDraftContent={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Graph mirror',body:'Local revision two',body_html:'',reply_record_id:'',attachments:[]};
    await service.create(actor,scope,id,compose);const mirrors=new EmailProviderDraftMirrorStore(db,cipher),guard=async(tx:unknown)=>{await authority.current(actor,scope,'human_draft',tx);};
    const initial=await mirrors.claim(scope,id,1,'graph-pin-initial-claim-token',guard);assert.ok(initial);
    const baseline=createHash('sha256').update('provider old draft').digest('hex');
    const currentState={schema_version:'deft.email_provider_draft_state.v1',account_id:scope.account_id,provider:'microsoft',provider_draft_ref:'graph-private-ref',
      baseline_digest:baseline,provider_version:'graph-version-one'};
    assert.equal(await mirrors.finish(scope,id,initial!,'graph-pin-initial-claim-token',{state:'synced',provider_state:currentState},guard),'synced');
    await service.update(actor,scope,id,1,{...compose,body:'Local revision two'});
    const bytes=Buffer.from('exact graph mime revision two'),wanted=createHash('sha256').update(bytes).digest('hex');
    const lease={job_id:randomUUID(),lock_token:'graph-pin-update-lease-token',job_name:'native-email-draft-sync' as const,draft_id:id,revision:2};
    const capability={scope,resource_binding_id:binding,authority_version:'graph-pin-authority',expires_at:Date.now()+60_000};let operationId='';
    const provider={async sync(request:any,host:any){
      if(request.operation==='inspect')return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'microsoft',operation_id:request.operation_id,
        outcome:'present',provider_draft_ref:'graph-private-ref',baseline_digest:baseline,provider_version:'graph-version-one',limitations:[],mime_bytes:Buffer.from('provider old draft')};
      assert.equal(request.operation,'update');operationId=request.operation_id;
      const row=(await pool.query('SELECT state,envelope_revision,provider_envelope FROM email_provider_draft_mirrors WHERE draft_id=$1',[id])).rows[0];
      assert.equal(row.state,'syncing');assert.equal(row.envelope_revision,2);assert.ok(row.provider_envelope,'operation tuple is durably pinned before provider effect');
      assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'update',account_id:scope.account_id,authority_epoch:9,
        provider_draft_ref:'graph-private-ref',baseline_digest:baseline,desired_digest:wanted}),true);
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'microsoft',operation_id:request.operation_id,outcome:'unknown',
        provider_draft_ref:'graph-private-ref',baseline_digest:baseline,provider_version:'graph-version-one',limitations:[]};
    }};
    const processor=new EmailProviderDraftMirrorService(async()=>capability,store,mirrors,{prepareDesired:async()=>({provider:'microsoft',authority_epoch:9,mime_bytes:bytes,mime_digest:wanted})},provider as any);
    assert.deepEqual(await processor.sync(scope,id,2,lease as any),{state:'unknown',revision:2});
    const recovered=await mirrors.claimRecovery(scope,id,2,'graph-pin-recovery-lease-token',guard);assert.ok(recovered);
    assert.equal(recovered?.operation_id,operationId);assert.deepEqual(recovered?.provider_state?.recovery,{operation_id:operationId,desired_revision:2,desired_digest:wanted,
      provider_draft_ref:'graph-private-ref',baseline_digest:baseline,provider_version:'graph-version-one'});
    assert.ok(bytes.every(value=>value===0));
  });

  await t.test('CAS conflict preserves edits, archive is soft, and archived content remains reopenable', async () => {
    const id = draftId(); await service.create(actor, scope, id, content());
    const changed = await service.update(actor, scope, id, 1, content('Updated but unsent'));
    assert.equal(changed.revision, 2); assert.equal(changed.content.body, 'Updated but unsent');
    await assert.rejects(service.update(actor, scope, id, 1, content('stale local buffer')),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_CONFLICT');
    const archived = await service.archive(actor, scope, id, 2);
    assert.equal(archived.status, 'archived'); assert.equal(archived.revision, 3);
    assert.equal((await service.list(actor, scope)).some(item => item.draft_id === id), false);
    assert.equal((await service.read(actor, scope, id)).content.body, 'Updated but unsent');
    const row = await pool.query('SELECT count(*)::int AS n FROM email_drafts WHERE org_id=$1 AND owner_user_id=$2 AND draft_id=$3', [org, owner, id]);
    assert.equal(row.rows[0].n, 1);
  });

  await t.test('agent-origin drafts retain immutable run provenance while human edits are tracked separately', async () => {
    const id = draftId();
    await store.create(scope, id, content(), { kind: 'agent', created_by_user_id: 'agent-fixture', originating_run_id: 'run-fixture' }, async () => {});
    const edited = await store.update(scope, id, 1, content('Human reviewed edit'), owner, async () => {});
    assert.deepEqual(edited.origin, { kind: 'agent', created_by_user_id: 'agent-fixture', originating_run_id: 'run-fixture' });
    assert.equal(edited.last_edited_by_user_id, owner); assert.equal(edited.content.body, 'Human reviewed edit');
  });

  await t.test('authority loss at final transaction fence rolls back an edit', async () => {
    const id = draftId(); const created = await service.create(actor, scope, id, content());
    calls = 0; denyAt = 3; // outer authority, transaction entry, final pre-commit fence
    await assert.rejects(service.update(actor, scope, id, created.revision, content('must roll back')),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_ACCESS_DENIED');
    denyAt = -1;
    assert.equal((await service.read(actor, scope, id)).content.body, content().body);
  });

  await t.test('route content cannot forge provenance, state, headers, or malformed attachment nomination', async () => {
    for (const invalid of [
      { ...content(), origin: 'agent', originating_run_id: 'forged-run' },
      { ...content(), status: 'submitted' },
      { ...content(), subject: 'header\r\nBcc: forged@example.test' },
      { ...content(), attachments: [{ ...content().attachments[0], sha256: 'not-a-digest' }] },
    ]) await assert.rejects(service.create(actor, scope, draftId(), invalid),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_INVALID');
  });
});
