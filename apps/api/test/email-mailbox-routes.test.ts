import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmailMailboxRoutes } from '../src/routes/email-mailbox.js';
import { EmailMailboxError, type EmailMailboxService } from '../src/lib/email-mailbox-service.js';
import {NativeEmailPresentationSchema} from '../src/lib/app-connection-contract.js';
import {EmailUnifiedMailboxError} from '../src/lib/email-mailbox-unified.js';
import {EmailFolderManageError} from '../src/lib/email-folder-management-contract.js';

const session = {id:'human',org_id:'org',sid:'web',exp:2_000_000_000};

test('M24 folder manage/status/recent bind only verified session; opt-in catalogue cannot widen old browse input',async()=>{
 const calls:unknown[][]=[],operation='00000000-0000-4000-8000-000000000001',result={schema_version:'deft.email_folder_manage_result.v1',account_id:'account',operation_id:operation,kind:'create',state:'unknown',folder_id:null,label:null,automatic_retry:false,undo_supported:false};
 const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,folders:async()=>({list:async(...args:any[])=>{calls.push(['list',...args]);return {} as any;},manage:async(...args:any[])=>{calls.push(['manage',...args]);return result as any;},status:async(...args:any[])=>{calls.push(['status',...args]);return result as any;},recent:async(...args:any[])=>{calls.push(['recent',...args]);return {} as any;}})});
 const headers={authorization:'Bearer synthetic','content-type':'application/json'};
 assert.equal((await app.request('/accounts/account/folders/query',{method:'POST',headers,body:JSON.stringify({cursor:null,limit:20,management:true})})).status,200);assert.deepEqual(calls[0][3],{cursor:null,limit:20,management:true});
 assert.equal((await app.request('/accounts/account/folders/manage',{method:'POST',headers,body:JSON.stringify({operation_id:operation,kind:'create',name:'Business'})})).status,200);
 assert.deepEqual(calls[1].slice(1,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},{org_id:'org',owner_user_id:'human',account_id:'account'}]);
 assert.equal((await app.request('/accounts/account/folders/operations/'+operation,{headers})).status,200);assert.equal((await app.request('/accounts/account/folders/operations',{headers})).status,200);assert.deepEqual(calls.map(row=>row[0]),['list','manage','status','recent']);
 for(const body of [{operation_id:operation,kind:'create',name:'Business',owner_user_id:'foreign'},{operation_id:operation,kind:'create',name:'Business',provider_id:'raw'},{operation_id:operation,kind:'rename',name:'Business',destination_id:'move-handle'},{operation_id:operation,kind:'delete',name:'Business'},{operation_id:operation,kind:'create',name:'x'.repeat(129)}])assert.equal((await app.request('/accounts/account/folders/manage',{method:'POST',headers,body:JSON.stringify(body)})).status,400);
 assert.equal((await app.request('/accounts/account/folders/manage',{method:'POST',headers,body:JSON.stringify({operation_id:operation,kind:'create',name:'x'.repeat(17000)})})).status,413);
 assert.equal((await app.request('/accounts/account/folders/operations?limit=1000',{headers})).status,400);assert.equal((await app.request('/accounts/account/folders/operations/not-uuid',{headers})).status,400);assert.equal(calls.length,4);
});
test('M24 folder unsupported is400, conflict409 and real denial403; provider secrets stay unavailable',async()=>{
 for(const [error,status]of [[new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED'),400],[new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT'),409],[new EmailMailboxError('EMAIL_ACCESS_DENIED'),403],[Error('private-provider-token'),503]] as const){const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},folders:async()=>({list:async()=>{throw error;},manage:async()=>{throw error;}})});const response=await app.request('/accounts/account/folders/manage',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({operation_id:'00000000-0000-4000-8000-000000000001',kind:'create',name:'Business'})});assert.equal(response.status,status);assert.equal(JSON.stringify(await response.json()).includes('private-provider-token'),false);}
});
function fixture(failure?: Error) {
  const calls:unknown[][]=[];
  const service={list:async (...args:unknown[])=>{calls.push(args);if(failure)throw failure;return {items:[],account_id:'account'};}};
  const app=createEmailMailboxRoutes({verify:async token=>{if(token!=='valid')throw new Error('bad token');return session;},
    service:async()=>service as unknown as Pick<EmailMailboxService,'list'>,now:()=>1_000_000});
  const request=(query='',token='valid')=>app.request(`/accounts/account/messages${query}`,{headers:{authorization:`Bearer ${token}`}});
  return {app,calls,request};
}
test('native list derives scope and expiry from verified session only',async()=>{
  const {request,calls}=fixture(); const result=await request('?folder=sent&limit=20');
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},
    {org_id:'org',owner_user_id:'human',account_id:'account'},{folder:'sent',limit:20,cursor:null}]);
});
test('missing and invalid Bearer sessions never call mailbox',async()=>{
  const {app,request,calls}=fixture();
  assert.equal((await app.request('/accounts/account/messages')).status,401);
  assert.equal((await request('','invalid')).status,401);assert.equal(calls.length,0);
});

test('mailbox lists retain totals by default and accept explicit costly-count omission',async()=>{
  const f=fixture();
  assert.equal((await f.request()).status,200);
  assert.equal((f.calls[0]?.[2] as {include_total?:boolean}).include_total,undefined);
  assert.equal((await f.request('?include_total=true')).status,200);
  assert.equal((f.calls[1]?.[2] as {include_total?:boolean}).include_total,true);
  assert.equal((await f.request('?include_total=false')).status,200);
  assert.equal((f.calls[2]?.[2] as {include_total?:boolean}).include_total,false);
  assert.equal((await f.request('?include_total=yes')).status,400);
});
test('cross-owner query injection, duplicate values and invalid page budgets are rejected',async()=>{
  const {request,calls}=fixture();
  for(const query of ['?owner_user_id=other','?org_id=other','?folder=inbox&folder=sent','?limit=101','?limit=0','?limit=1.1'])
    assert.equal((await request(query)).status,400,query);
  assert.equal(calls.length,0);
});
test('revoked access and stale cursor are explicit; internal error contents remain private',async()=>{
  assert.equal((await fixture(new EmailMailboxError('EMAIL_ACCESS_DENIED')).request()).status,403);
  assert.equal((await fixture(new EmailMailboxError('EMAIL_CURSOR_EXPIRED')).request()).status,409);
  const result=await fixture(new Error('private-provider-token')).request();
  assert.equal(result.status,503);assert.deepEqual(await result.json(),{code:'EMAIL_UNAVAILABLE'});
});
test('explicit adoption binds the verified owner and rejects extra powers and oversized bodies',async()=>{
  const calls:unknown[][]=[];
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw new Error('unused');},now:()=>1000,
    enroll:async(...args)=>{calls.push(args);return {account_id:'account',provider:'gmail',state:'active',authority_revision:1};}});
  const binding='00000000-0000-4000-8000-000000000001';
  const request=(body:unknown)=>app.request('/accounts/account/adopt',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await request({resource_binding_id:binding})).status,200);
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},'org',{account_id:'account',resource_binding_id:binding}]);
  assert.equal((await request({resource_binding_id:binding,owner_user_id:'other'})).status,400);
  assert.equal((await request({resource_binding_id:binding,grant_send:true})).status,400);
  assert.equal((await request({resource_binding_id:'x'.repeat(5000)})).status,413);
  assert.equal(calls.length,1);
});

test('reading choices are owner-session scoped, revision checked and reject injected powers',async()=>{
  const calls:unknown[][]=[];
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw new Error('unused');},now:()=>1000,
    readingPreferences:{get:async(...args)=>{calls.push(args);return {account_id:'account',external_images:'ask',revision:1};},
      update:async(...args)=>{calls.push(args);if(args[3].expected_revision!==1)throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
        return {account_id:'account',external_images:args[3].external_images,revision:2};}}});
  const url='/accounts/account/reading-preferences',headers={authorization:'Bearer valid','content-type':'application/json'};
  assert.equal((await app.request(url)).status,401);
  const get=await app.request(url,{headers});assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},'org','account']);
  const update=(body:unknown)=>app.request(url,{method:'PATCH',headers,body:JSON.stringify(body)});
  const save=await update({external_images:'always',expected_revision:1});assert.equal(save.status,200);
  assert.deepEqual(await save.json(),{account_id:'account',external_images:'always',revision:2});
  assert.equal((await update({external_images:'ask',expected_revision:2})).status,409);
  for(const body of [{external_images:'always',expected_revision:1,owner_user_id:'other'},
    {external_images:'always',expected_revision:1,allow_ai:true},{external_images:'yes',expected_revision:1},
    {external_images:'always',expected_revision:0}])assert.equal((await update(body)).status,400);
  assert.equal((await app.request(url+'?org_id=other',{headers})).status,400);
});

test('Refresh only queues the verified owners account and cannot accept job or provider powers',async()=>{
  const calls:unknown[][]=[];
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw new Error('unused');},now:()=>1000,
    refresh:async(...args)=>{calls.push(args);return {account_id:'account',state:'queued'};}});
  const headers={authorization:'Bearer valid','content-type':'application/json'},url='/accounts/account/refresh';
  const send=(body:unknown)=>app.request(url,{method:'POST',headers,body:JSON.stringify(body)});
  const result=await send({});assert.equal(result.status,202);assert.deepEqual(await result.json(),{account_id:'account',state:'queued'});
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},'org','account']);
  for(const body of [{owner_user_id:'other'},{force:true},{lock_token:'mine'},{send:true}])assert.equal((await send(body)).status,400);
  assert.equal(calls.length,1);assert.equal((await app.request(url,{method:'POST'})).status,401);
});

test('unified query scopes all nominated accounts to verified human and returns recoverable continuation conflicts',async()=>{
  const calls:unknown[][]=[];let conflict=false;
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw new Error('unused');},now:()=>1000,
    unified:async()=>({list:async(...args)=>{calls.push(args);if(conflict)throw new EmailUnifiedMailboxError('EMAIL_UNIFIED_PAGE_CHANGED');
      return {items:[],next_cursor:null,accounts:[],coverage:'partial',count:{returned:0,exact_total:null},restart_required:false};}})});
  const headers={authorization:'Bearer valid','content-type':'application/json'},url='/messages/query';
  const send=(body:unknown)=>app.request(url,{method:'POST',headers,body:JSON.stringify(body)});
  const result=await send({account_ids:['one','two']});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},
    {org_id:'org',owner_user_id:'human'},{account_ids:['one','two'],folder:'inbox',limit:50,cursor:null}]);
  for(const body of [{account_ids:['one','two'],owner_user_id:'other'},{account_ids:['one','one']},
    {account_ids:['one','two'],limit:101},{account_ids:['one','two'],provider_url:'https://other.test'}])assert.equal((await send(body)).status,400);
  assert.equal(calls.length,1);conflict=true;
  const changed=await send({account_ids:['one','two']});assert.equal(changed.status,409);assert.deepEqual(await changed.json(),{code:'EMAIL_UNIFIED_PAGE_CHANGED'});
});

test('unified HTTP count choice is additive, boolean-only and remains owner-scoped',async()=>{
  const calls:unknown[][]=[];
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,
    unified:async()=>({list:async(...args)=>{calls.push(args);return {items:[],next_cursor:null,accounts:[],coverage:'complete',count:{returned:0,exact_total:null},restart_required:false};}})});
  const send=(include_total:unknown)=>app.request('/messages/query',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},
    body:JSON.stringify({account_ids:['one','two'],include_total})});
  for(const include_total of [false,true]){
    assert.equal((await send(include_total)).status,200);
    assert.deepEqual(calls.at(-1)?.[1],{org_id:'org',owner_user_id:'human'});
    assert.equal((calls.at(-1)?.[2] as {include_total:boolean}).include_total,include_total);
  }
  assert.equal((await send('false')).status,400);assert.equal(calls.length,2);
});

test('native source uses logical ID and verified owner, emits a no-store attachment and clears internal bytes',async()=>{
  const calls:unknown[][]=[],message='mail_'+'b'.repeat(64),bytes=new TextEncoder().encode('Subject: synthetic\r\n\r\nHello');
  const expected=new Uint8Array(bytes);
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw new Error('unused');},now:()=>1000,
    content:async()=>({readSource:async(...args)=>{calls.push(args);return {account_id:'account',logical_message_id:message,
      media_type:'message/rfc822',byte_length:bytes.length,digest:'a'.repeat(64),mime_bytes:bytes};}})});
  const headers={authorization:'Bearer valid'},url=`/accounts/account/messages/${message}/source`;
  const result=await app.request(url,{headers});assert.equal(result.status,200);
  assert.equal(result.headers.get('content-type'),'message/rfc822');assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(result.headers.get('content-disposition'),'attachment; filename="message.eml"');assert.equal(result.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),expected);assert.ok(bytes.every(value=>value===0));
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},
    {org_id:'org',owner_user_id:'human',account_id:'account'},message]);
  assert.equal((await app.request(url+'?owner_user_id=other',{headers})).status,400);
  assert.equal((await app.request('/accounts/account/messages/provider-id/source',{headers})).status,400);
  assert.equal(calls.length,1);
});
test('native source route rejects oversized/dishonest/mistyped bytes before constructing an attachment',async()=>{
 const message='mail_'+'b'.repeat(64);
 for(const kind of ['oversized','length','type','bytes']){
  const bytes=new Uint8Array(kind==='oversized'?35*1024*1024+1:8);
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,
   content:async()=>({readSource:async()=>({account_id:'account',logical_message_id:message,media_type:kind==='type'?'text/html':'message/rfc822',
    byte_length:kind==='length'?7:bytes.length,digest:'a'.repeat(64),mime_bytes:kind==='bytes'?'not bytes':bytes})} as any)});
  const response=await app.request(`/accounts/account/messages/${message}/source`,{headers:{authorization:'Bearer valid'}});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{code:'EMAIL_SOURCE_UNAVAILABLE'});assert.ok(bytes.every(value=>value===0));
 }
});

test('native presentation stays JSON and files/images use source-bound nominations with no-store binary disposal',async()=>{
  const message='mail_'+'c'.repeat(64),digest='d'.repeat(64),ref='e'.repeat(64),calls:unknown[][]=[];
  const identity={account_id:'account',provider:'gmail' as const,logical_message_id:message,source_digest:digest};
  const buffers:Uint8Array[]=[];
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,
    content:async()=>({readSource:async()=>{throw Error('unused');},
      readPresentation:async(...args)=>{calls.push(args);return NativeEmailPresentationSchema.parse({schema_version:'deft.email_presentation.v1' as const,...identity,
        content_trust:'unsanitized' as const,files:[],presentation:{format:'html' as const,content:'<script>unsafe()</script><p>Hello</p>',plain_text:'Hello',truncated:false,headers:[],metadata:{account_id:'account',primary_address:'owner@example.test',verified_sender_identities:'[]',reply_from:'',reply_to:'',reply_to_list:'',reply_cc:'',subject:'',message_id:'',references:'',conversation_id:'conversation',conversation_coverage_state:'unknown',conversation_indexed_count:'0',conversation_exact_count:'',conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'},images:[]}});},
      readFile:async(...args)=>{calls.push(args);const bytes=new Uint8Array([1,2,3]);buffers.push(bytes);return {schema_version:'deft.email_file.v1' as const,...identity,file_ref:ref,filename:'quote"/résumé.pdf',media_type:'application/pdf',byte_length:3,bytes};},
      readImage:async(...args)=>{calls.push(args);const bytes=new Uint8Array([4,5,6]);buffers.push(bytes);return {schema_version:'deft.email_image.v1' as const,...identity,image_ref:ref,media_type:'image/png',byte_length:3,bytes};}})});
  const headers={authorization:'Bearer valid','content-type':'application/json'},base=`/accounts/account/messages/${message}`;
  const presentation=await app.request(base+'/presentation',{headers});assert.equal(presentation.status,200);
  assert.match(presentation.headers.get('content-type')??'',/^application\/json/);assert.equal(presentation.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await presentation.json()).content_trust,'unsanitized');
  for(const operation of ['file','image']){
    const input={source_digest:digest,[operation+'_ref']:ref};
    const response=await app.request(base+'/'+operation,{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('content-security-policy'),"default-src 'none'; sandbox");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array(operation==='file'?[1,2,3]:[4,5,6]));
    assert.ok(buffers.at(-1)?.every(value=>value===0));
    if(operation==='file')assert.match(response.headers.get('content-disposition')??'',/^attachment; filename="attachment"; filename\*=UTF-8''quote%22_r%C3%A9sum%C3%A9.pdf$/);
    for(const extra of [{url:'https://other.test'},{owner_user_id:'other'},{source:{provider_id:'fake'}}])
      assert.equal((await app.request(base+'/'+operation,{method:'POST',headers,body:JSON.stringify({...input,...extra})})).status,400);
  }
  assert.equal(calls.length,3);
  for(const args of calls)assert.deepEqual(args.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},
    {org_id:'org',owner_user_id:'human',account_id:'account'},message]);
  assert.equal((await app.request(base+'/presentation?owner_user_id=other',{headers})).status,400);
});

test('native search preserves the human query and cannot accept raw provider cursors or owner scope',async()=>{
  const calls:unknown[][]=[];
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,
    search:async()=>({search:async(...args)=>{calls.push(args);return {account_id:'account',query:args[2].query,source:'provider',coverage:'partial',complete:false,exact_total:null,observed_at:null,next_cursor:null,provider_result_cap:1000,limitations:['provider_result_cap_1000'],failure_count:0,query_complete:false,unsupported:[],items:[]};}})});
  const headers={authorization:'Bearer valid','content-type':'application/json'},url='/accounts/account/search';
  const send=(body:unknown)=>app.request(url,{method:'POST',headers,body:JSON.stringify(body)});
  const query='from:"Jane Doe" subject:report';const response=await send({query});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},
    {org_id:'org',owner_user_id:'human',account_id:'account'},{query,limit:50,cursor:null}]);
  for(const extra of [{owner_user_id:'other'},{provider_url:'https://other.test'},{provider_cursor:'secret'},{ast:{terms:[]}}])assert.equal((await send({query,...extra})).status,400);
  assert.equal(calls.length,1);
});


test('conversation HTTP derives current session and cached anchor; never accepts provider thread identifiers',async()=>{
 const calls:unknown[][]=[],logical='mail_'+'a'.repeat(64),headers={authorization:'Bearer valid','content-type':'application/json'};
 const result={account_id:'account',anchor_logical_message_id:logical,items:[],next_cursor:null,has_more:false,observed_at:'2026-10-04T00:00:00.000Z',source:'provider' as const,consistency:'weak' as const,complete:true,coverage:'complete' as const,failure_count:0,count:{returned:0,exact_total:null}};
 const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,
  conversation:async()=>({read:async(...args)=>{calls.push(args);return result;}})});
 const url='/accounts/account/messages/'+logical+'/conversation',send=(body:unknown)=>app.request(url,{method:'POST',headers,body:JSON.stringify(body)});
 const response=await send({});assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
 assert.deepEqual(calls[0]?.slice(0,3),[{user_id:'human',web_session_id:'web',access_expires_at:2_000_000_000_000},{org_id:'org',owner_user_id:'human',account_id:'account'},{logical_message_id:logical,cursor:null,limit:50}]);
 for(const body of [{owner_user_id:'other'},{thread_id:'provider-private'},{source:{}},{limit:101},{cursor:''}])assert.equal((await send(body)).status,400);
 assert.equal(calls.length,1);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await app.request(url,{method:'POST'})).status,401);
});
