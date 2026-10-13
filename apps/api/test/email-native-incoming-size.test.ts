import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {NativeEmailPresentationSchema,NativeEmailFileSchema} from '../src/lib/app-connection-contract.js';
import {EmailMessageContentService} from '../src/lib/email-message-content.js';
import {createEmailMailboxRoutes} from '../src/routes/email-mailbox.js';
const M=1024*1024,logical='mail_'+'a'.repeat(64),digest='b'.repeat(64),ref='c'.repeat(64);
const scope={org_id:'synthetic-org',owner_user_id:'synthetic-owner',account_id:'synthetic-account'};
const identity={account_id:scope.account_id,provider:'gmail',logical_message_id:logical,source_digest:digest};
const file=(size:number,index=0)=>({file_ref:index?String(index).repeat(64):ref,filename:'business.bin',media_type:'application/octet-stream',size_bytes:size,disposition:'attachment',preview:'unsupported'});
function presentation(files:unknown[]){return {schema_version:'deft.email_presentation.v1',...identity,content_trust:'unsanitized',files,presentation:{format:'plain',content:'Body preserved',plain_text:'Body preserved',truncated:false,images:[],headers:[],metadata:{account_id:scope.account_id,primary_address:'owner@example.test',verified_sender_identities:'[]',reply_from:'',reply_to:'',reply_to_list:'',reply_cc:'',subject:'',message_id:'',references:'',conversation_id:'synthetic-conversation',conversation_coverage_state:'unknown',conversation_indexed_count:'0',conversation_exact_count:'',conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'}}};}
test('native inventory independently accepts visible source-only and combined files up to35MiB; aggregate forgeries fail',()=>{
 const oversized=NativeEmailPresentationSchema.parse(presentation([file(26*M)]));assert.equal(oversized.files[0].size_bytes,26*M);assert.equal(oversized.presentation.plain_text,'Body preserved');
 assert.equal(NativeEmailPresentationSchema.parse(presentation([file(18*M),file(16*M,1)])).files.length,2);
 assert.equal(NativeEmailPresentationSchema.parse(presentation([file(35*M)])).files[0].size_bytes,35*M);
 for(const files of [[file(35*M+1)],[file(18*M),file(18*M,1)]])assert.equal(NativeEmailPresentationSchema.safeParse(presentation(files)).success,false);
});
test('native direct file DTO remains25MiB independently of visible35MiB metadata',()=>{
 const bytes=new Uint8Array(25*M);
 try{assert.equal(NativeEmailFileSchema.parse({schema_version:'deft.email_file.v1',...identity,file_ref:ref,filename:'business.bin',media_type:'application/octet-stream',byte_length:bytes.length,bytes}).byte_length,25*M);
  assert.equal(NativeEmailFileSchema.safeParse({schema_version:'deft.email_file.v1',...identity,file_ref:ref,filename:'business.bin',media_type:'application/octet-stream',byte_length:26*M,bytes}).success,false);
 }finally{bytes.fill(0);}
});
function serviceFixture(size=9*M){
 let deny=false,changed=false,held=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const reached=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const bytes=Buffer.alloc(size,0x41),hash=createHash('sha256').update(bytes).digest('hex');
 const capability={scope,resource_binding_id:'synthetic-binding',authority_version:'synthetic-authority',expires_at:Date.now()+60_000};
 const record=()=>({account_id:scope.account_id,logical_message_id:logical,revision:changed?'changed':'current',received_at:null,folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{},provider_source:{schema_version:'deft.email_provider_source.v1',...scope,logical_message_id:logical,provider:'gmail',locator:{kind:'gmail',message_id:'synthetic-message'}}});
 const service=new EmailMessageContentService({current:async()=>{if(deny)throw Error('denied');return capability;}} as any,{readMessage:async()=>record()} as any,
  {readSource:async()=>{started();if(held)await gate;return {schema_version:'deft.email_source.v1',account_id:scope.account_id,provider:'gmail',source_kind:'provider_original',media_type:'message/rfc822',byte_length:bytes.length,digest:hash,mime_bytes:bytes};}} as any);
 const actor={user_id:scope.owner_user_id,web_session_id:'synthetic-session',access_expires_at:Date.now()+60_000};
 return {bytes,hash,service,actor,reached,release,hold(){held=true;},deny(){deny=true;},change(){changed=true;}};
}
test('native source service accepts exact >8MiB bytes while held revocation/source changes still zero and deny',async()=>{
 const success=serviceFixture();try{const result=await success.service.readSource(success.actor,scope,logical);assert.equal(result.byte_length,9*M);assert.equal(result.digest,success.hash);assert.equal(result.mime_bytes,success.bytes);}finally{success.bytes.fill(0);}
 for(const mutation of ['deny','change','abort'] as const){const f=serviceFixture(),controller=new AbortController();f.hold();const pending=f.service.readSource(f.actor,scope,logical,controller.signal);await f.reached;
  if(mutation==='abort')controller.abort();else f[mutation]();f.release();await assert.rejects(pending);assert.ok(f.bytes.every(byte=>byte===0));}
});
test('native source service rejects raw35MiB+1 and clears provider bytes',async()=>{
 const f=serviceFixture(35*M+1);await assert.rejects(f.service.readSource(f.actor,scope,logical));assert.ok(f.bytes.every(byte=>byte===0));
});
const session={id:scope.owner_user_id,org_id:scope.org_id,sid:'synthetic-session',exp:2_000_000_000};
test('native original route returns >8MiB exact byte attachment with private headers and clears service buffer',async()=>{
 const bytes=Buffer.alloc(9*M,0x41),hash=createHash('sha256').update(bytes).digest('hex');
 const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,content:async()=>({readSource:async()=>({account_id:scope.account_id,logical_message_id:logical,media_type:'message/rfc822',byte_length:bytes.length,digest:hash,mime_bytes:bytes})})});
 const response=await app.request(`/accounts/${scope.account_id}/messages/${logical}/source`,{headers:{authorization:'Bearer synthetic'}});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-disposition')??'',/attachment/);assert.ok(bytes.every(byte=>byte===0));
 const returned=new Uint8Array(await response.arrayBuffer());try{assert.equal(returned.length,9*M);assert.equal(createHash('sha256').update(returned).digest('hex'),hash);}finally{returned.fill(0);}
});
test('native file route rejects mocked >25MiB, dishonest counts and nonbytes before binary disclosure',async()=>{
 for(const kind of ['oversized','dishonest','nonbytes']){
  const bytes=new Uint8Array(kind==='oversized'?25*M+1:3),result={schema_version:'deft.email_file.v1',...identity,file_ref:ref,filename:'business.bin',media_type:'application/octet-stream',byte_length:kind==='dishonest'?2:bytes.length,bytes:kind==='nonbytes'?'not bytes':bytes};
  const app=createEmailMailboxRoutes({verify:async()=>session,service:async()=>{throw Error('unused');},now:()=>1000,content:async()=>({readSource:async()=>{throw Error('unused');},readFile:async()=>result} as any)});
  const response=await app.request(`/accounts/${scope.account_id}/messages/${logical}/file`,{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({source_digest:digest,file_ref:ref})});
  assert.equal(response.status,503);assert.ok(bytes.every(byte=>byte===0));
 }
});
