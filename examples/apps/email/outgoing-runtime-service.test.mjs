import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {createAppConnectionAdapter} from './providers/connection-http.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailSendJournal} from './outgoing-operation-store.mjs';
import {runEmailOutgoing} from './outgoing-runtime-service.mjs';
import {createEmailScopedSupervisor} from './scoped-service-supervisor.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex'),copy=value=>structuredClone(value);
function store(){const rows=new Map(),queues=new Map();return {rows,async withLock({key},fn){const prior=queues.get(key)??Promise.resolve();let release;
 const next=new Promise(resolve=>{release=resolve;});queues.set(key,next);await prior;try{return await fn({read:async()=>copy(rows.get(key)??null),
  compareAndSwap:async({expected_revision,value})=>{const row=rows.get(key);if((row?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(row?.revision??0)+1,value:copy(value)});return true;}});
 }finally{release();if(queues.get(key)===next)queues.delete(key);}}};}
async function fixture({loseResponse=false,rich=false}={}){
 const now=Date.now(),clock=()=>now,scope={org_id:randomUUID(),owner_id:randomUUID(),installation_id:randomUUID()},accountId='gmail-controlled';
 const binding={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  resource_target_key:'personal',state_key:'drafts',draft_id:randomUUID(),draft_revision:2,artifact_digest:'sha256:'+'a'.repeat(64),declaration_digest:'sha256:'+'b'.repeat(64),
  runtime_binding_id:randomUUID(),action_key:'send_message',action_contract_digest:'sha256:'+'c'.repeat(64),input_digest:'sha256:'+'d'.repeat(64)};
 const resourceId=randomUUID(),clients={gmail:{client_id:'synthetic-client',client_secret:'synthetic-private-secret',redirect_uri:'https://deft.example.test/apps/connections/callback'}};
 const accountBinding={scope,account_id:accountId,provider:'gmail',connection_target:'personal',resource_binding_id:resourceId,
  action_binding_id:binding.runtime_binding_id,authority_epoch:1,capabilities:['read','send']};
 const durable=store(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(3),key_id:'test',store:durable,now:clock});
 const delivered=[],calls=[];const fetch=async(url,init)=>{calls.push(url);
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-token',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:3600,
   scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
  if(url==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'synthetic-subject',email:'verified@example.test',email_verified:true,name:'Verified'});
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/profile')return Response.json({emailAddress:'verified@example.test'});
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){
   const raw=Buffer.from(JSON.parse(init.body).raw,'base64url');delivered.push({raw,parsed:await simpleParser(raw)});
   if(loseResponse)throw Error('lost acknowledgement');return Response.json({id:'accepted-provider-id',threadId:'provider-thread',labelIds:['SENT']});}
  assert.fail('Unexpected provider endpoint');};
 const projection={purpose:'connect',org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,
  app_version_id:binding.app_version_id,grant_snapshot_id:binding.grant_snapshot_id,target_key:'personal',resource_key:'inbox',resource_binding_id:resourceId,
  action_key:'send_message',action_binding_id:binding.runtime_binding_id,web_session_id:randomUUID(),experience_session_id:randomUUID(),runtime_registration_id:randomUUID(),
  descriptor_digest:'sha256:'+'e'.repeat(64),allowed_operations:['list_summary','read_one'],lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,expires_at:now+300000,checked_at:now};
 const adapter=await createAppConnectionAdapter({host:{resolveContext:async()=>copy(projection),assertCurrent:async()=>copy(projection)},custody,fetch,now:clock,
  options:{origin:'https://deft.example.test',account_id:accountId,provider:'gmail',authority_epoch:1,connection_target:'personal',resource_binding_id:resourceId,
   action_binding_id:binding.runtime_binding_id,capabilities:['read','send'],clients}});
 const begin=await adapter.handle(new Request('https://deft-connection.invalid/connections/begin',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{});
 const auth=new URL((await begin.json()).authorization_url),callback=new URL('https://deft-connection.invalid/connections/callback');
 callback.searchParams.set('state',auth.searchParams.get('state'));callback.searchParams.set('code','synthetic-code');
 assert.equal((await adapter.handle(new Request(callback),{})).status,200);
 const pdf=Buffer.from('%PDF-1.4\ncontrolled immutable attachment\n%%EOF'),file={file_id:randomUUID(),upload_operation_id:randomUUID(),filename:'brief.pdf',
  media_type:'application/pdf',byte_length:pdf.length,digest:hash(pdf),expires_at:new Date(now+300000).toISOString()};
 const input=rich?{to:'controlled@example.test',cc:'copy@example.test',bcc:'hidden@example.test',subject:'Trusted rich delivery',body:'Exact controlled body.',body_html:'<p>Exact <strong>controlled</strong> body.</p>',parent_record_id:''}
  :{to:'controlled@example.test',subject:'Trusted delivery',body:'Exact controlled body.'};
 const built=await adapter.buildActionPayload({binding,input,draft_value:{...input,mode:'compose',...(rich?{reply_record_id:''}:{})},draft_updated_at:new Date(now).toISOString(),
  files:[{reference:file,bytes:pdf}],files_policy:{max_file_bytes:2097152,max_files_per_record:1,max_total_bytes_per_record:2097152,allowed_media_types:['application/pdf']},
  max_payload_bytes:4194304,expires_at:file.expires_at},{});
 const ref={snapshot_id:randomUUID(),digest:hash(built.bytes)},claim={run_id:randomUUID(),attempt_id:randomUUID(),operation_name:'send_message',schema_version:'deft.app_runtime_channel.v1',audience:'app_runtime',org_id:scope.org_id,
  runtime_binding_id:binding.runtime_binding_id,runtime_registration_id:projection.runtime_registration_id,app_installation_id:binding.installation_id,app_version_id:binding.app_version_id,grant_snapshot_id:binding.grant_snapshot_id,
  runtime_epoch:1,lifecycle_epoch:1,grant_epoch:1,session_id:'scoped-session',session_epoch:1,lease_expires_at:new Date(now+60000).toISOString()};
 const retained={ref,binding,metadata:built.metadata,file_refs:[file],expires_at:file.expires_at,byte_count:built.bytes.length,bytes_digest:hash(built.bytes)};
 let deny=false,substitute=false;const results=[];
 const sdk={claim:async()=>copy(claim),start:async()=>({...claim,input,snapshot_ref:copy(ref),lease_expires_at:new Date(now+60000).toISOString()}),
  payloadMetadata:async(_,requested)=>{assert.deepEqual(requested,ref);if(deny)throw Error('revoked');return copy(retained);},
  payloadBytes:async()=>substitute?Buffer.from('substitution'):Buffer.from(built.bytes),fileBytes:async(_,requested,id)=>{assert.deepEqual(requested,ref);assert.equal(id,file.file_id);return Buffer.from(pdf);},
  result:async(_,result)=>{results.push(copy(result));return {id:claim.run_id,state:result.status==='returned'?'succeeded':'unknown_outcome'};}};
 const runtimeOptions={account_binding:accountBinding,custody,journal:createEmailSendJournal({store:durable,encryption_key:new Uint8Array(32).fill(8),key_id:'send-test'}),clients,fetch,now:clock};
 return {run:()=>runEmailOutgoing({sdk,account_binding:accountBinding,custody,journal:createEmailSendJournal({store:durable,encryption_key:new Uint8Array(32).fill(8),key_id:'send-test'}),clients,fetch,now:clock}),
  runClaim:cached=>runEmailOutgoing({...runtimeOptions,sdk:{...sdk,claim:async()=>copy(cached)},expected_run_id:cached.run_id}),
  bindingPins:{id:binding.runtime_binding_id,registration_id:projection.runtime_registration_id,installation_id:binding.installation_id,app_version_id:binding.app_version_id,grant_snapshot_id:binding.grant_snapshot_id,action_key:'send_message',runtime_epoch:1,operator_user_id:binding.owner_user_id},
  sdk,claim,delivered,calls,results,pdf,bytes:built.bytes,deny:()=>{deny=true;},substitute:()=>{substitute=true;}};
}

test('scoped supervisor dispatches its cached exact claim into the actual immutable Send runtime and stops unknown across restart',async()=>{
 for(const loseResponse of [false,true]){
  const f=await fixture({rich:true,loseResponse});let state=null,claims=0,children=0;
  const ports={binding:f.bindingPins,org_id:f.claim.org_id,store:{load:async()=>copy(state),save:async value=>{state=copy(value);}},
   inspect:async()=>({binding:{...f.bindingPins,state:'active',registration_state:'active'}}),issueSession:async()=>({session_id:f.claim.session_id,session_token:'x'.repeat(32),expires_at:new Date(Date.now()+300000).toISOString()}),
   createClient:()=>({claim:async()=>{claims++;return claims===1?copy(f.claim):null;}}),runChild:async({claim,credential})=>{children++;assert.equal(state.inflight.run_id,claim.run_id);assert.deepEqual(Object.keys(credential).sort(),['session_id','session_token']);return f.runClaim(claim);}};
  const first=await createEmailScopedSupervisor(ports);assert.equal((await first.step()).phase,loseResponse?'paused':'idle');assert.equal(children,1);assert.equal(f.delivered.length,1);assert.deepEqual(f.delivered[0].raw,f.bytes);
  const restarted=await createEmailScopedSupervisor(ports);assert.equal((await restarted.step()).phase,loseResponse?'paused':'idle');assert.equal(children,1);assert.equal(f.delivered.length,1);assert.equal(claims,loseResponse?1:2);
 }
});

test('missing host completion acknowledgement remains unknown even after provider acceptance',async()=>{
 const f=await fixture();f.sdk.result=async()=>({});assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.delivered.length,1);
 assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.delivered.length,1);
});
test('production executor consumes immutable channel payload and durable journal; restart cannot duplicate Send',async()=>{
 const f=await fixture();assert.equal((await f.run()).state,'provider_accepted');assert.equal((await f.run()).state,'provider_accepted');
 assert.equal(f.delivered.length,1);assert.deepEqual(f.delivered[0].raw,f.bytes);assert.deepEqual(f.delivered[0].parsed.attachments[0].content,f.pdf);
 assert.equal(f.delivered[0].parsed.from.value[0].address,'verified@example.test');assert.equal(f.results[0].status,'returned');
});

test('production executor releases retained rich MIME with exact To/Cc/Bcc/plain/HTML/PDF and no Send reconstruction',async()=>{
 const f=await fixture({rich:true});assert.equal((await f.run()).state,'provider_accepted');assert.equal(f.delivered.length,1);const parsed=f.delivered[0].parsed;
 assert.deepEqual(f.delivered[0].raw,f.bytes);assert.equal(parsed.to.value[0].address,'controlled@example.test');assert.equal(parsed.cc.value[0].address,'copy@example.test');assert.equal(parsed.bcc.value[0].address,'hidden@example.test');
 assert.equal(parsed.html,'<p>Exact <strong>controlled</strong> body.</p>');assert.equal(parsed.text,'Exact controlled body.');assert.deepEqual(parsed.attachments[0].content,f.pdf);
 assert.equal((await f.run()).state,'provider_accepted');assert.equal(f.delivered.length,1);
});
test('acceptance response loss remains unknown across restart and never resends',async()=>{
 const f=await fixture({loseResponse:true});assert.equal((await f.run()).state,'outcome_unknown');assert.equal((await f.run()).state,'outcome_unknown');
 assert.equal(f.delivered.length,1);assert.equal(f.results.every(result=>result.status==='indeterminate'),true);
});
test('revoked release or substituted MIME stops before provider send',async()=>{
 for(const change of ['deny','substitute']){const f=await fixture();f[change]();assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.delivered.length,0);}
});

test('denied or malformed Start stops explicitly without metadata, result or provider calls',async()=>{
 for(const response of ['denied','missing']){
  const f=await fixture();let reads=0;
  f.sdk.start=async()=>{if(response==='denied')throw Error('APP_RUNTIME_ACCESS_DENIED');return {};};
  f.sdk.payloadMetadata=async()=>{reads++;throw Error('must not read');};
  const result=await f.run();assert.equal(result.state,'stopped');assert.equal(result.code,'EMAIL_SEND_START_UNCONFIRMED');
  assert.equal(result.automatic_retry,false);assert.equal(reads,0);assert.equal(f.delivered.length,0);assert.equal(f.results.length,0);
 }
});
