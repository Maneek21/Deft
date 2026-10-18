import test from 'node:test';
import assert from 'node:assert/strict';
import {compileEmailQuery} from '../email-query-language.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{searchCompiler}=require(require.resolve('imapflow').replace(/imap-flow\.js$/u,'search-compiler.js'));
import {fixture} from './native-imap-query-fixture.mjs';
test('registered IMAP search traverses all selectable folders and restarts cursor without skipped UID leftovers',async()=>{
 const f=await fixture(),hits=[];let cursor=null,result;for(let i=0;i<30;i++){result=await f.adapter.nativeEmailSearch({query:'subject:"café exact phrase" -from:excluded@example.test',cursor,limit:1},f.context);hits.push(...result.items);cursor=result.next_cursor;f.adapter=f.restart();if(!result.has_more)break;}
 assert.equal(result.has_more,false);assert.equal(result.query_complete,true);assert.equal(result.provider_result_cap,null);assert.equal(result.original_query,'subject:"café exact phrase" -from:excluded@example.test');assert.deepEqual(hits.map(row=>[row.provider_source.locator.mailbox,row.provider_source.locator.uid]),[['INBOX',20001],['INBOX',1],['Projects',1]]);assert.equal(new Set(hits.map(row=>row.logical_message_id)).size,3);assert.ok(hits.some(row=>row.folders[0].startsWith('folder:')));assert.equal(f.calls.cleanup,f.calls.connections);assert.equal(f.calls.released,f.calls.locks.length);
});
test('Unicode phrase/exclusion/flags/size uses actual ImapFlow compiler and unsupported semantics never connect',async()=>{
 const f=await fixture(),query='"résumé" -from:excluded@example.test is:starred larger:500 smaller:2K',compiled=compileEmailQuery('imap_smtp',query),tokens=searchCompiler(f.client,{...compiled.request.search,uid:'1:4096'});
 assert.ok(tokens.some(token=>token.value==='CHARSET'));assert.ok(tokens.some(token=>token.value==='UID'));assert.ok(tokens.some(token=>token.value==='NOT'));
 const page=await f.adapter.nativeEmailSearch({query,cursor:null,limit:100},f.context);assert.deepEqual(page.items.map(row=>row.provider_source.locator.uid),[20001]);
 const before=f.calls.connections;for(const query of ['after:2026-10-01','has:attachment','unknown:term','alice OR bob']){const unsupported=await f.adapter.nativeEmailSearch({query,cursor:null,limit:1},f.context);assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.original_query,query);assert.deepEqual(unsupported.items,[]);assert.equal(unsupported.query_complete,false);}assert.equal(f.calls.connections,before);
 await assert.rejects(f.adapter.nativeEmailSearch({query:'subject:"unterminated',cursor:null,limit:1},f.context));assert.equal(f.calls.connections,before);
});
test('search cursor binds query/account/catalog/current UIDVALIDITY and held revocation clears disclosure',async()=>{
 const f=await fixture(),page=await f.adapter.nativeEmailSearch({query:'café',cursor:null,limit:1},f.context);assert.ok(page.next_cursor);
 await assert.rejects(f.adapter.nativeEmailSearch({query:'other',cursor:page.next_cursor,limit:1},f.context),/CURSOR_INVALID/);await assert.rejects(f.adapter.nativeEmailSearch({query:'café',cursor:page.next_cursor,limit:1},{...f.context,account_id:'foreign'}));
 f.boxes.get('INBOX').validity='99';await assert.rejects(f.adapter.nativeEmailSearch({query:'café',cursor:page.next_cursor,limit:1},f.context),/QUERY_RESET/);
 const revoked=await fixture();revoked.afterSearch=async()=>revoked.deny();await assert.rejects(revoked.adapter.nativeEmailSearch({query:'café',cursor:null,limit:1},revoked.context));assert.equal(revoked.calls.fetch.length,0);assert.equal(revoked.calls.cleanup,1);
 const changed=await fixture(),first=await changed.adapter.nativeEmailSearch({query:'café',cursor:null,limit:1},changed.context);changed.boxes.delete('Projects');await assert.rejects(changed.adapter.nativeEmailSearch({query:'café',cursor:first.next_cursor,limit:1},changed.context),/QUERY_RESET/);
});
test('header relationships include Sent and other folders, never same Subject/UID or a full/provider-thread claim',async()=>{
 const f=await fixture();f.anchorRow.headers=Buffer.from('Message-ID: <message-1@example.test>\r\nReferences: <parent@example.test>\r\n\r\n');const hits=[];let cursor=null,page;
 for(let i=0;i<30;i++){page=await f.adapter.nativeEmailConversation({source:f.source,cursor,limit:1},f.context);assert.equal(page.complete,false);assert.equal(page.thread_basis,'message_headers');assert.ok(page.limitations.includes('not_provider_thread'));hits.push(...page.items);cursor=page.next_cursor;f.adapter=f.restart();if(!page.has_more)break;}
 assert.equal(page.has_more,false);assert.deepEqual(hits.map(row=>[row.provider_source.locator.mailbox,row.provider_source.locator.uid]),[['INBOX',1],['Localized Sent',2],['Localized Sent',1],['Projects',2]]);assert.ok(hits.some(row=>row.folders.includes('sent')));assert.equal(new Set(hits.map(row=>row.provider_source.conversation_id)).size,4);assert.equal(new Set(hits.map(row=>row.logical_message_id)).size,4);assert.equal(f.calls.cleanup,f.calls.connections);
 const bad=await fixture();await assert.rejects(bad.adapter.nativeEmailConversation({source:{...bad.source,locator:{...bad.source.locator,uidvalidity:'99'}},cursor:null,limit:10},bad.context));assert.equal(bad.calls.fetch.length,0);
});
test('partial FETCH cannot prove search completion and anchor/header changes invalidate related traversal',async()=>{
 const f=await fixture();f.omit();const page=await f.adapter.nativeEmailSearch({query:'café',cursor:null,limit:100},f.context);assert.ok(page.failure_count>0);assert.equal(page.query_complete,false);
 const related=await fixture(),first=await related.adapter.nativeEmailConversation({source:related.source,cursor:null,limit:1},related.context);related.anchorRow.headers=Buffer.from('Message-ID: <changed@example.test>\r\n\r\n');await assert.rejects(related.adapter.nativeEmailConversation({source:related.source,cursor:first.next_cursor,limit:1},related.context),/CURSOR_INVALID/);
});

test('M22 actual registered IMAP scopes discover localized special-use folders and never fall back absent roles',async()=>{
 const compiled=compileEmailQuery('imap_smtp','in:drafts');assert.ok(searchCompiler({capabilities:new Map(),enabled:new Set(),mailbox:{}},{...compiled.request.search,uid:'1:4096'}).some(token=>token.value==='ALL'));
 for(const [role,path,special]of [['inbox','INBOX',null],['sent','Localized Sent','\\Sent'],['drafts','Localized Drafts','\\Drafts'],['spam','Localized Junk','\\Junk'],['trash','Localized Trash','\\Trash']]){
  const f=await fixture();if(!f.boxes.has(path))f.boxes.set(path,{...f.boxes.get('Projects'),specialUse:special});const query='in:'+role+' subject:"café exact phrase"',hits=[];let cursor=null,page;
  do{page=await f.adapter.nativeEmailSearch({query,cursor,limit:1},f.context);assert.equal(page.status,'supported');assert.equal(page.original_query,query);hits.push(...page.items);cursor=page.next_cursor;f.adapter=f.restart();}while(page.has_more);
  assert.equal(page.query_complete,true);assert.ok(f.calls.locks.every(p=>p===path));assert.ok(hits.every(row=>row.provider_source.locator.mailbox===path));
  const only=await f.adapter.nativeEmailSearch({query:'in:'+role,cursor:null,limit:100},f.context);assert.equal(only.status,'supported');assert.ok(only.items.length>0);assert.ok(only.items.every(row=>row.provider_source.locator.mailbox===path));
 }
 const missing=await fixture(),v=await missing.adapter.nativeEmailSearch({query:'in:drafts',cursor:null,limit:100},missing.context);assert.equal(v.status,'unsupported');assert.equal(v.unsupported[0].reason,'folder_scope_unavailable');assert.equal(v.query_complete,false);assert.equal(v.items.length,0);assert.equal(missing.calls.locks.length,0);assert.equal(missing.calls.search.length,0);assert.equal(missing.calls.connections,1);
 const noselect=await fixture();const list=noselect.client.list;noselect.client.list=async()=>[...await list(),{path:'Unselectable Drafts',specialUse:'\\Drafts',flags:new Set(['\\Noselect'])}];assert.equal((await noselect.adapter.nativeEmailSearch({query:'in:drafts',cursor:null,limit:1},noselect.context)).status,'unsupported');assert.equal(noselect.calls.locks.length,0);
});
test('M22 scoped IMAP continuation retains full catalog/query validity and held final authority',async()=>{
 const f=await fixture(),query='in:inbox',a=await f.adapter.nativeEmailSearch({query,cursor:null,limit:1},f.context);assert.ok(a.next_cursor);await assert.rejects(f.adapter.nativeEmailSearch({query:'in:sent',cursor:a.next_cursor,limit:1},f.context),/CURSOR_INVALID/);
 f.boxes.delete('Projects');await assert.rejects(f.adapter.nativeEmailSearch({query,cursor:a.next_cursor,limit:1},f.context),/QUERY_RESET/);
 const held=await fixture();held.afterFetch=async()=>held.deny();await assert.rejects(held.adapter.nativeEmailSearch({query,cursor:null,limit:1},held.context));assert.equal(held.calls.cleanup,1);
 const unsupported=await fixture();for(const query of ['in:inbox in:sent','-in:trash','in:archive'])assert.equal((await unsupported.adapter.nativeEmailSearch({query,cursor:null,limit:1},unsupported.context)).status,'unsupported');assert.equal(unsupported.calls.connections,0);
});
