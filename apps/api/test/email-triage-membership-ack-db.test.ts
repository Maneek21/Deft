import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {emailNativeTriageSourceFingerprint} from '../src/lib/email-native-triage.js';
import type {EmailScope,EmailMessageRecord} from '../src/lib/email-mailbox-service.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_m25_release';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');

test('isolated PostgreSQL confirmed Gmail memberships preserve version ordering, ABA, scope, ciphertext and final authority rollback',{skip:!safe,timeout:120000},async t=>{
 const namespace='triage_ack_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:target,max:2});
 assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'email_m25_release',role:'gate_g_test',port:55435});
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

 const barrier=()=>{let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};};
 const seed=async(name:string,count=1)=>{const scope=await setup(name),rows=Array.from({length:count},(_,n)=>({...record(scope,n+1),data:{subject:'Private synthetic search fixture',in_inbox:true,in_sent:false,in_archive:false,folder_membership_complete:true,custom:'retained'}}));
  await otherDb.insert(emailMessages).values(rows.map(row=>values(scope,row)));await otherDb.insert(emailMemberships).values(rows.map(row=>({...scope,logical_message_id:row.logical_message_id,folder:'inbox',inventory_generation:'kept-generation'})));return scope;};
 const review=async(scope:EmailScope,n=1)=>{const revision=await store.readAcknowledgementRevision(scope,guardFor(scope));assert.equal(revision,7);const row=await store.readMessage(scope,logical(n));assert.ok(row);return {row,revision};};
 const update=(reviewed:Awaited<ReturnType<typeof review>>,folders:readonly string[])=>({logical_message_id:reviewed.row.logical_message_id,expected_revision:reviewed.row.revision,expected_source_digest:emailNativeTriageSourceFingerprint(reviewed.row),expected_checkpoint_revision:reviewed.revision!,flags:{seen:false,flagged:false,answered:null},folders});
 const raw=async(scope:EmailScope)=>(await concurrent.query('SELECT * FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 ORDER BY logical_message_id',Object.values(scope))).rows;
 const cp=async(scope:EmailScope)=>(await concurrent.query('SELECT revision,coverage,fresh_until FROM email_checkpoints WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0];
 await t.test('exact full folders and summary fields change atomically; original locator/provider revision and other metadata remain identical with both envelopes resealed',async()=>{
  const scope=await seed('full'),reviewed=await review(scope),before=(await raw(scope))[0],folders=['spam','label:'+'c'.repeat(64)];
  assert.deepEqual(await store.acknowledgeFlags(scope,[update(reviewed,folders)],guardFor(scope)),{acknowledged:1,stale:0});
  const row=(await store.readMessage(scope,logical(1)))!,after=(await raw(scope))[0];assert.deepEqual(row.folders,[...folders].sort());assert.deepEqual(row.data,{...reviewed.row.data,in_inbox:false,in_sent:false,in_archive:false,folder_membership_complete:true});
  assert.notDeepEqual(after.source_envelope,before.source_envelope);assert.equal(after.storage_revision,before.storage_revision+1);assert.deepEqual(row.provider_source,reviewed.row.provider_source);assert.equal(after.revision,before.revision);assert.equal(after.inventory_generation,before.inventory_generation);assert.notDeepEqual(after.summary_envelope,before.summary_envelope);assert.equal(JSON.stringify(after).includes('Private synthetic'),false);assert.equal((await cp(scope)).revision,8);assert.equal((await cp(scope)).fresh_until,null);
 });
 await t.test('both actual overlapping ACK orders skip the held older checkpoint, including an equal-value Not spam ABA winner',async()=>{
  for(const winner of ['spam','inbox']){const scope=await seed('race-'+winner),a=await review(scope),b=await review(scope),entered=barrier(),release=barrier();let calls=0;
   const held=store.acknowledgeFlags(scope,[update(a,[winner==='spam'?'inbox':'spam'])],async tx=>{await guardFor(scope)(tx);if(++calls===1){entered.release();await release.promise;}});await entered.promise;
   const first=await store.acknowledgeFlags(scope,[update(b,[winner])],guardFor(scope));assert.deepEqual(first,{acknowledged:1,stale:0});assert.equal((await cp(scope)).revision,8);release.release();assert.deepEqual(await held,{acknowledged:0,stale:1});assert.deepEqual((await store.readMessage(scope,logical(1)))!.folders,[winner]);assert.equal(calls,2);
  }
 });
 await t.test('a sync-version bump skips old membership; missing-only search persistence preserves reviewed targets without false overwrites',async()=>{
  const scope=await seed('sync'),old=await review(scope);await concurrent.query('UPDATE email_checkpoints SET revision=revision+1 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope));const before=await raw(scope);
  assert.deepEqual(await store.acknowledgeFlags(scope,[update(old,['spam'])],guardFor(scope)),{acknowledged:0,stale:1});assert.deepEqual(await raw(scope),before);
  const searchScope=await seed('search'),reviewed=await review(searchScope),cached=await raw(searchScope);await store.persistSearchResults(searchScope,[{...record(searchScope,1,'older-provider'),folders:['trash']},record(searchScope,2)],guardFor(searchScope));assert.deepEqual((await raw(searchScope))[0],cached[0]);assert.equal((await cp(searchScope)).revision,8);
  const afterSearch=await raw(searchScope);
  // The retained legacy account-wide pin is intentionally conservative: a
  // missing-only insert advances the checkpoint without changing this target.
  assert.deepEqual(await store.acknowledgeFlags(searchScope,[update(reviewed,['spam'])],guardFor(searchScope)),{acknowledged:0,stale:1});assert.deepEqual(await raw(searchScope),afterSearch);assert.equal((await cp(searchScope)).revision,8);
  const freshRevision=await store.readAcknowledgementRevision(searchScope,guardFor(searchScope));assert.equal(freshRevision,8);const freshRow=(await store.readMessage(searchScope,logical(1)))!;
  assert.deepEqual(await store.acknowledgeFlags(searchScope,[update({row:freshRow,revision:freshRevision},['spam'])],guardFor(searchScope)),{acknowledged:1,stale:0});assert.equal((await cp(searchScope)).revision,9);assert.deepEqual((await store.readMessage(searchScope,logical(1)))!.folders,['spam']);assert.deepEqual((await store.readMessage(searchScope,logical(2)))!.folders,['inbox']);
 });
 await t.test('changed source/revision, tombstones and foreign account targets never publish memberships',async()=>{
  for(const change of ['revision','source','deleted']){const scope=await seed('stale-'+change),reviewed=await review(scope);
   if(change==='revision')await concurrent.query('UPDATE email_messages SET revision=$4 WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',[...Object.values(scope),'provider-newer']);
   if(change==='source')await otherDb.update(emailMessages).set({source_envelope:crypto.seal({...reviewed.row.provider_source,locator:{message_id:'changed'}},{...scope,kind:'provider_source',record_id:logical(1),revision:7})}).where(sql`account_id=${scope.account_id}`);
   if(change==='deleted')await concurrent.query('UPDATE email_messages SET deleted_at=now(),summary_envelope=NULL,source_envelope=NULL WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope));const before=await raw(scope);
   assert.deepEqual(await store.acknowledgeFlags(scope,[update(reviewed,['spam'])],guardFor(scope)),{acknowledged:0,stale:1});assert.deepEqual(await raw(scope),before);assert.equal((await cp(scope)).revision,7);
  }
  const scope=await seed('scoped'),foreign=await seed('foreign');const value=update(await review(scope),['spam']);assert.deepEqual(await store.acknowledgeFlags(foreign,[value],guardFor(foreign)),{acknowledged:0,stale:1});assert.deepEqual((await store.readMessage(foreign,logical(1)))!.folders,['inbox']);
 });
 await t.test('actual final SQL authority loss rolls back folders, encrypted metadata, flags, checkpoint and attempted revocation together',async()=>{
  const scope=await seed('late-denial'),reviewed=await review(scope),before=await raw(scope),checkpointBefore=await cp(scope);let calls=0;
  await assert.rejects(store.acknowledgeFlags(scope,[update(reviewed,['spam'])],async tx=>{if(++calls===2)await (tx as typeof db).execute(sql`UPDATE email_accounts SET state='paused' WHERE account_id=${scope.account_id}`);await guardFor(scope)(tx);}),/SQL authority revoked/);
  assert.deepEqual(await raw(scope),before);assert.deepEqual(await cp(scope),checkpointBefore);assert.deepEqual((await store.readMessage(scope,logical(1)))!.folders,['inbox']);assert.equal((await concurrent.query('SELECT state FROM email_accounts WHERE account_id=$1',[scope.account_id])).rows[0].state,'active');
 });
 await t.test('25 targets with100 confirmed memberships remain bounded and exact in one account checkpoint transaction',async()=>{
  const scope=await seed('maximum',25),revision=await store.readAcknowledgementRevision(scope,guardFor(scope));assert.equal(revision,7);const folders=Array.from({length:100},(_,n)=>'label:'+n.toString(16).padStart(64,'0')),updates=[];
  for(let n=1;n<=25;n++){const row=(await store.readMessage(scope,logical(n)))!;updates.push(update({row,revision},folders));}membershipBindCounts.length=0;
  assert.deepEqual(await store.acknowledgeFlags(scope,updates,guardFor(scope)),{acknowledged:25,stale:0});assert.equal((await cp(scope)).revision,8);assert.deepEqual((await store.readMessage(scope,logical(25)))!.folders,folders);assert.equal(membershipBindCounts.length,25);assert.ok(membershipBindCounts.every(n=>n<=700&&n<65536));
 });
 await t.test('missing checkpoint and caller cancellation make no cache effects; guarded revision read permits real SQL FOR SHARE authority',async()=>{
  const scope=await setup('missing-checkpoint');await concurrent.query('DELETE FROM email_checkpoints WHERE account_id=$1',[scope.account_id]);assert.equal(await store.readAcknowledgementRevision(scope,guardFor(scope)),null);
  const present=await seed('aborted'),reviewed=await review(present),before=await raw(present);await assert.rejects(store.acknowledgeFlags(present,[update(reviewed,['spam'])],guardFor(present),AbortSignal.abort()));assert.deepEqual(await raw(present),before);
 });
});
