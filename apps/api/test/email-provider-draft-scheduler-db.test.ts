import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailDrafts,emailProviderDraftMirrors,jobQueue} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailDraftStore} from '../src/lib/email-draft-store.js';
import {PostgresEmailProviderDraftScheduler} from '../src/lib/email-provider-draft-scheduler.js';
import {EmailProviderDraftMirrorStore} from '../src/lib/email-provider-draft-mirror-store.js';
import {PostgresEmailProviderDraftRecovery} from '../src/lib/email-provider-draft-recovery.js';
import {EmailProviderDraftControls} from '../src/lib/email-provider-draft-controls.js';

const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_upgrade';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const scope=()=>({org_id:'draft-scheduler-'+randomUUID(),owner_user_id:'owner-'+randomUUID(),account_id:'account-'+randomUUID()});
const content=(subject:string)=>({mode:'compose',to:'',cc:'',bcc:'',subject,body:'fixture',body_html:'',reply_record_id:'',attachments:[]});

test('provider-draft producer repairs opt-in desires atomically without reading content or resurrecting terminal states',{skip:!safe,timeout:45000},async t=>{
 const admin=new pg.Pool({connectionString:target,max:1}),schema='email_draft_scheduler_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:target,max:8,options:`-c search_path=${schema},public`});
 const db=drizzle(pool,{schema:{emailAccounts,emailDrafts,emailProviderDraftMirrors,jobQueue}});
 await pool.query(`CREATE TABLE email_accounts(
   org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL,
   resource_binding_id text NOT NULL,principal_digest text,state text NOT NULL,authority_revision integer NOT NULL,
   consented_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(org_id,owner_user_id,account_id))`);
 await pool.query(readFileSync(resolve(process.cwd(),'packages/db/upgrades/0.3.0-preview.66-email-native-drafts.sql'),'utf8'));
 await pool.query(readFileSync(resolve(process.cwd(),'packages/db/upgrades/0.3.0-preview.70-email-provider-draft-mirrors.sql'),'utf8'));
 await pool.query('CREATE TABLE queue_fixture(payload jsonb NOT NULL,dedupe_key text UNIQUE NOT NULL)');
 await pool.query('CREATE TABLE job_queue(id text PRIMARY KEY,org_id text NOT NULL,queue text NOT NULL,name text NOT NULL,status text NOT NULL,lock_expires_at timestamptz,data jsonb NOT NULL,dedupe_key text UNIQUE)');
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 const keys={current:()=>({key_id:'scheduler-fixture-key',key:Buffer.alloc(32,41)}),read:(_purpose:unknown,id:string)=>id==='scheduler-fixture-key'?{key_id:id,key:Buffer.alloc(32,41)}:null,keyIds:()=>['scheduler-fixture-key']};
 const cipher=new EmailMailboxCrypto(keys),drafts=new EmailDraftStore(db,cipher);
 const addAccount=async(s:ReturnType<typeof scope>,enabled:boolean)=>pool.query(
  `INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at,provider_draft_sync_enabled)
   VALUES($1,$2,$3,'gmail','binding-fixture',$4,'active',7,now(),$5)`,[s.org_id,s.owner_user_id,s.account_id,'a'.repeat(64),enabled]);
 const addDraft=async(s:ReturnType<typeof scope>,id=randomUUID(),subject='fixture')=>drafts.create(s,id,content(subject),
  {kind:'human',created_by_user_id:s.owner_user_id,originating_run_id:null},async()=>{});
 const scheduledPayloads:unknown[]=[];
 const enqueue=async(tx:any,payload:unknown,key:string)=>{scheduledPayloads.push(payload);await tx.execute(sql`INSERT INTO queue_fixture(payload,dedupe_key) VALUES (${JSON.stringify(payload)}::jsonb,${key}) ON CONFLICT(dedupe_key) DO NOTHING`);};
 const scheduler=new PostgresEmailProviderDraftScheduler(db as any,cipher,enqueue);

 await t.test('seeds a preexisting draft after opt-in and dedupes an already queued desired revision',async()=>{
  const s=scope();await addAccount(s,false);const existing=await addDraft(s);
  await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',[s.org_id,s.owner_user_id,s.account_id]);
  const first=await scheduler.repair(null,10);assert.equal(first.scheduled,1);
  const row=(await pool.query('SELECT state,desired_revision FROM email_provider_draft_mirrors WHERE draft_id=$1',[existing.draft_id])).rows[0];
  assert.deepEqual(row,{state:'queued',desired_revision:1});
  const second=await scheduler.repair(null,10);assert.equal(second.scheduled,1,'queued rows are durably rearmed with the same queue dedupe identity');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM queue_fixture')).rows[0].n,1);
  assert.equal(scheduledPayloads.length,2);
  assert.deepEqual(scheduledPayloads[0],{...s,draft_id:existing.draft_id,revision:1,authority_revision:7});
  await pool.query("UPDATE email_provider_draft_mirrors SET state='paused' WHERE draft_id=$1",[existing.draft_id]);
 });

 await t.test('terminal conflict and unknown rows are preserved even when a missed desire is repaired',async()=>{
  const s=scope();await addAccount(s,true);
  for(const state of ['conflict','unknown'] as const){
   const row=await addDraft(s);await drafts.update(s,row.draft_id,1,content('second'),s.owner_user_id,async()=>{});
   await pool.query('UPDATE email_provider_draft_mirrors SET state=$1,desired_revision=1 WHERE draft_id=$2',[state,row.draft_id]);
  }
  const before=(await pool.query('SELECT count(*)::int AS n FROM queue_fixture')).rows[0].n;
  const result=await scheduler.repair(null,10);assert.equal(result.scheduled,0);
  const states=(await pool.query("SELECT state,desired_revision FROM email_provider_draft_mirrors WHERE org_id=$1 ORDER BY state",[s.org_id])).rows;
  assert.deepEqual(states,[{state:'conflict',desired_revision:2},{state:'unknown',desired_revision:2}]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM queue_fixture')).rows[0].n,before);
 });

 await t.test('queue enqueue and newly repaired mirror row roll back together',async()=>{
  const s=scope();await addAccount(s,true);const row=await addDraft(s);
  await pool.query('DELETE FROM email_provider_draft_mirrors WHERE draft_id=$1',[row.draft_id]);
  const failing=new PostgresEmailProviderDraftScheduler(db as any,cipher,async(tx:any,payload:unknown,key:string)=>{
   await tx.execute(sql`INSERT INTO queue_fixture(payload,dedupe_key) VALUES (${JSON.stringify(payload)}::jsonb,${key}) ON CONFLICT(dedupe_key) DO NOTHING`);
   throw new Error('fixture enqueue failure');
  });
  await assert.rejects(failing.repair(null,10),/fixture enqueue failure/u);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_provider_draft_mirrors WHERE draft_id=$1',[row.draft_id])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM queue_fixture')).rows[0].n,1,'only the first subtest queue row remains');
 });

 await t.test('recovery leaves an exact live lease alone and makes expired or foreign-scope effects unknown',async()=>{
  const a=scope(),b=scope(),c=scope();await addAccount(a,true);await addAccount(b,true);await addAccount(c,true);
  const first=await addDraft(a),second=await addDraft(b),third=await addDraft(c);const mirrors=new EmailProviderDraftMirrorStore(db as any,cipher);
  const firstClaim=await mirrors.claim(a,first.draft_id,1,'recovery-live-token-123456789',async()=>{});
  const secondClaim=await mirrors.claim(b,second.draft_id,1,'recovery-foreign-token-123456',async()=>{});
  const thirdClaim=await mirrors.claim(c,third.draft_id,1,'recovery-expired-token-123456',async()=>{});
  assert.ok(firstClaim&&secondClaim&&thirdClaim);
  await pool.query("UPDATE email_provider_draft_mirrors SET updated_at=now()-interval '5 minutes' WHERE draft_id=$1",[first.draft_id]);
  await pool.query("UPDATE email_provider_draft_mirrors SET updated_at=now()-interval '4 minutes' WHERE draft_id=$1",[second.draft_id]);
  await pool.query("UPDATE email_provider_draft_mirrors SET updated_at=now()-interval '3 minutes' WHERE draft_id=$1",[third.draft_id]);
  await pool.query('INSERT INTO job_queue(id,org_id,queue,name,status,lock_expires_at,data) VALUES($1,$2,$3,$4,$5,now()+interval \'2 minutes\',$6::jsonb),($7,$8,$9,$10,$11,now()+interval \'2 minutes\',$12::jsonb)',[
   randomUUID(),a.org_id,'scheduled-jobs','native-email-draft-sync','running',JSON.stringify({...a,draft_id:first.draft_id,revision:1}),
   randomUUID(),b.org_id,'scheduled-jobs','native-email-draft-sync','running',JSON.stringify({...b,account_id:'foreign-account',draft_id:second.draft_id,revision:1})]);
  const recovery=new PostgresEmailProviderDraftRecovery(db as any,mirrors,()=>Date.now());
  assert.deepEqual(await recovery.recover(1),{scanned:1,recovered:1},'live oldest row is excluded before the batch limit');
  let states=(await pool.query('SELECT draft_id,state FROM email_provider_draft_mirrors WHERE draft_id=ANY($1::text[]) ORDER BY draft_id',[[first.draft_id,second.draft_id]])).rows;
  assert.equal(states.find((row:any)=>row.draft_id===first.draft_id)?.state,'syncing');
  assert.equal(states.find((row:any)=>row.draft_id===second.draft_id)?.state,'unknown');
  assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[third.draft_id])).rows[0].state,'syncing');
  assert.deepEqual(await recovery.recover(1),{scanned:1,recovered:1});
  assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[third.draft_id])).rows[0].state,'unknown');
  await pool.query("UPDATE job_queue SET lock_expires_at=now()-interval '1 second' WHERE data->>'draft_id'=$1",[first.draft_id]);
  assert.deepEqual(await recovery.recover(10),{scanned:1,recovered:1});
  assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[first.draft_id])).rows[0].state,'unknown');
  assert.equal(await mirrors.claim(a,first.draft_id,1,'recovery-do-not-replay-token',async()=>{}),null);
 });

 await t.test('human recovery control is owner-guarded, generation-CASed, atomic, and reports pending state',async()=>{
  const s=scope();await addAccount(s,true);await pool.query("UPDATE email_accounts SET provider='microsoft' WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3",[s.org_id,s.owner_user_id,s.account_id]);
  const draft=await addDraft(s),mirrors=new EmailProviderDraftMirrorStore(db as any,cipher),lock='control-fixture-initial-token-123456';
  const claim=await mirrors.claim(s,draft.draft_id,1,lock,async()=>{});assert.ok(claim);
  const digest='f'.repeat(64),state={schema_version:'deft.email_provider_draft_state.v1',account_id:s.account_id,provider:'microsoft',provider_draft_ref:'private-control-ref',
   baseline_digest:'e'.repeat(64),provider_version:'control-version',recovery:{operation_id:claim!.operation_id,desired_revision:1,desired_digest:digest,
    provider_draft_ref:'private-control-ref',baseline_digest:'e'.repeat(64),provider_version:'control-version'}};
  assert.equal(await mirrors.finish(s,draft.draft_id,claim!,lock,{state:'unknown',provider_state:state},async()=>{}),'unknown');
  const actor={user_id:s.owner_user_id,web_session_id:'sid-control-fixture',access_expires_at:Date.now()+60000};
  const authority={async current(actual:any,selected:any,operation:string){assert.equal(actual.user_id,selected.owner_user_id);
   assert.ok(operation==='human_read'||operation==='human_modify');return {scope:s,resource_binding_id:'control-binding',authority_version:'control-revision',expires_at:Date.now()+60000};}};
  const enqueueControl=async(tx:any,payload:any,key:string)=>tx.execute(sql`INSERT INTO job_queue(id,org_id,queue,name,status,data,dedupe_key)
    VALUES (${randomUUID()},${payload.org_id},'scheduled-jobs','native-email-draft-sync','pending',${JSON.stringify(payload)}::jsonb,${key}) ON CONFLICT(dedupe_key) DO NOTHING`);
  const controls=new EmailProviderDraftControls(db as any,authority as any,mirrors as any,enqueueControl as any);
  const status=await controls.status(actor,s,draft.draft_id);assert.equal(status.recovery_available,true);assert.equal(status.recovery_pending,false);
  assert.deepEqual(await controls.recover(actor,s,draft.draft_id,{expected_revision:1,expected_generation:status.generation}),
    {account_id:s.account_id,draft_id:draft.draft_id,state:'queued'});
  assert.equal((await controls.status(actor,s,draft.draft_id)).recovery_pending,true);
  const queued=(await pool.query("SELECT data FROM job_queue WHERE data->>'draft_id'=$1",[draft.draft_id])).rows[0].data;
  assert.deepEqual(queued,{...s,draft_id:draft.draft_id,revision:1,generation:1,mode:'reconcile',authority_revision:7});
  await pool.query("UPDATE job_queue SET status='failed' WHERE data->>'draft_id'=$1",[draft.draft_id]);
  await assert.rejects(controls.recover(actor,s,draft.draft_id,{expected_revision:1,expected_generation:2}),/EMAIL_DRAFT_SYNC_CONFLICT/u);
  const broken=new EmailProviderDraftControls(db as any,authority as any,mirrors as any,async(tx:any,payload:any,key:string)=>{
   await tx.execute(sql`INSERT INTO job_queue(id,org_id,queue,name,status,data,dedupe_key) VALUES (${randomUUID()},${payload.org_id},'scheduled-jobs','native-email-draft-sync','pending',${JSON.stringify(payload)}::jsonb,${key})`);
   throw new Error('fixture enqueue failure');
  });
  const other=scope();await addAccount(other,true);await pool.query("UPDATE email_accounts SET provider='microsoft' WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3",[other.org_id,other.owner_user_id,other.account_id]);
  const otherDraft=await addDraft(other),otherClaim=await mirrors.claim(other,otherDraft.draft_id,1,'control-other-claim-token-123456',async()=>{});assert.ok(otherClaim);
  await mirrors.finish(other,otherDraft.draft_id,otherClaim!,'control-other-claim-token-123456',{state:'unknown',provider_state:{...state,account_id:other.account_id,
   provider_draft_ref:'private-other-ref',recovery:{...state.recovery,operation_id:otherClaim!.operation_id,provider_draft_ref:'private-other-ref'}}},async()=>{});
  await assert.rejects(broken.recover({...actor,user_id:other.owner_user_id},other,otherDraft.draft_id,{expected_revision:1,expected_generation:1}),/fixture enqueue failure/u);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM job_queue WHERE data->>'draft_id'=$1",[otherDraft.draft_id])).rows[0].n,0);
  assert.equal((await pool.query('SELECT state FROM email_provider_draft_mirrors WHERE draft_id=$1',[otherDraft.draft_id])).rows[0].state,'unknown');
 });
});
