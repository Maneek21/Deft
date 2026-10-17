import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {RegisteredEmailMailboxProvider} from '../src/lib/email-mailbox-provider.js';
import {EmailMailboxSearchService} from '../src/lib/email-mailbox-search.js';
import {EmailMailboxConversationService} from '../src/lib/email-mailbox-conversation.js';
import type {EmailAuthority,EmailMessageRecord,EmailScope} from '../src/lib/email-mailbox-service.js';
async function fixture(){
 const {fixture}=await import(new URL('../../../examples/apps/email/providers/native-imap-query-fixture.mjs',import.meta.url).href),f=await fixture(),scope:EmailScope={org_id:f.account.org_id,owner_user_id:f.account.owner_user_id,account_id:f.account.account_id};
 const actor={user_id:scope.owner_user_id,web_session_id:'real-synthetic-owner-session',access_expires_at:Date.now()+600000},cached=new Map<string,EmailMessageRecord>();let allowed=true,version='v1',persists=0;
 const authority:EmailAuthority={async current(a,s,operation){assert.equal(operation,'human_read');if(!allowed||a.user_id!==scope.owner_user_id||JSON.stringify(s)!==JSON.stringify(scope))throw Error('DENIED');return {scope,resource_binding_id:f.account.resource_binding_id,authority_version:version,expires_at:actor.access_expires_at};}};
 const provider=new RegisteredEmailMailboxProvider(async(s,cap,recheck,signal)=>({adapter:f.adapter,context:{...f.context,authority_version:cap.authority_version,signal,recheck}}));
 const store={async persistSearchResults(s:EmailScope,records:readonly EmailMessageRecord[],guard:(tx:unknown)=>Promise<void>){assert.deepEqual(s,scope);await guard({synthetic_transaction:true});persists++;for(const row of records)cached.set(row.logical_message_id,structuredClone(row));return {records:structuredClone(records),dropped:0};},async readMessage(s:EmailScope,id:string){assert.deepEqual(s,scope);return structuredClone(cached.get(id)??null);}};
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'imap-query-key',key:Buffer.alloc(32,69)}),read:(_purpose,key_id)=>key_id==='imap-query-key'?{key_id,key:Buffer.alloc(32,69)}:null,keyIds:()=>['imap-query-key']});
 const makeSearch=()=>new EmailMailboxSearchService(authority,store,provider,cipher),makeConversation=()=>new EmailMailboxConversationService(authority,store,provider,cipher);
 const logical=(mailbox:string,validity:string,uid:number)=>'mail_'+createHash('sha256').update(JSON.stringify([f.scope,scope.account_id,JSON.stringify([scope.account_id,'imap_smtp',[mailbox,validity,uid]])])).digest('hex');
 return {f,scope,actor,cached,provider,makeSearch,makeConversation,logical,get persists(){return persists;},deny(){allowed=false;},changeVersion(){version='v2';}};
}
test('public IMAP search persists three independent expected pages, encrypts cursors and exposes no private mailbox selectors',async()=>{
 const x=await fixture(),query='subject:"café exact phrase" -from:excluded@example.test',ids:string[]=[];let cursor:string|null=null,result;
 for(let i=0;i<20;i++){result=await x.makeSearch().search(x.actor,x.scope,{query,limit:1,cursor});ids.push(...result.items.map(row=>row.logical_message_id));cursor=result.next_cursor;x.f.adapter=x.f.restart();assert.equal(result.exact_total,null);assert.equal(result.source,'provider');assert.ok(result.items.every(row=>!Object.hasOwn(row,'provider_source')));if(!cursor)break;assert.equal(cursor.includes('INBOX'),false);}
 assert.deepEqual(ids,[x.logical('INBOX','7',20001),x.logical('INBOX','7',1),x.logical('Projects','9',1)]);assert.equal(result!.query_complete,true);assert.equal(result!.complete,true);assert.equal(x.cached.size,3);assert.equal(x.persists,3);
 const before=x.f.calls.connections,unsupported=await x.makeSearch().search(x.actor,x.scope,{query:'after:2026-10-01',limit:1,cursor:null});assert.equal(unsupported.query,'after:2026-10-01');assert.equal(unsupported.complete,false);assert.ok(unsupported.unsupported.length);assert.equal(x.f.calls.connections,before);
});
test('public IMAP related messages persist distinct identities outside Inbox and always return explicit partial header basis',async()=>{
 const x=await fixture();x.f.anchorRow.headers=Buffer.from('Message-ID: <message-1@example.test>\r\nReferences: <parent@example.test>\r\n\r\n');
 await x.makeSearch().search(x.actor,x.scope,{query:'larger:1',limit:100,cursor:null});const anchor=x.logical('INBOX','7',1),ids:string[]=[];let cursor:string|null=null,result;
 for(let i=0;i<20;i++){result=await x.makeConversation().read(x.actor,x.scope,{logical_message_id:anchor,limit:1,cursor});ids.push(...result.items.map(row=>row.logical_message_id));cursor=result.next_cursor;x.f.adapter=x.f.restart();assert.equal(result.complete,false);assert.equal(result.coverage,'partial');assert.equal(result.thread_basis,'message_headers');assert.ok(result.limitations?.includes('not_provider_thread'));assert.equal(result.count.exact_total,null);assert.ok(result.items.every(row=>!Object.hasOwn(row,'provider_source')));if(!cursor)break;assert.equal(cursor.includes('INBOX'),false);}
 assert.deepEqual(ids,[anchor,x.logical('Localized Sent','8',2),x.logical('Localized Sent','8',1),x.logical('Projects','9',2)]);assert.equal(result!.has_more,false);assert.equal(new Set(ids.map(id=>x.cached.get(id)!.provider_source.conversation_id)).size,4);
});
test('held IMAP revocation, foreign scope and source epoch reset cannot disclose or persist a page',async()=>{
 const x=await fixture(),first=await x.makeSearch().search(x.actor,x.scope,{query:'café',limit:1,cursor:null});assert.ok(first.next_cursor);await assert.rejects(x.makeSearch().search(x.actor,{...x.scope,account_id:'foreign'},{query:'café',limit:1,cursor:first.next_cursor}),/ACCESS_DENIED/);
 x.changeVersion();await assert.rejects(x.makeSearch().search(x.actor,x.scope,{query:'café',limit:1,cursor:first.next_cursor}),/CURSOR_INVALID/);
 const held=await fixture();let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);held.f.afterSearch=async()=>{entered();await wait;};const pending=held.makeSearch().search(held.actor,held.scope,{query:'café',limit:1,cursor:null});await ready;held.deny();release();await assert.rejects(pending);assert.equal(held.persists,0);assert.equal(held.cached.size,0);
 const changed=await fixture();await changed.makeSearch().search(changed.actor,changed.scope,{query:'larger:1',limit:100,cursor:null});const anchor=changed.logical('INBOX','7',1),page=await changed.makeConversation().read(changed.actor,changed.scope,{logical_message_id:anchor,limit:1,cursor:null});assert.ok(page.next_cursor);const row=changed.cached.get(anchor)!;row.provider_source.locator={kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'99',uid:1};await assert.rejects(changed.makeConversation().read(changed.actor,changed.scope,{logical_message_id:anchor,limit:1,cursor:page.next_cursor}),/CURSOR_INVALID/);
});

test('earlier short IMAP FETCH remains partial after later successful final page and service restart',async()=>{
 const x=await fixture();x.f.omit();let cursor:string|null=null,result;for(let i=0;i<20;i++){result=await x.makeSearch().search(x.actor,x.scope,{query:'café',limit:1,cursor});cursor=result.next_cursor;if(!cursor)break;}
 assert.equal(result!.complete,false);assert.equal(result!.coverage,'partial');assert.equal(result!.query_complete,false);assert.equal(result!.failure_count,1);assert.equal(result!.next_cursor,null);
});
