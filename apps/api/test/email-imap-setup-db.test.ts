import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '@deft/db/schema';
import {PostgresEmailMailboxEnrollment} from '../src/lib/email-mailbox-enrollment.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_71';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('actual PostgreSQL IMAP enrollment commits encrypted credential with account; stale setup and late revocation roll back',{skip:!safe,timeout:45000},async t=>{
 const admin=new pg.Pool({connectionString:target,max:1}),namespace='email_imap_setup_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+namespace);
 const pool=new pg.Pool({connectionString:target,max:6,options:'-c search_path='+namespace+',public'});
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+namespace+' CASCADE');await admin.end();});
 // Copy only columns/defaults/checks, not production FK ancestry; that graph is
 // supplied by the existing enrollment helper seam. Native account/credential
 // constraints and transaction behavior below execute against real PostgreSQL.
 for(const table of ['email_accounts','app_resource_bindings','web_sessions'])await pool.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 await pool.query('CREATE TABLE users(id text PRIMARY KEY,kind text,is_agent boolean);CREATE TABLE org_members(org_id text,user_id text,role text,is_active boolean,app_run_authorization_version integer)');
 await pool.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.65-email-imap-credentials.sql',import.meta.url),'utf8'));
 const database=drizzle(pool,{schema}),org=randomUUID(),owner=randomUUID(),sid=randomUUID(),bindingId=randomUUID(),installation=randomUUID(),registration=randomUUID(),version=randomUUID(),grant=randomUUID();
 const actor={user_id:owner,web_session_id:sid,access_expires_at:Date.now()+120000};
 await pool.query("INSERT INTO users VALUES($1,'human',false);",[owner]);await pool.query("INSERT INTO org_members VALUES($1,$2,'member',true,1)",[org,owner]);
 await database.insert(schema.webSessions).values({id:sid,org_id:org,user_id:owner,refresh_token_hash:'fixture-only',expires_at:new Date(actor.access_expires_at)});
 await database.insert(schema.appResourceBindings).values({id:bindingId,org_id:org,app_installation_id:installation,app_version_id:version,grant_snapshot_id:grant,runtime_registration_id:registration,
  provider_instance_id:registration,provider_snapshot_id:randomUUID(),resource_key:'inbox',target_key:'personal',resource_family:'email',operation_name:'sync_inbox',interface_identity:'deft.resource_sync.v2:'+org+':'+installation+':inbox',reviewed_descriptor:{schema_version:'deft.app_sync_descriptor.v1'},descriptor_digest:'sha256:'+'a'.repeat(64),owner_user_id:owner,
  max_records_per_page:100,max_page_bytes:65536,max_retained_records:1000,max_retained_bytes:1048576,min_interval_seconds:60,state:'active',reviewed_by_user_id:owner,reviewed_at:new Date(Date.now()-60000),consent_expires_at:new Date(actor.access_expires_at)});
 const [binding]=await database.select().from(schema.appResourceBindings);
 const live={binding,installation:{id:installation,org_id:org},registration:{id:registration,org_id:org,operator_user_id:owner},version:{id:version},grant:{id:grant},descriptor_digest:'a'.repeat(64),provider_snapshot:{id:'fixture'}};
 const pins={org_id:org,owner_user_id:owner,installation_id:installation,app_version_id:version,grant_snapshot_id:grant,target_key:'personal',resource_key:'inbox',resource_binding_id:bindingId,action_key:null,action_binding_id:null};
 let failFinal=false,verified=false;
 const enrollment=new PostgresEmailMailboxEnrollment(database,{loadBinding:async()=>{if(failFinal&&verified)throw Error('late revocation');return live as any;},
  getRegistry:async()=>({select:()=>({pins,adapter:{nativeEmailAccount:async()=>{throw Error('Setup must use its tested profile');}}})} as any),
  verifyImap:async input=>{await input.context.recheck();verified=true;return {...input.profile as any,verified_at:new Date().toISOString()};}});
 const profile={host:'imap.example.test',port:993,transport:'implicit_tls',username:'owner',password:'synthetic-fixture-password',identity:{primary_address:'owner@example.test',display_label:'Personal'}};
 const keys={current:()=>({key_id:'fixture',key:Buffer.alloc(32,41)}),read:()=>({key_id:'fixture',key:Buffer.alloc(32,41)}),keyIds:()=>['fixture']};
 const input={account_id:'imap-account',resource_binding_id:bindingId};
 const result=await enrollment.setupImap(actor,org,input,profile,0,keys);assert.equal(result.state,'active');
 const [account]=await database.select().from(schema.emailAccounts),[credential]=await database.select().from(schema.emailImapCredentials);
 assert.equal(account?.principal_digest,credential?.principal_digest);assert.equal(credential?.connection_revision,1);assert.equal(JSON.stringify(credential).includes(profile.password),false);
 const concurrent=await Promise.allSettled([enrollment.setupImap(actor,org,input,{...profile,password:'updated-one'},1,keys),enrollment.setupImap(actor,org,input,{...profile,password:'updated-two'},1,keys)]);
 assert.equal(concurrent.filter(v=>v.status==='fulfilled').length,1);assert.equal((await database.select().from(schema.emailImapCredentials))[0]?.connection_revision,2);
 failFinal=true;verified=false;
 await assert.rejects(enrollment.setupImap(actor,org,{...input,account_id:'rollback-account'},profile,0,keys));
 assert.equal((await database.select().from(schema.emailAccounts)).length,1);assert.equal((await database.select().from(schema.emailImapCredentials)).length,1);
});
