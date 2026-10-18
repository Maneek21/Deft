import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailAccountRuntime} from './account-runtime.mjs';
import {createGmailAdapter} from './gmail.mjs';
import {createMetadataResetReader} from './conversation-reset.mjs';
import {encodeCursor,decodeCursor,digest,PROVIDER_LIMITS} from './contract.mjs';
const scope={org_id:'org',owner_id:'owner',installation_id:'installation'};
const account={account_id:'first',provider:'gmail',display_label:'first',primary_address:'owner@example.test',verified_sender_identities:[],capabilities:['read','search','thread'],connection_target:'personal',resource_binding_id:'binding',action_binding_id:null,authority_epoch:2,health:'connected'};
const response=v=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
const message=id=>({id,threadId:'thread',labelIds:['INBOX'],internalDate:'1790762400000',payload:{headers:[]}});
function fixture(){let state=null,allowed=true,handler;const calls=[];const make=(changed={})=>createEmailAccountRuntime({scope:changed.scope??scope,accounts:[{...account,...changed.account}],authorize:async()=>allowed,custody:{getAccessToken:async()=>'synthetic'},indexState:state,fetch:async(url,init)=>{calls.push(new URL(url));assert.equal(init.method,'GET');return handler(new URL(url));}});return{make,calls,setState:v=>{state=structuredClone(v);},setHandler:v=>{handler=v;},revoke:()=>{allowed=false;}};}
test('legacy reset and nested Gmail list bindings survive an admitted increase1 to25 without reset or scope change',async()=>{
 const f=fixture();let lists=0;f.setHandler(u=>u.pathname.endsWith('/profile')?response({historyId:'100'}):u.pathname.endsWith('/messages')?(lists++,response(lists===1?{messages:[{id:'one'}],nextPageToken:'next'}:{messages:[{id:'two'},{id:'three'}],nextPageToken:'last'})):response(message(u.pathname.split('/').at(-1))));
 let r=f.make(),p=await r.resetMetadataCoverage('first',{limit:1});const first=r.exportIndex(),legacy=first.metadata_resets[0].binding,inner=first.metadata_resets[0].value.cursor,id=first.records[0].logical_message_id;f.setState(first);
 r=f.make();p=await r.resetMetadataCoverage('first',{limit:25,cursor:p.next_cursor});const after=r.exportIndex();assert.equal(p.messages.length,2);assert.equal(p.has_more,true);assert.equal(p.mailbox_reset_complete,false);assert.equal(after.records.find(x=>x.locator.message_id==='one').logical_message_id,id);assert.equal(after.metadata_resets[0].binding,legacy);assert.equal(JSON.parse(Buffer.from(after.metadata_resets[0].value.cursor,'base64url')).binding,JSON.parse(Buffer.from(inner,'base64url')).binding);assert.equal(f.calls.filter(u=>u.pathname.endsWith('/profile')).length,1);assert.equal(f.calls.filter(u=>u.pathname.endsWith('/messages')).at(-1).searchParams.get('maxResults'),'25');assert.equal(f.calls.filter(u=>u.pathname.endsWith('/messages')).at(-1).searchParams.get('pageToken'),'next');
});
test('Gmail list compatibility cannot widen account, epoch, operation, query, labels or spam/trash coverage',async()=>{
 const old={account_id:account.account_id,epoch:2,operation:'read',query:'',label_ids:[],include_spam_trash:true,limit:1},cursor=encodeCursor(digest(old),'next');let calls=0;
 const make=(changed={})=>createGmailAdapter({account:{...account,...changed},getAccessToken:async()=>'synthetic',assertAuthority:async()=>true,fetch:async u=>{calls++;assert.equal(new URL(u).searchParams.get('maxResults'),'25');return response({messages:[],nextPageToken:'after'});}});
 const p=await make().listMessages({limit:25,cursor,include_spam_trash:true});assert.equal(decodeCursor(p.next_cursor,digest(old)),'after');
 for(const change of [{account_id:'other'},{authority_epoch:3}])await assert.rejects(make(change).listMessages({limit:25,cursor,include_spam_trash:true}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 for(const request of [{include_spam_trash:false},{label_ids:['SENT']}])await assert.rejects(make().listMessages({limit:25,cursor,include_spam_trash:true,...request}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 await assert.rejects(make().searchMessages({limit:25,cursor,include_spam_trash:true,query:'foreign'}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(calls,1);
});
test('reset binding changes and malformed, consumed, decreasing or oversized limits fail before provider access',async()=>{
 const f=fixture();f.setHandler(u=>u.pathname.endsWith('/profile')?response({historyId:'100'}):response({messages:[],nextPageToken:'next'}));let r=f.make(),p=await r.resetMetadataCoverage('first',{limit:25});f.setState(r.exportIndex());const count=f.calls.length;
 for(const request of [{limit:1,cursor:p.next_cursor},{limit:0,cursor:p.next_cursor},{limit:101,cursor:p.next_cursor},{limit:25,cursor:'forged'}])await assert.rejects(f.make().resetMetadataCoverage('first',request),/EMAIL_PROVIDER_(CURSOR_INVALID|PAGE_LIMIT)/);
 for(const changed of [{authority_epoch:3},{connection_target:'other'},{resource_binding_id:'other'}])await assert.rejects(f.make({account:changed}).resetMetadataCoverage('first',{limit:25,cursor:p.next_cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(f.calls.length,count);
 for(const changed of [{owner_id:'other'},{org_id:'other'},{installation_id:'other'}])assert.throws(()=>f.make({scope:{...scope,...changed}}),/EMAIL_LOGICAL_/);assert.equal(f.calls.length,count);
 f.revoke();await assert.rejects(f.make().resetMetadataCoverage('first',{limit:25,cursor:p.next_cursor}),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);assert.equal(f.calls.length,count);
});
test('Gmail history and Graph folder continuation keep legacy bindings while requesting25',async()=>{
 for(const provider of ['gmail','microsoft']){
  const selected={...account,provider},checkpoint=provider==='gmail'?'100':null,folder_id=provider==='gmail'?null:'inbox',binding=digest({provider,account_id:account.account_id,epoch:2,checkpoint,folder_id,limit:1});const base=provider==='gmail'?'next':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=next',cursor=encodeCursor(binding,base);let calls=0;
  const reader=createMetadataResetReader({account:selected,getAccessToken:async()=>'synthetic',assertAuthority:async()=>true,fetch:async(u,init)=>{calls++;if(provider==='gmail'){assert.equal(new URL(u).searchParams.get('maxResults'),'25');return response({history:[],historyId:'101',nextPageToken:'after'});}assert.match(init.headers.Prefer,/maxpagesize=25/);return response({value:[],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=after'});}});
  const p=await reader.resetReadChanges({limit:25,cursor,checkpoint,folder_id});assert.ok(decodeCursor(p.next_cursor,binding));await assert.rejects(reader.resetReadChanges({limit:25,cursor,checkpoint:provider==='gmail'?'200':checkpoint,folder_id:provider==='gmail'?folder_id:'sent'}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(calls,1);
 }
});
test('legacy scoped binding acceptance never relaxes malformed cursor framing or current response caps',async()=>{
 const binding=digest({account_id:account.account_id,epoch:2,operation:'read',query:'',label_ids:[],include_spam_trash:false,limit:1});let calls=0;const reader=createGmailAdapter({account,getAccessToken:async()=>'synthetic',assertAuthority:async()=>true,fetch:async()=>{calls++;return response({messages:Array.from({length:26},(_,i)=>({id:String(i)}))});}});
 for(const raw of [{v:2,binding,value:'next'},{v:1,binding,value:'next',extra:true}])await assert.rejects(reader.listMessages({limit:25,cursor:Buffer.from(JSON.stringify(raw)).toString('base64url')}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 await assert.rejects(reader.listMessages({limit:25,cursor:'x'.repeat(PROVIDER_LIMITS.cursor_bytes+1)}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(calls,0);await assert.rejects(reader.listMessages({limit:25,cursor:encodeCursor(binding,'next')}),/EMAIL_PROVIDER_RESPONSE_INVALID/);assert.equal(calls,1);
});
