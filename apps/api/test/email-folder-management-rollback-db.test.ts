import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
import pg from 'pg';import {drizzle} from 'drizzle-orm/node-postgres';import {canonicalCapabilityJson} from '@deft/shared';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailOperationJournal} from '../src/lib/email-operation-journal.js';
import {PostgresEmailDraftSyncJournal} from '../src/lib/email-draft-sync-journal.js';
import {PostgresEmailGraphSendJournal} from '../src/lib/email-graph-send-journal.js';
import {PostgresEmailSentCopyJournal} from '../src/lib/email-sent-copy-journal.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_m24_release',safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const signed=(raw:object)=>({...raw,digest:createHash('sha256').update(canonicalCapabilityJson(raw)).digest('hex')});
test('actual old four journal domains remain readable after93 and cannot interpret or replay folder_manage',{skip:!safe,timeout:60000},async t=>{
 const namespace='folder_rollback_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:target,max:1});assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'email_m24_release',role:'gate_g_test',port:55435});
 await admin.query(`CREATE SCHEMA ${namespace}`);const pool=new pg.Pool({connectionString:target,max:2,options:`-c search_path=${namespace},public`});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE email_accounts(org_id text,owner_user_id text,account_id text,PRIMARY KEY(org_id,owner_user_id,account_id));');
 for(const file of ['0.3.0-preview.67-email-native-operations.sql','0.3.0-preview.71-email-draft-sync-journal.sql','0.3.0-preview.74-email-graph-send-upload.sql','0.3.0-preview.79-email-smtp-sent-copy.sql'])await pool.query(readFileSync(new URL('../../../packages/db/upgrades/'+file,import.meta.url),'utf8'));
 const scope={org_id:'org-rollback',owner_user_id:'owner-rollback',account_id:'account-rollback'},providerScope={org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:'installation-rollback'};await pool.query('INSERT INTO email_accounts VALUES($1,$2,$3)',Object.values(scope));
 const db=drizzle(pool) as any,cipher=new EmailMailboxCrypto({current:()=>({key_id:'rollback',key:Buffer.alloc(32,17)}),read:()=>({key_id:'rollback',key:Buffer.alloc(32,17)}),keyIds:()=>['rollback']}),guard=async()=>{},sha='a'.repeat(64);
 const triage=new PostgresEmailOperationJournal(db,cipher,scope,providerScope,guard),draft=new PostgresEmailDraftSyncJournal(db,cipher,scope,guard),graph=new PostgresEmailGraphSendJournal(db,cipher,scope,guard),sent=new PostgresEmailSentCopyJournal(db,cipher,scope,guard),id=randomUUID();
 const cases=[
  {kind:'triage',journal:triage,scope:providerScope,plan:signed({schema_version:'deft.email_triage_plan.v1',operation_id:randomUUID(),binding:{scope:providerScope,account:{account_id:scope.account_id}},items:[{logical_id:'mail_'+sha}],operation:{kind:'flag'}})},
  {kind:'draft_sync',journal:draft,scope,plan:signed({schema_version:'deft.email_draft_sync_plan.v1',operation_id:randomUUID(),scope,provider:'microsoft',provider_draft_ref:'old-draft',binding_digest:sha,baseline_digest:sha,baseline_version:'old-version',desired_digest:sha,initial_content_digest:sha,desired_content_digest:sha,steps:[]})},
  {kind:'send_upload',journal:graph,scope,plan:signed({schema_version:'deft.email_graph_send_plan.v1',operation_id:randomUUID(),scope,binding_digest:sha,mime_digest:sha,skeleton_digest:sha,content_digest:sha,from_address:'owner@example.test',files:[]})},
  {kind:'sent_copy',journal:sent,scope,plan:signed({schema_version:'deft.email_sent_copy_plan.v1',operation_id:randomUUID(),scope,binding_digest:sha,principal_digest:sha,mime_digest:sha,byte_length:100,mode:'server_managed',message_id:'<old@example.test>',mailbox:null,uidvalidity:null,uidnext:null})},
 ];
 const values=new Map<string,unknown>();for(const row of cases)values.set(row.kind,await (row.journal as any).create(row.plan));
 const before=(await pool.query('SELECT operation_id,kind,revision,content_envelope FROM email_operations ORDER BY operation_id')).rows;
 const client=await pool.connect();try{await client.query('BEGIN');await client.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.93-email-folder-management.sql',import.meta.url),'utf8'));await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 assert.deepEqual((await pool.query('SELECT operation_id,kind,revision,content_envelope FROM email_operations ORDER BY operation_id')).rows,before);
 await pool.query("INSERT INTO email_operations(org_id,owner_user_id,account_id,operation_id,kind,revision,content_envelope) VALUES($1,$2,$3,$4,'folder_manage',1,$5)",[...Object.values(scope),id,cipher.seal({untrusted:'newdomain'}, {...scope,kind:'operation',record_id:'folder-manage:'+id,revision:1})]);
 const newBefore=(await pool.query('SELECT * FROM email_operations WHERE operation_id=$1',[id])).rows[0];let callbacks=0;
 for(const row of cases)await t.test(row.kind+' actual old reader keeps encrypted old value and rejects foreign domain before callback',async()=>{
  assert.deepEqual(await (row.journal as any).load(row.scope,row.plan.operation_id),values.get(row.kind));await assert.rejects((row.journal as any).load(row.scope,id));await assert.rejects((row.journal as any).change(row.scope,id,async()=>{callbacks++;assert.fail('No old-domain callback or effect');}));
  assert.deepEqual((await pool.query('SELECT * FROM email_operations WHERE operation_id=$1',[id])).rows[0],newBefore);
 });
 assert.equal(callbacks,0);assert.deepEqual((await pool.query("SELECT operation_id,kind,revision,content_envelope FROM email_operations WHERE kind!='folder_manage' ORDER BY operation_id")).rows,before);
});
