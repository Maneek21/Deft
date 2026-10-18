import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {emailNativeTriageSourceFingerprint,EmailNativeTriageService} from '../src/lib/email-native-triage.js';
import type {EmailScope,EmailMessageRecord} from '../src/lib/email-mailbox-service.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_m32_release';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');

test('isolated PostgreSQL per-message ACK versions preserve unrelated-write availability, ABA, scope, ciphertext and final authority rollback',{skip:!safe,timeout:120000},async t=>{
 const namespace='triage_ack_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:target,max:2});
 assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'email_m32_release',role:'gate_g_test',port:55435});
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
 await concurrent.query(`CREATE TABLE email_notification_states(org_id text,owner_user_id text,account_id text,initial_inventory_complete boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id));
  CREATE TABLE email_sync_receipts(org_id text,owner_user_id text,account_id text,page_id text,request_digest text,page_digest text,checkpoint_revision integer,observed_at timestamptz,complete boolean,has_more boolean,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id,page_id));
  CREATE TABLE email_provider_states(org_id text,owner_user_id text,account_id text,state_key text,storage_revision integer,generation text,state_envelope jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,owner_user_id,account_id,state_key));`);
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
 const review=async(scope:EmailScope,n=1)=>{const pins=await store.readAcknowledgementVersions(scope,[logical(n)],guardFor(scope));assert.equal(pins.length,1);assert.ok(pins[0]);const revision=pins[0].storage_revision;assert.equal(revision,7);const row=await store.readMessage(scope,logical(n));assert.ok(row);return {row,revision};};
 const update=(reviewed:Awaited<ReturnType<typeof review>>,folders:readonly string[])=>({logical_message_id:reviewed.row.logical_message_id,expected_revision:reviewed.row.revision,expected_source_digest:emailNativeTriageSourceFingerprint(reviewed.row),expected_storage_revision:reviewed.revision!,flags:{seen:false,flagged:false,answered:null},folders});
 const raw=async(scope:EmailScope)=>(await concurrent.query('SELECT * FROM email_messages WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3 ORDER BY logical_message_id',Object.values(scope))).rows;
 const cp=async(scope:EmailScope)=>(await concurrent.query('SELECT revision,coverage,fresh_until FROM email_checkpoints WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3',Object.values(scope))).rows[0];
 await t.test('actual service+store pins targets, accepts an unrelated write during effect, fresh Undo restores and status/replay cannot ACK',async()=>{
  const scope=await seed('composed',2),original=(await store.readMessage(scope,logical(1)))!,operation=randomUUID(),actor={user_id:scope.owner_user_id,web_session_id:'synthetic-sid',access_expires_at:instant.getTime()+60000},cap={scope,resource_binding_id:'synthetic-binding',authority_version:'synthetic-authority',expires_at:actor.access_expires_at};let effects=0;const retained=new Map<string,any>();
  const authority={current:async(_actor:unknown,s:EmailScope,kind:string,tx?:unknown)=>{assert.equal(kind,'human_modify');assert.deepEqual(s,scope);if(tx)await guardFor(scope)(tx);else await db.transaction(guardFor(scope));return cap;}};
  const provider={invoke:async(_s:unknown,input:any,_c:unknown,recheck:()=>Promise<void>,beforeReserve:()=>Promise<void>)=>{
   const id=input.mode==='undo'?input.undo_operation_id:input.operation_id;if(input.mode==='status'||retained.has(id))return {...retained.get(id),items:retained.get(id).items.map(({confirmed_flags:_f,confirmed_folders:_d,...item}:any)=>item)};
   await beforeReserve();if(effects===0)await concurrent.query('UPDATE email_checkpoints SET revision=revision+1 WHERE account_id=$1',[scope.account_id]);effects++;await recheck();const undo=input.mode==='undo';const receipt={schema_version:'deft.email_native_triage_result.v1',account_id:scope.account_id,operation_id:id,operation:'spam',automatic_retry:false,undo_available:!undo,items:[{logical_message_id:logical(1),state:'succeeded',undo_supported:!undo,confirmed_flags:{seen:!undo,flagged:false,answered:null},confirmed_folders:[undo?'inbox':'spam']}]};retained.set(id,receipt);return receipt;}};
  const service=new EmailNativeTriageService(authority as any,store,provider as any,undefined,()=>instant.getTime());
  await service.apply(actor,scope,{operation_id:operation,kind:'spam',logical_message_ids:[logical(1)]});assert.equal(effects,1);assert.equal((await cp(scope)).revision,9);let row=(await store.readMessage(scope,logical(1)))!;assert.equal(row.flags.seen,true);assert.deepEqual(row.folders,['spam']);assert.deepEqual(row.provider_source,original.provider_source);
  await service.apply(actor,scope,{operation_id:operation,kind:'spam',logical_message_ids:[logical(1)]});await service.status(actor,scope,operation);assert.equal(effects,1);assert.equal((await cp(scope)).revision,9);
  const undo=randomUUID();await service.undo(actor,scope,operation,undo);assert.equal(effects,2);assert.equal((await cp(scope)).revision,10);row=(await store.readMessage(scope,logical(1)))!;assert.equal(row.flags.seen,false);assert.deepEqual(row.folders,['inbox']);assert.deepEqual(row.provider_source,original.provider_source);
  await service.undo(actor,scope,operation,undo);await service.status(actor,scope,undo);assert.equal(effects,2);assert.equal((await cp(scope)).revision,10);
 });
 await t.test('exact full folders and summary fields change atomically; original locator/provider revision and other metadata remain identical with both envelopes resealed',async()=>{
  const scope=await seed('full'),reviewed=await review(scope),before=(await raw(scope))[0],folders=['spam','label:'+'c'.repeat(64)];
  assert.deepEqual(await store.acknowledgeFlags(scope,[update(reviewed,folders)],guardFor(scope)),{acknowledged:1,stale:0});
  const row=(await store.readMessage(scope,logical(1)))!,after=(await raw(scope))[0];assert.deepEqual(row.folders,[...folders].sort());assert.deepEqual(row.data,{...reviewed.row.data,in_inbox:false,in_sent:false,in_archive:false,folder_membership_complete:true});
  assert.notDeepEqual(after.source_envelope,before.source_envelope);assert.equal(after.storage_revision,before.storage_revision+1);assert.deepEqual(row.provider_source,reviewed.row.provider_source);assert.equal(after.revision,before.revision);assert.equal(after.inventory_generation,before.inventory_generation);assert.notDeepEqual(after.summary_envelope,before.summary_envelope);assert.equal(JSON.stringify(after).includes('Private synthetic'),false);assert.equal((await cp(scope)).revision,8);assert.equal((await cp(scope)).fresh_until,null);
 });
 await t.test('both actual overlapping ACK orders skip the held older target version, including an equal-value Not spam ABA winner',async()=>{
  for(const winner of ['spam','inbox']){const scope=await seed('race-'+winner),a=await review(scope),b=await review(scope),entered=barrier(),release=barrier();let calls=0;
   const held=store.acknowledgeFlags(scope,[update(a,[winner==='spam'?'inbox':'spam'])],async tx=>{await guardFor(scope)(tx);if(++calls===1){entered.release();await release.promise;}});await entered.promise;
   const first=await store.acknowledgeFlags(scope,[update(b,[winner])],guardFor(scope));assert.deepEqual(first,{acknowledged:1,stale:0});assert.equal((await cp(scope)).revision,8);release.release();assert.deepEqual(await held,{acknowledged:0,stale:1});assert.deepEqual((await store.readMessage(scope,logical(1)))!.folders,[winner]);assert.equal(calls,2);
  }
 });
 await t.test('unrelated-row sync version is accepted, same-target equal-value rewrite skips, and missing-only search preserves target',async()=>{
  const scope=await seed('sync',2),old=await review(scope),other=(await store.readMessage(scope,logical(2)))!;
  await otherDb.transaction(async tx=>{await tx.execute(sql`SELECT revision FROM email_checkpoints WHERE account_id=${scope.account_id} FOR UPDATE`);
   await tx.update(emailMessages).set({storage_revision:8,summary_envelope:crypto.seal(other.data,{...scope,kind:'summary',record_id:logical(2),revision:8}),source_envelope:crypto.seal(other.provider_source,{...scope,kind:'provider_source',record_id:logical(2),revision:8})}).where(sql`account_id=${scope.account_id} AND logical_message_id=${logical(2)}`);
   await tx.execute(sql`UPDATE email_checkpoints SET revision=8 WHERE account_id=${scope.account_id}`);});
  assert.deepEqual(await store.acknowledgeFlags(scope,[update(old,['spam'])],guardFor(scope)),{acknowledged:1,stale:0});assert.equal((await cp(scope)).revision,9);assert.deepEqual((await store.readMessage(scope,logical(1)))!.folders,['spam']);assert.deepEqual((await store.readMessage(scope,logical(2)))!.provider_source,other.provider_source);
  const changed=await seed('same-row'),prior=await review(changed);await otherDb.transaction(async tx=>{await tx.execute(sql`SELECT revision FROM email_checkpoints WHERE account_id=${changed.account_id} FOR UPDATE`);await tx.update(emailMessages).set({storage_revision:8,summary_envelope:crypto.seal(prior.row.data,{...changed,kind:'summary',record_id:logical(1),revision:8}),source_envelope:crypto.seal(prior.row.provider_source,{...changed,kind:'provider_source',record_id:logical(1),revision:8})}).where(sql`account_id=${changed.account_id}`);await tx.execute(sql`UPDATE email_checkpoints SET revision=8 WHERE account_id=${changed.account_id}`);});const unchanged=await raw(changed);
  assert.deepEqual(await store.acknowledgeFlags(changed,[update(prior,['spam'])],guardFor(changed)),{acknowledged:0,stale:1});assert.deepEqual(await raw(changed),unchanged);
  const searchScope=await seed('search'),reviewed=await review(searchScope),cached=await raw(searchScope);await store.persistSearchResults(searchScope,[{...record(searchScope,1,'older-provider'),folders:['trash']},record(searchScope,2)],guardFor(searchScope));assert.deepEqual((await raw(searchScope))[0],cached[0]);assert.equal((await cp(searchScope)).revision,8);
  assert.deepEqual(await store.acknowledgeFlags(searchScope,[update(reviewed,['spam'])],guardFor(searchScope)),{acknowledged:1,stale:0});assert.deepEqual((await store.readMessage(searchScope,logical(1)))!.folders,['spam']);assert.deepEqual((await store.readMessage(searchScope,logical(2)))!.folders,['inbox']);
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
  const scope=await seed('maximum',25),pins=await store.readAcknowledgementVersions(scope,Array.from({length:25},(_,n)=>logical(n+1)),guardFor(scope));assert.equal(pins.length,25);assert.ok(pins.every(pin=>pin.storage_revision===7));const revision=7;const folders=Array.from({length:100},(_,n)=>'label:'+n.toString(16).padStart(64,'0')),updates=[];
  for(let n=1;n<=25;n++){const row=(await store.readMessage(scope,logical(n)))!;updates.push(update({row,revision},folders));}membershipBindCounts.length=0;
  assert.deepEqual(await store.acknowledgeFlags(scope,updates,guardFor(scope)),{acknowledged:25,stale:0});assert.equal((await cp(scope)).revision,8);assert.deepEqual((await store.readMessage(scope,logical(25)))!.folders,folders);assert.equal(membershipBindCounts.length,25);assert.ok(membershipBindCounts.every(n=>n<=700&&n<65536));
 });
 await t.test('missing checkpoint and caller cancellation make no cache effects; guarded revision read permits real SQL FOR SHARE authority',async()=>{
  const scope=await setup('missing-checkpoint');await concurrent.query('DELETE FROM email_checkpoints WHERE account_id=$1',[scope.account_id]);assert.equal(await store.readAcknowledgementRevision(scope,guardFor(scope)),null);
  const present=await seed('aborted'),reviewed=await review(present),before=await raw(present);await assert.rejects(store.acknowledgeFlags(present,[update(reviewed,['spam'])],guardFor(present),AbortSignal.abort()));assert.deepEqual(await raw(present),before);
  const noCheckpoint=await seed('missing-row-checkpoint'),pin=await review(noCheckpoint);await concurrent.query('DELETE FROM email_checkpoints WHERE account_id=$1',[noCheckpoint.account_id]);const saved=await raw(noCheckpoint);assert.deepEqual(await store.acknowledgeFlags(noCheckpoint,[update(pin,['spam'])],guardFor(noCheckpoint)),{acknowledged:0,stale:1});assert.deepEqual(await raw(noCheckpoint),saved);
 });
 const syncCommit=(scope:EmailScope,row:EmailMessageRecord,revision:number,cursor:string|null=null)=>({page_id:randomUUID(),request_digest:'a'.repeat(64),page_digest:'b'.repeat(64),expected_checkpoint_revision:revision,input_cursor:cursor,authority_version:'synthetic',resource_binding_id:'synthetic',page:{account_id:scope.account_id,items:[row],next_cursor:'next-private-cursor',has_more:true,observed_at:instant.toISOString(),complete:false,failure_count:0,tombstones:[],state_updates:[{state_key:'c'.repeat(64),generation:'synthetic-generation',value:{cursor:'private-provider-state'}}]}});
 await t.test('M35 actual held same-target sync before reservation refreshes exact row/source ACK while post-reserve sync conservatively skips it',async()=>{
  for(const beforeReserveSync of [true,false]){const scope=await seed('reserve-sync-'+beforeReserveSync),original=(await store.readMessage(scope,logical(1)))!,actor={user_id:scope.owner_user_id,web_session_id:'synthetic-sid',access_expires_at:instant.getTime()+60000},cap={scope,resource_binding_id:'synthetic-binding',authority_version:'synthetic-authority',expires_at:actor.access_expires_at};let effects=0;const captured:number[]=[];
   const authority={current:async(_a:unknown,s:EmailScope,kind:string,tx?:unknown)=>{assert.equal(kind,'human_modify');assert.deepEqual(s,scope);if(tx)await guardFor(scope)(tx);else await db.transaction(guardFor(scope));return cap;}};
   const synced={...original,revision:'current-provider-metadata',flags:{...original.flags,seen:beforeReserveSync},provider_source:{...original.provider_source,locator:{...(original.provider_source.locator as Record<string,unknown>),label_ids:['INBOX']}}} as EmailMessageRecord;
   const provider={invoke:async(_s:unknown,input:any,_c:unknown,recheck:()=>Promise<void>,reserve:()=>Promise<void>)=>{
    if(beforeReserveSync)await store.commitPage(scope,syncCommit(scope,synced,7),guardFor(scope));await reserve();effects++;
    if(!beforeReserveSync)await store.commitPage(scope,syncCommit(scope,synced,7),guardFor(scope));await recheck();
    return {schema_version:'deft.email_native_triage_result.v1',account_id:scope.account_id,operation_id:input.operation_id,operation:'mark_read',automatic_retry:false,undo_available:false,items:[{logical_message_id:logical(1),state:'succeeded',undo_supported:false,confirmed_flags:{seen:true,flagged:false,answered:null}}]};}};
   const scopedStore={readMessage:store.readMessage.bind(store),acknowledgeFlags:store.acknowledgeFlags.bind(store),readAcknowledgementVersions:async(s:EmailScope,ids:readonly string[],guard:(tx:unknown)=>Promise<void>,signal?:AbortSignal)=>{const pins=await store.readAcknowledgementVersions(s,ids,guard,signal);assert.ok(pins[0]);captured.push(pins[0].storage_revision);return pins;}};
   const service=new EmailNativeTriageService(authority as any,scopedStore,provider as any,undefined,()=>instant.getTime());
   await service.apply(actor,scope,{operation_id:randomUUID(),kind:'mark_read',logical_message_ids:[logical(1)]});assert.equal(effects,1);assert.deepEqual(captured,beforeReserveSync?[7,8]:[7,7]);
   const current=(await store.readMessage(scope,logical(1)))!,ciphertext=(await raw(scope))[0];assert.equal(current.revision,'current-provider-metadata');assert.deepEqual(current.provider_source,synced.provider_source);assert.equal(current.flags.seen,beforeReserveSync);assert.equal(ciphertext.storage_revision,beforeReserveSync?9:8);assert.equal((await cp(scope)).revision,beforeReserveSync?9:8);
  }
 });
 await t.test('M35 second bulk reservation cannot re-pin an earlier effect through actual equal-value row-version advancement',async()=>{
  const scope=await seed('reserve-bulk',2),actor={user_id:scope.owner_user_id,web_session_id:'synthetic-sid',access_expires_at:instant.getTime()+60000},cap={scope,resource_binding_id:'synthetic-binding',authority_version:'synthetic-authority',expires_at:actor.access_expires_at};let effects=0,pins=0;
  const authority={current:async(_a:unknown,_s:EmailScope,_kind:string,tx?:unknown)=>{if(tx)await guardFor(scope)(tx);else await db.transaction(guardFor(scope));return cap;}};
  const provider={invoke:async(_s:unknown,input:any,_c:unknown,recheck:()=>Promise<void>,reserve:()=>Promise<void>)=>{
   await reserve();effects++;const newer=await review(scope);await store.acknowledgeFlags(scope,[update(newer,['inbox'])],guardFor(scope));await reserve();effects++;await recheck();
   return {schema_version:'deft.email_native_triage_result.v1',account_id:scope.account_id,operation_id:input.operation_id,operation:'mark_read',automatic_retry:false,undo_available:false,items:[1,2].map(n=>({logical_message_id:logical(n),state:'succeeded',undo_supported:false,confirmed_flags:{seen:true,flagged:false,answered:null}}))};}};
  const scopedStore={readMessage:store.readMessage.bind(store),acknowledgeFlags:store.acknowledgeFlags.bind(store),readAcknowledgementVersions:async(s:EmailScope,ids:readonly string[],guard:(tx:unknown)=>Promise<void>,signal?:AbortSignal)=>{pins++;return store.readAcknowledgementVersions(s,ids,guard,signal);}};
  const service=new EmailNativeTriageService(authority as any,scopedStore,provider as any,undefined,()=>instant.getTime());await service.apply(actor,scope,{operation_id:randomUUID(),kind:'mark_read',logical_message_ids:[logical(1),logical(2)]});assert.equal(effects,2);assert.equal(pins,2);
  assert.equal((await store.readMessage(scope,logical(1)))!.flags.seen,false);assert.equal((await store.readMessage(scope,logical(2)))!.flags.seen,true);assert.deepEqual((await raw(scope)).map(row=>row.storage_revision),[8,9]);assert.equal((await cp(scope)).revision,9);
 });
 await t.test('new search-discovered target ACK is immediately writable; retained cursor follows insertion and final ACK revision',async()=>{
  const scope=await setup('new-search'),cursor='retained-private-cursor';await otherDb.update(emailCheckpoints).set({cursor_envelope:crypto.seal({cursor},{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:7})}).where(sql`account_id=${scope.account_id}`);
  const item=record(scope,1);await store.persistSearchResults(scope,[item],guardFor(scope));assert.equal((await cp(scope)).revision,8);assert.deepEqual(await store.readCheckpoint(scope),{revision:8,cursor,has_more:false});
  const pins=await store.readAcknowledgementVersions(scope,[logical(1)],guardFor(scope));assert.ok(pins[0]);assert.equal(pins[0].storage_revision,8);const row=(await store.readMessage(scope,logical(1)))!;
  assert.deepEqual(await store.acknowledgeFlags(scope,[update({row,revision:8},['spam'])],guardFor(scope)),{acknowledged:1,stale:0});assert.equal((await cp(scope)).revision,9);assert.equal((await raw(scope))[0].storage_revision,9);assert.equal((await store.readCheckpoint(scope)).cursor,cursor);assert.deepEqual((await store.readMessage(scope,logical(1)))!.folders,['spam']);
  const before=await cp(scope);await store.persistSearchResults(scope,[item],guardFor(scope));assert.deepEqual(await cp(scope),before);
 });
 await t.test('first actual same-target sync invalidates held ACK for both new and legacy ahead-of-checkpoint search rows',async()=>{
  for(const legacy of [false,true]){const scope=await setup('search-sync-'+legacy),item=record(scope,1);await store.persistSearchResults(scope,[item],guardFor(scope));
   if(legacy)await concurrent.query('UPDATE email_checkpoints SET revision=7 WHERE account_id=$1',[scope.account_id]);
   const pins=await store.readAcknowledgementVersions(scope,[logical(1)],guardFor(scope)),row=(await store.readMessage(scope,logical(1)))!;assert.ok(pins[0]);assert.equal(pins[0].storage_revision,8);
   const entered=barrier(),release=barrier();let guards=0;const held=store.acknowledgeFlags(scope,[update({row,revision:8},['spam'])],async tx=>{await guardFor(scope)(tx);if(++guards===1){entered.release();await release.promise;}});const settled=held.then(value=>({value,error:null}),error=>({value:null,error}));await entered.promise;
   try{const current=(await cp(scope)).revision,result=await store.commitPage(scope,syncCommit(scope,item,current),guardFor(scope));assert.equal(result.checkpoint_revision,9);assert.equal((await raw(scope))[0].storage_revision,9);}finally{release.release();await settled;}
   const outcome=await settled;if(outcome.error)throw outcome.error;assert.deepEqual(outcome.value,{acknowledged:0,stale:1});assert.deepEqual((await store.readMessage(scope,logical(1)))!.folders,['inbox']);assert.equal(guards,2);
   const states=await concurrent.query('SELECT storage_revision,state_envelope FROM email_provider_states WHERE account_id=$1',[scope.account_id]);assert.equal(states.rows[0].storage_revision,9);assert.deepEqual(crypto.open(states.rows[0].state_envelope,{...scope,kind:'checkpoint',record_id:'provider-state:'+'c'.repeat(64)+':synthetic-generation',revision:9}),{value:{cursor:'private-provider-state'}});assert.equal((await store.readCheckpoint(scope)).cursor,'next-private-cursor');
  }
 });
 await t.test('legacy ahead rows ACK monotonically; tombstone resurrection sync advances; version overflow preserves all state',async()=>{
  const scope=await setup('legacy-ack'),item=record(scope,1);await store.persistSearchResults(scope,[item],guardFor(scope));await concurrent.query('UPDATE email_checkpoints SET revision=7 WHERE account_id=$1',[scope.account_id]);const row=(await store.readMessage(scope,logical(1)))!;
  assert.deepEqual(await store.acknowledgeFlags(scope,[update({row,revision:8},['spam'])],guardFor(scope)),{acknowledged:1,stale:0});assert.equal((await cp(scope)).revision,9);assert.equal((await raw(scope))[0].storage_revision,9);
  const revived=await seed('resurrection');await concurrent.query('UPDATE email_messages SET storage_revision=8,deleted_at=now(),source_envelope=NULL,summary_envelope=NULL WHERE account_id=$1',[revived.account_id]);assert.equal((await store.commitPage(revived,syncCommit(revived,record(revived,1),7),guardFor(revived))).checkpoint_revision,9);assert.equal((await raw(revived))[0].storage_revision,9);assert.ok((await store.readMessage(revived,logical(1)))!);
  const maximum=await seed('overflow'),old=(await store.readMessage(maximum,logical(1)))!;await otherDb.update(emailMessages).set({storage_revision:2147483647,summary_envelope:crypto.seal(old.data,{...maximum,kind:'summary',record_id:logical(1),revision:2147483647}),source_envelope:crypto.seal(old.provider_source,{...maximum,kind:'provider_source',record_id:logical(1),revision:2147483647})}).where(sql`account_id=${maximum.account_id}`);const before=await raw(maximum),beforeCP=await cp(maximum);
  await assert.rejects(store.acknowledgeFlags(maximum,[update({row:old,revision:2147483647},['spam'])],guardFor(maximum)),/EMAIL_CHECKPOINT_CONFLICT/);assert.deepEqual(await raw(maximum),before);assert.deepEqual(await cp(maximum),beforeCP);
  await assert.rejects(store.commitPage(maximum,syncCommit(maximum,old,7),guardFor(maximum)),/EMAIL_CHECKPOINT_CONFLICT/);assert.deepEqual(await raw(maximum),before);assert.deepEqual(await cp(maximum),beforeCP);
 });
 await t.test('search insert and elevated legacy sync final SQL denial roll back row version, cursor, memberships and state',async()=>{
  for(const mode of ['search','sync']){const scope=await setup('revision-denial-'+mode),item=record(scope,1);if(mode==='sync'){await store.persistSearchResults(scope,[item],guardFor(scope));await concurrent.query('UPDATE email_checkpoints SET revision=7 WHERE account_id=$1',[scope.account_id]);}const before=await raw(scope),beforeCP=await cp(scope);let calls=0;
   const guard=async(tx:unknown)=>{if(++calls===2)await (tx as typeof db).execute(sql`UPDATE email_accounts SET state='paused' WHERE account_id=${scope.account_id}`);await guardFor(scope)(tx);};
   await assert.rejects(mode==='search'?store.persistSearchResults(scope,[item],guard):store.commitPage(scope,syncCommit(scope,item,7),guard),/SQL authority revoked/);assert.deepEqual(await raw(scope),before);assert.deepEqual(await cp(scope),beforeCP);assert.equal((await concurrent.query('SELECT count(*)::int AS n FROM email_provider_states WHERE account_id=$1',[scope.account_id])).rows[0].n,0);
  }
 });

});
