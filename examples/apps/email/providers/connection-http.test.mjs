import {EMAIL_DOCUMENT_METADATA_FIELDS} from './resource-reader.mjs';
import {LogicalMailIndex,logicalMailIdForProviderMessage} from '../logical-mail-index.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppConnectionAdapter,createEmailConnectionHttp} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {oauthAccountKey} from './oauth-contract.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';

const copy=value=>structuredClone(value),reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function memoryStore(){
 const rows=new Map(),queues=new Map();
 return {rows,async withLock({key},callback){const prior=queues.get(key)??Promise.resolve();let release;const next=new Promise(resolve=>{release=resolve;});queues.set(key,next);await prior;try{return await callback({async read(){return copy(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const row=rows.get(key);if((row?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(row?.revision??0)+1,value:copy(value)});return true;}});}finally{release();if(queues.get(key)===next)queues.delete(key);}}};
}
async function fixture({capabilities=['read','search','thread'],allowed=['list_summary','read_one','search'],action=null}={}){
 let time=1_000_000,tick=0,denied=false,sendLive=true,resourceLive=true,afterFetch=null;
 const projection={purpose:'connect',org_id:'org',owner_user_id:'owner',web_session_id:'sid',experience_session_id:'experience',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',target_key:'google_connection',resource_key:'gmail_mailbox',resource_binding_id:'resource',runtime_registration_id:'registration',descriptor_digest:'digest',action_key:action?'email_send':null,action_binding_id:action,allowed_operations:allowed,lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,expires_at:time+300000,checked_at:time};
 const options={origin:'https://deft.example.test',account_id:'google-a',provider:'gmail',authority_epoch:7,connection_target:'google_connection',resource_binding_id:'resource',action_binding_id:action,capabilities,clients:{gmail:{client_id:'google-client',client_secret:'private-client-secret',redirect_uri:'https://deft.example.test/apps/connections/callback'}}};
 const store=memoryStore(),now=()=>time,custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(4),key_id:'test-key',store,now}),calls=[];
 const authorized=()=>{if(denied||!resourceLive||projection.purpose==='connect'&&action&&!sendLive)throw Error('private host reason');return copy(projection);};
 const host={async resolveContext(context){assert.equal(context,'trusted-context');return authorized();},async assertCurrent(context){assert.equal(context,'trusted-context');return authorized();}};
 const fetch=async(url,init)=>{calls.push({url,init});let result;
  if(url==='https://oauth2.googleapis.com/token'){assert.equal(init.body.get('code'),'provider-code');result=reply({access_token:'private-access-token',refresh_token:'private-refresh-token',token_type:'Bearer',expires_in:120,scope:init.body.get('scope')??'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});}
  else if(url==='https://openidconnect.googleapis.com/v1/userinfo')result=reply({sub:'private-provider-subject',email:'verified@example.test',email_verified:true,name:'Verified mailbox'});
  else if(url==='https://gmail.googleapis.com/gmail/v1/users/me/profile')result=reply({emailAddress:'verified@example.test'});
  else assert.fail('Unexpected network effect: '+url);
  await afterFetch?.({url,init});return result;
 };
 const adapter=await createAppConnectionAdapter({host,options,custody,fetch,now,monotonic:()=>tick});
 const request=(route,body={})=>{projection.purpose=route==='manage'?(body.operation??'status'):'connect';return new Request('https://deft-connection.invalid/connections/'+route,{method:'POST',headers:{'content-type':'application/json',origin:options.origin},body:JSON.stringify(body)});};
 const invoke=async(route,body)=>{const response=await adapter.handle(request(route,body),'trusted-context');return {response,data:await response.json()};};
 const begin=()=>invoke('begin');
 const callback=async(state,params={code:'provider-code'})=>{projection.purpose='connect';const url=new URL('https://deft-connection.invalid/connections/callback');url.searchParams.set('state',state);for(const [key,value]of Object.entries(params))url.searchParams.set(key,value);const response=await adapter.handle(new Request(url,{headers:{origin:options.origin}}),'trusted-context');return {response,data:await response.json()};};
 const connect=async()=>{const pending=await begin();assert.equal(pending.response.status,200);return callback(new URL(pending.data.authorization_url).searchParams.get('state'));};
 const binding={scope:{org_id:'org',owner_id:'owner',installation_id:'installation'},account_id:options.account_id,provider:options.provider,connection_target:options.connection_target,resource_binding_id:options.resource_binding_id,action_binding_id:options.action_binding_id,authority_epoch:options.authority_epoch,capabilities};
 return {adapter,options,projection,store,custody,calls,host,fetch,now,request,invoke,begin,callback,connect,binding,deny:()=>{denied=true;},withdrawSend:()=>{sendLive=false;},revokeResource:()=>{resourceLive=false;},advance:ms=>{time+=ms;tick+=ms;},tick:ms=>{tick+=ms;},afterFetch:fn=>{afterFetch=fn;}};
}
const stateOf=result=>new URL(result.data.authorization_url).searchParams.get('state');
const assertPrivate=value=>{const text=JSON.stringify(value);for(const field of ['access_token','refresh_token','provider_subject','client_secret','connection_target','resource_binding_id','action_binding_id','authority_epoch','private-'])assert.equal(text.includes(field),false,field+' leaked');};

test('private deployment payload builder reads verified account without refreshing or sending',async()=>{
 const f=await fixture({capabilities:['read','send'],action:'send-binding'});await f.connect();f.projection.action_key='send_message';
 const input={to:'controlled@example.test',subject:'Saved draft',body:'Exact saved body'};
 const request={binding:{org_id:'org',owner_user_id:'owner',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',
  resource_target_key:'google_connection',action_key:'send_message',runtime_binding_id:'send-binding',draft_id:'saved-draft',draft_revision:1},
  input,draft_value:{...input,mode:'compose'},draft_updated_at:new Date(f.now()).toISOString(),files:[],max_payload_bytes:4194304,
  expires_at:new Date(f.now()+60000).toISOString()};
 const before=f.calls.length,result=await f.adapter.buildActionPayload(request,'trusted-context');
 assert.equal(result.metadata.preview.items[0].value,'verified@example.test');assert.ok(result.bytes.length>0);assert.equal(f.calls.length,before);
 for(const field of ['access_token','refresh_token','client_secret','private-access-token','private-provider-subject'])assert.equal(JSON.stringify(result.metadata).includes(field),false);
 await assert.rejects(f.adapter.buildActionPayload({...request,binding:{...request.binding,owner_user_id:'other'}},'trusted-context'));
 f.withdrawSend();await assert.rejects(f.adapter.buildActionPayload(request,'trusted-context'));assert.equal(f.calls.length,before);
});

test('saved Send reads the existing custody ceiling without requiring optional connection reviews',async()=>{
 for(const optional of [['modify'],['modify','permanent_delete']]){
  const f=await fixture({capabilities:['read','search','thread','send',...optional],action:'send-binding'});
  f.projection.reviewed_action_keys=['triage_message',...(optional.includes('permanent_delete')?['permanent_delete_message']:[])];
  await f.connect();
  // Human Send capture has its own exact Send authority, not a new OAuth review.
  delete f.projection.reviewed_action_keys;f.projection.action_key='send_message';
  const input={to:'controlled@example.test',subject:'Saved draft',body:'Exact saved body'};
  const request={binding:{org_id:'org',owner_user_id:'owner',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',
   resource_target_key:'google_connection',action_key:'send_message',runtime_binding_id:'send-binding',draft_id:'saved-draft',draft_revision:1},
   input,draft_value:{...input,mode:'compose'},draft_updated_at:new Date(f.now()).toISOString(),files:[],max_payload_bytes:4194304,expires_at:new Date(f.now()+60000).toISOString()};
  const before=f.calls.length,custodyBefore=copy([...f.store.rows]);
  const result=await f.adapter.buildActionPayload(request,'trusted-context');
  assert.equal(result.metadata.preview.items[0].value,'verified@example.test');assert.ok(result.bytes.length>0);
  assert.equal(f.calls.length,before);assert.deepEqual([...f.store.rows],custodyBefore);
  for(const field of ['owner_user_id','runtime_binding_id','app_version_id','grant_snapshot_id'])await assert.rejects(f.adapter.buildActionPayload({...request,binding:{...request.binding,[field]:'other'}},'trusted-context'));
  f.revokeResource();await assert.rejects(f.adapter.buildActionPayload(request,'trusted-context'));assert.equal(f.calls.length,before);
 }
});

test('real factory begin/callback/status/disconnect uses encrypted custody and public views',async()=>{
 const f=await fixture();assert.deepEqual((await f.invoke('manage')).data,{state:'not_connected',account:null});assert.equal(f.calls.length,0);
 const pending=await f.begin();assert.equal(pending.response.status,200);assert.equal(typeof pending.data.expires_at,'number');assert.equal(new URL(pending.data.authorization_url).origin,'https://accounts.google.com');assertPrivate(pending.data);
 const result=await f.callback(stateOf(pending));assert.equal(result.response.status,200);assert.equal(result.data.state,'connected');assert.equal(result.data.account.health,'connected');assert.equal(result.data.account.primary_address,'verified@example.test');assert.deepEqual(result.data.account.capabilities,['read','search','thread']);assertPrivate(result.data);
 const before=f.calls.length,status=await f.invoke('manage',{});assert.deepEqual(status.data,result.data);assert.equal(f.calls.length,before);
 const disconnected=await f.invoke('manage',{operation:'disconnect'});assert.equal(disconnected.data.state,'revoked');assert.equal(disconnected.data.account.health,'revoked');assertPrivate(disconnected.data);assert.equal(f.calls.length,before);
 const durable=JSON.stringify([...f.store.rows.values()]);for(const secret of ['private-access-token','private-refresh-token','private-provider-subject','verified@example.test',stateOf(pending)])assert.equal(durable.includes(secret),false);
 assert.equal(f.store.rows.get(oauthAccountKey(f.binding)).value.health,'revoked');
});

test('new adapter instance reconstructs truthful status from same encrypted custody',async()=>{
 const f=await fixture();await f.connect();const reopened=await createAppConnectionAdapter({host:f.host,options:f.options,custody:f.custody,fetch:f.fetch,now:f.now});
 const response=await reopened.handle(f.request('manage'),'trusted-context');assert.equal((await response.json()).state,'connected');assert.equal(f.calls.length,3);
});

test('browser cannot nominate mapping, scope, provider, URLs or trusted setup',async()=>{
 const f=await fixture();for(const extra of [{account_id:'other'},{provider:'microsoft'},{scope:{owner_id:'other'}},{authorization_url:'https://attacker.test'},{context:'attacker'}]){const result=await f.invoke('begin',extra);assert.equal(result.response.status,400);assertPrivate(result.data);}
 for(const operation of ['send','revoke_provider_grant','connect'])assert.equal((await f.invoke('manage',{operation})).response.status,400);
 const foreign=new Request('https://attacker.test/connections/begin',{method:'POST',body:'{}'});assert.equal((await f.adapter.handle(foreign,'trusted-context')).status,403);
 const crossOrigin=new Request('https://deft-connection.invalid/connections/begin',{method:'POST',headers:{origin:'https://attacker.test'},body:'{}'});assert.equal((await f.adapter.handle(crossOrigin,'trusted-context')).status,403);assert.equal(f.calls.length,0);assert.equal(f.store.rows.size,0);
});

test('strict callback shape rejects duplicate and arbitrary parameters before custody/provider I/O',async()=>{
 const f=await fixture(),pending=await f.begin(),state=stateOf(pending);
 for(const suffix of ['&state=duplicate','&redirect_uri=https://attacker.test','&error=access_denied','&code=duplicate']){const response=await f.adapter.handle(new Request('https://deft-connection.invalid/connections/callback?state='+state+'&code=provider-code'+suffix),'trusted-context');assert.equal(response.status,400);assertPrivate(await response.json());}
 assert.equal(f.calls.length,0);assert.equal((await f.callback(state)).response.status,200);
});

test('provider cancellation is bounded non2xx and burns one-use browser-bound state',async()=>{
 const f=await fixture(),pending=await f.begin();const cancelled=await f.callback(stateOf(pending),{error:'access_denied'});assert.equal(cancelled.response.status,400);assert.equal(cancelled.data.code,'EMAIL_CONNECTION_CANCELLED');assertPrivate(cancelled.data);assert.equal(f.calls.length,0);
 assert.equal((await f.callback(stateOf(pending))).response.status,403);assert.equal(f.calls.length,0);assert.equal((await f.invoke('manage')).data.state,'not_connected');
});

test('callback from another authenticated SID cannot consume original browser state',async()=>{
 const f=await fixture(),pending=await f.begin();f.projection.web_session_id='other-sid';const denied=await f.callback(stateOf(pending));assert.equal(denied.response.status,403);assert.equal(f.calls.length,0);
 f.projection.web_session_id='sid';assert.equal((await f.callback(stateOf(pending))).response.status,200);
});

test('callback for a different immutable server account denies before token exchange',async()=>{
 const f=await fixture(),pending=await f.begin();const other=await createAppConnectionAdapter({host:f.host,options:{...f.options,account_id:'google-b'},custody:f.custody,fetch:f.fetch,now:f.now});
 const url='https://deft-connection.invalid/connections/callback?state='+stateOf(pending)+'&code=provider-code';assert.equal((await other.handle(new Request(url),'trusted-context')).status,403);assert.equal(f.calls.length,0);
});

test('fresh host authority loss after exchange denies before identity disclosure or connected response',async()=>{
 const f=await fixture(),pending=await f.begin();f.afterFetch(()=>f.deny());const result=await f.callback(stateOf(pending));assert.equal(result.response.status,403);assert.equal(f.calls.length,1);assertPrivate(result.data);assert.equal(f.store.rows.get(oauthAccountKey(f.binding)).value.health,'revoked');
});

test('host lifecycle/grant/runtime identity changes during provider I/O fail closed',async()=>{
 for(const key of ['owner_user_id','target_key','resource_binding_id','app_version_id','grant_snapshot_id','runtime_registration_id','descriptor_digest','experience_session_id','lifecycle_epoch','grant_epoch','runtime_epoch']){
  const f=await fixture(),pending=await f.begin();f.afterFetch(()=>{f.projection[key]=typeof f.projection[key]==='number'?2:'changed';});const result=await f.callback(stateOf(pending));assert.equal(result.response.status,403,key);assert.equal(f.calls.length,1,key);assertPrivate(result.data);
 }
});

test('checked_at and renewed deadline are dynamic but captured DB upper-time deadline cannot extend',async()=>{
 const dynamic=await fixture(),pending=await dynamic.begin();dynamic.afterFetch(()=>{dynamic.projection.checked_at+=1;dynamic.projection.expires_at+=100000;});assert.equal((await dynamic.callback(stateOf(pending))).response.status,200);
 const expired=await fixture(),next=await expired.begin();expired.afterFetch(()=>{expired.tick(300001);expired.projection.expires_at+=1000000;});const result=await expired.callback(stateOf(next));assert.equal(result.response.status,403);assert.equal(expired.calls.length,1);
 const skew=await fixture();skew.projection.checked_at+=500000;skew.projection.expires_at=skew.projection.checked_at+100;const last=await skew.begin();skew.afterFetch(()=>skew.tick(101));assert.equal((await skew.callback(stateOf(last))).response.status,403);assert.equal(skew.calls.length,1);
});

test('list_summary alone never mints full read; search/thread permissions are explicitly intersected',async()=>{
 const summary=await fixture({allowed:['list_summary'],capabilities:['read']});assert.notEqual((await summary.begin()).response.status,200);assert.equal(summary.calls.length,0);
 const narrow=await fixture({allowed:['read_one'],capabilities:['read','search']});const result=await narrow.connect();assert.deepEqual(result.data.account.capabilities,['read']);
 const thread=await fixture({allowed:['read_one'],capabilities:['thread']});assert.deepEqual((await thread.connect()).data.account.capabilities,['thread']);
 const search=await fixture({allowed:['search'],capabilities:['read','search','thread']});assert.deepEqual((await search.connect()).data.account.capabilities,['search']);
});

test('send scope only follows exact server action mapping and never causes a send',async()=>{
 const read=await fixture();const pending=await read.begin();assert.equal(new URL(pending.data.authorization_url).searchParams.get('scope').includes('gmail.send'),false);
 const send=await fixture({capabilities:['read','send'],action:'action-binding'});const approved=await send.begin();assert.equal(new URL(approved.data.authorization_url).searchParams.get('scope').includes('gmail.send'),true);assert.equal((await send.callback(stateOf(approved))).data.account.capabilities.includes('send'),true);assert.equal(send.calls.length,3);
 const changed=await fixture({capabilities:['read','send'],action:'action-binding'});changed.projection.action_binding_id='other-action';assert.equal((await changed.begin()).response.status,403);assert.equal(changed.calls.length,0);
});

test('local disconnect rejects earlier callback while host account epoch remains unchanged',async()=>{
 const f=await fixture();await f.connect();const pending=await f.begin();await f.invoke('manage',{operation:'disconnect'});const count=f.calls.length;assert.equal((await f.callback(stateOf(pending))).response.status,403);assert.equal(f.calls.length,count);assert.equal((await f.invoke('manage')).data.state,'revoked');assert.equal(f.options.authority_epoch,7);
});

test('public connected callback requires durable publication acknowledgement',async()=>{
 const f=await fixture(),binding=f.binding,setup={binding,browser_binding:'server-sid',expires_at:f.now()+300000};let ack=false;
 const http=createEmailConnectionHttp({clients:f.options.clients,custody:f.custody,origin:f.options.origin,fetch:f.fetch,now:f.now,host:{async resolveSetup(){return setup;},async assertAuthority(){return {allowed:true,expires_at:setup.expires_at};},async publishAccount({account}){assert.equal(account.health,'connected');return ack;}}});
 const response=await http.handle(f.request('begin')),pending=await response.json(),url=new URL('https://deft-connection.invalid/connections/callback');url.searchParams.set('state',new URL(pending.authorization_url).searchParams.get('state'));url.searchParams.set('code','provider-code');const result=await http.handle(new Request(url));assert.equal(result.status,503);assert.equal((await result.json()).code,'EMAIL_CONNECTION_PUBLICATION_UNCONFIRMED');
 ack=true;assert.equal((await http.handle(f.request('manage'))).status,200);
});

test('bounded invalid bodies, methods and generic host errors do not expose secrets',async()=>{
 const f=await fixture();for(const body of ['[1]','{"operation":"status","extra":true}','{',' '.repeat(5000)]){const response=await f.adapter.handle(new Request('https://deft-connection.invalid/connections/manage',{method:'POST',body}),'trusted-context');assert.equal(response.status,400);assertPrivate(await response.json());}
 assert.equal((await f.adapter.handle(new Request('https://deft-connection.invalid/connections/begin'),'trusted-context')).status,405);
 f.deny();const result=await f.begin();assert.equal(result.response.status,403);assertPrivate(result.data);assert.equal(JSON.stringify(result.data).includes('private host reason'),false);assert.equal(f.calls.length,0);
});

test('withdrawn Send still permits status/local discard with unchanged custody pins and capability ceiling',async()=>{
 const f=await fixture({capabilities:['read','search','thread','send'],action:'action-binding'});
 const connected=await f.connect(),pending=await f.begin();assert.equal(connected.response.status,200);
 const prior=await f.custody.withAccount(f.binding,tx=>tx.read()),storedBefore=copy([...f.store.rows]);
 f.withdrawSend();f.advance(121000); // Access token expired; status must still make no refresh request.
 const count=f.calls.length,status=await f.invoke('manage');assert.equal(status.response.status,200);assert.deepEqual(status.data,connected.data);assertPrivate(status.data);
 assert.deepEqual([...f.store.rows],storedBefore,'status does not rewrite or rebind ciphertext');
 assert.equal((await f.begin()).response.status,403);assert.equal((await f.callback(stateOf(pending))).response.status,403);
 const disconnected=await f.invoke('manage',{operation:'disconnect'});assert.equal(disconnected.response.status,200);assert.equal(disconnected.data.state,'revoked');assertPrivate(disconnected.data);
 const settled=await f.custody.withAccount(f.binding,tx=>tx.read());assert.deepEqual(settled.binding,prior.binding);assert.equal(settled.setup_generation,prior.setup_generation+1);
 assert.equal(settled.secret.access_token,'discarded');assert.equal(settled.secret.refresh_token,'discarded');assert.equal(settled.secret.expires_at,0);assert.equal(settled.secret.identity.provider_subject,prior.secret.identity.provider_subject);
 assert.equal(f.calls.length,count,'status/disconnect never refresh, send or revoke remotely');
});

test('revoked resource authority denies both cleanup purposes without custody changes or provider I/O',async()=>{
 const f=await fixture({capabilities:['read','send'],action:'action-binding'});await f.connect();const before=copy([...f.store.rows]),count=f.calls.length;f.revokeResource();
 for(const body of [{},{operation:'disconnect'}]){const result=await f.invoke('manage',body);assert.equal(result.response.status,403);assertPrivate(result.data);assert.equal(JSON.stringify(result.data).includes('verified@example.test'),false);}
 assert.deepEqual([...f.store.rows],before);assert.equal(f.calls.length,count);
});

test('cross-purpose, absent and unknown projections fail before any state/custody/provider effect',async()=>{
 const f=await fixture();
 for(const [route,body,purpose]of [['begin',{},'status'],['manage',{},'connect'],['manage',{operation:'disconnect'},'status'],['manage',{},'disconnect']]){
  const request=f.request(route,body);f.projection.purpose=purpose;const response=await f.adapter.handle(request,'trusted-context');assert.equal(response.status,403);assertPrivate(await response.json());
 }
 const callback=new Request('https://deft-connection.invalid/connections/callback?state='+ 's'.repeat(32)+'&code=provider-code');f.projection.purpose='status';assert.equal((await f.adapter.handle(callback,'trusted-context')).status,403);
 for(const purpose of [undefined,'read','send','revoke_provider_grant']){const request=f.request('manage');if(purpose===undefined)delete f.projection.purpose;else f.projection.purpose=purpose;assert.equal((await f.adapter.handle(request,'trusted-context')).status,403);}
 assert.equal(f.store.rows.size,0);assert.equal(f.calls.length,0);
});

test('purpose changes during provider I/O cannot produce connected state or disclose identity',async()=>{
 const f=await fixture(),pending=await f.begin();f.afterFetch(()=>{f.projection.purpose='disconnect';});const result=await f.callback(stateOf(pending));assert.equal(result.response.status,403);assertPrivate(result.data);assert.equal(JSON.stringify(result.data).includes('verified@example.test'),false);assert.equal(f.calls.length,1);
 assert.equal(f.store.rows.get(oauthAccountKey(f.binding)).value.health,'revoked');
});

test('resource withdrawal after status custody lock release withholds the reconstructed identity',async()=>{
 const f=await fixture();await f.connect();const count=f.calls.length;
 const custody={...f.custody,async withAccount(binding,read){const result=await f.custody.withAccount(binding,read);f.revokeResource();return result;}};
 const adapter=await createAppConnectionAdapter({host:f.host,options:f.options,custody,fetch:f.fetch,now:f.now});
 const response=await adapter.handle(f.request('manage'),'trusted-context');assert.equal(response.status,403);const result=await response.json();assertPrivate(result);assert.equal(JSON.stringify(result).includes('verified@example.test'),false);assert.equal(f.calls.length,count);
});

test('summary-only source authority permits cleanup without changing the stored full capability binding',async()=>{
 const f=await fixture({capabilities:['read','search','thread','send'],action:'action-binding'}),connected=await f.connect();
 const before=copy([...f.store.rows]),prior=await f.custody.withAccount(f.binding,tx=>tx.read()),count=f.calls.length;f.projection.allowed_operations=['list_summary'];
 const status=await f.invoke('manage');assert.equal(status.response.status,200);assert.deepEqual(status.data,connected.data);assert.deepEqual([...f.store.rows],before);
 assert.notEqual((await f.begin()).response.status,200,'summary cannot acquire full mailbox OAuth scopes');
 const disconnected=await f.invoke('manage',{operation:'disconnect'});assert.equal(disconnected.response.status,200);assert.equal(disconnected.data.state,'revoked');
 const settled=await f.custody.withAccount(f.binding,tx=>tx.read());assert.deepEqual(settled.binding,prior.binding);assert.equal(settled.secret.access_token,'discarded');assert.equal(f.calls.length,count);
});

test('cleanup preserves an originally admitted subset of the configured ceiling after operations narrow',async()=>{
 const f=await fixture({capabilities:['read','search','send'],allowed:['read_one'],action:'action-binding'}),connected=await f.connect();assert.deepEqual(connected.data.account.capabilities,['read','send']);
 const before=copy([...f.store.rows]),prior=await f.custody.withAccount(f.binding,tx=>tx.read()),count=f.calls.length;assert.deepEqual(prior.binding.capabilities,['read','send']);f.projection.allowed_operations=['list_summary'];
 const status=await f.invoke('manage');assert.equal(status.response.status,200);assert.deepEqual(status.data,connected.data);assert.deepEqual([...f.store.rows],before,'status never upgrades the stored ceiling');
 const disconnected=await f.invoke('manage',{operation:'disconnect'});assert.equal(disconnected.response.status,200);const settled=await f.custody.withAccount(f.binding,tx=>tx.read());assert.deepEqual(settled.binding,prior.binding);assert.equal(settled.setup_generation,prior.setup_generation+1);assert.equal(f.calls.length,count);
});

test('cleanup status cannot promote stale pins, an old epoch or a larger stored ceiling to connected',async()=>{
 for(const changed of [{resource_binding_id:'new-resource'},{action_binding_id:'new-action'},{authority_epoch:8},{capabilities:['read','send']}]){
  const f=await fixture({capabilities:['read','search','send'],action:'action-binding'});await f.connect();const before=copy([...f.store.rows]),count=f.calls.length;
  const options={...f.options,...changed};if(changed.resource_binding_id)f.projection.resource_binding_id=changed.resource_binding_id;if(changed.action_binding_id)f.projection.action_binding_id=changed.action_binding_id;
  const adapter=await createAppConnectionAdapter({host:f.host,options,custody:f.custody,fetch:f.fetch,now:f.now});const response=await adapter.handle(f.request('manage'),'trusted-context');assert.equal(response.status,200);const result=await response.json();assert.equal(result.state,'reauth_required');assertPrivate(result);
  assert.deepEqual([...f.store.rows],before,'status never rebinds or upgrades credentials');assert.equal(f.calls.length,count);
 }
});


async function readerFixture(){
 const f=await fixture({capabilities:['read','send'],action:'send-binding'});await f.connect();
 const scope=f.binding.scope,index=new LogicalMailIndex(scope),row=index.upsert(scope,{account_id:f.binding.account_id,provider:'gmail',locator:{kind:'gmail',message_id:'private-native',thread_id:'private-thread',label_ids:['INBOX']},sender:'Peer <peer@example.test>',recipients:'verified@example.test, Other <other@example.test>',cc:'cc@example.test',subject:'Parent',message_id:'<parent@example.test>',references:'<prior@example.test>',body_status:'lazy',files_status:'unknown'});
 const record={record_id:'11111111-1111-4111-8111-111111111111',revision:'retained-revision',label:'Parent',data:{account_id:row.account_id,provider:'gmail',logical_message_id:row.logical_message_id}};
 const text='Selected plain body.\n<img src="https://external.invalid/passive">',headers=[{name:'From',value:'Peer <peer@example.test>'},{name:'Reply-To',value:'reply@example.test'},{name:'To',value:'verified@example.test, Other <other@example.test>'},{name:'Cc',value:'cc@example.test'},{name:'Subject',value:'Parent'},{name:'Message-ID',value:'<parent@example.test>'},{name:'References',value:'<prior@example.test>'}];
 let after=()=>{},reads=0;
 const fetch=async(url,init)=>{assert.equal(init.method,'GET');assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/private-native?format=full');reads++;const result=reply({id:'private-native',threadId:'private-thread',labelIds:['INBOX'],internalDate:String(f.now()),payload:{mimeType:'multipart/mixed',headers,parts:[{mimeType:'text/plain',filename:'',headers:[{name:'Content-Type',value:'text/plain; charset=utf-8'}],body:{size:Buffer.byteLength(text),data:Buffer.from(text).toString('base64url')}},{mimeType:'application/pdf',filename:'lazy.pdf',body:{attachmentId:'never-read',size:100}}]}});await after();return result;};
 const adapter=await createAppConnectionAdapter({host:f.host,options:f.options,custody:f.custody,fetch,now:f.now,indexStore:{load:async()=>index.exportState(scope)}});
 f.projection.purpose='read_document';f.projection.content_policy={document:{max_characters:16}};
 return {...f,adapter,record,headers,index,row,scope,text,reads:()=>reads,after:fn=>{after=fn;}};
}
test('governed reader resolves private account locator and returns exact bounded plain metadata, never files',async()=>{
 const f=await readerFixture(),result=await f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context');
 assert.deepEqual(Object.keys(result.metadata).sort(),Object.keys(EMAIL_DOCUMENT_METADATA_FIELDS).sort());
 assert.equal(result.format,'plain');assert.equal(result.content,f.text.slice(0,16));assert.equal(result.truncated,true);assert.equal(result.metadata.reply_to,'reply@example.test');assert.equal(f.reads(),1);
 assert.equal(JSON.stringify(result).includes('private-native'),false);assert.equal(JSON.stringify(result).includes('access_token'),false);
 f.headers.find(row=>row.name==='Message-ID').value='';assert.equal((await f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context')).metadata.message_id,'');
});
test('reader denies account/locator injection, absent policy, revocation and current tombstone after I/O',async()=>{
 for(const mutate of [f=>{f.record.data.account_id='other';},f=>{f.record.data.logical_message_id='provider-native';},f=>{delete f.projection.content_policy;},f=>{f.projection.allowed_operations=['list_summary'];},f=>{f.projection.runtime_epoch++;f.after(()=>{f.projection.runtime_epoch++;});},f=>{f.after(()=>f.revokeResource());}]){
  const f=await readerFixture();mutate(f);await assert.rejects(f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context'));
 }
 const f=await readerFixture();f.after(()=>f.index.recordProviderDeletion(f.scope,{account_id:f.binding.account_id,provider:'gmail',provider_message_id:'private-native',provider_conversation_id:'private-thread',evidence:{kind:'provider_mailbox_deleted',event_id:'history-deleted',authority_epoch:7,observed_at:new Date(f.now()).toISOString()}}));await assert.rejects(f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context'));
});
test('trusted Reply all capture re-reads nominated parent and seals recipients/thread headers/PDF without Send',async()=>{
 const f=await readerFixture();f.projection.purpose='connect';f.projection.action_key='send_message';
 const input={parent_record_id:f.record.record_id,to:'reply@example.test',cc:'other@example.test, cc@example.test',subject:'Re: Parent',body:'Exact reply body.\n'},request={binding:{org_id:'org',owner_user_id:'owner',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',resource_target_key:'google_connection',action_key:'send_message',runtime_binding_id:'send-binding',draft_id:'saved-draft',draft_revision:1},input,draft_value:{...input,mode:'reply_all',reply_record_id:input.parent_record_id},draft_updated_at:new Date(f.now()).toISOString(),files:[],max_payload_bytes:4194304,expires_at:new Date(f.now()+60000).toISOString(),source_records:{parent_record_id:[{...f.record,resource_key:'inbox',resource_binding_id:'resource'}]}};
 const built=await f.adapter.buildActionPayload(request,'trusted-context');assert.equal(f.reads(),1);assert.deepEqual(built.metadata.payload.to.map(row=>row.address),['reply@example.test']);assert.deepEqual(built.metadata.payload.cc.map(row=>row.address),['other@example.test','cc@example.test']);assert.equal(built.metadata.payload.reply_headers.in_reply_to,'<parent@example.test>');assert.deepEqual(built.metadata.payload.reply_headers.references,['<prior@example.test>','<parent@example.test>']);assert.equal(built.metadata.payload.mode,'reply_all');
 for(const mutation of [r=>{delete r.source_records;},r=>{r.source_records.parent_record_id[0].resource_binding_id='other';},r=>{r.source_records.parent_record_id[0].data.account_id='other';},r=>{r.input.to='attacker@example.test';r.draft_value.to=r.input.to;}]){const changed=copy(request);mutation(changed);await assert.rejects(f.adapter.buildActionPayload(changed,'trusted-context'));}
});

test('governed document carries only current attested historical coverage and withholds after expiry',async()=>{
 const f=await readerFixture(),mark=extra=>f.index.markCoverage(f.scope,{account_id:f.binding.account_id,conversation_id:f.row.conversation_id,complete:true,covers_folders:['INBOX','SENT'],observed_at:new Date(f.now()-86400000).toISOString(),authority_epoch:f.binding.authority_epoch,resource_binding_id:f.binding.resource_binding_id,...extra});
 mark();let result=await f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context');assert.equal(result.metadata.conversation_coverage_state,'complete');assert.equal(result.metadata.conversation_exact_count,'1');assert.equal(result.metadata.conversation_drained,'true');
 mark({authority_epoch:6});result=await f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context');assert.equal(result.metadata.conversation_coverage_state,'stale');assert.equal(result.metadata.conversation_exact_count,'');
 mark({authority_epoch:null,resource_binding_id:null});result=await f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context');assert.equal(result.metadata.conversation_coverage_state,'unknown');
 mark();f.after(()=>f.advance(3600000));await assert.rejects(f.adapter.readResource({operation:'read_document',record:f.record},'trusted-context'));
});
test('retained owner cleanup with zero mailbox operations discards exact encrypted credentials without refreshing or granting',async()=>{
 const f=await fixture({capabilities:['read','search','thread','send'],action:'action-binding'}),connected=await f.connect();
 const before=copy([...f.store.rows]),prior=await f.custody.withAccount(f.binding,tx=>tx.read()),count=f.calls.length;f.projection.allowed_operations=[];
 const status=await f.invoke('manage');assert.equal(status.response.status,200);assert.deepEqual(status.data,connected.data);assert.deepEqual([...f.store.rows],before);
 assert.notEqual((await f.begin()).response.status,200,'retained cleanup cannot admit provider OAuth');
 const disconnected=await f.invoke('manage',{operation:'disconnect'});assert.equal(disconnected.response.status,200);assert.equal(disconnected.data.state,'revoked');
 const settled=await f.custody.withAccount(f.binding,tx=>tx.read());assert.deepEqual(settled.binding,prior.binding);assert.equal(settled.secret.access_token,'discarded');assert.equal(f.calls.length,count);
});
test('governed source uses existing exact read consent and actual provider bytes, never display reconstruction',async()=>{
 const f=await readerFixture(),bytes=Buffer.from('From: original@example.test\r\nSubject: Original wire source\r\n\r\nActual provider bytes.\r\n');
 let calls=0,after=()=>{};const fetch=async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(new URL(url).searchParams.get('format'),'raw');assert.equal(new URL(url).pathname,'/gmail/v1/users/me/messages/private-native');await after();return new Response(JSON.stringify({id:'private-native',raw:bytes.toString('base64url')}),{headers:{'content-type':'application/json'}});};
 const adapter=await createAppConnectionAdapter({host:f.host,options:f.options,custody:f.custody,fetch,now:f.now,indexStore:{load:async()=>f.index.exportState(f.scope)}});
 f.projection.purpose='read_source';f.projection.content_policy.source={media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608};
 const source=await adapter.readSource({record:f.record},'trusted-context');assert.deepEqual(Buffer.from(source.bytes),bytes);assert.equal(source.media_type,'message/rfc822');assert.equal(source.filename,'message.eml');assert.equal(calls,1);
 delete f.projection.content_policy.source;await assert.rejects(adapter.readSource({record:f.record},'trusted-context'));assert.equal(calls,1);
 f.projection.content_policy.source={media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608};after=()=>f.revokeResource();await assert.rejects(adapter.readSource({record:f.record},'trusted-context'));assert.equal(calls,2);
});
test('actual governed provider source port lists and downloads MIME files; current account/revocation deny before handoff',async()=>{
 const f=await readerFixture(),bytes=Buffer.from('From: original@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=files\r\n\r\n--files\r\nContent-Type: text/plain\r\n\r\nControlled body\r\n--files\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="controlled.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nRXhhY3QgYnl0ZXM=\r\n--files--\r\n');
 let calls=0,after=()=>{};const fetch=async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(new URL(url).searchParams.get('format'),'raw');await after();return new Response(JSON.stringify({id:'private-native',raw:bytes.toString('base64url')}),{headers:{'content-type':'application/json'}});};
 const adapter=await createAppConnectionAdapter({host:f.host,options:f.options,custody:f.custody,fetch,now:f.now,indexStore:{load:async()=>f.index.exportState(f.scope)}});
 f.projection.purpose='read_source';f.projection.content_policy.source={media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608};
 const listed=await adapter.readSourceFiles({record:f.record},'trusted-context');assert.equal(listed.files[0].filename,'controlled.txt');const downloaded=await adapter.readSourceFiles({record:f.record,file_ref:listed.files[0].file_ref},'trusted-context');assert.equal(Buffer.from(downloaded.bytes).toString(),'Exact bytes');
 const transient={...f.record,data:{...f.record.data,conversation_id:f.row.conversation_id},provider_source:providerSourceForParent({account_id:f.binding.account_id,provider:'gmail',authority_epoch:f.binding.authority_epoch},f.row)};
 const presented=await adapter.readSourceFiles({record:transient,presentation:true},'trusted-context');assert.equal(presented.presentation.content,'Controlled body');assert.equal(presented.presentation.metadata.account_id,f.binding.account_id);assert.deepEqual(JSON.parse(presented.presentation.metadata.verified_sender_identities),['verified@example.test']);assert.equal(presented.presentation.metadata.conversation_id,f.row.conversation_id);
 const before=calls;await assert.rejects(adapter.readSourceFiles({record:{...f.record,data:{...f.record.data,account_id:'foreign'}}},'trusted-context'));assert.equal(calls,before);
 after=()=>f.revokeResource();await assert.rejects(adapter.readSourceFiles({record:f.record,file_ref:listed.files[0].file_ref},'trusted-context'));
});

test('new mutation scopes require exact current reviewed action keys and the configured capability ceiling',async()=>{
 const configured=['read','send','modify','permanent_delete'];
 for(const [keys,modify,permanent]of [[undefined,false,false],[[],false,false],[['send_message'],false,false],[['triage_message'],true,false],[['permanent_delete_message'],false,true],[['triage_message','permanent_delete_message'],true,true]]){
  const f=await fixture({capabilities:configured,action:'send-binding'});if(keys!==undefined)f.projection.reviewed_action_keys=keys;
  const begin=await f.begin();assert.equal(begin.response.status,200);const scopes=new URL(begin.data.authorization_url).searchParams.get('scope').split(' ');
  assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.modify'),modify);assert.equal(scopes.includes('https://mail.google.com/'),permanent);assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.send'),true);assert.equal(f.calls.length,0);
 }
 const narrow=await fixture({capabilities:['read','send'],action:'send-binding'});narrow.projection.reviewed_action_keys=['triage_message','permanent_delete_message'];const scopes=new URL((await narrow.begin()).data.authorization_url).searchParams.get('scope');assert.equal(scopes.includes('gmail.modify'),false);assert.equal(scopes.includes('https://mail.google.com/'),false);
 for(const keys of [['triage_message','triage_message'],['foreign-key'],['x'.repeat(49)],{},null]){const f=await fixture({capabilities:configured,action:'send-binding'});f.projection.reviewed_action_keys=keys;assert.equal((await f.begin()).response.status,403);assert.equal(f.calls.length,0);assert.equal(f.store.rows.size,0);}
});
test('review withdrawal during OAuth exchange prevents connected publication before identity discovery',async()=>{
 const f=await fixture({capabilities:['read','modify'],action:'send-binding'});f.projection.reviewed_action_keys=['triage_message'];const pending=await f.begin();f.afterFetch(()=>{f.projection.reviewed_action_keys=[];});const completed=await f.callback(stateOf(pending));assert.equal(completed.response.status,403);assert.equal(f.calls.length,1);assert.equal(JSON.stringify(completed.data).includes('verified@example.test'),false);
});

const nativeBarrier=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function nativeFixture(provider='gmail'){
 const f=await fixture();await f.connect();let allowed=true,checks=0,held=async()=>{};
 let options=copy(f.options),binding=copy(f.binding);
 if(provider==='microsoft'){
  options={...options,provider,account_id:'microsoft-a',connection_target:'ms_target',resource_binding_id:'ms_resource',clients:{microsoft:{client_id:'ms-client',client_secret:'fixture-ms-secret',redirect_uri:'https://deft.example.test/apps/connections/callback',tenant:'common'}}};
  binding={...binding,provider,account_id:options.account_id,connection_target:options.connection_target,resource_binding_id:options.resource_binding_id};
  const prior=await f.custody.withAccount(f.binding,tx=>tx.read());
  await f.custody.withAccount(binding,tx=>tx.write({health:'connected',secret:{...prior.secret,scopes:['offline_access','User.Read','Mail.Read'],
   client_fingerprint:createOAuthProvider({provider,client:options.clients.microsoft,fetch:f.fetch,now:f.now}).client_fingerprint}}));
 }
 const calls=[],state={labels:['INBOX'],next:null,malformed:false};
 const fetch=async(url,init)=>{
  calls.push({url,init});await held({url,init});const parsed=new URL(url);
  if(url==='https://oauth2.googleapis.com/token'){
   assert.equal(init.method,'POST');assert.equal(init.body.get('grant_type'),'refresh_token');
   return reply({access_token:'native-refreshed-fixture-token',token_type:'Bearer',expires_in:120});
  }
  assert.equal(init.method,'GET');assert.ok(init.headers.Authorization.startsWith('Bearer '));
  if(state.handler)return state.handler(url,init);
  if(provider==='gmail'){
   if(url==='https://openidconnect.googleapis.com/v1/userinfo')return reply({sub:'private-provider-subject',email:'verified@example.test',email_verified:true,name:'Verified mailbox'});
   if(parsed.pathname==='/gmail/v1/users/me/profile')return reply({emailAddress:'verified@example.test'});
   if(parsed.pathname==='/gmail/v1/users/me/messages')return reply({messages:[{id:'g-message-one',threadId:'g-thread'}],...(state.next?{nextPageToken:state.next}:{})});
   if(parsed.pathname==='/gmail/v1/users/me/messages/g-message-one')return reply({id:'g-message-one',threadId:'g-thread',labelIds:state.labels,internalDate:'100000',payload:{headers:[{name:'From',value:'sender@example.test'},{name:'To',value:'verified@example.test'},{name:'Subject',value:'Native fixture subject'},{name:'Message-ID',value:'fixture@mail'}]}});
  }else if(parsed.pathname==='/v1.0/me/messages'){
   assert.ok(init.headers.Prefer.includes('ImmutableId'));
   return reply({value:[state.malformed?{id:'bad'}:{id:'immutable-message',conversationId:'ms-conversation',parentFolderId:'inbox-id',from:{emailAddress:{address:'sender@example.test'}},toRecipients:[{emailAddress:{address:'verified@example.test'}}],subject:'Native Graph fixture',receivedDateTime:'2026-10-04T00:00:00.000Z',isRead:false,flag:{flagStatus:'flagged'},hasAttachments:false,internetMessageId:'graph-fixture@mail'}]});
  }
  assert.fail('Unexpected native provider effect: '+url);
 };
 const host={resolveContext:async()=>assert.fail('Native path must not resolve Experience context'),assertCurrent:async()=>assert.fail('Native path must not resolve Experience authority')};
 const adapter=await createAppConnectionAdapter({host,options,custody:f.custody,fetch,now:f.now});
 const context={org_id:'org',owner_user_id:'owner',account_id:options.account_id,installation_id:'installation',resource_binding_id:options.resource_binding_id,
  authority_version:'native-authority-1',expires_at:f.now()+60000,recheck:async()=>{checks++;if(!allowed)throw Error('denied');}};
 return {...f,adapter,options,binding,context,calls,state,checks:()=>checks,denyNative:()=>{allowed=false;},hold:fn=>{held=fn;}};
}
test('native account uses deployment identity and fresh custody without Experience, token renewal or provider I/O',async()=>{
 const f=await nativeFixture(),status=await f.adapter.nativeEmailAccount(f.context);
 assert.equal(status.account_id,'google-a');assert.notEqual(status.account_id,f.options.connection_target);assert.equal(status.health,'connected');assert.equal(status.connection_revision,1);assert.match(status.principal_digest,/^[a-f0-9]{64}$/);
 assert.equal(f.calls.length,0);assert.ok(f.checks()>=2);
 for(const key of ['access_token','refresh_token','provider_subject','client_secret','private-access-token'])assert.equal(JSON.stringify(status).includes(key),false);
 for(const changed of [{account_id:'wrong'},{resource_binding_id:'wrong'},{owner_user_id:'other'},{installation_id:'fabricated'},{projection:{}}])await assert.rejects(f.adapter.nativeEmailAccount({...f.context,...changed}));
 assert.equal(f.calls.length,0);f.denyNative();await assert.rejects(f.adapter.nativeEmailAccount(f.context));
});
test('native metadata fanout shares only pending SQL checks and still rejects a later revoke',async t=>{
 const f=await nativeFixture();let active=0,peak=0,count=0;
 const context={...f.context,recheck:async()=>{active++;peak=Math.max(peak,active);count++;
  try{await new Promise(resolve=>setImmediate(resolve));await f.context.recheck();}finally{active--;}}};
 f.state.handler=url=>{const id=new URL(url).pathname.split('/').at(-1);
  if(id==='messages')return reply({messages:Array.from({length:10},(_,n)=>({id:'parallel-'+n}))});
  return reply(nativeGmailMessage(id));};
 const page=await f.adapter.nativeEmailPage({cursor:null,limit:10},context);
 t.diagnostic(JSON.stringify({metadata_messages:10,sql_guard_calls:count,max_concurrent_guards:peak}));
 assert.equal(page.items.length,10);assert.equal(peak,1,'One runtime must not duplicate simultaneous SQL authority traversals');
 const prior=count;f.denyNative();await assert.rejects(f.adapter.nativeEmailPage({cursor:null,limit:10},context));
 assert.ok(count>prior,'Completed SQL decisions must never be reused');
});
test('native Gmail pages include spam/trash and preserve existing logical IDs without false complete coverage',async()=>{
 const f=await nativeFixture(),first=await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);
 assert.equal(first.complete,false);assert.equal(first.has_more,false);assert.equal(first.items.length,1);assert.equal(first.failure_count,0);assert.deepEqual(first.tombstones,[]);
 const listing=new URL(f.calls[0].url);assert.equal(listing.searchParams.get('includeSpamTrash'),'true');assert.equal(listing.searchParams.has('q'),false);assert.equal(listing.searchParams.has('labelIds'),false);
 const source=first.items[0].provider_source,expected=new LogicalMailIndex(f.binding.scope).upsert(f.binding.scope,{account_id:f.options.account_id,provider:'gmail',locator:source.locator});
 assert.equal(first.items[0].logical_message_id,expected.logical_message_id);assert.equal(first.items[0].data.subject,'Native fixture subject');
 f.state.labels=['SENT'];const moved=await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);
 assert.equal(moved.items[0].logical_message_id,first.items[0].logical_message_id);assert.deepEqual(moved.items[0].folders,['sent']);
 assert.equal(JSON.stringify(first).includes('private-access-token'),false);
});
test('native initial provider cursor reports remaining work separately from converged coverage',async()=>{
 const f=await nativeFixture();f.state.next='provider-page-two';const page=await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);
 assert.equal(page.has_more,true);assert.equal(page.complete,false);assert.equal(typeof page.next_cursor,'string');
 f.state.next=null;const last=await f.adapter.nativeEmailPage({cursor:page.next_cursor,limit:25},f.context);assert.equal(last.has_more,false);assert.equal(last.complete,false);
 assert.ok(f.calls.some(call=>new URL(call.url).searchParams.get('pageToken')==='provider-page-two'));
 await assert.rejects(f.adapter.nativeEmailPage({cursor:page.next_cursor,limit:0},f.context));
});
test('native Graph metadata uses immutable IDs and never treats its final collection page as all-folder convergence',async()=>{
 const f=await nativeFixture('microsoft'),page=await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);
 assert.equal(page.account_id,'microsoft-a');assert.equal(page.complete,false);assert.equal(page.has_more,false);assert.equal(page.items[0].provider_source.locator.id_type,'immutable');assert.equal(page.items[0].flags.flagged,true);
 f.state.malformed=true;const incomplete=await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);assert.equal(incomplete.failure_count,1);assert.equal(incomplete.complete,false);assert.deepEqual(incomplete.items,[]);
});
test('legacy disconnect immediately denies fresh native pages through custody health before more provider I/O',async()=>{
 const f=await nativeFixture();await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);const before=f.calls.length;
 await f.invoke('manage',{operation:'disconnect'});const status=await f.adapter.nativeEmailAccount(f.context);assert.equal(status.health,'revoked');assert.ok(status.connection_revision>1);
 await assert.rejects(f.adapter.nativeEmailPage({cursor:null,limit:25},f.context));assert.equal(f.calls.length,before);
});
test('disconnect during held native GET denies output and prevents later metadata GETs',async()=>{
 const f=await nativeFixture(),entered=nativeBarrier(),held=nativeBarrier();f.hold(async()=>{entered.release();await held.promise;});
 const page=f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);await entered.promise;await f.invoke('manage',{operation:'disconnect'});held.release();await assert.rejects(page);assert.equal(f.calls.length,1);
});
test('reconnect generation and changed provider principal invalidate held native pages',async()=>{
 for(const changed of ['generation','principal']){
  const f=await nativeFixture(),before=await f.adapter.nativeEmailAccount(f.context),entered=nativeBarrier(),held=nativeBarrier();f.hold(async()=>{entered.release();await held.promise;});
  const page=f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);await entered.promise;
  await f.custody.withAccount(f.binding,async tx=>{const prior=tx.read();await tx.write({health:'connected',secret:{...prior.secret,identity:{...prior.secret.identity,...(changed==='principal'?{provider_subject:'different-principal'}:{})}},advance_setup:changed==='generation'});});
  held.release();await assert.rejects(page);const after=await f.adapter.nativeEmailAccount(f.context);
  if(changed==='generation'){assert.ok(after.connection_revision>before.connection_revision);assert.equal(after.principal_digest,before.principal_digest);}else assert.notEqual(after.principal_digest,before.principal_digest);
 }
});
test('native SQL-only token authority never reenters custody, including token refresh',{timeout:2000},async()=>{
 const f=await nativeFixture();
 await f.custody.withAccount(f.binding,async tx=>{const prior=tx.read();await tx.write({health:'connected',secret:{...prior.secret,expires_at:f.now()-1}});});
 const page=await f.adapter.nativeEmailPage({cursor:null,limit:25},f.context);assert.equal(page.items.length,1);assert.ok(f.checks()>2);
 assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 const refreshed=await f.custody.withAccount(f.binding,tx=>tx.read());assert.equal(refreshed.secret.access_token,'native-refreshed-fixture-token');
});

function nativeStateFixture(f){
 let state=null,revision=0;const rows=new Map();
 const ports={async read(){return copy(state);},async stale(generation,_after,limit){return [...rows.values()].filter(row=>row.inventory_generation!==generation).slice(0,limit).map(({logical_message_id,provider_source})=>({logical_message_id,provider_source:copy(provider_source)}));}};
 const context={...f.context,provider_state:ports};
 const apply=page=>{assert.equal(page.failure_count,0);for(const item of page.items)rows.set(item.logical_message_id,copy(item));for(const id of page.tombstones)rows.delete(id);for(const update of page.state_updates)state={...copy(update),storage_revision:++revision};};
 const step=async(cursor=null,limit=2)=>{const page=await f.adapter.nativeEmailPage({cursor,limit},context);apply(page);return page;};
 const seed=id=>rows.set(logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'gmail',id),{logical_message_id:logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'gmail',id),inventory_generation:'old',provider_source:{account_id:f.options.account_id,locator:{kind:'gmail',message_id:id,thread_id:'g-thread',label_ids:[]}}});
 return {context,step,apply,rows,seed,state:()=>state};
}
const nativeGmailMessage=(id,labels=['INBOX'])=>({id,threadId:'g-thread',labelIds:labels,internalDate:'100000',payload:{headers:[{name:'Subject',value:'Converged '+id}]}});
test('native Gmail publishes arrivals during unfinished inventory without advancing its baseline checkpoint',async()=>{
 const f=await nativeFixture(),db=nativeStateFixture(f);let inventories=0,histories=0;
 f.state.handler=url=>{const u=new URL(url),id=u.pathname.split('/').at(-1);
  if(id==='profile')return reply({historyId:'100'});
  if(id==='messages'){inventories++;return reply({messages:[{id:'old-'+inventories}],nextPageToken:'inventory-'+inventories});}
  if(id==='history'){histories++;assert.equal(u.searchParams.get('maxResults'),'1');return reply(u.searchParams.get('startHistoryId')==='100'?{history:[{id:'101',messagesAdded:[{message:{id:'arrived-during-backfill'}}]}],historyId:'102'}:{history:[],historyId:'102'});}
  return reply(nativeGmailMessage(id));
 };
 let page=await db.step(null,1);const generation=page.generation;
 for(let n=0;n<3;n++)page=await db.step(page.next_cursor,1);
 assert.ok([...db.rows.values()].some(row=>row.data.subject==='Converged arrived-during-backfill'),'New mail must appear before an unbounded initial inventory finishes');
 assert.ok(histories>0);assert.ok(inventories>=2,'History must not starve older inventory');
 assert.equal(db.state().value.phase,'inventory');assert.equal(db.state().value.checkpoint,'100');assert.equal(page.complete,false);assert.equal(page.has_more,true);
 assert.equal(page.generation,generation);assert.ok(JSON.stringify(db.state()).length<65536);
});
test('native Gmail upgrades retained inventory and durably drains bounded history metadata without skipping older pages',async()=>{
 const f=await nativeFixture(),db=nativeStateFixture(f);let inventories=0,history=0;
 f.state.handler=url=>{const u=new URL(url),id=u.pathname.split('/').at(-1);
  if(id==='profile')return reply({historyId:'100'});
  if(id==='messages'){inventories++;return reply({messages:[{id:'old-'+inventories}],nextPageToken:'older-'+inventories});}
  if(id==='history'){history++;assert.equal(u.searchParams.get('startHistoryId'),'100');return reply({history:[{id:'101',messagesAdded:['new-a','gone','new-b'].map(id=>({message:{id}}))}],historyId:'102'});}
  return id==='gone'?new Response('{}',{status:404}):reply(nativeGmailMessage(id));
 };
 let page=await db.step(null,1);delete db.state().value.inventory_refresh; // existing deployed v1 state
 const initialCursor=db.state().value.cursor,generation=db.state().generation;db.seed('gone');
 page=await db.step(page.next_cursor,1);assert.equal(page.items[0].data.subject,'Converged new-a');
 assert.equal(db.state().value.cursor,initialCursor);assert.equal(db.state().value.inventory_refresh.pending.length,2);
 for(let n=0;n<4;n++)page=await db.step(page.next_cursor,1);
 assert.equal(history,1);assert.equal(inventories,3);assert.equal(db.state().generation,generation);
 assert.equal(db.state().value.checkpoint,'100');assert.equal(db.state().value.inventory_refresh.checkpoint,'102');
 assert.ok([...db.rows.values()].some(row=>row.data.subject==='Converged new-b'));
 assert.ok(![...db.rows.values()].some(row=>row.provider_source.locator.message_id==='gone'));
 assert.equal(page.complete,false);
 db.state().value.inventory_refresh.pending=['duplicate','duplicate'];
 const calls=f.calls.length;await assert.rejects(db.step(page.next_cursor,1),/EMAIL_NATIVE_STATE_INVALID/);assert.equal(f.calls.length,calls);
});
test('native Gmail expired interleaved history restarts safely and makes inventory progress',async()=>{
 const f=await nativeFixture(),db=nativeStateFixture(f);let profiles=0,inventories=0;
 f.state.handler=url=>{const id=new URL(url).pathname.split('/').at(-1);
  if(id==='profile')return reply({historyId:++profiles===1?'100':'200'});
  if(id==='messages'){inventories++;return reply({messages:[{id:'kept'}],nextPageToken:'older'});}
  if(id==='history')return new Response('{}',{status:404});return reply(nativeGmailMessage(id));};
 let page=await db.step(null,1);const generation=db.state().generation;
 page=await db.step(page.next_cursor,1);assert.notEqual(db.state().generation,generation);assert.equal(db.state().value.checkpoint,'200');
 assert.deepEqual(page.tombstones,[]);assert.equal(db.rows.size,1);assert.equal(page.complete,false);
 await db.step(page.next_cursor,1);assert.equal(inventories,2);
});
test('native Gmail durable pages catch up addition/deletion/labels and confirm unseen404 before convergence',async()=>{
 const f=await nativeFixture(),db=nativeStateFixture(f);db.seed('retained-stale');let changes=0;
 f.state.handler=(url)=>{const u=new URL(url),id=u.pathname.split('/').at(-1);
  if(id==='profile')return reply({historyId:'100'});
  if(id==='messages'){assert.equal(u.searchParams.get('includeSpamTrash'),'true');return reply({messages:[{id:'one'},{id:'two'}]});}
  if(id==='history'){assert.equal(u.searchParams.get('maxResults'),'1');changes++;return reply(u.searchParams.get('startHistoryId')==='100'?{history:[{id:'101',messagesAdded:[{message:{id:'three'}}],messagesDeleted:[{message:{id:'two'}}],labelsRemoved:[{message:{id:'one'}}]}],historyId:'102'}:{history:[],historyId:'102'});}
  if(id==='two'||id==='retained-stale')return new Response('{}',{status:404});
  return reply(nativeGmailMessage(id,id==='one'?['SENT']:['INBOX']));
 };
 let page=await db.step();assert.equal(page.complete,false);assert.equal(page.has_more,true);assert.equal(page.tombstones.length,1); // authenticated listing/metadata race
 const pages=[page];while(page.has_more&&pages.length<20){page=await db.step(page.next_cursor);pages.push(page);}
 assert.equal(page.complete,true);assert.equal(page.has_more,false);assert.ok(changes>=3);assert.ok(pages.slice(0,-1).every(row=>row.complete===false));
 assert.equal(db.rows.size,2);assert.deepEqual([...db.rows.values()].map(row=>row.data.subject).sort(),['Converged one','Converged three']);
 const one=db.rows.get(logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'gmail','one'));assert.deepEqual(one.folders,['sent']);
 assert.ok(pages.some(row=>row.tombstones.includes(logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'gmail','retained-stale'))));
 assert.ok(pages.every(row=>JSON.stringify(row.state_updates).length<65536));
 const idle=await db.step(page.next_cursor);assert.equal(idle.complete,true);assert.equal(idle.has_more,false);assert.equal(typeof idle.next_cursor,'string');
});
test('native Gmail expired history resets generation without tombstoning a partial inventory',async()=>{
 const f=await nativeFixture(),db=nativeStateFixture(f);let expired=false;
 f.state.handler=url=>{const u=new URL(url),id=u.pathname.split('/').at(-1);if(id==='profile')return reply({historyId:expired?'200':'100'});
  if(id==='messages')return reply({messages:[{id:'one'}]});if(id==='history')return expired?new Response('{}',{status:404}):reply({history:[],historyId:'100'});return reply(nativeGmailMessage(id));};
 let page=await db.step();for(let i=0;page.has_more&&i<10;i++)page=await db.step(page.next_cursor);
 assert.equal(page.complete,true);const generation=db.state().generation;expired=true;
 const reset=await db.step(page.next_cursor);assert.equal(reset.complete,false);assert.equal(reset.has_more,true);assert.deepEqual(reset.tombstones,[]);
 assert.notEqual(db.state().generation,generation);assert.equal(db.state().value.phase,'inventory');assert.equal(db.state().value.checkpoint,'200');assert.equal(db.rows.size,1);
});
test('native Gmail stale state denies and oversized history resets without truncation or early deletion',async()=>{
 const f=await nativeFixture(),db=nativeStateFixture(f);
 let oversized=false;
 f.state.handler=url=>{const u=new URL(url),id=u.pathname.split('/').at(-1);if(id==='profile')return reply({historyId:oversized?'102':'100'});if(id==='messages')return reply({messages:[]});if(id==='history'){oversized=true;return u.searchParams.get('startHistoryId')==='100'?reply({history:[{id:'101',messagesAdded:Array.from({length:257},(_,i)=>({message:{id:'message-'+i}}))}],historyId:'102'}):reply({history:[],historyId:'102'});}assert.fail('unexpected metadata');};
 const first=await db.step(),prior=copy(db.state()),count=f.calls.length;
 await assert.rejects(f.adapter.nativeEmailPage({cursor:null,limit:2},db.context),/EMAIL_NATIVE_STATE_CONFLICT/);assert.equal(f.calls.length,count);
 const reset=await f.adapter.nativeEmailPage({cursor:first.next_cursor,limit:2},db.context);assert.deepEqual(db.state(),prior);assert.equal(db.rows.size,0);
 assert.equal(reset.complete,false);assert.equal(reset.has_more,true);assert.deepEqual(reset.tombstones,[]);assert.deepEqual(reset.items,[]);
 db.apply(reset);assert.notEqual(db.state().generation,prior.generation);assert.equal(db.state().value.checkpoint,'102');assert.equal(db.state().value.phase,'inventory');
 let page=await db.step(reset.next_cursor);for(let i=0;page.has_more&&i<10;i++)page=await db.step(page.next_cursor);assert.equal(page.complete,true);
});

function nativeGraphStateFixture(f){
 const states=new Map(),rows=new Map();let cursor=null;
 const context={...f.context,provider_state:{async read(key){return copy(states.get(key)??null);},async stale(generation,_after,limit){return [...rows.values()].filter(row=>row.inventory_generation!==generation).slice(0,limit).map(({logical_message_id,provider_source})=>({logical_message_id,provider_source:copy(provider_source)}));}}};
 const step=async()=>{const page=await f.adapter.nativeEmailPage({cursor,limit:2},context);assert.equal(page.failure_count,0);
  for(const row of page.items)rows.set(row.logical_message_id,copy(row));for(const id of page.tombstones)rows.delete(id);
  for(const update of page.state_updates){assert.match(update.state_key,/^[a-f0-9]{64}$/);assert.ok(JSON.stringify(update.value).length<65536);states.set(update.state_key,{...copy(update),storage_revision:(states.get(update.state_key)?.storage_revision??0)+1});}
  cursor=page.next_cursor;return page;
 };
 const seed=id=>{const logical_message_id=logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'microsoft',id);rows.set(logical_message_id,{logical_message_id,inventory_generation:'old',provider_source:{account_id:f.options.account_id,locator:{kind:'microsoft',id_type:'immutable',message_id:id,conversation_id:'conversation',folder_id:'old-folder'}}});};
 return {context,states,rows,step,seed,cursor:()=>cursor};
}
function nativeGraphHandler(f){
 const known={inbox:'inbox-id',sentitems:'sent-id',junkemail:'spam-id',deleteditems:'trash-id',drafts:'drafts-id',archive:'archive-id'};
 const state={moved:false,expired:false,malicious:false,seen:[],folderCount:0,reverseCatalog:false,omitCustom:false,addFolder:false};
 const metadata=(id,folder)=>({id,conversationId:'graph-conversation',parentFolderId:folder,subject:'Graph '+id,receivedDateTime:'2026-10-04T00:00:00.000Z',isRead:true,flag:{flagStatus:'notFlagged'},hasAttachments:false});
 const link=(folder,token)=>`https://graph.microsoft.com/v1.0/me/mailFolders('${folder}')/messages/delta?$deltatoken=${token}`;
 f.state.handler=(url,init)=>{
  const u=new URL(url),path=decodeURIComponent(u.pathname);assert.ok(init.headers.Prefer.includes('ImmutableId'));state.seen.push(url);
  const well=/\/mailFolders\/([^/]+)$/.exec(path);
  if(well&&known[well[1]])return reply({id:known[well[1]],displayName:'Localized '+well[1]});
  if(path==='/v1.0/me/mailFolders'){
   assert.equal(u.searchParams.get('includeHiddenFolders'),'true');state.folderCount++;
   let ids=u.searchParams.has('$skiptoken')?['drafts-id','archive-id','hidden-id',...(state.omitCustom?[]:['custom-id']),...(state.addFolder?['added-id']:[])]:['inbox-id','sent-id','spam-id','trash-id'];
   if(state.reverseCatalog)ids=ids.reverse();
   return reply({value:ids.map(id=>({id})),...(!u.searchParams.has('$skiptoken')?{'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/mailFolders?includeHiddenFolders=true&$skiptoken=second'}:{})});
  }
  const children=/\/mailFolders\/([^/]+)\/childFolders$/.exec(path);
  if(children){assert.equal(u.searchParams.get('includeHiddenFolders'),'true');return reply({value:children[1]==='hidden-id'?[{id:'nested-id'}]:[]});}
  const delta=/\/mailFolders(?:\/([^/]+)|\('([^']+)'\))\/messages\/delta$/.exec(path);
  if(delta){const folder=delta[1]??delta[2],checkpoint=u.searchParams.get('$deltatoken');
   if(state.expired){state.expired=false;return new Response('{}',{status:410});}
   if(state.malicious)return reply({value:[], '@odata.nextLink':'https://attacker.invalid/v1.0/me/mailFolders/inbox-id/messages/delta'});
   if(checkpoint&&folder==='inbox-id'&&checkpoint==='first'){state.moved=true;return reply({value:[{id:'one','@removed':{reason:'deleted'}},{id:'dead','@removed':{reason:'deleted'}}],'@odata.deltaLink':link(folder,'second')});}
   if(!checkpoint&&folder==='inbox-id'&&!u.searchParams.has('$skiptoken'))return reply({value:[metadata('one',folder)],'@odata.nextLink':`https://graph.microsoft.com/v1.0/me/mailFolders('${folder}')/messages/delta?$skiptoken=page-two`});
   const ids=!checkpoint?(folder==='inbox-id'?['dead']:folder==='nested-id'?['nested']:folder==='custom-id'?['custom']:[]):[];
   return reply({value:ids.map(id=>metadata(id,folder)),'@odata.deltaLink':link(folder,checkpoint??'first')});
  }
  const message=/\/messages\/([^/]+)$/.exec(path);
  if(message){const id=message[1];if(['dead','retained-stale'].includes(id)||id==='custom'&&state.omitCustom)return new Response('{}',{status:404});return reply(metadata(id,id==='one'?state.moved?'sent-id':'inbox-id':id==='nested'?'nested-id':'custom-id'));}
  assert.fail('unexpected Graph effect: '+url);
 };return state;
}
test('native Graph traverses hidden descendants and delta pages, resolves canonical folders and distinguishes moves from deletes',async()=>{
 const f=await nativeFixture('microsoft'),db=nativeGraphStateFixture(f),network=nativeGraphHandler(f);db.seed('retained-stale');let page;const pages=[];
 for(let i=0;i<100;i++){page=await db.step();pages.push(page);if(!page.has_more)break;}
 assert.equal(page.complete,true);assert.equal(page.has_more,false);assert.ok(pages.slice(0,-1).every(row=>row.complete===false));assert.ok(network.folderCount>=4);
 assert.equal(db.rows.size,3);assert.ok(network.seen.some(url=>url.includes('/hidden-id/childFolders')));assert.ok(network.seen.some(url=>url.includes('/nested-id/messages/delta')));
 assert.ok(network.seen.some(url=>new URL(url).searchParams.get('$skiptoken')==='page-two'));
 const one=db.rows.get(logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'microsoft','one'));assert.deepEqual(one.folders,['sent']);
 assert.equal([...db.rows.values()].find(row=>row.data.subject==='Graph nested').folders[0].startsWith('folder:'),true);
 const dead=logicalMailIdForProviderMessage(f.binding.scope,f.options.account_id,'microsoft','dead');assert.ok(pages.some(row=>row.tombstones.includes(dead)));assert.ok(pages.every(row=>!row.tombstones.includes(one.logical_message_id)));
 const count=f.calls.length,status=await f.adapter.nativeEmailAccount(db.context);assert.equal(status.provider,'microsoft');assert.equal(f.calls.length,count);
 const nextCycle=await db.step();assert.equal(nextCycle.complete,false);assert.equal(nextCycle.has_more,true);
});

test('native Graph catalog queue remains bounded across more than one hundred folders',async()=>{
 const f=await nativeFixture('microsoft'),db=nativeGraphStateFixture(f);let folderRequests=0,deltaRequests=0;
 f.state.handler=url=>{const u=new URL(url),path=decodeURIComponent(u.pathname);
  if(/^\/v1\.0\/me\/mailFolders\/[^/]+$/.test(path))return new Response('{}',{status:404});
  if(path==='/v1.0/me/mailFolders'){
   assert.equal(u.searchParams.get('includeHiddenFolders'),'true');folderRequests++;const offset=Number(u.searchParams.get('$skiptoken')??'0');
   return reply({value:Array.from({length:Math.min(20,105-offset)},(_,i)=>({id:'folder-'+(offset+i)})),...(offset+20<105?{'@odata.nextLink':`https://graph.microsoft.com/v1.0/me/mailFolders?includeHiddenFolders=true&$skiptoken=${offset+20}`}:{})});
  }
  const folder=/\/mailFolders(?:\/([^/]+)|\('([^']+)'\))\/(messages\/delta|childFolders)$/.exec(path);assert.ok(folder);
  if(folder[3]==='childFolders'){assert.equal(u.searchParams.get('includeHiddenFolders'),'true');return reply({value:[]});}
  deltaRequests++;return reply({value:[],'@odata.deltaLink':`https://graph.microsoft.com/v1.0/me/mailFolders('${folder[1]??folder[2]}')/messages/delta?$deltatoken=retained`});
 };
 let page;for(let i=0;i<850;i++){page=await db.step();assert.ok(page.state_updates.length<=8);if(!page.has_more)break;}
 assert.equal(page.complete,true);assert.equal(folderRequests,12);assert.equal(deltaRequests,210);
 const queueRows=[...db.states.values()].filter(row=>row.value.kind==='queue');assert.equal(queueRows.length,6);assert.ok(queueRows.every(row=>row.value.ids.length<=20));
});

test('native Graph unchanged catalog skips stale rereads and catalog deletion resets before confirmed cache cleanup',async()=>{
 const f=await nativeFixture('microsoft'),db=nativeGraphStateFixture(f),network=nativeGraphHandler(f);
 const converge=async(max=180)=>{let page;for(let i=0;i<max;i++){page=await db.step();if(!page.has_more)return page;}assert.fail('fixture did not converge');};
 assert.equal((await converge()).complete,true);
 const control=()=>[...db.states.values()].find(row=>row.value.version===1),generation=control().generation;
 const before=f.calls.length;network.reverseCatalog=true;assert.equal((await converge()).complete,true);
 assert.equal(control().generation,generation);assert.equal(db.rows.size,3);
 assert.equal(f.calls.slice(before).filter(call=>/^\/v1\.0\/me\/messages\//.test(new URL(call.url).pathname)).length,0);
 assert.equal(f.calls.slice(before).filter(call=>/\/mailFolders\/[^/]+$/.test(new URL(call.url).pathname)).length,0); // no well-known folder refresh
 network.omitCustom=true;const catalogBefore=control().value.completed_catalog;let detected=false;
 for(let i=0;i<100;i++){const page=await db.step();if(control().generation!==generation){assert.equal(page.complete,false);assert.deepEqual(page.tombstones,[]);detected=true;break;}}
 assert.equal(detected,true);assert.notEqual(control().generation,generation);assert.equal(db.rows.size,3); // catalog absence alone never deletes
 assert.equal((await converge()).complete,true);assert.equal(db.rows.size,2);assert.notDeepEqual(control().value.completed_catalog,catalogBefore);
 assert.equal([...db.rows.values()].some(row=>row.data.subject==='Graph custom'),false);
 const beforeAdded=control().generation;network.addFolder=true;assert.equal((await converge()).complete,true);assert.notEqual(control().generation,beforeAdded);assert.equal(db.rows.size,2);
});
test('native Graph expired delta resets generation, while malicious nextLink and stale cursor cannot advance state',async()=>{
 const f=await nativeFixture('microsoft'),db=nativeGraphStateFixture(f),network=nativeGraphHandler(f);let page;
 for(let i=0;i<100;i++){page=await db.step();if(!page.has_more)break;}assert.equal(page.complete,true);
 const generation=[...db.states.values()].find(row=>row.value.version===1).generation;network.expired=true;
 let reset;for(let i=0;i<10;i++){reset=await db.step();if([...db.states.values()].find(row=>row.value.version===1).value.reset)break;}
 assert.equal(reset.complete,false);assert.deepEqual(reset.tombstones,[]);assert.notEqual([...db.states.values()].find(row=>row.value.version===1).generation,generation);
 const snapshot=copy([...db.states]);await assert.rejects(f.adapter.nativeEmailPage({cursor:null,limit:2},db.context),/EMAIL_NATIVE_STATE_CONFLICT/);assert.deepEqual([...db.states],snapshot);
 network.malicious=true;let denied=false;
 for(let i=0;i<10;i++){try{await db.step();}catch(error){assert.match(error.code,/EMAIL_PROVIDER_CURSOR_INVALID/);denied=true;break;}}
 assert.equal(denied,true);assert.equal(f.calls.some(call=>call.url.startsWith('https://attacker.invalid')),false);
});
