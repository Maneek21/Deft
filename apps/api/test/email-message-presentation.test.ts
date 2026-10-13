import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
const importFixtureModule = (specifier: string): Promise<any> => import(specifier);
import {EmailMessageContentService,EmailMessageContentError,type EmailPresentationCache} from '../src/lib/email-message-content.js';
import {RegisteredEmailMailboxProvider} from '../src/lib/email-mailbox-provider.js';
import type {AppConnectionAdapter,NativeEmailAccount,NativeEmailPresentation,NativeEmailFile,NativeEmailImage} from '../src/lib/app-connection-contract.js';
import type {EmailActor,EmailCapability,EmailMessageRecord,EmailScope} from '../src/lib/email-mailbox-service.js';

const scope:EmailScope={org_id:'org-reader',owner_user_id:'owner-reader',account_id:'account-reader'};
const actor:EmailActor={user_id:scope.owner_user_id,web_session_id:'reader-session',access_expires_at:6000};
const cap:EmailCapability={scope,resource_binding_id:'binding-reader',authority_version:'authority-reader',expires_at:5000};
const logicalId='mail_'+'b'.repeat(64),sourceDigest=createHash('sha256').update('independent original MIME').digest('hex');
const fileRef=createHash('sha256').update(sourceDigest+':file:0').digest('hex');
const imageRef=createHash('sha256').update(sourceDigest+':image:0:cid:logo').digest('hex');
const identity={account_id:scope.account_id,provider:'gmail' as const,logical_message_id:logicalId,source_digest:sourceDigest};
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
const source={schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider:'gmail',authority_epoch:1,
  logical_message_id:logicalId,conversation_id:'conversation-reader',locator:{message_id:'private-message',thread_id:'private-thread'}};
const record=():EmailMessageRecord=>({account_id:scope.account_id,logical_message_id:logicalId,revision:'revision-reader',received_at:null,
  folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Independent fixture'},provider_source:structuredClone(source)});
const status:NativeEmailAccount={account_id:scope.account_id,provider:'gmail',resource_binding_id:cap.resource_binding_id,authority_epoch:2,
  connection_revision:3,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],primary_address:'owner@example.test',display_label:'Reader'};
const presentation=():NativeEmailPresentation=>({schema_version:'deft.email_presentation.v1',...identity,content_trust:'unsanitized',
  files:[{file_ref:fileRef,filename:'exact.txt',media_type:'text/plain',size_bytes:10,disposition:'attachment',preview:'text'}],
  presentation:{format:'html',content:'<p>Known body</p><script>untrusted()</script><img src="deft-image:'+imageRef+'">',plain_text:'Known body',truncated:false,
    images:[{image_ref:imageRef,kind:'cid',index:0,alt:'Logo'}],headers:[{label:'Subject',value:'Independent fixture'}],metadata:{account_id:scope.account_id,
      primary_address:'owner@example.test',verified_sender_identities:'["owner@example.test","reply@example.test"]',reply_from:'sender@example.test',reply_to:'replyto@example.test',
      reply_to_list:'owner@example.test',reply_cc:'cc@example.test',subject:'Independent fixture',message_id:'<known@example.test>',references:'<prior@example.test>',
      conversation_id:'conversation-reader',conversation_coverage_state:'unknown',conversation_indexed_count:'0',conversation_exact_count:'',conversation_observed_at:'',
      conversation_drained:'false',mailbox_reset_required:'false'}}});
function cachedFixture(){
 let allowed=true,version='authority-reader',message:EmailMessageRecord|null=record(),fetches=0,afterHit=()=>{};
 const rows=new Map<string,NativeEmailPresentation>();
 const cache:EmailPresentationCache={read:async(s,key)=>{assert.deepEqual(s,scope);const row=rows.get(key);if(row)afterHit();return row?structuredClone(row):null;},
  write:async(s,key,value)=>{assert.deepEqual(s,scope);rows.set(key,structuredClone(value));}};
 const service=new EmailMessageContentService({current:async()=>{if(!allowed)throw Error('revoked');return {...cap,authority_version:version};}},
  {readMessage:async()=>message?structuredClone(message):null},{readSource:async()=>assert.fail('No source operation'),readPresentation:async()=>{fetches++;return presentation();}},()=>1000,cache);
 return {service,rows,fetches:()=>fetches,revoke(){allowed=false;},authorityVersion(value:string){version=value;},
  message(value:EmailMessageRecord|null){message=value;},afterHit(fn:()=>void){afterHit=fn;}};
}
test('warm presentation uses no provider fetch while source and authority changes miss the cache',async()=>{
 const f=cachedFixture();const cold=await f.service.readPresentation(actor,scope,logicalId),warm=await f.service.readPresentation(actor,scope,logicalId);
 assert.deepEqual(cold,warm);assert.equal(warm.content_trust,'unsanitized');assert.equal(f.fetches(),1);
 f.message({...record(),revision:'new-source-revision'});await f.service.readPresentation(actor,scope,logicalId);assert.equal(f.fetches(),2);
 f.authorityVersion('new-connected-authority');await f.service.readPresentation(actor,scope,logicalId);assert.equal(f.fetches(),3);
 f.revoke();await assert.rejects(f.service.readPresentation(actor,scope,logicalId),/EMAIL_ACCESS_DENIED/);assert.equal(f.fetches(),3);
});
test('held cached hits never disclose after revoke, source change or removal',async()=>{
 for(const mutation of ['revoke','source','delete']){const f=cachedFixture();await f.service.readPresentation(actor,scope,logicalId);
  f.afterHit(()=>{if(mutation==='revoke')f.revoke();else f.message(mutation==='delete'?null:{...record(),revision:'changed'});});
  await assert.rejects(f.service.readPresentation(actor,scope,logicalId),/EMAIL_ACCESS_DENIED/);assert.equal(f.fetches(),1);
 }
});
test('provider drafts stay uncached and non-owner requests never read a retained presentation',async()=>{
 const f=cachedFixture();f.message({...record(),folders:['drafts']});await f.service.readPresentation(actor,scope,logicalId);await f.service.readPresentation(actor,scope,logicalId);
 assert.equal(f.fetches(),2);assert.equal(f.rows.size,0);
 await assert.rejects(f.service.readPresentation({...actor,user_id:'another'},scope,logicalId),/EMAIL_ACCESS_DENIED/);assert.equal(f.fetches(),2);
});
type Kind='presentation'|'file'|'image';
function fixture(options:{lateAuthority?:boolean;lateStatus?:Partial<NativeEmailAccount>;recordMutation?:(value:EmailMessageRecord)=>EmailMessageRecord|null;
  resultMutation?:(value:any,kind:Kind)=>any;abort?:AbortController;missing?:boolean;onFirstStore?:()=>void}={}){
  let live=true,stores=0,reads=0,accountReads=0,lastBytes:Uint8Array|undefined;
  const adapter:AppConnectionAdapter={handle:async()=>new Response(),nativeEmailAccount:async()=>{
    accountReads++;return accountReads>1&&options.lateStatus?{...status,...options.lateStatus}:status;
  }};
  const result=(kind:Kind)=>{
    reads++;let value:NativeEmailPresentation|NativeEmailFile|NativeEmailImage;
    if(kind==='presentation')value=presentation();
    else{lastBytes=kind==='file'?Uint8Array.from(Buffer.from('Exact file')):png.slice();
      value=kind==='file'?{schema_version:'deft.email_file.v1',...identity,file_ref:fileRef,filename:'exact.txt',media_type:'text/plain',byte_length:lastBytes.length,bytes:lastBytes}
        :{schema_version:'deft.email_image.v1',...identity,image_ref:imageRef,media_type:'image/png',byte_length:lastBytes.length,bytes:lastBytes};}
    if(options.lateAuthority)live=false;options.abort?.abort(new Error('fixture cancelled'));
    return options.resultMutation?.(value,kind)??value;
  };
  const checkSource=(input:{source:Readonly<Record<string,unknown>>})=>{assert.equal(input.source.authority_epoch,2);assert.equal(source.authority_epoch,1);assert.equal(input.source.locator && (input.source.locator as any).message_id,'private-message');};
  adapter.nativeEmailPresentation=async input=>{checkSource(input);return result('presentation');};
  adapter.nativeEmailFile=async input=>{checkSource(input);assert.equal(input.source_digest,sourceDigest);assert.equal(input.file_ref,fileRef);return result('file');};
  adapter.nativeEmailImage=async input=>{checkSource(input);assert.equal(input.source_digest,sourceDigest);assert.equal(input.image_ref,imageRef);return result('image');};
  const provider=new RegisteredEmailMailboxProvider(async(_scope,capability,recheck,signal)=>{
    assert.deepEqual(_scope,scope);assert.deepEqual(capability.scope,scope);
    return {adapter,context:{...scope,installation_id:'installation-reader',resource_binding_id:cap.resource_binding_id,authority_version:cap.authority_version,expires_at:4000,recheck,signal}};
  },()=>1000);
  const authority={async current(){if(!live)throw Error('revoked');return structuredClone(cap);}};
  const store={async readMessage(){stores++;if(stores===1)options.onFirstStore?.();if(options.missing)return null;const value=record();return stores>1&&options.recordMutation?options.recordMutation(value):value;}};
  const service=new EmailMessageContentService(authority as any,store,provider,()=>1000);
  return {service,provider,adapter,get lastBytes(){return lastBytes;},get counts(){return {stores,reads};}};
}
function invoke(f:ReturnType<typeof fixture>,kind:Kind,signal?:AbortSignal){
  if(kind==='presentation')return f.service.readPresentation(actor,scope,logicalId,signal);
  if(kind==='file')return f.service.readFile(actor,scope,logicalId,{source_digest:sourceDigest,file_ref:fileRef},signal);
  return f.service.readImage(actor,scope,logicalId,{source_digest:sourceDigest,image_ref:imageRef},signal);
}

test('public content service plus registered bridge returns unsanitized JSON presentation and exact source-bound binary files/images',async()=>{
  const f=fixture(),p=await f.service.readPresentation(actor,scope,logicalId);
  assert.equal(p.content_trust,'unsanitized');assert.equal(p.source_digest,sourceDigest);assert.equal(p.logical_message_id,logicalId);
  assert.equal(p.presentation.content,presentation().presentation.content);assert.deepEqual(p.files.map(file=>file.file_ref),[fileRef]);
  assert.deepEqual(JSON.parse(p.presentation.metadata.verified_sender_identities),['owner@example.test','reply@example.test']);
  const file=await f.service.readFile(actor,scope,logicalId,{source_digest:sourceDigest,file_ref:fileRef});assert.equal(Buffer.from(file.bytes).toString(),'Exact file');
  const image=await f.service.readImage(actor,scope,logicalId,{source_digest:sourceDigest,image_ref:imageRef});assert.deepEqual(image.bytes,png);
  assert.equal(file.source_digest,p.source_digest);assert.equal(image.image_ref,p.presentation.images[0]!.image_ref);assert.deepEqual(f.counts,{stores:6,reads:3});
});
test('native content service carries bounded omitted count and explicit inert plain fallback while old output stays valid',async()=>{
 const f=fixture({resultMutation:value=>({...value,omitted_file_count:1,presentation:{...value.presentation,format:'plain',content:'Known body',rendering_fallback:'plain_text',images:[]}})});
 const result=await f.service.readPresentation(actor,scope,logicalId);assert.equal(result.omitted_file_count,1);assert.equal(result.presentation.rendering_fallback,'plain_text');
 assert.equal((await fixture().service.readPresentation(actor,scope,logicalId)).omitted_file_count,undefined);
 for(const count of [-1,257,1.2,'1'])await assert.rejects(fixture({resultMutation:value=>({...value,omitted_file_count:count})}).service.readPresentation(actor,scope,logicalId));
 for(const format of ['html','plain'])await assert.rejects(fixture({resultMutation:value=>({...value,presentation:{...value.presentation,format,rendering_fallback:'plain_text'}})}).service.readPresentation(actor,scope,logicalId));
 await assert.rejects(fixture({lateAuthority:true,resultMutation:value=>({...value,omitted_file_count:1})}).service.readPresentation(actor,scope,logicalId));
});
test('held owner revocation or connected account principal/revision change denies all3 operations and clears binary output',async()=>{
  for(const kind of ['presentation','file','image'] as const)for(const options of [{lateAuthority:true},{lateStatus:{principal_digest:'f'.repeat(64)}},{lateStatus:{connection_revision:4}},{lateStatus:{health:'revoked'}}]){
    const f=fixture(options);await assert.rejects(invoke(f,kind));assert.equal(f.counts.reads,1);if(kind!=='presentation')assert.ok(f.lastBytes!.every(byte=>byte===0));
  }
});
test('cache source fingerprint deletion/revision/locator change after held operation denies and zeroes file/image bytes',async()=>{
  for(const kind of ['presentation','file','image'] as const)for(const recordMutation of [()=>null,(value:EmailMessageRecord)=>({...value,revision:'new-revision'}),(value:EmailMessageRecord)=>({...value,provider_source:{...value.provider_source,locator:{message_id:'changed'}}})]){
    const f=fixture({recordMutation});await assert.rejects(invoke(f,kind),error=>error instanceof EmailMessageContentError&&error.code==='EMAIL_ACCESS_DENIED');
    if(kind!=='presentation')assert.ok(f.lastBytes!.every(byte=>byte===0));
  }
});
test('strict output schemas reject wrong account/message/provider/digest/refs, unmarked HTML, unbounded content and malformed binary counts',async()=>{
  const mutations=[(value:any)=>({...value,account_id:'foreign'}),(value:any)=>({...value,logical_message_id:'mail_'+'c'.repeat(64)}),(value:any)=>({...value,provider:'microsoft'}),
    (value:any,kind:Kind)=>kind==='presentation'?{...value,content_trust:'sanitized'}:{...value,source_digest:'f'.repeat(64)},
    (value:any,kind:Kind)=>kind==='presentation'?{...value,presentation:{...value.presentation,content:'é'.repeat(140000)}}:{...value,byte_length:1},
    (value:any,kind:Kind)=>kind==='presentation'?{...value,presentation:{...value.presentation,metadata:{...value.presentation.metadata,account_id:'foreign'}}}:kind==='file'?{...value,file_ref:'e'.repeat(64)}:{...value,image_ref:'e'.repeat(64)},
    (value:any,kind:Kind)=>kind==='presentation'?{...value,files:Array(33).fill(value.files[0])}:kind==='file'?{...value,filename:'../unsafe.txt'}:{...value,media_type:'image/svg+xml'}];
  for(const kind of ['presentation','file','image'] as const)for(const resultMutation of mutations){const f=fixture({resultMutation});await assert.rejects(invoke(f,kind));if(kind!=='presentation')assert.ok(f.lastBytes!.every(byte=>byte===0));}
});
test('malformed nomination/non-owner/missing/unsupported messages never become provider reads',async()=>{
  const f=fixture();await assert.rejects(f.service.readFile(actor,scope,logicalId,{source_digest:'bad',file_ref:fileRef}));
  await assert.rejects(f.service.readImage(actor,scope,logicalId,{source_digest:sourceDigest,image_ref:imageRef,url:'https://attacker.invalid'} as any));
  await assert.rejects(f.service.readPresentation({...actor,user_id:'foreign'},scope,logicalId));assert.deepEqual(f.counts,{stores:0,reads:0});
  const missing=fixture({missing:true});await assert.rejects(invoke(missing,'presentation'),error=>error instanceof EmailMessageContentError&&error.code==='EMAIL_MESSAGE_NOT_FOUND');assert.equal(missing.counts.reads,0);
  const unsupported=fixture();delete unsupported.adapter.nativeEmailPresentation;await assert.rejects(invoke(unsupported,'presentation'));assert.equal(unsupported.counts.reads,0);
});
test('cancellation after adapter result zeroes returned bytes and prevents presentation exposure',async()=>{
  for(const kind of ['presentation','file','image'] as const){const abort=new AbortController(),f=fixture({abort});await assert.rejects(invoke(f,kind,abort.signal),/cancel/);if(kind!=='presentation')assert.ok(f.lastBytes!.every(byte=>byte===0));}
});
test('validated owner scope remains immutable across held store I/O before provider selection',async()=>{
  const mutable={...scope};const f=fixture({onFirstStore:()=>{mutable.account_id='foreign';mutable.owner_user_id='foreign';}});
  const p=await f.service.readPresentation(actor,mutable,logicalId);assert.equal(p.account_id,scope.account_id);assert.equal(mutable.account_id,'foreign');
});
test('actual registered OAuth adapter MIME inspector agrees with strict host contracts through all3 public service methods',async()=>{
  const {createAppConnectionAdapter}=await importFixtureModule('../../../examples/apps/email/providers/connection-http.mjs');
  const {createEncryptedEmailCustody}=await importFixtureModule('../../../examples/apps/email/providers/custody-encrypted.mjs');
  const {createOAuthProvider}=await importFixtureModule('../../../examples/apps/email/providers/oauth-provider.mjs');
  const {LogicalMailIndex}=await importFixtureModule('../../../examples/apps/email/logical-mail-index.mjs');
  const {providerSourceForParent}=await importFixtureModule('../../../examples/apps/email/providers/provider-browser.mjs');
  for(const providerName of ['gmail','microsoft'] as const){
    const ownerScope={org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:'installation-reader'};
    const binding={scope:ownerScope,account_id:scope.account_id,provider:providerName,connection_target:'host-deployment',resource_binding_id:cap.resource_binding_id,
      action_binding_id:null,authority_epoch:2,capabilities:['read']};
    const rows=new Map();const custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(41),key_id:'reader-contract-test',store:{
      async withLock({key}:any,work:any){return work({async read(){return structuredClone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}:any){const row=rows.get(key);if((row?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(row?.revision??0)+1,value:structuredClone(value)});return true;}});}}});
    const client={client_id:'synthetic-client',client_secret:'synthetic-secret',redirect_uri:'https://fixture.invalid/apps/connections/callback',...(providerName==='microsoft'?{tenant:'common'}:{})};
    const mime=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Registered MIME\r\nMessage-ID: <message@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=reader\r\n\r\n--reader\r\nContent-Type: text/html\r\n\r\n<p>Registered body</p><img src="cid:logo">\r\n--reader\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="report.txt"\r\n\r\nExact report\r\n--reader\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(png).toString('base64')+'\r\n--reader--\r\n');
    let providerFetches=0;const fetch=async()=>{providerFetches++;return providerName==='gmail'?new Response(JSON.stringify({id:'message',threadId:'thread',raw:mime.toString('base64url')}),{headers:{'content-type':'application/json'}}):new Response(mime,{headers:{'content-type':'message/rfc822'}});};
    await custody.withAccount(binding,async(tx:any)=>tx.write({health:'connected',secret:{access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_at:999999,
      scopes:providerName==='gmail'?['openid','email','https://www.googleapis.com/auth/gmail.readonly']:['offline_access','User.Read','Mail.Read'],
      client_fingerprint:createOAuthProvider({provider:providerName,client,fetch,now:()=>1000}).client_fingerprint,
      identity:{provider_subject:'verified-private-subject',primary_address:'owner@example.test',display_label:'Reader fixture',verified_sender_identities:['owner@example.test']}}}));
    const {scope:ignored,...options}=binding;
    const adapter=await createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{[providerName]:client}},custody,fetch,now:()=>1000,
      host:{resolveContext:async()=>assert.fail('No Experience projection'),assertCurrent:async()=>assert.fail('No Experience gate')}});
    const account={...options,health:'connected',primary_address:'owner@example.test',display_label:'Reader fixture',verified_sender_identities:['owner@example.test']};
    const locator=providerName==='gmail'?{kind:'gmail',message_id:'message',thread_id:'thread',label_ids:['INBOX']}:{kind:'microsoft',message_id:'message',conversation_id:'conversation',folder_id:'folder',id_type:'immutable'};
    const parent=new LogicalMailIndex(ownerScope).upsert(ownerScope,{account_id:scope.account_id,provider:providerName,locator});
    const provider=new RegisteredEmailMailboxProvider(async(_scope,_cap,recheck,signal)=>({adapter,context:{...scope,installation_id:ownerScope.installation_id,
      resource_binding_id:cap.resource_binding_id,authority_version:cap.authority_version,expires_at:4000,recheck,signal}}),()=>1000);
    const currentRecord={...record(),logical_message_id:parent.logical_message_id,provider_source:providerSourceForParent(account,parent)};
    const service=new EmailMessageContentService({current:async()=>structuredClone(cap)} as any,{readMessage:async()=>currentRecord},provider,()=>1000);
    const p=await service.readPresentation(actor,scope,parent.logical_message_id);
    assert.equal(p.source_digest,createHash('sha256').update(mime).digest('hex'));assert.equal(p.content_trust,'unsanitized');assert.deepEqual(p.presentation.headers.map(row=>row.label),['From','To','Subject']);
    const file=await service.readFile(actor,scope,parent.logical_message_id,{source_digest:p.source_digest,file_ref:p.files[0]!.file_ref});assert.equal(Buffer.from(file.bytes).toString(),'Exact report');
    const image=await service.readImage(actor,scope,parent.logical_message_id,{source_digest:p.source_digest,image_ref:p.presentation.images[0]!.image_ref});assert.deepEqual(Buffer.from(image.bytes),Buffer.from(png));
    assert.equal(providerFetches,3);file.bytes.fill(0);image.bytes.fill(0);
  }
});
