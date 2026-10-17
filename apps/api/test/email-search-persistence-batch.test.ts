import assert from 'node:assert/strict';
import test from 'node:test';
import {drizzle} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import type {EmailMessageRecord} from '../src/lib/email-mailbox-service.js';
const scope={org_id:'org-batch',owner_user_id:'owner-batch',account_id:'account-batch'},schema={emailAccounts,emailCheckpoints,emailMessages,emailMemberships,emailProviderStates,emailSyncReceipts};
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');
const record=(n:number,revision='provider-1'):EmailMessageRecord=>({account_id:scope.account_id,logical_message_id:logical(n),revision,received_at:'2026-10-07T12:00:00.000Z',folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Private synthetic subject'},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,logical_message_id:logical(n),provider:'gmail',locator:{kind:'gmail',message_id:'synthetic-'+n,thread_id:'synthetic-thread'}}});
function harness(options:{existing?:string[];readback?:EmailMessageRecord[];added?:string[];normalize?: (items:readonly EmailMessageRecord[])=>EmailMessageRecord[]}={}){
 const statements:Array<{sql:string;values:unknown[]}>=[],guards:unknown[]=[];
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'synthetic',key:Buffer.alloc(32,24)}),read:()=>({key_id:'synthetic',key:Buffer.alloc(32,24)}),keyIds:()=>['synthetic']});
 let seals=0;
 const crypto={seal:(...args:Parameters<EmailMailboxCrypto['seal']>)=>{seals++;return cipher.seal(...args);},open:cipher.open.bind(cipher)};
 const checkpoint={...scope,revision:7,coverage:'complete',cursor_envelope:null,observed_at:null,fresh_until:null,sync_state:'idle'};
 const messages=(options.readback??[]).map(row=>({...scope,logical_message_id:row.logical_message_id,revision:row.revision,storage_revision:7,received_at:new Date(row.received_at!),sort_at:new Date(row.received_at!),...row.flags,deleted_at:null,summary_envelope:cipher.seal(row.data,{...scope,kind:'summary',record_id:row.logical_message_id,revision:7}),source_envelope:cipher.seal(row.provider_source,{...scope,kind:'provider_source',record_id:row.logical_message_id,revision:7})}));
 const memberships=(options.readback??[]).flatMap(row=>row.folders.map(folder=>({...scope,logical_message_id:row.logical_message_id,folder})));
 const driver={async query(query:string|{text:string;rowMode?:string},values:unknown[]=[]){
  const sql=typeof query==='string'?query:query.text;statements.push({sql,values});
  if(/^select/.test(sql))for(const value of Object.values(scope))assert.ok(values.includes(value),'every select is scoped');
  let rows:Array<Record<string,unknown>>=[];
  if(/^select .*from "email_checkpoints"/.test(sql)){assert.match(sql,/for update$/);rows=[checkpoint];}
  else if(/^select "logical_message_id" from "email_messages"/.test(sql))rows=(options.existing??[]).map(logical_message_id=>({logical_message_id}));
  else if(/^select .*from "email_messages"/.test(sql))rows=messages;
  else if(/^select .*from "email_memberships"/.test(sql))rows=memberships;
  else if(/^insert into "email_messages"/.test(sql))return {rows:(options.added??[]).map(id=>[id]),rowCount:options.added?.length??0};
  const selected=sql.slice(0,sql.toLowerCase().indexOf(' from ')),fields=[...selected.matchAll(/(?:"[^"]+"\.)?"([^"]+)"/g)].map(match=>match[1]!);
  return {rows:typeof query!=='string'&&query.rowMode==='array'?rows.map(row=>fields.map(field=>{const value=row[field];return value instanceof Date?value.toISOString():value;})):rows,rowCount:rows.length};
 }};
 const identities=options.normalize?{normalizeRecords:async(_tx:unknown,_scope:unknown,items:readonly EmailMessageRecord[])=>options.normalize!(items),filterTombstones:async()=>[]}:undefined;
 const store=new PostgresEmailMailboxStore(drizzle(driver as never,{schema}),crypto as never,{identities});
 return {store,statements,guards,guard:async(tx:unknown)=>{guards.push(tx);},get seals(){return seals;}};
}

test('50 cached search hits skip every insert/encryption and retain newer canonical data under both guards',async()=>{
 const cached=Array.from({length:50},(_,n)=>({...record(n+1,'cache-newer'),flags:{seen:true,flagged:true,answered:true}})),h=harness({existing:cached.map(row=>row.logical_message_id),readback:cached});
 const result=await h.store.persistSearchResults(scope,cached.map((_,n)=>record(n+1)),h.guard);
 assert.deepEqual(result.records,cached);assert.equal(result.dropped,0);
 assert.equal(h.statements.filter(row=>/^insert into "email_messages"/.test(row.sql)).length,0);
 assert.equal(h.seals,0);assert.equal(h.guards.length,2);assert.equal(h.guards[0],h.guards[1]);
 assert.equal(h.statements.length,7);assert.equal(h.statements.at(-1)?.sql,'commit');
});

test('missing records use one encrypted insert and one membership batch; only successfully inserted IDs get memberships',async()=>{
 const first={...record(1),folders:['inbox','archive','inbox']},raced={...record(2,'cache-raced'),flags:{seen:true,flagged:false,answered:false}},h=harness({readback:[{...first,folders:['archive','inbox']},raced],added:[logical(1)]});
 const result=await h.store.persistSearchResults(scope,[first,record(2)],h.guard);
 const inserts=h.statements.filter(row=>/^insert into "email_messages"/.test(row.sql));assert.equal(inserts.length,1);assert.match(inserts[0]!.sql,/on conflict do nothing returning/);
 const membership=h.statements.filter(row=>/^insert into "email_memberships"/.test(row.sql));assert.equal(membership.length,1);
 assert.ok(membership[0]!.values.includes(logical(1)));assert.ok(!membership[0]!.values.includes(logical(2)));
 assert.equal(membership[0]!.values.filter(value=>value===logical(1)).length,2,'folder duplicates are eliminated');
 assert.equal(JSON.stringify(inserts[0]!.values).includes('Private synthetic subject'),false);
 assert.equal(result.records[1]!.revision,'cache-raced');assert.equal(result.records[1]!.flags.seen,true);
 assert.equal(h.statements.filter(row=>/^update "email_checkpoints"/.test(row.sql)).length,1);
});

test('tombstones count as existing identities and are never reinserted; alias-normalized identities are used',async()=>{
 const canonical=record(1),h=harness({existing:[logical(1),logical(2)],readback:[canonical],normalize:items=>items.map(row=>row.logical_message_id===logical(3)?canonical:row)});
 const result=await h.store.persistSearchResults(scope,[record(3),record(2)],h.guard);
 assert.deepEqual(result.records,[canonical]);assert.equal(result.dropped,1);
 assert.equal(h.statements.filter(row=>/^insert into "email_messages"/.test(row.sql)).length,0);
 const preRead=h.statements.find(row=>/^select "logical_message_id" from "email_messages"/.test(row.sql))!;
 assert.ok(!preRead.sql.includes('deleted_at'),'existence includes tombstones');assert.ok(preRead.values.includes(logical(1)));assert.ok(preRead.values.includes(logical(2)));assert.ok(!preRead.values.includes(logical(3)));
});

test('a race inserting all missing identities leaves coverage and memberships unchanged',async()=>{
 const h=harness({readback:[record(1,'race-newer')]});const result=await h.store.persistSearchResults(scope,[record(1)],h.guard);
 assert.equal(result.records[0]!.revision,'race-newer');assert.equal(h.statements.filter(row=>/^insert into "email_memberships"|^update "email_checkpoints"/.test(row.sql)).length,0);
});

test('empty input retains both transaction guards and duplicate/foreign account input fails before SQL',async()=>{
 const h=harness();assert.deepEqual(await h.store.persistSearchResults(scope,[],h.guard),{records:[],dropped:0});assert.equal(h.guards.length,2);
 assert.equal(h.statements.filter(row=>/email_messages|email_memberships/.test(row.sql)).length,0);
 const before=h.statements.length;await assert.rejects(h.store.persistSearchResults(scope,[record(1),record(1)],h.guard),/EMAIL_PAGE_INVALID/);
 await assert.rejects(h.store.persistSearchResults(scope,[{...record(1),account_id:'foreign'}],h.guard),/EMAIL_PAGE_INVALID/);assert.equal(h.statements.length,before);
});

test('late authority denial rolls back a partially inserted batch and checkpoint coverage',async()=>{
 const h=harness({readback:[record(1)],added:[logical(1)]});let calls=0;
 await assert.rejects(h.store.persistSearchResults(scope,[record(1)],async tx=>{await h.guard(tx);if(++calls===2)throw Error('late revoked');}),/late revoked/);
 assert.equal(h.statements.at(-1)?.sql,'rollback');assert.equal(h.statements.some(row=>row.sql==='commit'),false);assert.equal(h.guards[0],h.guards[1]);
});
