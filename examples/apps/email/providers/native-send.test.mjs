import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';
import {NATIVE_SEND_LIMITS} from './native-send.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const mime=Buffer.from('From: owner@example.test\r\nTo: recipient@example.test\r\nSubject: Native synthetic send\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nExact immutable draft\r\n');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fixture(provider='gmail',send=true){
 const scope={org_id:'org-send',owner_id:'owner-send',installation_id:'installation-send'},binding={scope,account_id:'send-account',provider,connection_target:'real-send-target',
  resource_binding_id:'send-binding',action_binding_id:send?'real-send-action-binding':null,authority_epoch:1,capabilities:send?['read','send']:['read']};
 const rows=new Map(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(49),key_id:'send-test',store:{async withLock({key},work){return work({async read(){return structuredClone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const old=rows.get(key);if((old?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(old?.revision??0)+1,value:structuredClone(value)});return true;}});}}});
 const client={client_id:'synthetic-send-client',client_secret:'synthetic-send-secret',redirect_uri:'https://fixture.invalid/callback',...(provider==='microsoft'?{tenant:'common'}:{})};
 let live=true,permit=true,handler=async()=>provider==='gmail'?json({id:'sent-provider-id'}):new Response(null,{status:202});const calls=[],reservations=[];
 const fetch=async(url,init)=>{assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.ok(init.headers.Authorization.startsWith('Bearer '));
  calls.push({url,init:{...init,body:Buffer.isBuffer(init.body)?Buffer.from(init.body):init.body}});return handler(url,init);};
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()+3600000,
  scopes:provider==='gmail'?['openid','email','https://www.googleapis.com/auth/gmail.readonly',...(send?['https://www.googleapis.com/auth/gmail.send']:[])]:['offline_access','User.Read','Mail.Read',...(send?['Mail.Send']:[])],
  client_fingerprint:createOAuthProvider({provider,client,fetch}).client_fingerprint,identity:{provider_subject:'verified-send-principal',primary_address:'owner@example.test',display_label:'Send account',verified_sender_identities:send?['owner@example.test']:[]}}}));
 const {scope:ignored,...options}=binding,adapter=await createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{[provider]:client}},custody,fetch,
  host:{resolveContext:async()=>assert.fail('No Experience projection'),assertCurrent:async()=>assert.fail('No Experience authority')}});
 const context={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,account_id:binding.account_id,resource_binding_id:binding.resource_binding_id,
  authority_version:'human-send-current',expires_at:Date.now()+60000,recheck:async()=>{if(!live)throw Error('Revoked');},send_before_reserve:async input=>{reservations.push(input);return permit;}};
 return {adapter,context,calls,reservations,binding,custody,deny(){live=false;},set permit(value){permit=value;},set handler(value){handler=value;},async replacePrincipal(){await custody.withAccount(binding,async tx=>{const row=tx.read();await tx.write({health:'connected',secret:{...row.secret,identity:{...row.secret.identity,provider_subject:'different-send-principal'}},advance_setup:true});});}};
}
const request=(bytes=mime)=>({operation_id:randomUUID(),mime_bytes:bytes,mime_digest:digest(bytes),from_address:'owner@example.test'});
test('registered native Gmail/Graph send uses exact verified sender, already-reserved digest and provider accepted semantics',async()=>{
 for(const provider of ['gmail','microsoft']){
  const f=await fixture(provider),input=request(),identity=await f.adapter.nativeEmailSendIdentity(f.context);assert.deepEqual(identity.verified_sender_identities,['owner@example.test']);assert.equal(identity.action_binding_id,'real-send-action-binding');assert.equal(f.calls.length,0);
  const result=await f.adapter.nativeEmailSend(input,f.context);assert.equal(result.schema_version,'deft.email_send_result.v1');assert.equal(result.operation_id,input.operation_id);assert.equal(result.provider,provider);
  assert.equal(result.transport_outcome,'provider_accepted');assert.equal(result.sent_copy_outcome,'pending');assert.equal(result.delivery_status,'unknown');assert.equal(result.provider_message_id,provider==='gmail'?'sent-provider-id':null);
  assert.equal(f.calls.length,1);assert.deepEqual(f.reservations,[{account_id:'send-account',authority_epoch:1,operation_id:input.operation_id,mime_digest:input.mime_digest}]);
  if(provider==='gmail'){assert.equal(f.calls[0].url,'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media');assert.equal(f.calls[0].init.headers['Content-Type'],'message/rfc822');assert.deepEqual(f.calls[0].init.body,mime);}
  else{assert.equal(f.calls[0].url,'https://graph.microsoft.com/v1.0/me/sendMail');assert.equal(f.calls[0].init.headers['Content-Type'],'text/plain');assert.equal(f.calls[0].init.headers.Prefer,'IdType="ImmutableId"');assert.deepEqual(Buffer.from(f.calls[0].init.body,'base64'),mime);}
  assert.deepEqual(input.mime_bytes,mime,'Caller-owned bytes remain intact');
 }
});
test('native Gmail reply MIME upload contains only host-nominated thread metadata and exact MIME bytes',async()=>{
 const f=await fixture(),input={...request(),thread_id:'private-cache-thread'};await f.adapter.nativeEmailSend(input,f.context);
 assert.equal(f.calls[0].url,'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart');
 const body=f.calls[0].init.body;assert.ok(body.includes(Buffer.from(JSON.stringify({threadId:'private-cache-thread'}))));assert.ok(body.includes(mime));assert.match(f.calls[0].init.headers['Content-Type'],/^multipart\/related; boundary=/u);
 const graph=await fixture('microsoft');await assert.rejects(graph.adapter.nativeEmailSend({...request(),thread_id:'guessed-conversation'},graph.context),/EMAIL_NATIVE_SEND_REPLY_UNSUPPORTED/);assert.equal(graph.calls.length,0);assert.equal(graph.reservations.length,0);
});
test('missing send capability, altered MIME/sender/scope and denied durable verification cannot effect a send',async()=>{
 const noSend=await fixture('gmail',false);await assert.rejects(noSend.adapter.nativeEmailSend(request(),noSend.context));assert.equal(noSend.calls.length,0);
 const f=await fixture();for(const input of [{...request(),account_id:'foreign'},{...request(),from_address:'attacker@example.test'},{...request(),mime_digest:'f'.repeat(64)}])await assert.rejects(f.adapter.nativeEmailSend(input,f.context));
 await assert.rejects(f.adapter.nativeEmailSend(request(),{...f.context,account_id:'foreign'}));await assert.rejects(f.adapter.nativeEmailSend(request(),{...f.context,send_before_reserve:undefined}));assert.equal(f.calls.length,0);
 f.permit=false;await assert.rejects(f.adapter.nativeEmailSend(request(),f.context),/EMAIL_PROVIDER_SEND_ALREADY_RESERVED/);assert.equal(f.calls.length,0);assert.equal(f.reservations.length,1);
 await assert.rejects(f.adapter.nativeEmailAccount(f.context),'Read port rejects send context');
});
test('native Gmail supports >8MiB MIME while Gmail35MiB and Graph3MiB limits fail before effect without truncation',async()=>{
 const f=await fixture(),large=Buffer.concat([mime,Buffer.alloc(9*1024*1024,65)]);await f.adapter.nativeEmailSend(request(large),f.context);assert.equal(f.calls[0].init.body.length,large.length);assert.deepEqual(f.calls[0].init.body,large);
 for(const [provider,size]of [['gmail',NATIVE_SEND_LIMITS.gmail_upload_bytes+1],['microsoft',NATIVE_SEND_LIMITS.microsoft_single_mime_bytes+1]]){
  const denied=await fixture(provider),bytes=Buffer.alloc(size,65);await assert.rejects(denied.adapter.nativeEmailSend(request(bytes),denied.context),/EMAIL_NATIVE_SEND_PROVIDER_SIZE_UNSUPPORTED/);assert.equal(denied.reservations.length,0);assert.equal(denied.calls.length,0);
 }
});
test('lost response and held principal change are uncertain; native adapter never automatically retries',async()=>{
 const f=await fixture();f.handler=async()=>{throw Error('Synthetic response loss after provider effect');};await assert.rejects(f.adapter.nativeEmailSend(request(),f.context),error=>error.outcome==='uncertain');assert.equal(f.calls.length,1);assert.equal(f.reservations.length,1);
 const held=await fixture('microsoft');let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});held.handler=async()=>{entered();await wait;return new Response(null,{status:202});};
 const sending=held.adapter.nativeEmailSend(request(),held.context);await ready;await held.replacePrincipal();release();await assert.rejects(sending);assert.equal(held.calls.length,1);assert.equal(held.reservations.length,1);
});
test('expired/aborted admission and malformed provider response reject; private MIME copies clear on late failure',async()=>{
 const f=await fixture();await assert.rejects(f.adapter.nativeEmailSend(request(),{...f.context,signal:AbortSignal.abort()}));await assert.rejects(f.adapter.nativeEmailSend(request(),{...f.context,expires_at:Date.now()-1}));assert.equal(f.calls.length,0);
 const broken=await fixture();broken.handler=async()=>json({});let cleared=0;const original=Buffer.prototype.fill;
 Buffer.prototype.fill=function(value,...args){if(value===0&&this.byteLength===mime.byteLength&&Buffer.from(this).equals(mime))cleared++;return original.call(this,value,...args);};
 try{await assert.rejects(broken.adapter.nativeEmailSend(request(),broken.context),error=>error.outcome==='uncertain');assert.ok(cleared>=2);}finally{Buffer.prototype.fill=original;}
 assert.equal(broken.calls.length,1);assert.equal(broken.reservations.length,1);
});
test('registered bundle exposes native-only snapshot serializer with host callbacks and no provider I/O',async()=>{
 const f=await fixture(),reference={account_id:'send-account',draft_id:'draft-current',expected_revision:1};let sealed,reserved;
 const ports={
  resolve:async nominated=>{assert.deepEqual(nominated,reference);return {scope:{org_id:'org-send',owner_id:'owner-send',installation_id:'installation-send'},account_id:'send-account',provider:'gmail',authority_epoch:1,
   verified_from:[{address:'owner@example.test',display_name:''}],captured_at:'2026-10-04T12:00:00.000Z',message_id:'<native-fixture@example.test>',
   limits:{max_recipients:200,max_body_bytes:1048576,max_files:32,max_file_bytes:25*1024*1024,max_total_file_bytes:25*1024*1024,max_mime_bytes:36700160,allowed_media_types:['text/plain']},
   draft:{account_id:'send-account',draft_id:'draft-current',revision:1,mode:'compose',from:{address:'owner@example.test',display_name:''},to:[{address:'recipient@example.test',display_name:''}],cc:[],bcc:[],subject:'Pure native serialization',body_format:'plain',body_bytes:Buffer.from('Body'),reply_parent:null,files:[]}};},
  seal:async value=>{sealed=value;return {snapshot_id:'host-sealed-snapshot',sealed_contract:'host-private-seal'};},
  verify:async value=>value.payload_digest===sealed.payload_digest,
  reserve:async value=>{reserved=value;return 'reserved';}
 };
 const service=f.adapter.nativeEmailSnapshotFactory(ports),snapshot=await service.prepare(reference),operation_id=randomUUID(),transport=await service.bind(snapshot,{operation_id,expected_digest:snapshot.payload_digest});
 assert.equal(reserved.operation_id,operation_id);assert.equal(transport.account_id,'send-account');assert.equal(transport.from_address,'owner@example.test');assert.deepEqual(transport.mime_bytes,snapshot.mime_bytes);assert.equal(f.calls.length,0);
 assert.throws(()=>f.adapter.nativeEmailSnapshotFactory({...ports,profile:'legacy'}),/EMAIL_NATIVE_SNAPSHOT_PORT_INVALID/);assert.throws(()=>f.adapter.nativeEmailSnapshotFactory({...ports,module_path:'browser-selected'}),/EMAIL_NATIVE_SNAPSHOT_PORT_INVALID/);
});
