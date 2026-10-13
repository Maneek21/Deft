import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {canonicalCapabilityJson} from '@deft/shared';
import * as schema from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {PostgresEmailOperationJournal} from '../src/lib/email-operation-journal.js';
import {PostgresEmailImapAliasStore} from '../src/lib/email-imap-alias-store.js';
import {EmailNativeTriageService,RegisteredEmailNativeTriageProvider} from '../src/lib/email-native-triage.js';
import {RegisteredEmailMailboxProvider} from '../src/lib/email-mailbox-provider.js';
import {emailImapSourceDigest,emailImapLocatorKey} from '../src/lib/email-imap-alias-contract.js';
import type {EmailMessageRecord,EmailScope,EmailSyncCommit} from '../src/lib/email-mailbox-service.js';
import type {NativeEmailTriagePlan} from '../src/lib/app-connection-contract.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('actual PG journal-proven UIDMOVE aliases and registered native adapter restart',{skip:!safe,timeout:60000},async t=>{
 const namespace='email_imap_alias_'+randomUUID().replaceAll('-','');assert.match(namespace,/^email_imap_alias_[a-f0-9]{32}$/u);
 const admin=new pg.Pool({connectionString:target});await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:8});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 // Labeled predecessor fixture: production-shaped columns/checks, no claim of
 // validating the whole release ledger here. Actual migration78 runs twice.
 for(const name of ['email_accounts','email_checkpoints','email_messages','email_memberships','email_provider_states','email_sync_receipts'])await pool.query(`CREATE TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
 await pool.query('ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_draft_sync_enabled boolean NOT NULL DEFAULT false');
 await pool.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.67-email-native-operations.sql',import.meta.url),'utf8'));
 const ddl=readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.78-email-imap-move-aliases.sql',import.meta.url),'utf8');await pool.query(ddl);await pool.query(ddl);
 const database=drizzle(pool,{schema}),scope={org_id:'org',owner_user_id:'owner',account_id:'account'},providerScope={org_id:'org',owner_id:'owner',installation_id:'installation'},binding={resource_binding_id:'binding',action_binding_id:'action',authority_epoch:1};
 await database.insert(schema.emailAccounts).values({...scope,provider:'imap_smtp',resource_binding_id:'binding',principal_digest:'a'.repeat(64),state:'active',consented_at:new Date()});
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'imap-alias-key',key:Buffer.alloc(32,84)}),read:(_purpose,id)=>id==='imap-alias-key'?{key_id:id,key:Buffer.alloc(32,84)}:null,keyIds:()=>['imap-alias-key']});
 let revoked=false;const guard=async(tx:unknown)=>{if(revoked)throw Error('REVOKED');const value=await(tx as typeof database).execute(sql`SELECT state FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} FOR SHARE`);assert.equal(value.rows[0]?.state,'active');};
 const aliases=new PostgresEmailImapAliasStore(database as never,cipher),store=()=>new PostgresEmailMailboxStore(database as never,cipher,{identities:aliases});
 const {nativeImapEffectsFixture}=await import(new URL('../../../examples/apps/email/providers/native-imap-effects-fixture.mjs',import.meta.url).href),f=nativeImapEffectsFixture();
 const {createAppConnectionAdapter}=await import(new URL('../../../examples/apps/email/providers/native-imap-connection.mjs',import.meta.url).href);
 const journal=()=>new PostgresEmailOperationJournal(database as never,cipher,scope,providerScope,guard);
 const mirroredJournal={load:journal().load.bind(journal()),create:async(plan:NativeEmailTriagePlan)=>{const value=await journal().create(plan);f.ledger.set(plan.operation_id,structuredClone(value));return value;},change:async(_scope:unknown,id:string,work:any)=>journal().change(providerScope,id,async(value,write)=>work(value,async(next:any)=>{await write(next);f.ledger.set(id,structuredClone(next));}))};
 const port={lookup:(locator:any)=>aliases.lookup(scope,locator,guard),reserve:(input:any)=>aliases.reserveMove(scope,input,providerScope,binding,guard),reconcile:async(id:string)=>{await aliases.reconcileMove(scope,id,providerScope,binding,guard);}};
 let adapter=await createAppConnectionAdapter({host:{nativeEmailImapHost:async()=>f.host}});
 const cap={scope,resource_binding_id:'binding',authority_version:'current-owner-cap',expires_at:Date.now()+60000},actor={user_id:'owner',web_session_id:'synthetic-human-session',access_expires_at:cap.expires_at};
 const current=async(_actor:any,_scope:any,_op:any,tx?:unknown)=>{if(tx)await guard(tx);else await database.transaction(guard);return cap;};
 const resolve=async(_scope:any,_cap:any,recheck:any,signal:any,purpose:string)=>({adapter,context:{...f.context,authority_version:cap.authority_version,expires_at:cap.expires_at,recheck,signal,imap_aliases:port,...(purpose==='triage'?{triage_journal:mirroredJournal}:{})}});
 const triage=()=>new EmailNativeTriageService({current},store(),new RegisteredEmailNativeTriageProvider(resolve as never));
 const source=f.source,record:EmailMessageRecord={account_id:scope.account_id,logical_message_id:source.logical_message_id,revision:'initial',received_at:'2026-10-04T00:00:00.000Z',folders:['inbox'],flags:{seen:false,flagged:false,answered:true},data:{subject:'MOVE fixture',logical_message_id:source.logical_message_id,conversation_id:source.conversation_id},provider_source:source};
 await store().persistSearchResults(scope,[record],guard);
 const committed=async(items:EmailMessageRecord[],tombstones:string[]=[],proofs:Record<string,string>={},complete=false)=>{const checkpoint=await store().readCheckpoint(scope),id=randomUUID();const commit:EmailSyncCommit={page_id:id,request_digest:emailImapSourceDigest([id,'request']),page_digest:emailImapSourceDigest([id,'page']),expected_checkpoint_revision:checkpoint.revision,input_cursor:checkpoint.cursor,authority_version:cap.authority_version,resource_binding_id:'binding',page:{account_id:scope.account_id,items,next_cursor:null,has_more:false,complete,observed_at:new Date().toISOString(),failure_count:0,tombstones,tombstone_sources:proofs,state_updates:[]}};return store().commitPage(scope,commit,guard);};
 await t.test('archive, restart source read, sync/search identity reuse and undo preserve logical/conversation identity',async()=>{
  const id=randomUUID(),result=await triage().apply(actor,scope,{operation_id:id,kind:'archive',logical_message_ids:[record.logical_message_id]});assert.equal(result.items[0]!.state,'succeeded');assert.equal(f.calls.write,1);
  const moved=(await store().readMessage(scope,record.logical_message_id))!;assert.deepEqual(moved.folders,['archive']);assert.deepEqual(moved.provider_source.locator,{kind:'imap_smtp',mailbox:'Localized Archive',uidvalidity:'101',uid:99});assert.equal(moved.provider_source.conversation_id,source.conversation_id);
  const raw=(await pool.query('SELECT * FROM email_imap_aliases')).rows;assert.equal(raw.length,2);assert.equal(JSON.stringify(raw).includes('Localized Archive'),false);assert.equal(JSON.stringify((await pool.query('SELECT * FROM email_imap_move_reservations')).rows).includes('INBOX'),false);
  assert.equal((await aliases.lookup(scope,source.locator,guard))!.logical_message_id,record.logical_message_id);assert.equal(await aliases.lookup({...scope,account_id:'foreign'},source.locator,guard),null);
  adapter=await createAppConnectionAdapter({host:{nativeEmailImapHost:async()=>f.host}});
  const original=await new RegisteredEmailMailboxProvider(resolve as never).readSource(scope,{source:moved.provider_source},cap,async()=>{await current(null,null,null);});assert.deepEqual(Buffer.from(original.mime_bytes),f.request.mime_bytes);original.mime_bytes.fill(0);
  const {LogicalMailIndex}=await import(new URL('../../../examples/apps/email/logical-mail-index.mjs',import.meta.url).href),{providerSourceForParent}=await import(new URL('../../../examples/apps/email/providers/provider-browser.mjs',import.meta.url).href);
  const discovered=providerSourceForParent(f.descriptor,new LogicalMailIndex(providerScope).upsert(providerScope,{account_id:'account',provider:'imap_smtp',locator:moved.provider_source.locator}));assert.notEqual(discovered.logical_message_id,record.logical_message_id);
  const hit={...moved,logical_message_id:discovered.logical_message_id,data:{...moved.data,logical_message_id:discovered.logical_message_id,conversation_id:discovered.conversation_id},provider_source:discovered};
  const persisted=await store().persistSearchResults(scope,[hit],guard);assert.equal(persisted.records[0]!.logical_message_id,record.logical_message_id);await committed([hit]);assert.equal((await pool.query('SELECT count(*) FROM email_messages')).rows[0].count,'1');
  // A held old-locator metadata page cannot revive Inbox or stale flags.
  await committed([record]);assert.deepEqual((await store().readMessage(scope,record.logical_message_id))!.folders,['archive']);
  await committed([], [record.logical_message_id], {[record.logical_message_id]:emailImapSourceDigest(source)});assert.ok(await store().readMessage(scope,record.logical_message_id));
  const again=await triage().apply(actor,scope,{operation_id:id,kind:'archive',logical_message_ids:[record.logical_message_id]});assert.equal(again.items[0]!.state,'succeeded');assert.equal(f.calls.write,1);
  const undone=await triage().undo(actor,scope,id,randomUUID());assert.equal(undone.items[0]!.state,'succeeded');assert.equal(f.calls.write,2);const restored=(await store().readMessage(scope,record.logical_message_id))!;assert.deepEqual(restored.folders,['inbox']);assert.equal(restored.provider_source.conversation_id,source.conversation_id);
 });
 const planFor=async(uid:number)=>{
  const {LogicalMailIndex}=await import(new URL('../../../examples/apps/email/logical-mail-index.mjs',import.meta.url).href),{providerSourceForParent}=await import(new URL('../../../examples/apps/email/providers/provider-browser.mjs',import.meta.url).href),locator={kind:'imap_smtp' as const,mailbox:'INBOX',uidvalidity:'100',uid};
  const ownSource=providerSourceForParent(f.descriptor,new LogicalMailIndex(providerScope).upsert(providerScope,{account_id:'account',provider:'imap_smtp',locator}));
  await store().persistSearchResults(scope,[{...record,logical_message_id:ownSource.logical_message_id,provider_source:ownSource}],guard);
  const {org_id,owner_user_id,installation_id,connection_revision,principal_digest,...account}=f.descriptor;
  const unsigned={schema_version:'deft.email_triage_plan.v1' as const,operation_id:randomUUID(),binding:{scope:providerScope,account,action_binding_id:'action',operations:['move']},operation:{kind:'move',destination:'Private Work'},items:[{logical_id:ownSource.logical_message_id,before:{locator,flags:['\\Answered'],modseq:'1'}}],created_at:Date.now(),expires_at:Date.now()+60000};
  const plan={...unsigned,digest:emailImapSourceDigest(unsigned)};await journal().create(plan);return {plan,source:ownSource,input:{operation_id:plan.operation_id,before_locator:locator,destination_mailbox:'Private Work',destination_folders:['folder:'+createHash('sha256').update(JSON.stringify({kind:'native_imap_folder_v1',path:'Private Work'})).digest('hex')]}};
 };
 await t.test('competing reservations serialize, same operation replays, unknown retains slot and no-effect releases',async()=>{
  const a=await planFor(2),b=await planFor(2);const outcomes=await Promise.allSettled([aliases.reserveMove(scope,a.input,providerScope,binding,guard),aliases.reserveMove(scope,b.input,providerScope,binding,guard)]);assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);assert.match(String((outcomes.find(outcome=>outcome.status==='rejected') as PromiseRejectedResult).reason),/BUSY/);
  const winner=outcomes[0]!.status==='fulfilled'?a:b;await aliases.reserveMove(scope,winner.input,providerScope,binding,guard);
  await journal().change(providerScope,winner.plan.operation_id,async(value,write)=>{value!.items[0]!.state='started';await write(value!);value!.items[0]!.state='unknown';await write(value!);});
  assert.equal((await aliases.reconcileMove(scope,winner.plan.operation_id,providerScope,binding,guard)).unresolved,1);await assert.rejects(aliases.reserveMove(scope,(winner===a?b:a).input,providerScope,binding,guard),/BUSY/);
  const noEffect=await planFor(3);await aliases.reserveMove(scope,noEffect.input,providerScope,binding,guard);await journal().change(providerScope,noEffect.plan.operation_id,async(value,write)=>{value!.items[0]!.state='failed';await write(value!);});await aliases.reconcileMove(scope,noEffect.plan.operation_id,providerScope,binding,guard);assert.equal((await pool.query('SELECT count(*) FROM email_imap_move_reservations WHERE logical_message_id=$1',[noEffect.source.logical_message_id])).rows[0].count,'0');
  // Even a current source-bound absence must not delete an unresolved MOVE.
  assert.equal((await committed([],[winner.source.logical_message_id],{[winner.source.logical_message_id]:emailImapSourceDigest(winner.source)},true)).complete,false);assert.ok(await store().readMessage(scope,winner.source.logical_message_id));
 });
 await t.test('cap denies before effect, collision and late revoke roll back, missing current source proof cannot delete',async()=>{
  const a=await planFor(4),id=a.source.logical_message_id;
  for(let uid=400;uid<432;uid++){const locator={kind:'imap_smtp' as const,mailbox:'INBOX',uidvalidity:'100',uid},key=emailImapLocatorKey(scope.account_id,locator),proof={schema_version:'deft.email_imap_alias.v1',provider_scope:providerScope,account_id:scope.account_id,logical_message_id:id,conversation_id:a.source.conversation_id,base_locator:a.source.locator,current_locator:a.source.locator,operation_id:a.plan.operation_id};await database.insert(schema.emailImapAliases).values({...scope,logical_message_id:id,locator_key:key,revision:1,evidence_envelope:cipher.seal(proof,{...scope,kind:'operation',record_id:'imap-alias:'+key,revision:1})});}
  const writes=f.calls.write;await assert.rejects(aliases.reserveMove(scope,a.input,providerScope,binding,guard),/ALIAS_LIMIT/);assert.equal(f.calls.write,writes);
  f.boxes.get('INBOX').rows.set(4,{uid:4,flags:new Set(['\\Answered']),modseq:1n});
  const capped=await triage().apply(actor,scope,{operation_id:randomUUID(),kind:'archive',logical_message_ids:[id]});assert.equal(capped.items[0]!.state,'failed');assert.equal(capped.items[0]!.code,'EMAIL_IMAP_MOVE_ALIAS_LIMIT');assert.equal(f.calls.write,writes);assert.equal(f.boxes.get('INBOX').rows.has(4),true);
  const b=await planFor(5);await aliases.reserveMove(scope,b.input,providerScope,binding,guard);const after={kind:'imap_smtp' as const,mailbox:'Private Work',uidvalidity:'103',uid:555},key=emailImapLocatorKey(scope.account_id,after);
  const collisionProof={schema_version:'deft.email_imap_alias.v1',provider_scope:providerScope,account_id:scope.account_id,logical_message_id:id,conversation_id:a.source.conversation_id,base_locator:a.source.locator,current_locator:after,operation_id:a.plan.operation_id};await database.insert(schema.emailImapAliases).values({...scope,logical_message_id:id,locator_key:key,revision:1,evidence_envelope:cipher.seal(collisionProof,{...scope,kind:'operation',record_id:'imap-alias:'+key,revision:1})});
  await journal().change(providerScope,b.plan.operation_id,async(value,write)=>{value!.items[0]!.state='started';await write(value!);Object.assign(value!.items[0]!,{state:'succeeded',after:{locator:after,flags:[],modseq:'2'}});await write(value!);});
  await assert.rejects(aliases.reconcileMove(scope,b.plan.operation_id,providerScope,binding,guard),/COLLISION/);assert.deepEqual((await store().readMessage(scope,b.source.logical_message_id))!.provider_source.locator,b.source.locator);assert.equal((await pool.query('SELECT logical_message_id FROM email_imap_aliases WHERE locator_key=$1',[key])).rows[0].logical_message_id,id);
  const c=await planFor(6);let guards=0;await assert.rejects(aliases.reserveMove(scope,c.input,providerScope,binding,async tx=>{await guard(tx);if(++guards===2)throw Error('LATE_REVOKE');}),/LATE_REVOKE/);assert.equal((await pool.query('SELECT count(*) FROM email_imap_move_reservations WHERE logical_message_id=$1',[c.source.logical_message_id])).rows[0].count,'0');
  await committed([],[c.source.logical_message_id]);assert.ok(await store().readMessage(scope,c.source.logical_message_id));await committed([],[c.source.logical_message_id],{[c.source.logical_message_id]:emailImapSourceDigest(c.source)});assert.equal(await store().readMessage(scope,c.source.logical_message_id),null);
  revoked=true;await assert.rejects(aliases.lookup(scope,source.locator,guard),/REVOKED/);revoked=false;
 });
});
