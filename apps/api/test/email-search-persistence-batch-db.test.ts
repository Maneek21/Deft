import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import type {EmailScope,EmailMessageRecord} from '../src/lib/email-mailbox-service.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_m3_release';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');

test('isolated PostgreSQL batched search persistence preserves canonical cache/tombstones, actual concurrent insert conflicts and late SQL rollback',{skip:!safe,timeout:120000},async t=>{
 const namespace='search_batch_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:target,max:2});
 assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'email_m3_release',role:'gate_g_test',port:55435});
 await admin.query(`CREATE SCHEMA ${namespace}`);
 const options=`-c search_path=${namespace},public`,pool=new pg.Pool({connectionString:target,max:2,options}),concurrent=new pg.Pool({connectionString:target,max:2,options});
 const statements:string[]=[],membershipBindCounts:number[]=[];let beforeMessageInsert:(()=>Promise<void>)|null=null;
 pool.on('connect',client=>{
  const original=client.query.bind(client);
  (client as any).query=(...args:any[])=>{const text=typeof args[0]==='string'?args[0]:args[0].text;statements.push(text);
   if(/^insert into "email_memberships"/.test(text))membershipBindCounts.push((args[0]?.values??args[1]??[]).length);
   if(/^insert into "email_messages"/.test(text)&&beforeMessageInsert){const hook=beforeMessageInsert;beforeMessageInsert=null;return hook().then(()=>(original as any)(...args));}
   return (original as any)(...args);
  };
 });
 t.after(async()=>{await pool.end();await concurrent.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
 await concurrent.query(`CREATE TABLE email_accounts(org_id text,owner_user_id text,account_id text,state text,PRIMARY KEY(org_id,owner_user_id,account_id));
  CREATE TABLE email_checkpoints(org_id text,owner_user_id text,account_id text,revision integer NOT NULL DEFAULT 0,cursor_envelope jsonb,observed_at timestamptz,fresh_until timestamptz,coverage text NOT NULL DEFAULT 'partial',has_more boolean NOT NULL DEFAULT false,sync_state text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id),FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts);
  CREATE TABLE email_messages(org_id text,owner_user_id text,account_id text,logical_message_id text,revision text,storage_revision integer,received_at timestamptz,sort_at timestamptz,seen boolean NOT NULL DEFAULT false,flagged boolean NOT NULL DEFAULT false,answered boolean NOT NULL DEFAULT false,summary_envelope jsonb,source_envelope jsonb,inventory_generation text,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id,logical_message_id),FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts,CHECK((deleted_at IS NULL AND summary_envelope IS NOT NULL AND source_envelope IS NOT NULL) OR(deleted_at IS NOT NULL AND summary_envelope IS NULL AND source_envelope IS NULL)));
  CREATE TABLE email_memberships(org_id text,owner_user_id text,account_id text,logical_message_id text,folder text,inventory_generation text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id,logical_message_id,folder),FOREIGN KEY(org_id,owner_user_id,account_id,logical_message_id) REFERENCES email_messages);`);
 const schema={emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts},db=drizzle(pool,{schema}),otherDb=drizzle(concurrent,{schema});
 const crypto=new EmailMailboxCrypto({current:()=>({key_id:'synthetic',key:Buffer.alloc(32,24)}),read:()=>({key_id:'synthetic',key:Buffer.alloc(32,24)}),keyIds:()=>['synthetic']});
 const instant=new Date('2026-10-07T12:00:00Z'),store=new PostgresEmailMailboxStore(db,crypto,{now:()=>instant});
 const setup=async(account_id:string):Promise<EmailScope>=>{const scope={org_id:'org-search',owner_user_id:'owner-search',account_id};await concurrent.query("INSERT INTO email_accounts VALUES($1,$2,$3,'active')",Object.values(scope));await otherDb.insert(emailCheckpoints).values({...scope,revision:7,coverage:'complete',observed_at:instant,fresh_until:new Date(instant.getTime()+60000)});return scope;};
 const record=(scope:EmailScope,n:number,revision='provider-1'):EmailMessageRecord=>({account_id:scope.account_id,logical_message_id:logical(n),revision,received_at:instant.toISOString(),folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Private synthetic search fixture'},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,logical_message_id:logical(n),provider:'gmail',locator:{kind:'gmail',message_id:'synthetic-'+n,thread_id:'synthetic-thread'}}});
 const values=(scope:EmailScope,row:EmailMessageRecord)=>({...scope,logical_message_id:row.logical_message_id,revision:row.revision,storage_revision:7,received_at:instant,sort_at:instant,...row.flags,summary_envelope:crypto.seal(row.data,{...scope,kind:'summary',record_id:row.logical_message_id,revision:7}),source_envelope:crypto.seal(row.provider_source,{...scope,kind:'provider_source',record_id:row.logical_message_id,revision:7})});
 const guardFor=(scope:EmailScope)=>async(tx:unknown)=>{const found=await (tx as typeof db).execute(sql`SELECT account_id FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} AND state='active' FOR SHARE`);if(found.rows.length!==1)throw Error('SQL authority revoked');};
 await t.test('50 cached provider hits retain newer exact data without INSERTs; two scopes sharing logical IDs remain independent',async()=>{
  const scope=await setup('cached'),foreign=await setup('foreign'),cached=Array.from({length:50},(_,n)=>({...record(scope,n+1,'cache-newer'),flags:{seen:true,flagged:true,answered:true}}));
  await otherDb.insert(emailMessages).values(cached.map(row=>values(scope,row)));await otherDb.insert(emailMemberships).values(cached.map(row=>({...scope,logical_message_id:row.logical_message_id,folder:'inbox'})));
  await otherDb.insert(emailMessages).values(values(foreign,record(foreign,1,'foreign-only')));
  const before=(await concurrent.query('SELECT * FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 ORDER BY logical_message_id',Object.values(scope))).rows;
  statements.length=0;const began=performance.now(),result=await store.persistSearchResults(scope,cached.map((_,n)=>record(scope,n+1)),guardFor(scope)),elapsed=performance.now()-began;
  assert.deepEqual(result.records,cached);assert.equal(result.dropped,0);assert.equal(statements.filter(text=>/^insert into "email_messages"/.test(text)).length,0);
  assert.deepEqual((await concurrent.query('SELECT * FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 ORDER BY logical_message_id',Object.values(scope))).rows,before);
  assert.equal((await store.readMessage(foreign,logical(1)))!.revision,'foreign-only');
  console.log(JSON.stringify({proof:'actual PG cached50',count:50,persistence_ms:Math.round(elapsed),live_data:false}));
 });
 await t.test('one insert batch and one membership batch discover50 openable encrypted messages without overwriting a tombstone',async()=>{
  const scope=await setup('missing'),tombstone=record(scope,99);
  await otherDb.insert(emailMessages).values({...values(scope,tombstone),deleted_at:instant,summary_envelope:null,source_envelope:null});
  const missing=Array.from({length:50},(_,n)=>({...record(scope,n+1),folders:['inbox','archive','inbox']}));statements.length=0;
  const result=await store.persistSearchResults(scope,[...missing,tombstone],guardFor(scope));
  assert.equal(result.records.length,50);assert.equal(result.dropped,1);assert.equal(statements.filter(text=>/^insert into "email_messages"/.test(text)).length,1);assert.equal(statements.filter(text=>/^insert into "email_memberships"/.test(text)).length,1);
  assert.equal(await store.readMessage(scope,logical(99)),null);assert.equal((await store.readMessage(scope,logical(50)))!.data.subject,missing[49]!.data.subject);
  const checkpoint=await concurrent.query('SELECT coverage,revision FROM email_checkpoints WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope));assert.deepEqual(checkpoint.rows[0],{coverage:'partial',revision:8});
  const raw=await concurrent.query('SELECT summary_envelope,source_envelope FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope));assert.equal(JSON.stringify(raw.rows).includes('Private synthetic search fixture'),false);
 });
 await t.test('maximum100 records with100 folders fit one membership batch under the PostgreSQL bind ceiling',async()=>{
  const scope=await setup('maximum'),folders=Array.from({length:100},(_,n)=>'folder-'+n.toString().padStart(3,'0'));
  const records=Array.from({length:100},(_,n)=>({...record(scope,n+1),folders}));statements.length=0;membershipBindCounts.length=0;
  const result=await store.persistSearchResults(scope,records,guardFor(scope));
  assert.deepEqual(result.records,records);assert.equal(result.dropped,0);
  assert.equal(statements.filter(text=>/^insert into "email_messages"/.test(text)).length,1);
  assert.equal(statements.filter(text=>/^insert into "email_memberships"/.test(text)).length,1);
  assert.deepEqual(membershipBindCounts,[60000]);assert.ok(membershipBindCounts[0]!<65536);
  assert.equal((await concurrent.query('SELECT count(*)::integer AS n FROM email_memberships WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0].n,10000);
  const updated=await concurrent.query('SELECT DISTINCT updated_at FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope));assert.deepEqual(updated.rows,[{updated_at:instant}]);
 });
 await t.test('direct concurrent INSERT between existence read and INSERT preserves raced canonical data and membership',async()=>{
  const scope=await setup('race'),raced={...record(scope,1,'race-newer'),folders:['archive'],flags:{seen:true,flagged:true,answered:false}};
  beforeMessageInsert=async()=>{await otherDb.insert(emailMessages).values(values(scope,raced));await otherDb.insert(emailMemberships).values({...scope,logical_message_id:logical(1),folder:'archive'});};
  const result=await store.persistSearchResults(scope,[record(scope,1)],guardFor(scope));assert.equal(beforeMessageInsert,null);assert.deepEqual(result.records,[raced]);
  assert.equal((await concurrent.query('SELECT coverage FROM email_checkpoints WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0].coverage,'complete');
 });
 await t.test('late SQL authority denial rolls back inserted messages/memberships/coverage and account-state change',async()=>{
  const scope=await setup('late-denial');let calls=0;
  await assert.rejects(store.persistSearchResults(scope,[record(scope,1),record(scope,2)],async tx=>{if(++calls===2)await (tx as typeof db).execute(sql`UPDATE email_accounts SET state='paused' WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id}`);await guardFor(scope)(tx);}),/SQL authority revoked/);
  assert.equal((await concurrent.query('SELECT count(*)::integer AS n FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0].n,0);
  assert.equal((await concurrent.query('SELECT count(*)::integer AS n FROM email_memberships WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0].n,0);
  assert.equal((await concurrent.query('SELECT coverage FROM email_checkpoints WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0].coverage,'complete');
  assert.equal((await concurrent.query('SELECT state FROM email_accounts WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0].state,'active');
 });
});
