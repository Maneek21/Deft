import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts,jobQueue} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {createEmailMailboxServicePageRunner} from '../src/lib/email-mailbox-service-runtime.js';
import {createEmailMailboxJobHandler} from '../src/lib/email-mailbox-job.js';
import {EmailMailboxError,syncEmailMailboxPage,type EmailCapability,type EmailMessageRecord,type EmailProviderPage} from '../src/lib/email-mailbox-service.js';
import {emailNativeTriageSourceFingerprint} from '../src/lib/email-native-triage.js';
import {PostgresEmailMailboxRefresh} from '../src/lib/email-mailbox-refresh.js';
import {emailMailboxSyncDedupeKey} from '../src/lib/email-mailbox-scheduler.js';
import type {EmailAuthorityDatabase} from '../src/lib/email-mailbox-authority.js';
const TARGET='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_notifications_87_fresh';
const safe=process.env.DATABASE_URL===TARGET&&process.env.DEFT_TEST_DATABASE_URL===TARGET;
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}

test('actual PG reproduces triage checkpoint collision and recovery of the failed live job classification',{skip:!safe,timeout:30000},async t=>{
 const admin=new pg.Pool({connectionString:TARGET,max:1}),namespace='sync_race_'+randomUUID().replaceAll('-','');
 const who=(await admin.query('SELECT current_database() db,current_user role,inet_server_port() port')).rows[0];
 assert.deepEqual(who,{db:'email_stage34_notifications_87_fresh',role:'gate_g_test',port:55435});
 await admin.query(`CREATE SCHEMA ${namespace}`);
 const pool=new pg.Pool({connectionString:TARGET,max:5,options:`-c search_path=${namespace},public`});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
 for(const table of ['email_accounts','email_checkpoints','email_messages','email_memberships','email_provider_states','email_sync_receipts','email_notification_states','email_notification_events','job_queue'])await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
 const database=drizzle(pool,{schema:{emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts,jobQueue}}),now=Date.now(),scope={org_id:randomUUID(),owner_user_id:randomUUID(),account_id:'synthetic-collision'},binding=randomUUID();
 await database.insert(emailAccounts).values({...scope,provider:'gmail',resource_binding_id:binding,state:'active',principal_digest:'a'.repeat(64),authority_revision:1,consented_at:new Date(now)});
 const keys={current:()=>({key_id:'test-race',key:Buffer.alloc(32,19)}),read:()=>({key_id:'test-race',key:Buffer.alloc(32,19)}),keyIds:()=>['test-race']};
 const store=new PostgresEmailMailboxStore(database,new EmailMailboxCrypto(keys));
 const capability:EmailCapability={scope,resource_binding_id:binding,authority_version:'current',expires_at:now+120000};
 const current=async(tx?:unknown)=>{const executor=(tx??database) as typeof database;const rows=await executor.select().from(emailAccounts);if(rows[0]?.state!=='active')throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return capability;};
 const record:EmailMessageRecord={account_id:scope.account_id,logical_message_id:'mail_'+'b'.repeat(64),revision:'same-provider-content',received_at:new Date(now-1000).toISOString(),folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Synthetic'},provider_source:{account_id:scope.account_id,locator:{message_id:'synthetic'}}};
 let providerSeen=false,hold=false,calls=0;const entered=barrier(),release=barrier();
 const provider={assertConnected:async(_s:unknown,_cap:unknown,recheck:()=>Promise<void>)=>{await recheck();return {account_id:scope.account_id,provider:'gmail' as const,resource_binding_id:binding,authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected' as const,capabilities:['read'] as ['read'],primary_address:'test@example.test',display_label:'Synthetic'};},
  readPage:async()=>{calls++;const seen=providerSeen;if(hold){entered.release();await release.promise;}return {account_id:scope.account_id,items:[{...record,flags:{...record.flags,seen}}],next_cursor:'same-history-anchor',has_more:false,complete:false,observed_at:new Date().toISOString(),failure_count:0,tombstones:[],state_updates:[]} as EmailProviderPage;}};
 await syncEmailMailboxPage(scope,{expected_checkpoint_revision:0,cursor:null,page_id:'initial'},{current,store,provider});
 const lease={job_id:randomUUID(),lock_token:randomUUID()},deferrals:Array<{message:string;delayMs:number}>=[];
 const runner=createEmailMailboxServicePageRunner({currentSql:async()=>current(),components:async()=>({store,provider})});
 const handler=createEmailMailboxJobHandler({enabled:()=>true,runPage:runner,defer:(message,delayMs)=>{deferrals.push({message,delayMs});return Object.assign(new Error(message),{deferred:true});}});
 await t.test('held old page rolls back after synchronous flag acknowledgement; next leased page restarts current checkpoint',async()=>{
  hold=true;const pending=handler({id:lease.job_id,name:'native-email-sync',lockToken:lease.lock_token,attempts:4,data:{...scope,authority_revision:1}});await entered.promise;
  const heldRecord=await store.readMessage(scope,record.logical_message_id);assert.ok(heldRecord);
  await store.acknowledgeFlags(scope,[{logical_message_id:record.logical_message_id,expected_revision:heldRecord.revision,expected_source_digest:emailNativeTriageSourceFingerprint(heldRecord),flags:{seen:true,flagged:null,answered:null}}],async tx=>{await current(tx);});
  assert.equal((await store.readCheckpoint(scope)).revision,2);release.release();
  await assert.rejects(pending,e=>e instanceof Error&&e.message==='Native email sync checkpoint advanced');
  assert.deepEqual(deferrals,[{message:'Native email sync checkpoint advanced',delayMs:1000}]);
  assert.equal((await store.readMessage(scope,record.logical_message_id))?.flags.seen,true,'held provider snapshot must never undo confirmed read state');
  assert.equal((await store.readCheckpoint(scope)).revision,2);hold=false;providerSeen=true;
  const fresh=await runner({...scope,authority_revision:1},lease);assert.equal(fresh.checkpoint_revision,3);assert.equal(calls,3);
 });
 await t.test('explicit Refresh rearms existing exact failed checkpoint-conflict row, preserving hard denial failures',async()=>{
  const actor={user_id:scope.owner_user_id,web_session_id:randomUUID(),access_expires_at:now+120000},id=randomUUID(),payload={...scope,authority_revision:1};
  await database.insert(jobQueue).values({id,org_id:scope.org_id,queue:'scheduled-jobs',name:'native-email-sync',data:payload,dedupe_key:emailMailboxSyncDedupeKey(payload),status:'failed',attempts:5,max_attempts:5,error:'EMAIL_CHECKPOINT_CONFLICT',completed_at:new Date(now)});
  const authority={inspect:async()=>({capability,account:{principal_digest:'a'.repeat(64)}})};
  const service=new PostgresEmailMailboxRefresh(database as unknown as EmailAuthorityDatabase,async()=>({authority:authority as never,sqlAuthority:{current:async()=>current()} as never}),async()=>{},()=>now);
  assert.equal((await service.request(actor,scope.org_id,scope.account_id)).state,'queued');
  const row=(await database.select().from(jobQueue))[0]!;assert.equal(row.id,id);assert.equal(row.attempts,0);assert.equal(row.status,'pending');assert.equal(row.error,null);
  await pool.query("UPDATE job_queue SET status='failed',error='EMAIL_ACCESS_DENIED',attempts=5 WHERE id=$1",[id]);
  assert.equal((await service.request(actor,scope.org_id,scope.account_id)).state,'needs_attention');
 });
});
