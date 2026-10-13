import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {canonicalCapabilityJson} from '@deft/shared';
import {emailAccounts,emailOperations,emailDrafts,emailProviderDraftMirrors,emailOutbox,emailOutboxEvents,jobQueue} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailOutboxCrypto} from '../src/lib/email-outbox-crypto.js';
import {EmailOutboxStore} from '../src/lib/email-outbox-store.js';
import {EmailOutboxService} from '../src/lib/email-outbox-service.js';
import {EmailDraftStore} from '../src/lib/email-draft-store.js';
import {PostgresEmailGraphSendJournal} from '../src/lib/email-graph-send-journal.js';
import {RegisteredEmailNativeSendProvider} from '../src/lib/email-native-send-provider.js';
import {createEmailNativeOutgoingSnapshotBuilder} from '../src/lib/email-native-outgoing-snapshot.js';
import {EmailDraftContentSchema} from '../src/lib/email-draft-service.js';
import type {EmailGraphSendPlan} from '../src/lib/email-graph-send-contract.js';
import type {EmailOutboxLease} from '../src/lib/email-outbox-contract.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
test('actual PG Graph progress, registered preparation and leased encrypted Outbox',{skip:!safe,timeout:90000},async t=>{
 const namespace='email_graph_send_'+randomUUID().replaceAll('-','');assert.match(namespace,/^email_graph_send_[a-f0-9]{32}$/u);
 const admin=new pg.Pool({connectionString:target});await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:8});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 await pool.query("CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,authority_revision integer NOT NULL DEFAULT 7,provider_draft_sync_enabled boolean NOT NULL DEFAULT false,state text NOT NULL DEFAULT 'active',PRIMARY KEY(org_id,owner_user_id,account_id))");
 await pool.query('CREATE TABLE job_queue (LIKE public.job_queue INCLUDING ALL)');
 for(const name of ['66-email-native-drafts','67-email-native-operations','70-email-provider-draft-mirrors','71-email-draft-sync-journal','72-email-outbox','73-email-outbox-attempt-markers','74-email-graph-send-upload']){
  const ddl=readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.'+name+'.sql',import.meta.url),'utf8');await pool.query(ddl);if(name.startsWith('74'))await pool.query(ddl);
 }
 const database=drizzle(pool,{schema:{emailAccounts,emailOperations,emailDrafts,emailProviderDraftMirrors,emailOutbox,emailOutboxEvents,jobQueue}}),scope={org_id:'graph-send-org',owner_user_id:'graph-send-owner',account_id:'graph-send-account'};
 await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES($1,$2,$3)',Object.values(scope));
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'graph-send-key',key:Buffer.alloc(32,61)}),read:(_purpose,id)=>id==='graph-send-key'?{key_id:id,key:Buffer.alloc(32,61)}:null,keyIds:()=>['graph-send-key']});
 const binary=new EmailOutboxCrypto({current:()=>({key_id:'graph-send-key',key:Buffer.alloc(32,61)}),read:(_purpose,id)=>id==='graph-send-key'?{key_id:id,key:Buffer.alloc(32,61)}:null,keyIds:()=>['graph-send-key']});
 let clock=Date.now(),revoked=false;const guard=async(tx:unknown)=>{if(revoked)throw Error('REVOKED');const rows=await(tx as typeof database).execute(sql`SELECT state FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} FOR SHARE`);assert.equal(rows.rows[0]?.state,'active');};
 const journal=()=>new PostgresEmailGraphSendJournal(database as never,cipher,scope,guard,()=>clock);
 await t.test('encrypted committed progress, exclusive leases, immutable plan, stale lease and irreversible send marker',async()=>{
  const unsigned={schema_version:'deft.email_graph_send_plan.v1' as const,operation_id:randomUUID(),scope,binding_digest:'a'.repeat(64),mime_digest:'b'.repeat(64),skeleton_digest:'c'.repeat(64),content_digest:'d'.repeat(64),from_address:'owner@example.test',files:[]};
  const plan={...unsigned,digest:sha(canonicalCapabilityJson(unsigned))} satisfies EmailGraphSendPlan;await journal().create(plan);
  const raw=(await pool.query('SELECT * FROM email_operations WHERE operation_id=$1',[plan.operation_id])).rows[0];assert.equal(raw.kind,'send_upload');assert.equal(JSON.stringify(raw).includes('owner@example.test'),false);assert.equal(raw.content_envelope.key_version,'graph-send-key');
  assert.throws(()=>cipher.open(raw.content_envelope,{...scope,kind:'operation',record_id:plan.operation_id,revision:raw.revision}));
  await assert.rejects(journal().load({...scope,account_id:'foreign'},plan.operation_id),/DENIED/);
  await assert.rejects(journal().create({...plan,mime_digest:'f'.repeat(64)}),/PLAN_CONFLICT/);
  let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);
  const held=journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);value.create={state:'started'};await write(value);entered();await waiting;value.create={state:'unknown'};await write(value);});await ready;
  assert.equal((await journal().load(scope,plan.operation_id))?.create.state,'started');await assert.rejects(journal().change(scope,plan.operation_id,()=>null),/BUSY/);
  clock+=120001;await journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);assert.equal(value.create.state,'started');value.create={state:'unknown'};await write(value);});release();await assert.rejects(held,/JOURNAL_CONFLICT/);
  await assert.rejects(journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);value.create={state:'prepared'};await write(value);}),/STATE_CONFLICT/);
  await journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);value.create={state:'applied',ref:'private-immutable-draft'};await write(value);value.send.state='started';await write(value);value.send.state='unknown';await write(value);});
  await assert.rejects(journal().change(scope,plan.operation_id,async(value,write)=>{assert.ok(value);value.send.state='started';await write(value);}),/STATE_CONFLICT/);
  revoked=true;await assert.rejects(journal().load(scope,plan.operation_id),/REVOKED/);revoked=false;
  await assert.rejects(pool.query('INSERT INTO email_operations(org_id,owner_user_id,account_id,operation_id,kind) VALUES($1,$2,$3,$4,$5)',[...Object.values(scope),randomUUID(),'unsupported']),/kind_check/);
 });
 await t.test('real SQL journal resumes registered adapter after lost upload ACK and a new instance',async()=>{
  const {graphSendFixture,syntheticGraphMime}=await import(new URL('../../../examples/apps/email/providers/native-graph-send-fixture.mjs',import.meta.url).href);
  const f=await graphSendFixture({journal:journal(),scope,now:()=>clock}),input=await syntheticGraphMime();try{f.loss='range';assert.equal((await f.adapter.nativeEmailPrepareSend(input,f.context)).state,'pending');const held=await journal().load(scope,input.operation_id);assert.ok(held?.files[0]?.upload_url);assert.ok(held?.files[0]?.range);assert.equal(held?.send.state,'prepared');
   const raw=(await pool.query('SELECT content_envelope FROM email_operations WHERE operation_id=$1',[input.operation_id])).rows[0];assert.equal(JSON.stringify(raw).includes('outlook.office.com'),false);
   f.context.send_upload_journal=journal();f.adapter=await f.restart();assert.equal((await f.adapter.nativeEmailPrepareSend(input,f.context)).state,'ready');assert.equal(f.files.length,1);assert.equal(f.sessionPosts,1);assert.equal(f.sends,0);
  }finally{await f.close();}
 });
 await t.test('25MiB saved draft through real serializer, encrypted Outbox, preparation deferral, final claim and no repeat',async()=>{
  const {graphSendFixture}=await import(new URL('../../../examples/apps/email/providers/native-graph-send-fixture.mjs',import.meta.url).href);let f=await graphSendFixture({journal:journal(),scope,now:()=>clock});
  try{
   const cap={scope,resource_binding_id:'graph-send-binding',authority_version:'exact-current-cap',expires_at:clock+86400000},actor={user_id:scope.owner_user_id,web_session_id:'real-synthetic-session',access_expires_at:clock+86400000};let activeLease:EmailOutboxLease|undefined;
   const current=async(tx?:unknown)=>{if(tx)await guard(tx);else await database.transaction(guard);return cap;};
   const service={current:async(_scope:unknown,lease:EmailOutboxLease,tx?:unknown)=>{await current(tx);const rows=await(tx?tx as typeof database:database).execute(sql`SELECT * FROM job_queue WHERE id=${lease.job_id}${tx?sql` FOR SHARE`:sql``}`),row=rows.rows[0];if(!row||row.status!=='running'||row.lock_token!==lease.lock_token||new Date(String(row.lock_expires_at)).getTime()<=clock)throw Error('LEASE_DENIED');assert.equal((row.data as any).authority_revision,7);return cap;}};
   const scopedJournal=()=>new PostgresEmailGraphSendJournal(database as never,cipher,scope,async tx=>{if(activeLease)await service.current(scope,activeLease,tx);else await guard(tx);},()=>clock);
   const provider=new RegisteredEmailNativeSendProvider(async(_scope,_cap,recheck,signal)=>({adapter:f.adapter,context:{...f.context,authority_version:cap.authority_version,expires_at:Math.min(cap.expires_at,clock+60000),signal,recheck,send_upload_journal:scopedJournal(),send_prepare_before_effect:undefined}}),()=>clock);
   let file=Buffer.alloc(25*1024*1024,71);const metadata={file_id:randomUUID(),filename:'maximum.bin',media_type:'application/octet-stream',size_bytes:file.length,sha256:sha(file)};
   const snapshots=createEmailNativeOutgoingSnapshotBuilder({accounts:provider,graphPreparation:true,attachments:{readForSend:async()=>({...metadata,bytes:Buffer.from(file)})},replies:async()=>{throw Error('NO_REPLY');},createOutgoingSnapshotService:ports=>f.adapter.nativeEmailSnapshotFactory(ports),now:()=>new Date(clock)});
   const drafts=new EmailDraftStore(database as never,cipher,()=>new Date(clock)),store=()=>new EmailOutboxStore(database,cipher,binary,()=>new Date(clock)),human={current:async(_actor:unknown,_scope:unknown,_operation:unknown,tx?:unknown)=>current(tx)};
   const make=()=>new EmailOutboxService(human,service,drafts,store(),snapshots,provider,()=>clock);
   const draftId=randomUUID(),content={mode:'compose',to:'Visible <visible@example.test>',cc:'copy@example.test',bcc:'hidden@example.test',subject:'Maximum saved draft',body:'h'.repeat(256*1024),body_html:'',reply_record_id:'',attachments:[metadata]};EmailDraftContentSchema.parse(content);
   await drafts.create(scope,draftId,content,{kind:'human',created_by_user_id:scope.owner_user_id,originating_run_id:null},guard);
   const item=await make().enqueue(actor,scope,{draft_id:draftId,expected_revision:1,request_id:randomUUID(),undo_delay_seconds:0});assert.equal(f.creates,0);assert.equal(f.sends,0);
   const raw=(await pool.query('SELECT * FROM email_outbox WHERE outbox_id=$1',[item.outbox_id])).rows[0];assert.ok(raw.byte_length>3*1024*1024&&raw.byte_length<=35*1024*1024);assert.equal(raw.ciphertext.includes(Buffer.from('hidden@example.test')),false);
   const run=async(entry=item)=>{const token=randomUUID(),row=(await pool.query('SELECT job_id FROM email_outbox WHERE outbox_id=$1',[entry.outbox_id])).rows[0];await pool.query("UPDATE job_queue SET status='running',lock_token=$2,lock_expires_at=$3 WHERE id=$1",[row.job_id,token,new Date(clock+120000)]);activeLease={job_id:row.job_id,lock_token:token,job_name:'native-email-outbox',outbox_id:entry.outbox_id,operation_id:entry.operation_id};return make().dispatch(scope,activeLease);};
   f.loss='range';let result=await run();assert.equal(result.state,'waiting');assert.equal((await make().read(actor,scope,item.outbox_id))?.state,'queued');assert.equal(f.sends,0);
   for(let i=0;result.state==='waiting'&&i<8;i++){clock+=result.delay_ms!;f.adapter=await f.restart();result=await run();}
   assert.equal(result.state,'accepted');assert.equal(f.creates,1);assert.equal(f.files.length,1);assert.equal(sha(f.files[0].bytes),metadata.sha256);assert.equal(f.sends,1);assert.equal((await journal().load(scope,item.operation_id))?.send.state,'accepted');
   assert.equal((await run()).state,'accepted');assert.equal(f.sends,1);assert.equal((await drafts.read(scope,draftId,guard))?.status,'submitted');
   const parsed=await f.inspect();assert.equal(parsed.bcc.value[0].address,'hidden@example.test');assert.equal(parsed.text?.trimEnd(),content.body);file.fill(0);
   // Independent provider fixtures let the same public leased service exercise
   // queued cancellation and uncertain final-send boundaries in real SQL.
   file=Buffer.alloc(4*1024*1024,74);Object.assign(metadata,{file_id:randomUUID(),size_bytes:file.length,sha256:sha(file)});
   const enqueueSmall=async()=>{const id=randomUUID();await drafts.create(scope,id,{...content,body:'Small body',attachments:[metadata]},{kind:'human',created_by_user_id:scope.owner_user_id,originating_run_id:null},guard);return make().enqueue(actor,scope,{draft_id:id,expected_revision:1,request_id:randomUUID(),undo_delay_seconds:0});};
   await f.close();f=await graphSendFixture({journal:journal(),scope,now:()=>clock});const cancelled=await enqueueSmall();f.loss='range';assert.equal((await run(cancelled)).state,'waiting');const effects=f.calls.length;assert.equal((await make().cancel(actor,scope,{outbox_id:cancelled.outbox_id,expected_revision:1})).state,'cancelled');assert.equal((await run(cancelled)).state,'cancelled');assert.equal(f.calls.length,effects);assert.equal(f.sends,0);
   await f.close();f=await graphSendFixture({journal:journal(),scope,now:()=>clock});const uncertain=await enqueueSmall();f.loss='send';assert.equal((await run(uncertain)).state,'uncertain');assert.equal(f.sends,1);f.adapter=await f.restart();assert.equal((await run(uncertain)).state,'uncertain');assert.equal(f.sends,1);assert.equal((await journal().load(scope,uncertain.operation_id))?.send.state,'unknown');file.fill(0);
  }finally{await f.close();}
 });
});
