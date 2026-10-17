import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDeftResourceSyncClientV3,digestResourceSyncDescriptorV2} from '@deft/app-kit';
import {createEmailAccountRuntime} from './account-runtime.mjs';
import {runEmailAccountSync,EMAIL_LOGICAL_RECORD_SCHEMA} from './service.mjs';
import {EMAIL_METADATA_DESCRIPTOR} from '../metadata-resource.mjs';

const fixture=JSON.parse(readFileSync(new URL('../fixtures/launch-stage0/fixtures.json',import.meta.url))),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,scope={...fixture.scope,installation_id:uuid(102)};
function account(id='gmail-personal'){const row=fixture.accounts.find(row=>row.id===id);return {account_id:id,provider:row.provider_hint==='imap'?'imap_smtp':row.provider_hint,display_label:row.display_name,primary_address:row.address,verified_sender_identities:[row.address],capabilities:row.provider_hint==='imap'?['read']:['read','search','thread','send'],connection_target:`reviewed-target-${id}`,resource_binding_id:uuid(id==='gmail-personal'?120:121),action_binding_id:uuid(id==='gmail-personal'?122:123),authority_epoch:1,health:'connected'};}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function memoryStore(){return {index:null,pending:null,async hasPending(){return this.pending!==null;},async load(){return this.index;},async stage(value){this.pending=structuredClone(value);},async commit(){this.index=this.pending.index_state;this.pending=null;}};}
async function serviceFixture(id='gmail-personal',{revoked=false,lostAck=false,recordSchema=EMAIL_LOGICAL_RECORD_SCHEMA,label='label',descriptorKey=EMAIL_METADATA_DESCRIPTOR.key}={}){
 const selected=account(id),attachments=EMAIL_METADATA_DESCRIPTOR.attachments,descriptor={...EMAIL_METADATA_DESCRIPTOR,key:descriptorKey,label_field:label,record_schema:recordSchema},descriptor_digest=await digestResourceSyncDescriptorV2(descriptor),claim={schema_version:'deft.app_runtime_channel.v3',audience:'app_resource_sync',work_kind:'sync_page',org_id:scope.org_id,app_installation_id:scope.installation_id,app_version_id:uuid(103),grant_snapshot_id:uuid(104),lifecycle_epoch:1,grant_epoch:1,runtime_registration_id:uuid(id==='gmail-personal'?110:111),resource_binding_id:selected.resource_binding_id,runtime_epoch:1,session_id:uuid(id==='gmail-personal'?130:131),session_epoch:1,run_id:uuid(140),attempt_id:uuid(141),attempt_number:1,claim_token:uuid(142),sequence:1,lease_expires_at:new Date(Date.now()+60000).toISOString(),descriptor_digest},started={schema_version:claim.schema_version,audience:claim.audience,work_kind:claim.work_kind,resource_binding_id:claim.resource_binding_id,run_id:claim.run_id,attempt_id:claim.attempt_id,sequence:claim.sequence,lease_expires_at:claim.lease_expires_at,descriptor_digest,descriptor,input:{schema_version:'deft.app_sync_request.v2',cursor:null,max_items:2,attachments}},hostCalls=[],providerCalls=[],tokenCalls=[];
 const sdk=createDeftResourceSyncClientV3({channel_url:'https://host.example.test/api/app-resource-sync/channel',credential:{session_id:claim.session_id,session_token:'s'.repeat(32)},fetch:async(url,init)=>{const operation=new URL(url).pathname.split('/').at(-1);hostCalls.push({operation,body:JSON.parse(init.body),authorization:init.headers.authorization});if(operation==='claim')return response({schema_version:claim.schema_version,audience:claim.audience,claim});if(operation==='start')return response({schema_version:claim.schema_version,audience:claim.audience,started});if(operation==='heartbeat')return revoked?response({error:'denied'},401):response({schema_version:claim.schema_version,audience:claim.audience,work_kind:claim.work_kind,run_id:claim.run_id,attempt_id:claim.attempt_id,sequence:claim.sequence,renewed:true,lease_expires_at:claim.lease_expires_at});if(operation==='result'){if(lostAck)throw Error('lost host result acknowledgement');return response({schema_version:claim.schema_version,audience:claim.audience,work_kind:claim.work_kind,run_id:claim.run_id,attempt_id:claim.attempt_id,sequence:claim.sequence,accepted:true});}assert.fail(operation);}});
 const providerFetch=async(url,init)=>{providerCalls.push({url,init});return new URL(url).pathname.endsWith('/messages')?response({messages:[{id:'same-provider-id',threadId:'same-provider-thread'}]}):response({id:'same-provider-id',threadId:'same-provider-thread',labelIds:['INBOX'],internalDate:'1790762400000',historyId:'1',payload:{headers:[{name:'Subject',value:'Review the launch brief'},{name:'From',value:'reviewer@example.test'},{name:'To',value:selected.primary_address}]}});};
 return {sdk,mappings:[{scope,account:selected,session_id:claim.session_id,runtime_registration_id:claim.runtime_registration_id,resource_binding_id:claim.resource_binding_id}],custody:{getAccessToken:async request=>{tokenCalls.push(request);return `provider-token-${request.account.account_id}`;}},stateStore:memoryStore(),fetch:providerFetch,hostCalls,providerCalls,tokenCalls,started};
}

test('account runtime combines selected provider records with stable logical index and independent current revocation',async()=>{
 const personal=await serviceFixture(),runtime=createEmailAccountRuntime({scope,accounts:[account(),account('gmail-work')],authorize:async()=>true,custody:personal.custody,fetch:personal.fetch});const first=await runtime.listMessages('gmail-personal',{limit:1}),work=await runtime.listMessages('gmail-work',{limit:1});assert.notEqual(first.messages[0].logical_message_id,work.messages[0].logical_message_id);runtime.revokeAccount('gmail-personal');await assert.rejects(runtime.listMessages('gmail-personal',{limit:1}),/EMAIL_ACCOUNT_REVOKED/);assert.equal((await runtime.listMessages('gmail-work',{limit:1})).messages[0].logical_message_id,work.messages[0].logical_message_id);
});
test('actual Kit Sync v3 transport claim/start/current heartbeat -> exact reviewed target -> adapter/index -> result',async()=>{
 const first=await serviceFixture(),result=await runEmailAccountSync(first);assert.equal(result.state,'sync_settled');assert.equal(result.record_count,1);assert.ok(first.hostCalls.every(call=>call.authorization==='AppRuntime '+'s'.repeat(32)));assert.equal(first.hostCalls[0].operation,'claim');assert.equal(first.hostCalls[1].operation,'start');assert.ok(first.hostCalls.some(call=>call.operation==='heartbeat'));assert.equal(first.hostCalls.at(-1).operation,'result');assert.equal(first.providerCalls.length,2);assert.equal(first.tokenCalls[0].account.connection_target,'reviewed-target-gmail-personal');assert.equal(first.hostCalls.at(-1).body.page.upserts[0].data.account_id,'gmail-personal');assert.equal(first.stateStore.pending,null);assert.equal(first.stateStore.index.records.length,1);
 const work=await serviceFixture('gmail-work');await runEmailAccountSync(work);assert.equal(work.tokenCalls[0].account.connection_target,'reviewed-target-gmail-work');assert.notEqual(work.stateStore.index.records[0].logical_message_id,first.stateStore.index.records[0].logical_message_id);
});
test('foreign guessed target, host heartbeat revocation and another-account private state stop provider disclosure',async()=>{
 const foreign=await serviceFixture();foreign.mappings[0].resource_binding_id=uuid(999);foreign.mappings[0].account.resource_binding_id=uuid(999);await assert.rejects(runEmailAccountSync(foreign),error=>error.code==='EMAIL_PROVIDER_TARGET_MAPPING_DENIED');assert.equal(foreign.providerCalls.length,0);
 const revoked=await serviceFixture('gmail-personal',{revoked:true});await assert.rejects(runEmailAccountSync(revoked),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);assert.equal(revoked.providerCalls.length,0);
 const cross=await serviceFixture();cross.stateStore.index={records:[{account_id:'gmail-work'}]};await assert.rejects(runEmailAccountSync(cross),error=>error.code==='EMAIL_PROVIDER_STATE_ACCOUNT_MISMATCH');assert.equal(cross.providerCalls.length,0);
});
test('lost host result acknowledgement preserves staged identities and prevents any automatic sync replay',async()=>{
 const session=await serviceFixture('gmail-personal',{lostAck:true});await assert.rejects(runEmailAccountSync(session));assert.equal(session.stateStore.pending.index_state.records.length,1);const providerCalls=session.providerCalls.length,hostCalls=session.hostCalls.length;await assert.rejects(runEmailAccountSync(session),error=>error.code==='EMAIL_PROVIDER_SYNC_RECOVERY_REQUIRED');assert.equal(session.providerCalls.length,providerCalls);assert.equal(session.hostCalls.length,hostCalls);
});
test('legacy incompatible record descriptor fails closed before result or private index commit',async()=>{
 const session=await serviceFixture('gmail-personal',{recordSchema:{type:'object',properties:{subject:{type:'string',maxLength:200}},required:['subject'],additionalProperties:false},label:'subject'});await assert.rejects(runEmailAccountSync(session),error=>error.code==='EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED');assert.equal(session.stateStore.pending,null);assert.equal(session.stateStore.index,null);assert.equal(session.providerCalls.length,0);assert.equal(session.tokenCalls.length,0);assert.equal(session.hostCalls.some(call=>call.operation==='result'),false);
});
test('actual Sync v3 service publishes IMAP metadata without a source fetch or inventory file',async()=>{
 const session=await serviceFixture('imap'),calls=[];const client={async list(){return [{path:'INBOX'},{path:'Sent',specialUse:'\\Sent'},{path:'Archive',specialUse:'\\Archive'}];},async getMailboxLock(path){calls.push(['lock',path]);this.mailbox={uidValidity:'3001',uidNext:2};return {release(){calls.push(['release']);}};},async *fetch(range,options){calls.push(['fetch',range,options]);yield {uid:1,envelope:{subject:'Envelope only',from:[{address:'sender@example.test'}]},flags:new Set(),size:99999999};},async fetchOne(){assert.fail('source/file body access is unavailable in metadata sync');},async logout(){calls.push(['logout']);}};
 session.custody={connectImap:async()=>client};const result=await runEmailAccountSync(session),row=session.hostCalls.at(-1).body.page.upserts[0];assert.equal(result.record_count,1);assert.equal(row.data.provider,'imap_smtp');assert.equal(row.data.in_inbox,true);assert.equal(row.data.body_status,'lazy');assert.equal(row.data.files_status,'unknown');assert.deepEqual(row.attachments,[]);assert.equal(session.tokenCalls.length,0);assert.equal(session.providerCalls.length,0);assert.equal(calls.at(-1)[0],'logout');
});

test('trusted operator conversation sync indexes Sent metadata and persists complete coverage',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);
 const logical=session.stateStore.index.records[0].logical_message_id;
 session.mappings[0].conversation={logical_message_id:logical};
 session.fetch=async(url)=>{assert.match(new URL(url).pathname,/\/threads\/same-provider-thread$/);assert.equal(new URL(url).searchParams.get('format'),'metadata');return response({id:'same-provider-thread',messages:[{id:'same-provider-id',threadId:'same-provider-thread',labelIds:['INBOX'],internalDate:'1790762400000',payload:{headers:[{name:'Subject',value:'Conversation metadata'}]}},{id:'sent-id',threadId:'same-provider-thread',labelIds:['SENT'],internalDate:'1790762401000',payload:{headers:[{name:'Subject',value:'Conversation metadata'}]}}]});};
 await runEmailAccountSync(session);
 assert.equal(session.stateStore.index.records.length,2);
 assert.equal(session.stateStore.index.coverage[0].complete,true);
 assert.deepEqual(session.stateStore.index.coverage[0].covers_folders,['INBOX','SENT']);
 assert.ok(session.stateStore.index.records.every(row=>row.summary.body_status==='lazy'&&row.summary.files_status==='unknown'));
});


const threadMessage=(id,label='INBOX')=>({id,threadId:'same-provider-thread',labelIds:[label],internalDate:'1790762400000',historyId:'1',payload:{headers:[{name:'Subject',value:'Bounded thread'}]}});
test('conversation cursor cannot forge accumulated coverage or its observation time',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);session.mappings[0].conversation={logical_message_id:session.stateStore.index.records[0].logical_message_id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')]});
 await runEmailAccountSync(session);const cursor=session.hostCalls.at(-1).body.page.next_cursor;
 let decoded;try{decoded=JSON.parse(Buffer.from(cursor,'base64url'));}catch{decoded={v:1,value:{}};}
 for(const changed of [{observed_at:'2099-01-01T00:00:00.000Z'},{count:0},{folders:['invented']},{failed:false,sum:'0'.repeat(64)}]){
  session.started.input.cursor=Buffer.from(JSON.stringify({...decoded,value:{...decoded.value,...changed}})).toString('base64url');
  await assert.rejects(runEmailAccountSync(session),/EMAIL_PROVIDER_CURSOR_INVALID/);
 }
});

test('private scan resumes once, rejects replay and keeps runtime observation clock',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);const id=session.stateStore.index.records[0].logical_message_id;session.mappings[0].conversation={logical_message_id:id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')]});
 const before=Date.now();await runEmailAccountSync(session);const cursor=session.hostCalls.at(-1).body.page.next_cursor,observation=session.stateStore.index.coverage[0].observed_at;
 assert.ok(Date.parse(observation)>=before&&Date.parse(observation)<=Date.now());assert.match(cursor,/^[a-f0-9-]{36}$/);assert.equal(session.stateStore.index.conversation_scans.length,1);
 session.started.input.cursor=cursor;await runEmailAccountSync(session);assert.equal(session.stateStore.index.coverage[0].complete,true);assert.equal(session.stateStore.index.coverage[0].observed_at,observation);assert.equal(session.stateStore.index.conversation_scans.length,0);
 const results=session.hostCalls.filter(call=>call.operation==='result').length;await assert.rejects(runEmailAccountSync(session),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(session.hostCalls.filter(call=>call.operation==='result').length,results);
});

test('continuation is bound to account authority epoch, target, limit and owner',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);const id=session.stateStore.index.records[0].logical_message_id;session.mappings[0].conversation={logical_message_id:id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')]});await runEmailAccountSync(session);
 const state=session.stateStore.index,cursor=session.hostCalls.at(-1).body.page.next_cursor;let calls=0;
 const make=selected=>createEmailAccountRuntime({scope,accounts:[selected,account('gmail-work')],authorize:async()=>true,custody:session.custody,indexState:state,fetch:async()=>{calls++;return session.fetch();}});
 for(const selected of [{...account(),authority_epoch:2},{...account(),connection_target:'new-reviewed-target'},{...account(),resource_binding_id:uuid(990)}])await assert.rejects(make(selected).syncConversation('gmail-personal',{logical_message_id:id,limit:2,cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 await assert.rejects(make(account()).syncConversation('gmail-personal',{logical_message_id:id,limit:1,cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);
 await assert.rejects(make(account()).syncConversation('gmail-work',{logical_message_id:id,limit:2,cursor}),/EMAIL_LOGICAL_NOT_FOUND/);
 assert.throws(()=>createEmailAccountRuntime({scope:{...scope,owner_id:uuid(998)},accounts:[account()],authorize:async()=>true,custody:session.custody,indexState:state}),/EMAIL_LOGICAL_STATE_INVALID/);
 assert.equal(calls,0);
});

test('revocation before or during continuation prevents publishing coverage',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);const id=session.stateStore.index.records[0].logical_message_id;session.mappings[0].conversation={logical_message_id:id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')]});await runEmailAccountSync(session);
 const state=session.stateStore.index,cursor=session.hostCalls.at(-1).body.page.next_cursor;let calls=0;
 const make=initial=>{let allowed=initial;return createEmailAccountRuntime({scope,accounts:[account()],authorize:async()=>allowed,custody:session.custody,indexState:state,fetch:async()=>{calls++;allowed=false;return session.fetch();}});};
 await assert.rejects(make(false).syncConversation('gmail-personal',{logical_message_id:id,limit:2,cursor}),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);assert.equal(calls,0);
 await assert.rejects(make(true).syncConversation('gmail-personal',{logical_message_id:id,limit:2,cursor}),/EMAIL_ACCOUNT_(AUTHORITY_DENIED|REVOKED)/);assert.equal(calls,1);assert.equal(state.coverage[0].complete,false);
});

test('private scan rejects future observation time and oversized provider continuation',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);const id=session.stateStore.index.records[0].logical_message_id;session.mappings[0].conversation={logical_message_id:id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')]});await runEmailAccountSync(session);
 for(const changed of [{observed_at:'2099-01-01T00:00:00.000Z'},{provider_cursor:'x'.repeat(2049)}]){
  const state=structuredClone(session.stateStore.index);Object.assign(state.conversation_scans[0],changed);assert.throws(()=>createEmailAccountRuntime({scope,accounts:[account()],authorize:async()=>true,custody:session.custody,indexState:state}),/EMAIL_LOGICAL_SCAN_INVALID/);
 }
});
test('conversation service resumes provider cursor across fresh runtimes and marks only final complete coverage',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);session.mappings[0].conversation={logical_message_id:session.stateStore.index.records[0].logical_message_id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')]});
 await runEmailAccountSync(session);const page=session.hostCalls.at(-1).body.page,coverage=session.stateStore.index.coverage[0];assert.equal(page.has_more,true);assert.equal(coverage.complete,false);assert.ok(Buffer.byteLength(page.next_cursor)<=2048);assert.deepEqual(page.tombstones,[]);
 session.started.input.cursor=page.next_cursor;await runEmailAccountSync(session);assert.equal(session.stateStore.index.records.length,3);assert.equal(session.stateStore.index.coverage[0].complete,true);assert.equal(session.stateStore.index.coverage[0].authority_epoch,account().authority_epoch);assert.equal(session.stateStore.index.coverage[0].resource_binding_id,account().resource_binding_id);assert.equal(session.stateStore.index.coverage[0].observed_at,coverage.observed_at);assert.equal(session.hostCalls.at(-1).body.page.has_more,false);
});
test('failed conversation member and retained stale index stay partial without deletion',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);session.mappings[0].conversation={logical_message_id:session.stateStore.index.records[0].logical_message_id};
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('two','SENT'),{id:'bad',threadId:'foreign'}]});
 await runEmailAccountSync(session);assert.equal(session.stateStore.index.coverage[0].complete,false);assert.equal(session.stateStore.index.records.length,2);assert.deepEqual(session.hostCalls.at(-1).body.page.tombstones,[]);
 session.fetch=async()=>response({id:'same-provider-thread',messages:[threadMessage('two','SENT')]});await runEmailAccountSync(session);assert.equal(session.stateStore.index.coverage[0].complete,false);assert.equal(session.stateStore.index.records.length,2);
});
test('conversation mapping rejects unknown or foreign identities before provider access',async()=>{
 const session=await serviceFixture();session.mappings[0].conversation={logical_message_id:'mail_'+'a'.repeat(64)};await assert.rejects(runEmailAccountSync(session),/EMAIL_LOGICAL_NOT_FOUND/);assert.equal(session.providerCalls.length,0);
 for(const conversation of [{logical_message_id:'mail_'+'a'.repeat(64),thread_id:'guessed'},{logical_message_id:'guessed'},[]]){session.mappings[0].conversation=conversation;await assert.rejects(runEmailAccountSync(session),/EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID/);}
});
test('Microsoft conversation paging spans Inbox and Sent with lazy metadata',async()=>{
 const selected=account('microsoft'),calls=[],rows=[{id:'one',conversationId:'graph-thread',parentFolderId:'inbox-id',subject:'Inbox',receivedDateTime:'2026-10-01T00:00:00Z'},{id:'two',conversationId:'graph-thread',parentFolderId:'sent-id',subject:'Sent',sentDateTime:'2026-10-01T00:01:00Z'}];
 const make=state=>createEmailAccountRuntime({scope,accounts:[selected],authorize:async()=>true,custody:{getAccessToken:async()=> 'synthetic-token'},indexState:state,fetch:async url=>{calls.push(url);const next=new URL(url).searchParams.has('$skiptoken');return response({value:[rows[next?1:0]],...(!next?{'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next'}:{})});}});
 let runtime=make(null);const seed=await runtime.listMessages(selected.account_id,{limit:1}),id=seed.messages[0].logical_message_id;const first=await runtime.syncConversation(selected.account_id,{logical_message_id:id,limit:1});assert.equal(first.complete,false);assert.equal(new URL(calls.at(-1)).searchParams.get('$filter'),"conversationId eq 'graph-thread'");
 runtime=make(runtime.exportIndex());const last=await runtime.syncConversation(selected.account_id,{logical_message_id:id,limit:1,cursor:first.next_cursor});assert.equal(last.complete,true);assert.deepEqual(last.coverage.covers_folders,['inbox-id','sent-id']);assert.ok(runtime.exportIndex().records.every(row=>row.summary.body_status==='lazy'));
 const malformed=Buffer.from(JSON.stringify({token:first.next_cursor,count:10001})).toString('base64url');const count=calls.length;await assert.rejects(runtime.syncConversation(selected.account_id,{logical_message_id:id,limit:1,cursor:malformed}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(calls.length,count);
 await assert.rejects(runtime.syncConversation(selected.account_id,{logical_message_id:id,limit:2,cursor:first.next_cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);
});

test('invalid accumulated cursor fails closed at the service; changed Gmail revision restarts safely',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);session.mappings[0].conversation={logical_message_id:session.stateStore.index.records[0].logical_message_id};let rows=[threadMessage('same-provider-id'),threadMessage('two','SENT'),threadMessage('three','SENT')],calls=0;
 session.fetch=async()=>{calls++;return response({id:'same-provider-thread',messages:rows});};await runEmailAccountSync(session);const cursor=session.hostCalls.at(-1).body.page.next_cursor;
 session.started.input.cursor=Buffer.from(JSON.stringify({token:cursor,folders:['INBOX','INBOX']})).toString('base64url');await assert.rejects(runEmailAccountSync(session),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(calls,1);assert.equal(session.stateStore.pending,null);
 rows=[threadMessage('same-provider-id'),threadMessage('two','SENT')];session.started.input.cursor=cursor;await runEmailAccountSync(session);assert.equal(calls,3);assert.equal(session.stateStore.index.coverage[0].complete,false);assert.equal(session.stateStore.index.records.length,3);
});

test('existing Sync v3 publishes known logical tombstones with private checkpoints and stops on lost acknowledgement',async()=>{
 const session=await serviceFixture();await runEmailAccountSync(session);const id=session.stateStore.index.records[0].logical_message_id;session.mappings[0].reconciliation={kind:'provider_deletions'};
 session.fetch=async()=>response({historyId:'100'});let result=await runEmailAccountSync(session);assert.equal(result.baseline_only,true);assert.equal(result.tombstone_count,0);
 session.fetch=async()=>response({history:[{id:'101',messagesDeleted:[{message:{id:'same-provider-id',threadId:'same-provider-thread'}}]}],historyId:'102'});
 const savedResult=session.sdk.result;session.sdk={...session.sdk,result:async()=>{throw Error('lost tombstone acknowledgement');}};
 await assert.rejects(runEmailAccountSync(session),/lost tombstone acknowledgement/);assert.equal(session.stateStore.pending.page.tombstones[0].id,id);assert.equal(session.stateStore.pending.page.upserts.length,0);assert.equal(session.stateStore.pending.index_state.deletion_history[0].checkpoint,'102');assert.equal(session.stateStore.index.deletion_history[0].checkpoint,'100');
 session.sdk={...session.sdk,result:savedResult};await assert.rejects(runEmailAccountSync(session),/EMAIL_PROVIDER_SYNC_RECOVERY_REQUIRED/);
});

test('trusted Sync v3 metadata reset drains opaque pages and commits coverage clear only at final acknowledgement',async()=>{
 const session=await serviceFixture();session.mappings[0].reconciliation={kind:'metadata_reset'};
 session.fetch=async url=>{const u=new URL(url);if(u.pathname.endsWith('/profile'))return response({historyId:'100'});if(u.pathname.endsWith('/history'))return response({history:[],historyId:'100'});if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('includeSpamTrash'),'true');return response({messages:[{id:'same-provider-id'}]});}return response(threadMessage('same-provider-id'));};
 let result;for(let step=0;step<8;step++){result=await runEmailAccountSync(session);const page=session.hostCalls.at(-1).body.page;session.started.input.cursor=page.next_cursor;if(!page.has_more)break;assert.equal(result.mailbox_reset_complete,false);}
 assert.equal(result.mailbox_reset_complete,true);assert.equal(result.reset_required,false);assert.equal(session.stateStore.index.metadata_resets.length,0);assert.equal(session.stateStore.index.deletion_history[0].checkpoint,'100');
});


test('host-attested inbox descriptor runs the same account-scoped metadata Sync; arbitrary keys never reach provider',async()=>{
 const session=await serviceFixture('gmail-personal',{descriptorKey:'inbox'}),result=await runEmailAccountSync(session);assert.equal(result.state,'sync_settled');assert.equal(session.stateStore.index.records[0].account_id,'gmail-personal');assert.ok(session.providerCalls.length>0);
 const denied=await serviceFixture('gmail-personal',{descriptorKey:'other_mail'});await assert.rejects(runEmailAccountSync(denied),/EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED/);assert.equal(denied.providerCalls.length,0);assert.equal(denied.tokenCalls.length,0);assert.equal(denied.stateStore.index,null);
});
