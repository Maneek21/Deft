import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOutgoingSnapshotService} from '../outgoing-snapshot.mjs';
import {createOutgoingSendRuntime} from '../outgoing-send-runtime.mjs';
const clone=value=>structuredClone(value),json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function store(){const rows=new Map();return {rows,async withLock({key},fn){return fn({async read(){return clone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const old=rows.get(key);if((old?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(old?.revision??0)+1,value:clone(value)});return true;}});}};}
const mail=(id,full=false)=>({id,threadId:'thread-'+id,labelIds:['INBOX'],internalDate:'100000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'sender@example.test'},{name:'To',value:'reader@example.test'},{name:'Subject',value:'Mail '+id},{name:'Message-ID',value:'<'+id+'@example.test>'}],...(full?{body:{size:17,data:Buffer.from('exact body '+id.padEnd(6,' ')).toString('base64url')}}:{})}});
async function fixture({count=1025,capabilities=['read','search','thread','send']}={}){
 const signal=new AbortController(),context={signal:signal.signal,search_fields:['subject','sender','recipients','cc']};let deny=false,afterFetch=null,providerHandler=null;
 const projection={purpose:'connect',org_id:'org',owner_user_id:'owner',web_session_id:'sid',experience_session_id:'experience',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',target_key:'google_connection',resource_key:'inbox',resource_binding_id:'resource',runtime_registration_id:'registration',descriptor_digest:'digest',action_key:'send_message',action_binding_id:'send-binding',allowed_operations:['list_summary','read_one','search'],lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,expires_at:1300000,checked_at:1000000};
 const options={origin:'https://deft.example.test',account_id:'a',provider:'gmail',authority_epoch:7,connection_target:'google_connection',resource_binding_id:'resource',action_binding_id:'send-binding',capabilities,clients:{gmail:{client_id:'client',client_secret:'synthetic-secret',redirect_uri:'https://deft.example.test/apps/connections/callback'}}};
 const retained=store(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(4),key_id:'test-key',store:retained,now:()=>1000000}),calls=[];
 const host={async resolveContext(c){assert.equal(c,context);if(deny)throw Error();return clone(projection);},async assertCurrent(c){assert.equal(c,context);if(deny)throw Error();return clone(projection);}};
 const fetch=async(url,init)=>{calls.push({url,method:init.method??'GET'});let result;const u=new URL(url);
  if(url==='https://oauth2.googleapis.com/token')result=json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:120,scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
  else if(url==='https://openidconnect.googleapis.com/v1/userinfo')result=json({sub:'synthetic-sub',email:'reader@example.test',email_verified:true});
  else if(u.pathname.endsWith('/profile'))result=json({emailAddress:'reader@example.test'});
  else if(providerHandler)result=await providerHandler(u,init);
  else if(u.pathname.endsWith('/messages')){const start=Number(u.searchParams.get('pageToken')??0),size=Number(u.searchParams.get('maxResults'));result=json({messages:Array.from({length:Math.min(size,count-start)},(_,i)=>({id:'m'+(start+i)})),...(start+size<count?{nextPageToken:String(start+size)}:{})});}
  else if(u.pathname.includes('/messages/')){const row=mail(decodeURIComponent(u.pathname.split('/').at(-1)),u.searchParams.get('format')==='full');if(row.payload.body)row.payload.body.size=Buffer.from(row.payload.body.data,'base64url').length;result=json(row);}
  else if(u.pathname.includes('/threads/')){const threadId=decodeURIComponent(u.pathname.split('/').at(-1));result=json({id:threadId,messages:Array.from({length:13},(_,i)=>({...mail('t'+i),threadId}))});}
  else assert.fail('Unexpected effect '+url);
  await afterFetch?.({url,init});return result;
 };
 const adapter=await createAppConnectionAdapter({host,options,custody,fetch,now:()=>1000000,monotonic:()=>0,indexStore:{async load(){assert.fail('Browsing must not access the retained index');}}});
 const begin=await adapter.handle(new Request('https://deft-connection.invalid/connections/begin',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),context);const pending=await begin.json();assert.equal(begin.status,200);
 const callback=await adapter.handle(new Request('https://deft-connection.invalid/connections/callback?state='+new URL(pending.authorization_url).searchParams.get('state')+'&code=synthetic-code'),context);assert.equal(callback.status,200);
 const browse=(changes={})=>{projection.purpose='browse_resource';return adapter.browseResource({operation:'list',folder:'inbox',query:'',cursor:null,source:null,limit:10,...changes},context);};
 return {adapter,context,projection,retained,calls,browse,signal,deny:()=>{deny=true;},afterFetch:fn=>{afterFetch=fn;},provider:fn=>{providerHandler=fn;}};
}
const record=item=>({record_id:randomUUID(),revision:item.revision,label:item.label,data:item.data,provider_source:item.provider_source});
test('native message source exposes reviewed named options without touching retained index or modify scopes',async()=>{
 const f=await fixture(),page=await f.browse(),source=record(page.items[0]);f.projection.purpose='triage_options';f.projection.content_policy={document:{max_characters:16384},triage_options:{max_options:100}};
 f.provider((url,init)=>{assert.equal(init.method,'GET');assert.ok(url.pathname.endsWith('/labels'));return json({labels:[{id:'Label_7',name:'Review queue',type:'user'},{id:'INBOX',name:'Inbox',type:'system'}]});});
 const options=await f.adapter.readTriageOptions({record:source},f.context);assert.deepEqual(options.labels,[{id:'Label_7',label:'Review queue'}]);assert.equal(options.complete,true);assert.equal(options.account_id,source.data.account_id);
 f.deny();await assert.rejects(f.adapter.readTriageOptions({record:source},f.context));
});
test('typed native search is confined to reviewed fields and provider folder while operators remain quoted',async()=>{
 const f=await fixture();f.projection.content_policy={document:{max_characters:16384},search_filters:['from','has_attachments','received_on']};
 let query;f.provider(url=>{assert.ok(url.pathname.endsWith('/messages'));query=url.searchParams.get('q');assert.deepEqual(url.searchParams.getAll('labelIds'),['INBOX']);return json({messages:[]});});
 const result=await f.browse({operation:'search',filters:{from:'reviewer@example.test',has_attachments:true,received_on:'2026-10-02'}});assert.equal(result.items.length,0);assert.match(query,/from:"reviewer@example.test" has:attachment after:/);
 await assert.rejects(f.browse({operation:'search',filters:{subject:'unreviewed'}}));await assert.rejects(f.browse({operation:'search',filters:{from:'x" OR in:anywhere'}}));
});
test('provider browsing reaches messages beyond1000 without touching retained projection or custody',async()=>{
 const f=await fixture(),before=JSON.stringify([...f.retained.rows]);let cursor=null,total=0,last;
 do{const page=await f.browse({cursor});total+=page.items.length;cursor=page.next_cursor;last=page;assert.equal(page.count.exact_total,null);assert.equal(page.failure_count,0);for(const item of page.items)assert.equal(Object.values(item.data).includes(item.provider_source.locator.message_id),false);}while(cursor);
 assert.equal(total,1025);assert.equal(last.complete,true);assert.equal(last.items.at(-1).provider_source.locator.message_id,'m1024');assert.equal(JSON.stringify([...f.retained.rows]),before);assert.equal(f.calls.filter(c=>c.method!=='GET').length,1,'Only fixture OAuth setup posts');
});
test('opaque provider cursors reject another query/folder and search uses Gmail beyond the retained cache',async()=>{
 const f=await fixture(),page=await f.browse();const before=f.calls.length;
 await assert.rejects(f.browse({folder:'sent',cursor:page.next_cursor}));assert.equal(f.calls.length,before);
 await f.browse({operation:'search',folder:'archive',query:'older-than-1000'});
 const list=f.calls.findLast(c=>new URL(c.url).pathname.endsWith('/messages'));const url=new URL(list.url);assert.match(url.searchParams.get('q'),/older-than-1000/);assert.match(url.searchParams.get('q'),/-in:inbox/);
});
test('transient full message and complete provider thread page do not require an indexed UUID',async()=>{
 const f=await fixture({count:1}),page=await f.browse(),source=record(page.items[0]);
 f.projection.purpose='read_document';f.projection.content_policy={document:{max_characters:16384}};
 const document=await f.adapter.readResource({operation:'read_document',record:source},f.context);assert.match(document.content,/^exact body m0/);assert.equal(document.metadata.message_id,'<m0@example.test>');assert.equal(document.metadata.conversation_coverage_state,'unknown');
 const first=await f.browse({operation:'conversation',folder:'all',source});assert.equal(first.items.length,10);assert.equal(first.complete,false);
 const next=await f.browse({operation:'conversation',folder:'all',source,cursor:first.next_cursor});assert.equal(next.items.length,3);assert.equal(next.complete,true);assert.equal(next.items[0].data.conversation_id,source.data.conversation_id);
});
test('source account/epoch/locator substitution and mid-I/O revocation return no content/page',async()=>{
 const f=await fixture({count:1}),page=await f.browse(),source=record(page.items[0]);const before=f.calls.length;
 for(const patch of [{account_id:'b'},{authority_epoch:8},{locator:{...source.provider_source.locator,message_id:'other'}}]){
  await assert.rejects(f.browse({operation:'conversation',folder:'all',source:{...source,provider_source:{...source.provider_source,...patch}}}));assert.equal(f.calls.length,before);
 }
 f.afterFetch(()=>f.deny());await assert.rejects(f.browse());assert.equal(f.calls.length,before+1,'Revocation blocks metadata I/O after the list response');
});
test('request cancellation aborts the provider fetch and the other account remains usable',async()=>{
 const a=await fixture(),b=await fixture({count:1});let entered;
 const seen=new Promise(resolve=>{entered=resolve;});a.provider(async(u,init)=>{entered();return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});});
 const pending=a.browse();await seen;a.signal.abort();await assert.rejects(pending);const page=await b.browse();assert.equal(page.items.length,1);assert.equal(page.complete,true);
});
test('reply review re-reads a transient parent from the provider and rejects worker-supplied recipients',async()=>{
 const f=await fixture({count:1}),page=await f.browse(),source=record(page.items[0]);f.projection.purpose='connect';
 const input={parent_record_id:source.record_id,to:'sender@example.test',cc:'',subject:'Re: Mail m0',body:'Exact reviewed reply.'};
 const request={binding:{org_id:'org',owner_user_id:'owner',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',resource_target_key:'google_connection',action_key:'send_message',runtime_binding_id:'send-binding',draft_id:'saved-draft',draft_revision:1},
  input,draft_value:{...input,mode:'reply_all',reply_record_id:source.record_id},draft_updated_at:new Date(1000000).toISOString(),files:[],max_payload_bytes:4194304,expires_at:new Date(1060000).toISOString(),source_records:{parent_record_id:[{...source,resource_key:'inbox',resource_binding_id:'resource'}]}};
 const result=await f.adapter.buildActionPayload(request,f.context);assert.equal(result.metadata.payload.mode,'reply_all');assert.equal(result.metadata.payload.reply_headers.in_reply_to,'<m0@example.test>');assert.equal(result.metadata.payload.to[0].address,'sender@example.test');assert.equal(result.metadata.payload.reply_parent.thread_id,'thread-m0');
 const changed=clone(request);changed.input.to=changed.draft_value.to='attacker@example.test';await assert.rejects(f.adapter.buildActionPayload(changed,f.context));assert.equal(f.calls.filter(c=>c.method!=='GET').length,1,'No Gmail Send from browsing/review');
 f.provider(async()=>json({...mail('m0',true),threadId:'foreign-thread'}));
 await assert.rejects(f.adapter.buildActionPayload(request,f.context),'A freshly read foreign thread cannot nominate the reply');
 assert.equal(f.calls.filter(c=>c.method!=='GET').length,1);
});

test('owned provider parent capture carries its thread through sealed runtime to exactly one Gmail POST',async()=>{
 const f=await fixture({count:1}),source=record((await f.browse()).items[0]);f.projection.purpose='connect';
 const input={parent_record_id:source.record_id,to:'sender@example.test',cc:'',subject:'Re: Mail m0',body:'Exact reviewed reply.'};
 const draft_id=randomUUID(),request={binding:{org_id:'org',owner_user_id:'owner',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',resource_target_key:'google_connection',action_key:'send_message',runtime_binding_id:'send-binding',draft_id,draft_revision:1},input,
  draft_value:{...input,mode:'reply_all',reply_record_id:source.record_id},draft_updated_at:new Date(1000000).toISOString(),files:[],max_payload_bytes:4194304,expires_at:new Date(1060000).toISOString(),source_records:{parent_record_id:[{...source,resource_key:'inbox',resource_binding_id:'resource'}]}};
 const captured=await f.adapter.buildActionPayload(request,f.context),payload=captured.metadata.payload;
 const snapshot={snapshot_id:randomUUID(),sealed_contract:'fixture-authenticated-capture',payload,payload_digest:captured.metadata.payload_digest,mime_digest:payload.mime.digest,envelope:payload.envelope,mime_bytes:captured.bytes,body_bytes:Buffer.from(input.body),file_bytes:[]};
 let reserved=false,posts=0,outcome=null;
 const snapshots=createOutgoingSnapshotService({resolve:async()=>{assert.fail('No recapture');},seal:async()=>{assert.fail('No reseal');},verify:async value=>value.payload_digest===snapshot.payload_digest&&value.sealed_contract===snapshot.sealed_contract,reserve:async()=>{if(reserved)return 'replay';reserved=true;return 'reserved';}});
 const effect={run_id:randomUUID(),attempt_id:randomUUID(),operation_name:'reply_message',scope:payload.scope,account:captured.metadata.account,draft_ref:{draft_state_key:'drafts',draft_id,expected_revision:1},snapshot_ref:{snapshot_id:snapshot.snapshot_id,digest:snapshot.payload_digest},expires_at:new Date(1060000).toISOString()};
 const runtime=createOutgoingSendRuntime({now:()=>1000000,snapshots,custody:{async getAccessToken(){return 'fixture-token';}},host:{async resolveEffect(){return effect;},async assertEffect(){return true;},async loadSnapshot(){return snapshot;},async reserveTransport(){return true;},async recordOutcome(value){outcome=value;return true;},async readOutcome(){return outcome;}},fetch:async(url,init)=>{
  posts++;assert.equal(new URL(url).pathname.endsWith('/messages/send'),true);assert.equal(JSON.parse(init.body).threadId,source.provider_source.locator.thread_id);return json({id:'accepted-reply'});
 }});
 const result=await runtime.execute({run_id:effect.run_id,attempt_id:effect.attempt_id});assert.equal(result.status,'returned');assert.equal(posts,1);
 await runtime.execute({run_id:effect.run_id,attempt_id:effect.attempt_id});assert.equal(posts,1,'Prior journal outcome never grants another POST');
});
test('a terminal metadata failure remains incomplete even though the provider cursor is exhausted',async()=>{
 const f=await fixture({count:1});f.provider(async(u)=>u.pathname.endsWith('/messages')?json({messages:[{id:'m0'}]}):json(mail('different')));
 const page=await f.browse();assert.equal(page.schema_version,'deft.app_provider_browse_page.v1');assert.equal(page.next_cursor,null);assert.equal(page.complete,false);assert.equal(page.failure_count,1);assert.equal(page.count.exact_total,null);assert.deepEqual(page.items,[]);
});
test('metadata search cannot match secret body/hidden headers or inject Gmail operators',async()=>{
 const f=await fixture();f.context.search_fields=['subject'];
 const rows=[{...mail('body'),snippet:'secret needle',payload:{...mail('body').payload,headers:[{name:'Subject',value:'ordinary'},{name:'From',value:'secret needle@example.test'}],body:{data:Buffer.from('secret needle').toString('base64url')}}},
  {...mail('visible'),payload:{...mail('visible').payload,headers:[{name:'Subject',value:'Visible secret needle'}]}}];
 f.provider(async(u)=>u.pathname.endsWith('/messages')?json({messages:rows.map(row=>({id:row.id}))}):json(rows.find(row=>row.id===u.pathname.split('/').at(-1))));
 const page=await f.browse({operation:'search',query:'secret needle'});assert.equal(page.items.length,1);assert.equal(page.items[0].data.subject,'Visible secret needle');
 const query=new URL(f.calls.findLast(c=>new URL(c.url).pathname.endsWith('/messages')).url).searchParams.get('q');assert.equal(query,'((subject:"secret" subject:"needle"))');assert.equal(query.includes('from:'),false);
 await f.browse({operation:'search',query:'" OR in:anywhere has:attachment'});const escaped=new URL(f.calls.findLast(c=>new URL(c.url).pathname.endsWith('/messages')).url).searchParams.get('q');assert.equal(escaped,'((subject:"OR" subject:"in" subject:"anywhere" subject:"has" subject:"attachment"))');
 const before=f.calls.length;f.context.search_fields=['body','message_id'];await assert.rejects(f.browse({operation:'search',query:'secret'}));assert.equal(f.calls.length,before);
});
