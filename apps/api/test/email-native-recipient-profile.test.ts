import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseMailboxList,formatMailboxList,parseNativeMailboxList,formatNativeMailboxList} from '../../../packages/app-kit/src/mailbox-list.js';
import {NativeEmailPresentationSchema} from '../src/lib/email-native-adapter-contract.js';
import {EmailDraftContentSchema} from '../src/lib/email-draft-service.js';
import {assertNativeReplyModeAvailable} from '../src/lib/email-native-reply-policy.js';
import {createEmailNativeOutgoingSnapshotBuilder,type EmailNativeReplyContext} from '../src/lib/email-native-outgoing-snapshot.js';
import {createEmailProviderDraftMimeBuilder} from '../src/lib/email-provider-draft-mime.js';
import {createEmailNativeReplyResolver} from '../src/lib/email-native-reply.js';
const providerRoot=new URL('../../../examples/apps/email/',import.meta.url);
const {inspectEmailSourceFiles}=await import(new URL('providers/incoming-source-files.mjs',providerRoot).href);
const {parsedMailboxes,parsedNativeMailboxes}=await import(new URL('providers/resource-reader.mjs',providerRoot).href);
const {createOutgoingSnapshotService,serializeNativeDraft}=await import(new URL('outgoing-snapshot.mjs',providerRoot).href);
const {simpleParser}=createRequire(new URL('package.json',providerRoot))('mailparser');
const list=(n:number,start=0)=>Array.from({length:n},(_,i)=>`Person ${i+start} <p${i+start}@example.test>`).join(', ');
const owner='owner@example.test',logical='mail_'+'a'.repeat(64),conversation='conv_'+'a'.repeat(64);
const account={account_id:'account',provider:'gmail',primary_address:owner,verified_sender_identities:[owner]};
const mime=(to:string,extra='')=>Buffer.from(`From: Other <other@example.test>\r\nTo: ${to}\r\n${extra}Message-ID: <parent@example.test>\r\nSubject: Large recipient fixture\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExact readable body.`, 'utf8');
const inspect=(to:string,extra='')=>inspectEmailSourceFiles(mime(to,extra),{profile:'native',presentation:true,account,conversation_id:conversation});

test('native 32/33/200/201 profile preserves names/order/duplicates while legacy defaults stay32',()=>{
 for(const n of [32,33,200]){const value=list(n),parsed=parseNativeMailboxList(value);assert.equal(parsed.length,n);assert.deepEqual(parseNativeMailboxList(formatNativeMailboxList(parsed)),parsed);assert.deepEqual(parsedNativeMailboxes(value),parsed.map(row=>({address:row.address,display_name:row.displayName})));}
 assert.throws(()=>parseNativeMailboxList(list(201)));assert.throws(()=>parsedNativeMailboxes(list(201)));
 assert.equal(parseMailboxList(list(32)).length,32);assert.throws(()=>parseMailboxList(list(33)));assert.throws(()=>parseMailboxList(list(33),{maxItems:200}));assert.throws(()=>parsedMailboxes(list(33)));assert.throws(()=>formatMailboxList(parseNativeMailboxList(list(33))));
 const names=parseNativeMailboxList('"Comma, Name" <same@example.test>, "Comma, Name" <same@example.test>');assert.equal(names.length,2);assert.equal(names[0]!.displayName,'Comma, Name');assert.deepEqual(parseNativeMailboxList(formatNativeMailboxList(names)),names);
});
test('native UTF8 byte bounds are exact on parser, formatter and draft saving; unsupported syntax stays invalid',()=>{
 const base='"😀" <a@example.test>',bytes=Buffer.byteLength(base);
 for(const n of [16383,16384]){const value=base+' '.repeat(n-bytes);assert.equal(Buffer.byteLength(value),n);assert.equal(parseNativeMailboxList(value).length,1);assert.equal(parsedNativeMailboxes(value).length,1);assert.equal(EmailDraftContentSchema.safeParse(content({to:value})).success,true);}
 const over=base+' '.repeat(16385-bytes);assert.throws(()=>parseNativeMailboxList(over));assert.throws(()=>parsedNativeMailboxes(over));assert.equal(EmailDraftContentSchema.safeParse(content({to:over})).success,false);
 const huge=Array.from({length:200},(_,i)=>({address:`p${i}@example.test`,displayName:'😀'.repeat(64)}));assert.throws(()=>formatNativeMailboxList(huge));
 for(const value of ['Friends: a@example.test;','a@example.test\r\nBcc: b@example.test','"bad\ud800" <a@example.test>','"bad\u202e" <a@example.test>','a..b@example.test']){assert.throws(()=>parseNativeMailboxList(value));assert.throws(()=>parsedNativeMailboxes(value));}
});
test('actual native MIME33/200 retain full seeds/body; legacy accountpresence still rejects33',async()=>{
 for(const n of [33,200]){const value=await inspect(list(n));assert.equal(value.presentation.content,'Exact readable body.');assert.equal(parseNativeMailboxList(value.presentation.metadata.reply_to_list).length,n);assert.equal(value.reply_seed_unavailable,undefined);}
 await assert.rejects(inspectEmailSourceFiles(mime(list(33)),{presentation:true,account,conversation_id:conversation}));
});
test('native overflow/groups/duplicatecritical headers preserve body and flag empty authoritative seeds with independent display snippets',async()=>{
 const largeNames=Array.from({length:200},(_,i)=>`"${'😀'.repeat(64)}" <p${i}@example.test>`).join(', ');
 for(const [to,extra]of [[list(201),''],[largeNames,''],['Friends: a@example.test;',''],['a@example.test','To: b@example.test\r\n'],['a@example.test','Reply-To: Friends: b@example.test;\r\n']]){
  const value=await inspect(to!,extra);assert.equal(value.presentation.content,'Exact readable body.');assert.ok(value.reply_seed_unavailable?.length);for(const key of value.reply_seed_unavailable)assert.equal(value.presentation.metadata[key],'');assert.ok(value.presentation.headers.some((h:any)=>h.label==='To'));
  const dto={schema_version:'deft.email_presentation.v1',account_id:'account',provider:'gmail',logical_message_id:logical,source_digest:'b'.repeat(64),content_trust:'unsanitized',...value};assert.equal(NativeEmailPresentationSchema.safeParse(dto).success,true);
  assert.equal(NativeEmailPresentationSchema.safeParse({...dto,reply_seed_unavailable:['reply_to_list','reply_to_list']}).success,false);
  assert.equal(NativeEmailPresentationSchema.safeParse({...dto,reply_seed_unavailable:['unknown']}).success,false);
  assert.equal(NativeEmailPresentationSchema.safeParse({...dto,reply_seed_unavailable:['reply_from']}).success,false);
 }
});
const parent=(patch:Partial<EmailNativeReplyContext>={}):EmailNativeReplyContext=>({account_id:'account',provider:'gmail',logical_message_id:logical,message_id:'<parent@example.test>',references:[],from:'other@example.test',reply_to:'',to:owner,cc:'',thread_id:'thread',...patch});
test('current parent mode guards preserve independent simpleReply/Forward, own aliases, dedup and aggregate200',()=>{
 const unavailable=parent({to:'',reply_seed_unavailable:['reply_to_list']});assert.doesNotThrow(()=>assertNativeReplyModeAvailable(unavailable,'reply',[owner]));assert.doesNotThrow(()=>assertNativeReplyModeAvailable(unavailable,'forward',[owner]));assert.throws(()=>assertNativeReplyModeAvailable(unavailable,'reply_all',[owner]));
 assert.throws(()=>assertNativeReplyModeAvailable(parent({reply_to:'',reply_seed_unavailable:['reply_to']}),'reply',[owner]));
 assert.throws(()=>assertNativeReplyModeAvailable(parent({from:owner,to:'',reply_seed_unavailable:['reply_to_list']}),'reply',[owner]));
 assert.doesNotThrow(()=>assertNativeReplyModeAvailable(parent({from:owner,to:list(200),cc:''}),'reply_all',[owner]));
 assert.throws(()=>assertNativeReplyModeAvailable(parent({from:owner,to:list(200),cc:list(1,200)}),'reply_all',[owner]));
 assert.throws(()=>assertNativeReplyModeAvailable(parent({to:list(200)}),'reply_all',[owner]));
 assert.doesNotThrow(()=>assertNativeReplyModeAvailable(parent({to:list(199),cc:list(1)}),'reply_all',[owner]));
 assert.doesNotThrow(()=>assertNativeReplyModeAvailable(parent({from:'alias@example.test',to:list(200),cc:''}),'reply_all',[owner,'alias@example.test']));
});
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},capability={scope,resource_binding_id:'binding',authority_version:'v1',expires_at:Date.now()+120000};
const content=(patch:Record<string,unknown>={})=>({mode:'compose',to:'target@example.test',cc:'',bcc:'',subject:'Fixture',body:'Body',body_html:'',reply_record_id:'',attachments:[],...patch});
const draft=(value:unknown)=>({draft_id:randomUUID(),revision:1,content_revision:1,status:'draft',content:value,origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-07T00:00:00.000Z',updated_at:'2026-10-07T00:00:00.000Z'}) as any;
const identity={...account,provider:'gmail' as const,health:'connected',capabilities:['read','send','modify'],authority_epoch:1,connection_revision:1,principal_digest:'c'.repeat(64),resource_binding_id:'binding',action_binding_id:'action',display_label:'Fixture',org_id:'org',owner_user_id:'owner',installation_id:'install',connection_target:'target'};
function builderHarness(current:EmailNativeReplyContext=parent()){
 const calls={reserve:0,file:0,reply:0,serialize:0};let reply=current;
 const fileBytes=Buffer.from('Exact file');const file={file_id:randomUUID(),filename:'fixture.txt',media_type:'text/plain',size_bytes:fileBytes.length,sha256:createRequire(import.meta.url)('node:crypto').createHash('sha256').update(fileBytes).digest('hex')};
 const readFile=async()=>{calls.file++;return {...file,bytes:Buffer.from(fileBytes)};};
 const send=createEmailNativeOutgoingSnapshotBuilder({accounts:{getSendIdentity:async()=>identity as any},attachments:{readForSend:readFile},replies:async()=>{calls.reply++;return reply;},createOutgoingSnapshotService:(ports:any)=>createOutgoingSnapshotService({...ports,profile:'native'})});
 const ports={resolve:async()=>({account:identity,installation_id:'install',verified_sender_identities:[owner],serialize:async(...args:any[])=>{calls.serialize++;return serializeNativeDraft(...args);}}),readFile,readReply:async()=>{calls.reply++;return reply;}};
 const args=(value:unknown)=>({scope,capability,draft:draft(value),recheck:async()=>{}});
 return {calls,file,ports,setParent:(value:EmailNativeReplyContext)=>{reply=value;},send:(value:unknown)=>send.prepareAndBind({...args(value),actor:{user_id:'owner',web_session_id:'session',access_expires_at:Date.now()+120000},operation_id:randomUUID(),reserve:async()=>{calls.reserve++;return 'reserved';}} as any),remote:(value:unknown)=>createEmailProviderDraftMimeBuilder(ports)(args(value) as any)};
}
test('actual Send and providerdraft MIME retain33/200 names/order, and raw aggregate201 duplicates deny beforeeffects',async()=>{
 for(const n of [33,200]){const f=builderHarness(),value=content({to:list(n)}),send=await f.send(value),remote=await f.remote(value);for(const bytes of [send.mime_bytes!,remote.mime_bytes]){const parsed=await simpleParser(bytes);assert.equal(parsed.to.value.length,n);assert.equal(parsed.to.value[n-1].name,`Person ${n-1}`);bytes.fill(0);}}
 for(const fields of [{to:list(200),cc:'p0@example.test'},{to:list(100),cc:list(100,100),bcc:'p0@example.test'}]){const f=builderHarness(),value=content({...fields,attachments:[f.file]});await assert.rejects(f.send(value));await assert.rejects(f.remote(value));assert.equal(f.calls.reserve,0);assert.equal(f.calls.file,0);assert.equal(f.calls.serialize,0);}
});
test('saved replyAll cannot bypass current parent unavailable or aggregate201 before attachment/reservation/provider effects',async()=>{
 for(const current of [parent({to:'',reply_seed_unavailable:['reply_to_list']}),parent({to:list(200)})]){const f=builderHarness(current),value=content({mode:'reply_all',reply_record_id:logical,attachments:[f.file]});await assert.rejects(f.send(value));await assert.rejects(f.remote(value));assert.equal(f.calls.file,0);assert.equal(f.calls.reserve,0);assert.equal(f.calls.serialize,0);}
 const f=builderHarness(parent({to:'',reply_seed_unavailable:['reply_to_list']}));const value=content({mode:'forward',reply_record_id:logical});const send=await f.send(value),remote=await f.remote(value);send.mime_bytes?.fill(0);remote.mime_bytes.fill(0);
});
test('held attachment I/O parent overflow is denied at final Send and before providerdraft serialization',async()=>{
 const initial=parent(),unavailable=parent({to:'',reply_seed_unavailable:['reply_to_list']});
 for(const kind of ['send','remote']){const f=builderHarness(initial),value=content({mode:'reply_all',reply_record_id:logical,attachments:[f.file]});if(kind==='remote'){const read=f.ports.readFile;f.ports.readFile=async()=>{const file=await read();f.setParent(unavailable);return file;};await assert.rejects(f.remote(value));assert.equal(f.calls.serialize,0);}else{
   let reads=0,reserved=0,retained:Uint8Array|undefined;
   const builder=createEmailNativeOutgoingSnapshotBuilder({accounts:{getSendIdentity:async()=>identity as any},attachments:{readForSend:async()=>{retained=Buffer.from('Exact file');return {...f.file,bytes:retained};}},replies:async()=>++reads===1?initial:unavailable,createOutgoingSnapshotService:(ports:any)=>createOutgoingSnapshotService({...ports,profile:'native'})});
   await assert.rejects(builder.prepareAndBind({scope,capability,draft:draft(value),actor:{user_id:'owner',web_session_id:'session',access_expires_at:Date.now()+120000},recheck:async()=>{},operation_id:randomUUID(),reserve:async()=>{reserved++;return 'reserved';}} as any));assert.equal(reserved,0);assert.ok(retained?.every(byte=>byte===0));
  }}
});
test('real reply resolver transports current unavailable status without substituting a trimmed seed',async()=>{
 const inspected=await inspect(list(201)),source={schema_version:'deft.email_presentation.v1',account_id:'account',provider:'gmail',logical_message_id:logical,source_digest:'b'.repeat(64),content_trust:'unsanitized',...inspected};
 const record={account_id:'account',logical_message_id:logical,revision:1,provider_source:{provider:'gmail',locator:{thread_id:'thread'}}};
 const resolve=createEmailNativeReplyResolver({readMessage:async()=>record} as any,{readPresentation:async()=>NativeEmailPresentationSchema.parse(source)});
 const reply=await resolve({user_id:'owner',web_session_id:'session',access_expires_at:Date.now()+120000},scope,logical,async()=>{});assert.deepEqual(reply.reply_seed_unavailable,['reply_to_list']);assert.equal(reply.to,'');assert.doesNotThrow(()=>assertNativeReplyModeAvailable(reply,'reply',[owner]));assert.throws(()=>assertNativeReplyModeAvailable(reply,'reply_all',[owner]));
});
