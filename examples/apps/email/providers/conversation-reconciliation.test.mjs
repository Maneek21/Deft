import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailAccountRuntime} from './account-runtime.mjs';

const scope={org_id:'test-org',owner_id:'test-owner',installation_id:'test-installation'};
const account=(provider='gmail',id='first')=>({account_id:id,provider,display_label:id,primary_address:'owner@example.test',verified_sender_identities:['owner@example.test'],capabilities:['read','thread'],connection_target:`target-${id}`,resource_binding_id:`binding-${id}`,action_binding_id:null,authority_epoch:1,health:'connected'});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const gmailMessage=id=>({id,threadId:'thread',labelIds:['INBOX'],internalDate:'1790762400000',payload:{headers:[{name:'Subject',value:'Private conversation'}]}});
const graphMessage=(id,folder='inbox')=>({id,conversationId:'thread',parentFolderId:folder,subject:'Private conversation'});
function fixture(provider='gmail'){
 let state=null,handler=null,allowed=true;const calls=[],selected=account(provider);
 const make=(overrides={})=>createEmailAccountRuntime({scope,accounts:[{...selected,...overrides},account(provider,'second')],authorize:async()=>allowed,custody:{getAccessToken:async()=> 'synthetic-provider-token',authorizeMetadataResetScope:async request=>request.account.resource_binding_id===selected.resource_binding_id&&Array.isArray(request.folder_ids)&&request.folder_ids.every(id=>['inbox','sent'].includes(id))},indexState:state,fetch:async(url,init)=>{assert.equal(init.method,'GET');calls.push({url,init});return handler(url,init);}});
 return {selected,calls,make,setState(value){state=structuredClone(value);},setHandler(value){handler=value;},revoke(){allowed=false;}};
}
async function seed(f,ids=['one','two','three']){
 f.setHandler(url=>{const parsed=new URL(url);return f.selected.provider==='gmail'?(parsed.pathname.endsWith('/messages')?response({messages:ids.map(id=>({id,threadId:'thread'}))}):response(gmailMessage(decodeURIComponent(parsed.pathname.split('/').at(-1))))):response({value:ids.map(id=>graphMessage(id))});});
 const runtime=f.make(),page=await runtime.listMessages('first',{limit:ids.length});f.setState(runtime.exportIndex());return page.messages;
}
async function baseline(f){f.setHandler(()=>response({historyId:'100'}));const runtime=f.make(),page=await runtime.syncProviderDeletions('first',{limit:1});assert.equal(page.baseline_only,true);assert.deepEqual(page.tombstones,[]);f.setState(runtime.exportIndex());}

test('explicit Gmail history deletions paginate private queues and preserve stable tombstone links',async()=>{
 const f=fixture(),records=await seed(f);await baseline(f);let historyCalls=0;
 f.setHandler(url=>{const parsed=new URL(url);assert.equal(parsed.pathname.endsWith('/history'),true);assert.equal(parsed.searchParams.get('startHistoryId'),'100');assert.equal(parsed.searchParams.get('historyTypes'),'messageDeleted');historyCalls++;return response(parsed.searchParams.has('pageToken')?{history:[{id:'102',messagesDeleted:[{message:{id:'three',threadId:'thread'}}]}],historyId:'103'}:{history:[{id:'101',messagesDeleted:[{message:{id:'one',threadId:'thread'}},{message:{id:'two',threadId:'thread'}}]}],historyId:'103',nextPageToken:'next'});});
 let runtime=f.make(),page=await runtime.syncProviderDeletions('first',{limit:1});assert.equal(page.tombstones[0].id,records[0].logical_message_id);assert.equal(page.has_more,true);let firstCursor=page.next_cursor;f.setState(runtime.exportIndex());
 runtime=f.make();page=await runtime.syncProviderDeletions('first',{limit:1,cursor:firstCursor});assert.equal(page.tombstones[0].id,records[1].logical_message_id);assert.equal(historyCalls,1);f.setState(runtime.exportIndex());
 runtime=f.make();page=await runtime.syncProviderDeletions('first',{limit:1,cursor:page.next_cursor});assert.equal(page.tombstones[0].id,records[2].logical_message_id);assert.equal(page.has_more,false);assert.equal(historyCalls,2);const state=runtime.exportIndex();assert.equal(state.deletion_history[0].checkpoint,'103');assert.equal(state.records.length,3);assert.ok(state.records.every(row=>row.deletion.kind==='provider_mailbox_deleted'));f.setState(state);
 runtime=f.make();const coverage=await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id});assert.equal(coverage.state,'deleted');assert.equal(coverage.reason,'provider_deleted');assert.equal(coverage.count.indexed,0);assert.ok(!JSON.stringify(coverage).includes('provider_message_id'));await assert.rejects(runtime.syncProviderDeletions('first',{limit:1,cursor:firstCursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 await assert.rejects(runtime.readMessage('first',records[0].logical_message_id),/EMAIL_LOGICAL_MESSAGE_DELETED/);
 f.setHandler(url=>new URL(url).pathname.endsWith('/messages')?response({messages:[{id:'one'}]}):response(gmailMessage('one')));assert.equal((await runtime.listMessages('first',{limit:1})).messages.length,0);
});

test('partial/empty metadata and unrelated history do not infer deletion',async()=>{
 const f=fixture(),records=await seed(f);await baseline(f);
 f.setHandler(()=>response({history:[{id:'101',messages:[{id:'one'}],labelsRemoved:[{message:{id:'two'},labelIds:['INBOX']}]}],historyId:'102'}));const runtime=f.make(),page=await runtime.syncProviderDeletions('first',{limit:1});assert.deepEqual(page.tombstones,[]);assert.ok(runtime.exportIndex().records.every(row=>!row.deletion));assert.equal((await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id})).count.indexed,3);
});

test('expired Gmail history clears coverage, emits no tombstones, and keeps an honest reset gap',async()=>{
 const f=fixture(),records=await seed(f);await baseline(f);f.setHandler(()=>response({id:'thread',messages:['one','two','three'].map(gmailMessage)}));let runtime=f.make();await runtime.syncConversation('first',{logical_message_id:records[0].logical_message_id,limit:3});assert.equal((await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id})).coverage.complete,true);f.setState(runtime.exportIndex());
 f.setHandler(()=>response({error:'gone'},404));runtime=f.make();const page=await runtime.syncProviderDeletions('first',{limit:1});assert.equal(page.reset_required,true);assert.deepEqual(page.tombstones,[]);f.setState(runtime.exportIndex());
 f.setHandler(()=>response({historyId:'200'}));runtime=f.make();assert.equal((await runtime.syncProviderDeletions('first',{limit:2})).reset_required,true);const coverage=await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id});assert.equal(coverage.coverage.complete,false);assert.equal(coverage.count.exact_total,null);assert.equal(coverage.reason,'history_reset_required');
});

test('deletion cursors reject forgery, wrong epoch/target/account and current revocation',async()=>{
 const f=fixture(),records=await seed(f);await baseline(f);f.setHandler(()=>response({history:[{id:'101',messagesDeleted:[{message:{id:'one',threadId:'thread'}},{message:{id:'two',threadId:'thread'}}]}],historyId:'102'}));let runtime=f.make(),page=await runtime.syncProviderDeletions('first',{limit:1});f.setState(runtime.exportIndex());const cursor=page.next_cursor,count=f.calls.length;
 for(const changed of [{authority_epoch:2},{connection_target:'other-target'},{resource_binding_id:'other-binding'}])await assert.rejects(f.make(changed).syncProviderDeletions('first',{limit:1,cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 await assert.rejects(f.make().syncProviderDeletions('second',{limit:1,cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);await assert.rejects(f.make().syncProviderDeletions('first',{limit:1,cursor:Buffer.from(JSON.stringify({token:cursor,pending:[]})).toString('base64url')}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(f.calls.length,count);
 f.revoke();await assert.rejects(f.make().syncProviderDeletions('first',{limit:1,cursor}),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);await assert.rejects(f.make().readConversationCoverage('first',{logical_message_id:records[0].logical_message_id}),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);assert.equal(f.calls.length,count);
});

test('Graph folder removals require exact immutable GET404; moves and denied/uncertain lookups do not tombstone',async()=>{
 for(const status of [200,403,429,500,404]){
  const f=fixture('microsoft'),records=await seed(f,['one']);const delta='https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next';
  f.setHandler((url,init)=>{assert.match(init.headers.Prefer,/ImmutableId/);return new URL(url).pathname.endsWith('/delta')?response({value:[{id:'one','@removed':{reason:'deleted'}}],'@odata.deltaLink':delta}):response(status===200?{id:'one'}:{error:'safe fixture'},status);});
  const runtime=f.make();if(status!==200&&status!==404){await assert.rejects(runtime.syncProviderDeletions('first',{limit:1,folder_id:'inbox'}));assert.ok(runtime.exportIndex().records.every(row=>!row.deletion));continue;}
  const page=await runtime.syncProviderDeletions('first',{limit:1,folder_id:'inbox'});assert.equal(page.tombstones.length,status===404?1:0);assert.equal(f.calls.at(-1).url,'https://graph.microsoft.com/v1.0/me/messages/one?$select=id');
  const coverage=await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id});assert.equal(coverage.state,status===404?'gone':'partial');assert.equal(coverage.reason,status===404?'current_mailbox_absent':null);
 }
});

test('Graph continuation cannot carry bearer to another host, mailbox or folder;410 is a reset gap',async()=>{
 for(const link of ['https://attacker.example/me/mailFolders/inbox/messages/delta','https://graph.microsoft.com/v1.0/users/other/mailFolders/inbox/messages/delta','https://graph.microsoft.com/v1.0/me/mailFolders/sent/messages/delta']){
  const f=fixture('microsoft');await seed(f,['one']);f.setHandler(()=>response({value:[],'@odata.nextLink':link}));await assert.rejects(f.make().syncProviderDeletions('first',{limit:1,folder_id:'inbox'}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 }
 const f=fixture('microsoft');await seed(f,['one']);f.setHandler(()=>response({error:'expired'},410));const page=await f.make().syncProviderDeletions('first',{limit:1,folder_id:'inbox'});assert.equal(page.reset_required,true);assert.deepEqual(page.tombstones,[]);
});

test('private coverage facet is bounded, account-scoped and rejects historical future-time completeness',async()=>{
 const f=fixture(),records=await seed(f);let runtime=f.make();await assert.rejects(runtime.readConversationCoverage('second',{logical_message_id:records[0].logical_message_id}),/EMAIL_LOGICAL_NOT_FOUND/);
 const state=runtime.exportIndex();state.coverage=[{account_id:'first',conversation_id:records[0].conversation_id,complete:true,covers_folders:['INBOX','SENT'],observed_at:'2099-01-01T00:00:00.000Z'}];f.setState(state);runtime=f.make();const facet=await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id});assert.equal(facet.state,'partial');assert.equal(facet.coverage.complete,false);assert.equal(facet.coverage.observed_at,null);assert.equal(facet.count.exact_total,null);assert.ok(!JSON.stringify(facet).includes('provider_message_id'));assert.ok(!JSON.stringify(facet).includes('target-first'));
});

test('legacy index upgrades without losing identity; v2 prevents legacy readers ignoring tombstones',async()=>{
 const f=fixture(),records=await seed(f,['one']);const state=f.make().exportIndex();state.schema_version='deft.email_logical_index.v1';delete state.conversation_scans;delete state.deletion_history;f.setState(state);const runtime=f.make(),facet=await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id});assert.equal(facet.logical_message_id,records[0].logical_message_id);assert.equal(runtime.exportIndex().schema_version,'deft.email_logical_index.v2');assert.equal(runtime.exportIndex().records.length,1);
});

test('Gmail full lazy reset catches concurrent addition/deletion and confirms unseen404 before clearing gap',async()=>{
 const f=fixture(),records=await seed(f,['one','two','stale']);let listPages=0,historyPages=0;
 f.setHandler(url=>{const u=new URL(url);if(u.pathname.endsWith('/profile'))return response({historyId:'100'});if(u.pathname.endsWith('/history')){historyPages++;return response(u.searchParams.get('startHistoryId')==='100'?{history:[{id:'101',messagesAdded:[{message:{id:'three'}}],messagesDeleted:[{message:{id:'two',threadId:'thread'}}]}],historyId:'102'}:{history:[],historyId:'102'});}if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('includeSpamTrash'),'true');listPages++;return response(listPages===1?{messages:[{id:'one'}],nextPageToken:'second'}:{messages:[{id:'two'}]});}const id=u.pathname.split('/').at(-1);assert.equal(u.searchParams.get('format'),'metadata');return id==='stale'?response({error:'gone'},404):response(gmailMessage(id));});
 let cursor=null,first=null,result,runtime;for(let step=0;step<20;step++){runtime=f.make();result=await runtime.resetMetadataCoverage('first',{limit:1,cursor});if(!first)first=result.next_cursor;f.setState(runtime.exportIndex());cursor=result.next_cursor;if(!result.has_more)break;assert.equal(result.mailbox_reset_complete,false);assert.equal(result.reset_required,true);}
 assert.equal(result.mailbox_reset_complete,true);assert.equal(result.reset_required,false);assert.equal(listPages,2);assert.equal(historyPages,2);const state=runtime.exportIndex();assert.equal(state.records.find(row=>row.locator.message_id==='two').deletion.kind,'provider_mailbox_deleted');assert.equal(state.records.find(row=>row.locator.message_id==='stale').deletion.kind,'provider_mailbox_absent');assert.ok(state.records.some(row=>row.locator.message_id==='three'&&row.summary.body_status==='lazy'));assert.equal(state.deletion_history[0].checkpoint,'102');assert.equal(state.metadata_resets.length,0);await assert.rejects(f.make().resetMetadataCoverage('first',{limit:1,cursor:first}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal((await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id})).reset_required,false);
});

test('reset continuation fails closed on epoch/target substitution, replay, expiry and current revocation',async()=>{
 const f=fixture();await seed(f,['one']);f.setHandler(url=>new URL(url).pathname.endsWith('/profile')?response({historyId:'100'}):new URL(url).pathname.endsWith('/messages')?response({messages:[]}):response({error:'expired'},404));let runtime=f.make(),result=await runtime.resetMetadataCoverage('first',{limit:1});f.setState(runtime.exportIndex());const first=result.next_cursor,count=f.calls.length;
 for(const override of [{authority_epoch:2},{connection_target:'foreign'}])await assert.rejects(f.make(override).resetMetadataCoverage('first',{limit:1,cursor:first}),/EMAIL_PROVIDER_CURSOR_INVALID/);await assert.rejects(f.make().resetMetadataCoverage('first',{limit:1,cursor:'forged'}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(f.calls.length,count);
 for(let step=0;step<10&&result.has_more;step++){runtime=f.make();result=await runtime.resetMetadataCoverage('first',{limit:1,cursor:result.next_cursor});f.setState(runtime.exportIndex());}
 assert.equal(result.expired,true);assert.equal(result.mailbox_reset_complete,false);assert.equal(result.reset_required,true);assert.ok(runtime.exportIndex().deletion_history[0].reset_required);await assert.rejects(f.make().resetMetadataCoverage('first',{limit:1,cursor:first}),/EMAIL_PROVIDER_CURSOR_INVALID/);f.revoke();await assert.rejects(f.make().resetMetadataCoverage('first',{limit:1}),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);
});

test('canonical complete thread remains independently proven while mailbox reset gap is pending',async()=>{
 const f=fixture(),records=await seed(f,['one']);f.setHandler(url=>new URL(url).pathname.endsWith('/profile')?response({historyId:'100'}):new URL(url).pathname.includes('/threads/')?response({id:'thread',messages:[gmailMessage('one')]}):new URL(url).pathname.endsWith('/messages/one')?response(gmailMessage('one')):response({messages:[{id:'one'}],nextPageToken:'later'}));const runtime=f.make();await runtime.resetMetadataCoverage('first',{limit:1});await runtime.syncConversation('first',{logical_message_id:records[0].logical_message_id,limit:1});const facet=await runtime.readConversationCoverage('first',{logical_message_id:records[0].logical_message_id});assert.equal(facet.state,'complete');assert.equal(facet.coverage.complete,true);assert.equal(facet.reset_required,true);assert.equal(facet.reason,'history_reset_required');
});

test('Graph reset drains fresh reviewed folder delta and catchup before clearing only that scope',async()=>{
 const f=fixture('microsoft');await seed(f,['one']);let rounds=0;const delta='https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=end';f.setHandler((url,init)=>{assert.match(init.headers.Prefer,/ImmutableId/);assert.equal(new URL(url).pathname,'/v1.0/me/mailFolders/inbox/messages/delta');rounds++;return response({value:rounds===1?[graphMessage('one')]:[],'@odata.deltaLink':delta});});let cursor=null,result,runtime;for(let step=0;step<10;step++){runtime=f.make();result=await runtime.resetMetadataCoverage('first',{limit:1,folder_ids:['inbox'],cursor});f.setState(runtime.exportIndex());cursor=result.next_cursor;if(!result.has_more)break;}
 assert.equal(result.mailbox_reset_complete,true);assert.equal(result.reset_required,false);assert.deepEqual(result.covers_folders,['inbox']);assert.equal(rounds,2);const count=f.calls.length;await assert.rejects(f.make().resetMetadataCoverage('first',{limit:1,folder_ids:['protected-foreign']}),/EMAIL_PROVIDER_RESET_SCOPE_DENIED/);assert.equal(f.calls.length,count);
});

test('reset revocation during provider I/O cannot clear gap or publish completion',async()=>{
 const f=fixture();await seed(f,['one']);const count=f.calls.length;f.setHandler(()=>{f.revoke();return response({historyId:'100'});});const runtime=f.make();await assert.rejects(runtime.resetMetadataCoverage('first',{limit:1}),/EMAIL_ACCOUNT_(REVOKED|AUTHORITY_DENIED)/);assert.equal(f.calls.length,count+1);assert.ok(runtime.exportIndex().deletion_history.every(row=>row.reset_required));assert.equal(runtime.exportIndex().metadata_resets.length,0);
});

test('reset restores confirmed current presence after mailbox-gone evidence while retaining stable identity/history',async()=>{
 const f=fixture('microsoft'),records=await seed(f,['one']);const delta='https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=end';f.setHandler(url=>new URL(url).pathname.endsWith('/delta')?response({value:[{id:'one','@removed':{reason:'deleted'}}],'@odata.deltaLink':delta}):response({error:'gone'},404));let runtime=f.make();await runtime.syncProviderDeletions('first',{limit:1,folder_id:'inbox'});f.setState(runtime.exportIndex());let rounds=0;f.setHandler(()=>response({value:++rounds===1?[graphMessage('one')]:[],'@odata.deltaLink':delta}));let cursor=null,result;for(let step=0;step<10;step++){runtime=f.make();result=await runtime.resetMetadataCoverage('first',{limit:1,folder_ids:['inbox'],cursor});f.setState(runtime.exportIndex());cursor=result.next_cursor;if(!result.has_more)break;}const record=runtime.exportIndex().records[0];assert.equal(result.mailbox_reset_complete,true);assert.equal(record.logical_message_id,records[0].logical_message_id);assert.equal(record.deletion,undefined);assert.equal(record.last_absence.kind,'provider_mailbox_absent');
});
