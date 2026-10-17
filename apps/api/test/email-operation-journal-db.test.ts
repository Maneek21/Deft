import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {canonicalCapabilityJson} from '@deft/shared';
import {emailAccounts,emailOperations} from '@deft/db/schema';
import {and,eq} from 'drizzle-orm';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailOperationJournal} from '../src/lib/email-operation-journal.js';
import type {NativeEmailTriagePlan} from '../src/lib/email-native-adapter-contract.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('native operation journal commits reservations before effects, fences leases and preserves uncertain outcomes',{skip:!safe,timeout:30000},async t=>{
 const namespace='email_journal_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:target});
 await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:6});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE email_accounts (LIKE public.email_accounts INCLUDING ALL)');
 await pool.query(readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.67-email-native-operations.sql',import.meta.url),'utf8'));
 const database=drizzle(pool,{schema:{emailAccounts,emailOperations}}),scope={org_id:'org',owner_user_id:'owner',account_id:'account'};
 const providerScope={org_id:'org',owner_id:'owner',installation_id:'installation'};
 await database.insert(emailAccounts).values({...scope,provider:'gmail',resource_binding_id:'binding',principal_digest:'a'.repeat(64),state:'active',consented_at:new Date()});
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'test-key',key:Buffer.alloc(32,61)}),read:(_purpose,key_id)=>({key_id,key:Buffer.alloc(32,61)}),keyIds:()=>['test-key']});
 let clock=100000,guards=0,denyAt=Infinity;
 const guard=async(tx:unknown)=>{if(++guards===denyAt)throw Error('REVOKED');const [row]=await (tx as typeof database).select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).for('share');assert.equal(row?.state,'active');};
 const make=()=>new PostgresEmailOperationJournal(database as never,cipher,scope,providerScope,guard,()=>clock);
 const plan=()=>{const unsigned={schema_version:'deft.email_triage_plan.v1' as const,operation_id:randomUUID(),binding:{scope:providerScope,account:{account_id:scope.account_id},action_binding_id:'modify',operations:['mark_read']},operation:{kind:'mark_read'},items:[{logical_id:'mail_'+'a'.repeat(64),before:{seen:false}}],created_at:clock,expires_at:clock+900000};return {...unsigned,digest:createHash('sha256').update(canonicalCapabilityJson(unsigned)).digest('hex')} as NativeEmailTriagePlan;};
 const journal=make(),first=plan();await journal.create(first);
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const arrived=new Promise<void>(resolve=>{entered=resolve;});
 const active=journal.change(providerScope,first.operation_id,async(value,write)=>{assert.ok(value);value.items[0]!.state='started';await write(value);entered();await held;});
 await arrived;
 const reopened=make(),during=await reopened.load(providerScope,first.operation_id);assert.equal(during?.items[0]?.state,'started');
 await assert.rejects(reopened.change(providerScope,first.operation_id,()=>null),/EMAIL_TRIAGE_BUSY/);
 release();await active;
 assert.equal((await reopened.load(providerScope,first.operation_id))?.items[0]?.state,'started');
 await assert.rejects(reopened.change(providerScope,first.operation_id,async(value,write)=>{assert.ok(value);value.items[0]!.state='prepared';await write(value);}),/EMAIL_TRIAGE_OPERATION_CONFLICT/);
 await reopened.change(providerScope,first.operation_id,async(value,write)=>{assert.ok(value);value.items[0]!.state='unknown';await write(value);});
 const raw=await pool.query('SELECT content_envelope FROM email_operations WHERE operation_id=$1',[first.operation_id]);assert.equal(JSON.stringify(raw.rows).includes('logical_id'),false);
 await assert.rejects(journal.load({...providerScope,owner_id:'other'},first.operation_id),/EMAIL_TRIAGE_JOURNAL_UNAVAILABLE/);
 const second=plan();denyAt=guards+2;await assert.rejects(journal.create(second),/REVOKED/);denyAt=Infinity;assert.equal(await journal.load(providerScope,second.operation_id),null);
 // A stale holder cannot write after another process claims the expired lease.
 const third=plan();await journal.create(third);let releaseOld!:()=>void,enterOld!:()=>void;
 const oldHeld=new Promise<void>(resolve=>{releaseOld=resolve;}),oldEntered=new Promise<void>(resolve=>{enterOld=resolve;});
 const old=journal.change(providerScope,third.operation_id,async(value,write)=>{assert.ok(value);value.items[0]!.state='started';await write(value);enterOld();await oldHeld;value.items[0]!.state='succeeded';await write(value);});
 await oldEntered;clock+=120001;
 await reopened.change(providerScope,third.operation_id,async(value,write)=>{assert.ok(value);assert.equal(value.items[0]!.state,'started');value.items[0]!.state='unknown';await write(value);});
 releaseOld();await assert.rejects(old,/EMAIL_TRIAGE_JOURNAL_CONFLICT/);
 assert.equal((await reopened.load(providerScope,third.operation_id))?.items[0]?.state,'unknown');
 // Exercise the real native bridge and Gmail triage transport against this
 // PostgreSQL journal. Provider HTTP is synthetic; persistence is real.
 const bridgePath=new URL('../../../examples/apps/email/providers/native-triage.mjs',import.meta.url).href;
 const indexPath=new URL('../../../examples/apps/email/logical-mail-index.mjs',import.meta.url).href;
 const browserPath=new URL('../../../examples/apps/email/providers/provider-browser.mjs',import.meta.url).href;
 const [{createNativeEmailTriageBridge},{LogicalMailIndex},{providerSourceForParent}]=await Promise.all([import(bridgePath),import(indexPath),import(browserPath)]);
 const account={account_id:scope.account_id,provider:'gmail',connection_target:'target',resource_binding_id:'binding',action_binding_id:'modify',
  authority_epoch:1,health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',display_label:'Synthetic owner',verified_sender_identities:[]};
 const parent=new LogicalMailIndex(providerScope).upsert(providerScope,{account_id:scope.account_id,provider:'gmail',locator:{kind:'gmail',message_id:'synthetic-message',thread_id:'synthetic-thread',label_ids:['INBOX','UNREAD']}});
 const source=providerSourceForParent(account,parent);
 let labels=['INBOX','UNREAD'],writes=0,loseResponse=false,activeOperation='';
 const providerFetch=async(href:string,init:RequestInit)=>{
  assert.equal(new URL(href).origin,'https://gmail.googleapis.com');
  if(init.method!=='GET'){
   assert.equal((await make().load(providerScope,activeOperation))?.items[0]?.state,'started','An independent connection sees committed reservation before provider write');
   writes++;const body=JSON.parse(String(init.body));labels=[...new Set([...labels.filter(label=>!(body.removeLabelIds??[]).includes(label)),...(body.addLabelIds??[])])].sort();
   if(loseResponse)throw Error('Synthetic response loss after provider effect');
  }
  return new Response(JSON.stringify({id:'synthetic-message',threadId:'synthetic-thread',labelIds:labels}),{headers:{'content-type':'application/json'}});
 };
 const native=()=>createNativeEmailTriageBridge({now:()=>clock,runtime:async()=>({account,scope:providerScope,check:async()=>{},adapterOptions:{fetch:providerFetch},
  getModifyCredential:async()=>({token:'synthetic-fixture-token',granted_scopes:['https://www.googleapis.com/auth/gmail.modify']})})});
 const context=()=>({expires_at:clock+60000,triage_journal:make(),triage_before_reserve:async()=>{}});
 activeOperation=randomUUID();const request={mode:'apply',operation_id:activeOperation,operation:{kind:'mark_read'},sources:[source]};
 const receipt=await native().nativeEmailTriage(request,context());assert.equal(receipt.items[0].state,'succeeded');assert.equal(writes,1);assert.equal(labels.includes('UNREAD'),false);
 assert.deepEqual(await native().nativeEmailTriage(request,context()),receipt);assert.equal(writes,1,'Reopened durable receipt never writes twice');
 const originalOperation=activeOperation;activeOperation=randomUUID();
 const undo=await native().nativeEmailTriage({mode:'undo',operation_id:originalOperation,undo_operation_id:activeOperation},context());
 assert.equal(undo.items[0].state,'succeeded');assert.equal(labels.includes('UNREAD'),true);assert.equal(writes,2);
 activeOperation=randomUUID();loseResponse=true;const uncertain={...request,operation_id:activeOperation};
 const unknown=await native().nativeEmailTriage(uncertain,context());assert.equal(unknown.items[0].state,'unknown');assert.equal(writes,3);
 loseResponse=false;assert.equal((await native().nativeEmailTriage(uncertain,context())).items[0].state,'unknown');assert.equal(writes,3,'Unknown outcome blocks replay after fresh service/journal instances');
});
