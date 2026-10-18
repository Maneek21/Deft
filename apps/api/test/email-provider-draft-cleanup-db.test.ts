import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailDrafts,emailProviderDraftMirrors,emailSendOperations} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailDraftStore,type EmailDraftContent} from '../src/lib/email-draft-store.js';
import {EmailSendStore} from '../src/lib/email-send-store.js';
import {EmailProviderDraftMirrorStore} from '../src/lib/email-provider-draft-mirror-store.js';
import {EmailProviderDraftCleanupService} from '../src/lib/email-provider-draft-cleanup.js';
import {PostgresEmailProviderDraftCleanupScheduler} from '../src/lib/email-provider-draft-cleanup-scheduler.js';
import {EmailProviderDraftControls} from '../src/lib/email-provider-draft-controls.js';

const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_upgrade';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const content:EmailDraftContent={mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Synthetic cleanup',body:'Only test data',body_html:'',reply_record_id:'',attachments:[]};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

test('provider draft cleanup requires an accepted send and never repeats an uncertain DELETE',{skip:!safe,timeout:45000},async t=>{
  const admin=new pg.Pool({connectionString:target,max:1}),schema='email_cleanup_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:target,max:8,options:`-c search_path=${schema},public`});
  await pool.query('CREATE TABLE job_queue (LIKE public.job_queue INCLUDING ALL)');
  const db=drizzle(pool,{schema:{emailAccounts,emailDrafts,emailProviderDraftMirrors,emailSendOperations}});
  await pool.query(`CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL DEFAULT 'gmail',
    provider_draft_sync_enabled boolean NOT NULL DEFAULT false,state text NOT NULL DEFAULT 'active',authority_revision integer NOT NULL DEFAULT 1,
    resource_binding_id text NOT NULL DEFAULT 'fixture-binding',revoked_at timestamptz,consented_at timestamptz NOT NULL DEFAULT now(),
    principal_digest text NOT NULL DEFAULT '${'a'.repeat(64)}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,owner_user_id,account_id))`);
  await pool.query(readFileSync(resolve(process.cwd(),'packages/db/upgrades/0.3.0-preview.66-email-native-drafts.sql'),'utf8'));
  await pool.query(readFileSync(resolve(process.cwd(),'packages/db/upgrades/0.3.0-preview.70-email-provider-draft-mirrors.sql'),'utf8'));
  await pool.query(readFileSync(resolve(process.cwd(),'packages/db/upgrades/0.3.0-preview.68-email-native-send.sql'),'utf8'));
  await pool.query(readFileSync(resolve(process.cwd(),'packages/db/upgrades/0.3.0-preview.72-email-outbox.sql'),'utf8'));
  const org='cleanup-fixture-'+randomUUID(),owner='owner-'+randomUUID(),scope={org_id:org,owner_user_id:owner,account_id:'account-'+randomUUID()};
  await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,provider_draft_sync_enabled) VALUES($1,$2,$3,$4,true)',[org,owner,scope.account_id,'gmail']);
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const keys={current:()=>({key_id:'email-cleanup-db-test',key:Buffer.alloc(32,61)}),read:(_purpose:unknown,id:string)=>id==='email-cleanup-db-test'?{key_id:id,key:Buffer.alloc(32,61)}:null,keyIds:()=>['email-cleanup-db-test']};
  const crypto=new EmailMailboxCrypto(keys),drafts=new EmailDraftStore(db,crypto),sends=new EmailSendStore(db,crypto),mirrors=new EmailProviderDraftMirrorStore(db,crypto);
  const guard=async(tx:unknown)=>{await (tx as typeof db).execute(sql`SELECT 1 FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} FOR SHARE`);};
  const makeAccepted=async()=>{
    const draftId=randomUUID(),sendOperationId=randomUUID();
    await drafts.create(scope,draftId,content,{kind:'human',created_by_user_id:owner,originating_run_id:null},guard);
    const claimed=await mirrors.claim(scope,draftId,1,'cleanup-sync-lease-token-123456',guard);assert.ok(claimed);
    const baseDigest=digest(Buffer.from('provider original draft'));
    const providerState={schema_version:'deft.email_provider_draft_state.v1',account_id:scope.account_id,provider:'gmail',provider_draft_ref:'private-gmail-draft-ref',
      baseline_digest:baseDigest,provider_version:'gmail-version-1'};
    assert.equal(await mirrors.finish(scope,draftId,claimed!,'cleanup-sync-lease-token-123456',{state:'synced',provider_state:providerState},guard),'synced');
    await sends.reserve(scope,draftId,1,owner,sendOperationId,'a'.repeat(64),guard);
    await sends.finish(scope,sendOperationId,'accepted','private-provider-message',guard);
    return {draftId,sendOperationId,baseDigest,providerState};
  };
  const makeAcceptedOutbox=async()=>{
    const draftId=randomUUID(),outboxId=randomUUID(),operationId=randomUUID(),requestId=randomUUID(),jobId=randomUUID(),attemptId=randomUUID();
    await drafts.create(scope,draftId,content,{kind:'human',created_by_user_id:owner,originating_run_id:null},guard);
    const claim=await mirrors.claim(scope,draftId,1,'cleanup-outbox-token-123456789',guard),baseDigest=digest(Buffer.from('outbox provider draft'));
    const providerState={schema_version:'deft.email_provider_draft_state.v1',account_id:scope.account_id,provider:'gmail',provider_draft_ref:'private-outbox-draft',baseline_digest:baseDigest,provider_version:'outbox-gmail-v1'};
    assert.ok(claim);assert.equal(await mirrors.finish(scope,draftId,claim!,'cleanup-outbox-token-123456789',{state:'synced',provider_state:providerState},guard),'synced');
    await pool.query("UPDATE email_drafts SET status='submitted',revision=2,submitted_at=now() WHERE draft_id=$1",[draftId]);
    const stateEnvelope=crypto.seal({schedule:null,reason:null,provider_message_id:'private-outbox-receipt'},{...scope,kind:'operation',record_id:'outbox:'+outboxId+':state',revision:2});
    const bytes=Buffer.from('x'),mimeDigest=digest(bytes);
    await pool.query("INSERT INTO email_outbox(org_id,owner_user_id,account_id,outbox_id,request_id,operation_id,draft_id,draft_revision,revision,state,job_id,earliest_dispatch_at,snapshot_envelope,state_envelope,mime_digest,byte_length,ciphertext,key_version,nonce_b64,auth_tag_b64,attempt_id,attempt_lock_hash,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,2,'accepted',$8,now(),'{}'::jsonb,$9,$10,1,$11,'cleanup-test','aaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbb',$12,$13,now())",
      [scope.org_id,scope.owner_user_id,scope.account_id,outboxId,requestId,operationId,draftId,jobId,JSON.stringify(stateEnvelope),mimeDigest,bytes,attemptId,digest(Buffer.from('lock'))]);
    return {draftId,operationId,outboxId,baseDigest};
  };
  const cap={scope,resource_binding_id:'cleanup-binding',authority_version:'cleanup-authority',expires_at:Date.now()+60_000};
  const leaseFor=(id:string,operationId:string,mode:'delete'|'reconcile',generation:number)=>({job_id:randomUUID(),lock_token:'cleanup-job-lock-token-123456',job_name:'native-email-draft-cleanup' as const,
    draft_id:id,revision:1,operation_id:operationId,mode,generation});

  await t.test('one confirmed accepted receipt authorizes one exact version delete; local submitted content remains',async()=>{
    const {draftId,sendOperationId,baseDigest}=await makeAccepted();
    assert.equal(await sends.verifyAccepted(scope,{operation_id:sendOperationId,draft_id:draftId,revision:1},async()=>{},undefined),true);
    const lease=leaseFor(draftId,sendOperationId,'delete',1),calls:string[]=[],mime=Buffer.from('provider original draft'),readback=new Uint8Array(mime);
    const provider={async sync(request:any,host:any){calls.push(request.operation);
      if(request.operation==='inspect')return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'present',provider_draft_ref:'private-gmail-draft-ref',baseline_digest:baseDigest,provider_version:'gmail-version-1',limitations:[],mime_bytes:readback};
      assert.equal(request.operation,'delete');assert.equal(request.baseline_digest,baseDigest);assert.equal(request.provider_version,'gmail-version-1');
      assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'delete',account_id:scope.account_id,authority_epoch:9,
        provider_draft_ref:'private-gmail-draft-ref',baseline_digest:baseDigest,desired_digest:null}),true);
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'deleted',provider_draft_ref:'private-gmail-draft-ref',limitations:[]};
    }};
    const service=new EmailProviderDraftCleanupService(async(_scope,_lease)=>cap,mirrors,sends,provider as any);
    assert.deepEqual(await service.deleteAccepted(scope,draftId,1,sendOperationId,lease as any),{state:'deleted',revision:1});
    assert.deepEqual(calls,['inspect','delete']);assert.ok(readback.every(value=>value===0));
    const row=(await pool.query('SELECT state,provider_envelope FROM email_provider_draft_mirrors WHERE draft_id=$1',[draftId])).rows[0];
    assert.equal(row.state,'deleted');assert.equal(row.provider_envelope,null);
    const submitted=await drafts.read(scope,draftId,guard);assert.equal(submitted?.status,'submitted');assert.equal(submitted?.content_revision,1);
  });

  await t.test('changed provider version becomes conflict without DELETE; queued job alone is not accepted proof',async()=>{
    const {draftId,sendOperationId,baseDigest}=await makeAccepted(),lease=leaseFor(draftId,sendOperationId,'delete',1);
    const changed={async sync(request:any){assert.equal(request.operation,'inspect');return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,
      provider:'gmail',operation_id:request.operation_id,outcome:'present',provider_draft_ref:'private-gmail-draft-ref',baseline_digest:baseDigest,
      provider_version:'externally-changed-version',limitations:[],mime_bytes:Buffer.from('external edit')};}};
    const service=new EmailProviderDraftCleanupService(async()=>cap,mirrors,sends,changed as any);
    assert.deepEqual(await service.deleteAccepted(scope,draftId,1,sendOperationId,leaseFor(draftId,sendOperationId,'delete',2) as any),{state:'skipped',revision:1},
      'stale mirror generation cannot claim cleanup');
    assert.deepEqual(await service.deleteAccepted(scope,draftId,1,sendOperationId,lease as any),{state:'conflict',revision:1});
    assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[draftId])).rows[0].state,'conflict');
    const other=await makeAccepted();await pool.query("UPDATE email_send_operations SET state='unknown' WHERE operation_id=$1",[other.sendOperationId]);
    const unsafeLease=leaseFor(other.draftId,other.sendOperationId,'delete',1);
    await assert.rejects(service.deleteAccepted(scope,other.draftId,1,other.sendOperationId,unsafeLease as any),/CLEANUP|ACCESS|RETRY/u);
    assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[other.draftId])).rows[0].state,'synced');
  });

  await t.test('lost delete acknowledgement is reconciled by inspection only',async()=>{
    const {draftId,sendOperationId,baseDigest}=await makeAccepted(),lease=leaseFor(draftId,sendOperationId,'delete',1),calls:string[]=[],readbacks:Uint8Array[]=[];
    const provider={async sync(request:any,host:any){calls.push(request.operation);
      if(request.operation==='inspect'){const bytes=new Uint8Array(Buffer.from('provider original draft'));readbacks.push(bytes);return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,
        outcome:'present',provider_draft_ref:'private-gmail-draft-ref',baseline_digest:baseDigest,provider_version:'gmail-version-1',limitations:[],mime_bytes:bytes};}
      assert.equal(await host.draft_sync_before_effect({operation_id:request.operation_id,operation:'delete',account_id:scope.account_id,authority_epoch:9,
        provider_draft_ref:'private-gmail-draft-ref',baseline_digest:baseDigest,desired_digest:null}),true);
      return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,outcome:'unknown',
        provider_draft_ref:'private-gmail-draft-ref',limitations:[]};
    }};
    const service=new EmailProviderDraftCleanupService(async()=>cap,mirrors,sends,provider as any);
    assert.deepEqual(await service.deleteAccepted(scope,draftId,1,sendOperationId,lease as any),{state:'unknown',revision:1});assert.ok(readbacks.every(bytes=>bytes.every(value=>value===0)));
    const unknown=(await pool.query('SELECT state,provider_envelope::text AS envelope FROM email_provider_draft_mirrors WHERE draft_id=$1',[draftId])).rows[0];
    assert.equal(unknown.state,'unknown');assert.doesNotMatch(unknown.envelope,/private-gmail-draft-ref|gmail-version-1/u);
    const actor={user_id:owner,web_session_id:'sid-'+randomUUID(),access_expires_at:Date.now()+60_000},controlJobs:any[]=[];
    const authority={async current(_actor:any,selected:any,operation:string){assert.deepEqual(selected,scope);assert.ok(['human_read','human_modify'].includes(operation));
      return {scope,resource_binding_id:'cleanup-binding',authority_version:'cleanup-authority',expires_at:actor.access_expires_at};}};
    const controls=new EmailProviderDraftControls(db as any,authority as any,mirrors,async()=>{},)
      .useCleanup({mirrors,sends,enqueue:async(tx,payload,key)=>{controlJobs.push(payload);await (tx as unknown as typeof db).execute(sql`INSERT INTO job_queue(id,org_id,queue,name,data,status,run_at,max_attempts,dedupe_key)
        VALUES(${randomUUID()},${scope.org_id},'scheduled-jobs','native-email-draft-cleanup',${JSON.stringify(payload)}::jsonb,'pending',now(),2,${key})`);}});
    const status=await controls.status(actor,scope,draftId);assert.equal(status.recovery_available,true);assert.equal(status.state,'unknown');
    assert.deepEqual(Object.keys(status).sort(),['draft_id','account_id','enabled','draft_revision','state','desired_revision','synced_revision','generation','updated_at','recovery_available','recovery_pending'].sort());
    const queued=await controls.recover(actor,scope,draftId,{expected_revision:status.draft_revision,expected_generation:1});assert.equal(queued.state,'queued');
    assert.equal((await controls.status(actor,scope,draftId)).recovery_pending,true);
    assert.equal((await controls.recover(actor,scope,draftId,{expected_revision:status.draft_revision,expected_generation:1})).state,'queued');
    assert.equal(controlJobs.length,1,'repeated status recovery does not enqueue duplicate cleanup work');
    assert.deepEqual(controlJobs[0],{...scope,draft_id:draftId,revision:1,operation_id:sendOperationId,generation:1,authority_revision:1,mode:'reconcile'});
    const stored=(await mirrors.claim(scope,draftId,1,'cleanup-normal-retry-token-123456',guard));assert.equal(stored,null,'unknown delete cannot enter the ordinary sync/delete path');
    const recoveryLease=leaseFor(draftId,sendOperationId,'reconcile',1),before=calls.length;
    const stillPresent={async sync(request:any){calls.push(request.operation);assert.equal(request.operation,'inspect');return {schema_version:'deft.email_draft_sync_result.v1',
      account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,outcome:'present',provider_draft_ref:'private-gmail-draft-ref',
      baseline_digest:baseDigest,provider_version:'gmail-version-1',limitations:[],mime_bytes:Buffer.from('provider original draft')};}};
    const reconcile=new EmailProviderDraftCleanupService(async()=>cap,mirrors,sends,stillPresent as any);
    assert.deepEqual(await reconcile.reconcileUnknown(scope,draftId,1,sendOperationId,recoveryLease as any),{state:'unknown',revision:1});
    assert.equal(calls.slice(before).join(','),'inspect');assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[draftId])).rows[0].state,'unknown');
    const absent={async sync(request:any){assert.equal(request.operation,'inspect');return {schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,
      provider:'gmail',operation_id:request.operation_id,outcome:'missing',provider_draft_ref:'private-gmail-draft-ref',limitations:[]};}};
    const reconcileAbsent=new EmailProviderDraftCleanupService(async()=>cap,mirrors,sends,absent as any);
    assert.deepEqual(await reconcileAbsent.reconcileUnknown(scope,draftId,1,sendOperationId,leaseFor(draftId,sendOperationId,'reconcile',1) as any),{state:'deleted',revision:1});
    assert.equal((await pool.query('SELECT state,provider_envelope FROM email_provider_draft_mirrors WHERE draft_id=$1',[draftId])).rows[0].provider_envelope,null);
  });

  await t.test('bounded producer queues only accepted exact-revision mapped drafts and does not schedule unknown cleanup',async()=>{
    const first=await makeAccepted(),queued:any[]=[];
    const scheduler=new PostgresEmailProviderDraftCleanupScheduler(db as any,sends,async(_tx,payload,key)=>{queued.push({payload,key});});
    const outbox=await makeAcceptedOutbox();
    assert.equal(await sends.verifyAccepted(scope,{operation_id:outbox.operationId,draft_id:outbox.draftId,revision:1},async()=>{}),true);
    const page=await scheduler.repair(null,10);
    assert.equal(page.scanned,2);assert.equal(page.scheduled,2);
    const direct=queued.find(item=>item.payload.operation_id===first.sendOperationId),scheduled=queued.find(item=>item.payload.operation_id===outbox.operationId);
    assert.deepEqual(direct.payload,{...scope,draft_id:first.draftId,revision:1,operation_id:first.sendOperationId,generation:1,authority_revision:1,mode:'delete'});
    assert.deepEqual(scheduled.payload,{...scope,draft_id:outbox.draftId,revision:1,operation_id:outbox.operationId,generation:1,authority_revision:1,mode:'delete'});
    const again=await scheduler.repair(null,10);assert.equal(again.scheduled,2);
    assert.equal(queued.find((item,index)=>index>=2&&item.payload.operation_id===first.sendOperationId)?.key,direct.key,'direct-send dedupe key stays stable');
    assert.equal(queued.find((item,index)=>index>=2&&item.payload.operation_id===outbox.operationId)?.key,scheduled.key,'Outbox dedupe key stays stable');
    await pool.query("UPDATE email_provider_draft_mirrors SET state='unknown' WHERE draft_id=$1",[first.draftId]);
    await pool.query("UPDATE email_provider_draft_mirrors SET state='unknown' WHERE draft_id=$1",[outbox.draftId]);
    const afterUnknown=await scheduler.repair(null,10);assert.equal(afterUnknown.scanned,0,'unknown outcomes require explicit inspect-only recovery');
  });
});
