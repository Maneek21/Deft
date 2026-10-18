import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailProviderDraftMirrors,orgMembers,users} from '@deft/db/schema';
import {PostgresEmailProviderDraftSettings,EmailProviderDraftSettingsError} from '../src/lib/email-provider-draft-settings.js';
import {EmailMailboxError} from '../src/lib/email-mailbox-service.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('real Postgres flag persists with CAS and atomic queued pause/resume while live and unknown claims remain intact',{skip:!safe,timeout:60000},async t=>{
 const admin=new pg.Pool({connectionString:target,max:1}),namespace='email_draft_setting_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+namespace+'"');
 const pool=new pg.Pool({connectionString:target,max:8,options:'-c search_path='+namespace+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA "'+namespace+'" CASCADE');await admin.end();});
 await pool.query("CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL,resource_binding_id text NOT NULL,principal_digest text,state text NOT NULL DEFAULT 'active',authority_revision integer NOT NULL DEFAULT 1 CHECK(authority_revision>0),consented_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id))");
 await pool.query("CREATE TABLE users(id text PRIMARY KEY,kind text NOT NULL,is_agent boolean NOT NULL);CREATE TABLE org_members(org_id text NOT NULL,user_id text NOT NULL,role text NOT NULL,is_active boolean NOT NULL,app_run_authorization_version integer NOT NULL,PRIMARY KEY(org_id,user_id))");
 for(const file of ['66-email-native-drafts','70-email-provider-draft-mirrors'])await pool.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.'+file+'.sql',import.meta.url),'utf8'));
 const database=drizzle(pool,{schema:{emailAccounts,emailProviderDraftMirrors,orgMembers,users}}),scope={org_id:'org_'+randomUUID(),owner_user_id:'owner_'+randomUUID(),account_id:'account_'+randomUUID()};
 const actor={user_id:scope.owner_user_id,web_session_id:'sid_'+randomUUID(),access_expires_at:Date.now()+120000},binding='binding_'+randomUUID(),principal='a'.repeat(64);
 await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,consented_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[scope.org_id,scope.owner_user_id,scope.account_id,'gmail',binding,principal,new Date(Date.now()-60000)]);
 await pool.query("INSERT INTO users VALUES($1,'human',false)",[scope.owner_user_id]);await pool.query("INSERT INTO org_members VALUES($1,$2,'member',true,1)",[scope.org_id,scope.owner_user_id]);
 let failIfChanged:number|null=null;
 const service=new PostgresEmailProviderDraftSettings(database as any,{loadBinding:async(_tx,input)=>({binding:{id:binding,org_id:scope.org_id,owner_user_id:scope.owner_user_id},registration:{operator_user_id:scope.owner_user_id},installation:{id:'fixture'},checked_at:input.clock()} as any),
  runtime:async()=>({authority:{inspect:async(actual,actualScope,_operation,transaction)=>{
   assert.deepEqual(actual,actor);assert.deepEqual(actualScope,scope);
   const read=async(tx:any)=>{const [row]=await tx.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1).for('share');
    if(!row)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return {capability:{scope,resource_binding_id:binding,authority_version:'version-'+row.authority_revision,expires_at:actor.access_expires_at},
     account:{account_id:scope.account_id,resource_binding_id:binding,provider:'gmail',principal_digest:principal,connection_revision:failIfChanged!==null&&row.authority_revision!==failIfChanged?2:1,authority_epoch:row.authority_revision,health:'connected',capabilities:['read','modify']}} as any;};
   return transaction?read(transaction):database.transaction(read);
  }}})});
 assert.deepEqual(await service.get(actor,scope.org_id,scope.account_id),{account_id:scope.account_id,enabled:false,revision:1,supported:true});
 assert.equal((await service.update(actor,scope.org_id,scope.account_id,{enabled:true,expected_revision:1})).revision,2);
 const drafts=[randomUUID(),randomUUID(),randomUUID()],states=['queued','syncing','unknown'],token='b'.repeat(64),operation=randomUUID();
 for(let index=0;index<drafts.length;index++){
  await pool.query("INSERT INTO email_drafts(org_id,owner_user_id,account_id,draft_id,revision,content_revision,origin,created_by_user_id,last_edited_by_user_id,content_envelope) VALUES($1,$2,$3,$4,1,1,'human',$2,$2,'{}')",[scope.org_id,scope.owner_user_id,scope.account_id,drafts[index]]);
  await pool.query('INSERT INTO email_provider_draft_mirrors(org_id,owner_user_id,account_id,draft_id,desired_revision,state,claim_token_hash,claim_generation,claim_revision,claim_operation_id) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)',[scope.org_id,scope.owner_user_id,scope.account_id,drafts[index],states[index],index===1?token:null,index===1?1:null,index===1?1:null,index===1?operation:null]);
 }
 await service.update(actor,scope.org_id,scope.account_id,{enabled:false,expected_revision:2});
 const mirrors=async()=>{const result=await pool.query('SELECT draft_id,state,claim_token_hash,claim_operation_id FROM email_provider_draft_mirrors WHERE org_id=$1 ORDER BY draft_id',[scope.org_id]);return new Map(result.rows.map(row=>[row.draft_id,row]));};
 let rows=await mirrors();assert.equal(rows.get(drafts[0])!.state,'paused');assert.equal(rows.get(drafts[1])!.state,'syncing');assert.equal(rows.get(drafts[1])!.claim_token_hash,token);assert.equal(rows.get(drafts[1])!.claim_operation_id,operation);assert.equal(rows.get(drafts[2])!.state,'unknown');
 await service.update(actor,scope.org_id,scope.account_id,{enabled:true,expected_revision:3});rows=await mirrors();assert.equal(rows.get(drafts[0])!.state,'queued');assert.equal(rows.get(drafts[2])!.state,'unknown');
 const results=await Promise.allSettled([service.update(actor,scope.org_id,scope.account_id,{enabled:false,expected_revision:4}),service.update(actor,scope.org_id,scope.account_id,{enabled:false,expected_revision:4})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.ok(rejected.reason instanceof EmailProviderDraftSettingsError);assert.equal(rejected.reason.code,'EMAIL_DRAFT_SYNC_CONFLICT');
 failIfChanged=5;await assert.rejects(service.update(actor,scope.org_id,scope.account_id,{enabled:true,expected_revision:5}),(error:unknown)=>error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED');failIfChanged=null;
 const final=await service.get(actor,scope.org_id,scope.account_id);assert.equal(final.enabled,false);assert.equal(final.revision,5);rows=await mirrors();assert.equal(rows.get(drafts[0])!.state,'paused');assert.equal(rows.get(drafts[1])!.claim_operation_id,operation);assert.equal(rows.get(drafts[2])!.state,'unknown');
});
