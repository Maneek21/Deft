import test from 'node:test';
import assert from 'node:assert/strict';
import {EmailMailboxConversationService} from '../src/lib/email-mailbox-conversation.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import type {EmailCapability,EmailMessageRecord,EmailScope} from '../src/lib/email-mailbox-service.js';
const scope:EmailScope={org_id:'org',owner_user_id:'owner',account_id:'account'};
const actor={user_id:'owner',web_session_id:'session',access_expires_at:2_000_000_000_000};
const id=(hex:string)=>'mail_'+hex.repeat(64);
const record=(hex:string,folder='inbox'):EmailMessageRecord=>({account_id:'account',logical_message_id:id(hex),revision:'r1',received_at:'2026-10-04T12:00:00.000Z',folders:[folder],
 flags:{seen:false,flagged:false,answered:false},data:{subject:'Fixture'},provider_source:{schema_version:'deft.email_provider_source.v1',account_id:'account',logical_message_id:id(hex),provider:'gmail',authority_epoch:1,conversation_id:'thread',locator:{kind:'gmail',message_id:hex,thread_id:'thread',label_ids:['INBOX']}}});
const crypto=()=>new EmailMailboxCrypto({current:()=>({key_id:'key',key:Buffer.alloc(32,42)}),read:(_purpose,key)=>key==='key'?{key_id:key,key:Buffer.alloc(32,42)}:null,keyIds:()=>['key']});
function fixture(){
 let version='v1',allowed=true,now=Date.parse('2026-10-04T12:00:00Z'),hold:()=>Promise<void>=async()=>{},drop=false,failures=0,reads=0,persists=0;
 let anchor=record('a');const inputs:any[]=[];
 const authority={async current(_actor:unknown,selected:EmailScope,operation:string,tx?:unknown):Promise<EmailCapability>{assert.equal(operation,'human_read');if(!allowed)throw Error('revoked');return {scope:selected,resource_binding_id:'binding',authority_version:version,expires_at:actor.access_expires_at};}};
 const store={async readMessage(selected:EmailScope,logical:string){reads++;return logical===id('a')?{...structuredClone(anchor),account_id:selected.account_id,provider_source:{...structuredClone(anchor.provider_source),account_id:selected.account_id}}:null;},
 async persistSearchResults(_scope:EmailScope,records:readonly EmailMessageRecord[],guard:(tx:unknown)=>Promise<void>){persists++;await guard({transaction:true});return {records:drop?[]:records.map(row=>({...row,revision:'persisted',flags:{...row.flags,seen:true}})),dropped:drop?records.length:0};}};
 const provider={async readConversation(_scope:EmailScope,input:any,_cap:EmailCapability,recheck:()=>Promise<void>){inputs.push(input);await hold();await recheck();const page=input.cursor===null?0:input.cursor==='provider-secret-1'?1:2;
  const rows=[record('a'),record('b','sent'),record('c','archive')];return {schema_version:'deft.email_conversation_page.v1' as const,account_id:'account',provider:'gmail' as const,anchor_logical_message_id:id('a'),items:[rows[page]!],next_cursor:page===2?null:'provider-secret-'+(page+1),has_more:page!==2,complete:page===2,observed_at:'2026-10-04T12:00:00.000Z',failure_count:page===0?failures:0};}};
 return {service:new EmailMailboxConversationService(authority,store,provider,crypto(),()=>now),inputs,get persists(){return persists;},get reads(){return reads;},
  set hold(value:()=>Promise<void>){hold=value;},deny(){allowed=false;},changeVersion(){version='v2';},advance(ms:number){now+=ms;},changeSource(){anchor.provider_source.locator={kind:'gmail',message_id:'a',thread_id:'another'};},changeFlags(){anchor={...anchor,revision:'updated',folders:['archive'],flags:{seen:true,flagged:true,answered:false}};},drop(){drop=true;},fail(){failures=1;}};
}
const input=(cursor:string|null=null)=>({logical_message_id:id('a'),cursor,limit:1});
test('public conversation persists three provider pages and returns stable logical IDs outside Inbox without private source',async()=>{
 const f=fixture(),items=[];let cursor:string|null=null;for(let n=0;n<3;n++){const result=await f.service.read(actor,scope,input(cursor));items.push(...result.items);cursor=result.next_cursor;
  assert.equal(result.complete,n===2);assert.equal(result.count.exact_total,null);assert.equal(result.consistency,'weak');assert.equal(result.source,'provider');}
 assert.deepEqual(items.map(row=>row.logical_message_id),[id('a'),id('b'),id('c')]);assert.deepEqual(items.map(row=>row.folders),[['inbox'],['sent'],['archive']]);
 assert.ok(items.every(row=>row.revision==='persisted'&&row.flags.seen&&!Object.hasOwn(row,'provider_source')));assert.equal(f.persists,3);assert.equal(cursor,null);
 assert.deepEqual(f.inputs.map(row=>row.cursor),[null,'provider-secret-1','provider-secret-2']);
});
test('encrypted cursor binds owner/account/anchor/limit/authority and expiration, while metadata updates preserve traversal',async()=>{
 const f=fixture(),first=await f.service.read(actor,scope,input());assert.ok(first.next_cursor);assert.equal(first.next_cursor.includes('provider-secret'),false);f.changeFlags();
 await f.service.read(actor,scope,input(first.next_cursor));
 await assert.rejects(f.service.read(actor,{...scope,account_id:'other'},input(first.next_cursor)),/CURSOR_INVALID/);
 await assert.rejects(f.service.read(actor,scope,{...input(first.next_cursor),limit:2}),/CURSOR_INVALID/);
 f.changeSource();await assert.rejects(f.service.read(actor,scope,input(first.next_cursor)),/CURSOR_INVALID/);
 const other=fixture(),token=(await other.service.read(actor,scope,input())).next_cursor;other.changeVersion();await assert.rejects(other.service.read(actor,scope,input(token)),/CURSOR_INVALID/);
 const expired=fixture(),old=(await expired.service.read(actor,scope,input())).next_cursor;expired.advance(16*60_000);await assert.rejects(expired.service.read(actor,scope,input(old)),/CURSOR_INVALID/);
 await assert.rejects(f.service.read({...actor,user_id:'another'},scope,input()),/ACCESS_DENIED/);
 await assert.rejects(f.service.read(actor,scope,{...input(),conversation_id:'browser-id'} as any));
});
test('earlier dropped/failed page never becomes complete on final provider page',async()=>{
 for(const kind of ['drop','failure']){const f=fixture();kind==='drop'?f.drop():f.fail();let cursor:string|null=null;let result;
  for(let n=0;n<3;n++){result=await f.service.read(actor,scope,input(cursor));cursor=result.next_cursor;}
  assert.equal(result!.complete,false);assert.equal(result!.coverage,'partial');assert.ok(result!.failure_count>0);assert.equal(result!.count.exact_total,null);}
});
test('held revocation and changed cached source reject before persistence; missing anchors do no provider I/O',async()=>{
 for(const kind of ['revoke','source']){const f=fixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{entered=resolve;});
  f.hold=async()=>{entered();await held;};const pending=f.service.read(actor,scope,input());await ready;kind==='revoke'?f.deny():f.changeSource();release();await assert.rejects(pending,kind==='revoke'?/ACCESS_DENIED/:/SOURCE_CHANGED/);assert.equal(f.persists,0);}
 const f=fixture();await assert.rejects(f.service.read(actor,scope,{...input(),logical_message_id:id('d')}),/MESSAGE_NOT_FOUND/);assert.equal(f.inputs.length,0);
});
