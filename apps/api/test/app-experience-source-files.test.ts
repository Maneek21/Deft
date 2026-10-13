import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppConnectionRegistry } from '../src/lib/app-connection-registry.js';
import { AppExperienceResourceContentService } from '../src/lib/app-experience-resource-content.js';
import type { AppConnectionAdapter, AppConnectionProjection } from '../src/lib/app-connection-contract.js';
import { AppError } from '../src/lib/app-errors.js';

function fixture(readingPolicy?:ConstructorParameters<typeof AppExperienceResourceContentService>[4]) {
 const caller={org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID()},session=randomUUID(),record=randomUUID();
 const pins={org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'personal',resource_key:'inbox',resource_binding_id:randomUUID(),action_key:null,action_binding_id:null};
 const source={installation_id:pins.installation_id,target_key:pins.target_key,resource_binding_id:pins.resource_binding_id,exposure_id:randomUUID(),exposure_epoch:1,record:{record_id:record,revision:'provider-current',label:'Controlled MIME',data:{account_id:'controlled-account'},provider_source:{logical_message_id:'private-logical-id'}}};
 const state={live:true,calls:0,time:1000,changed:false};
 const projection:AppConnectionProjection={...pins,purpose:'read_source',web_session_id:caller.sid,experience_session_id:session,runtime_registration_id:randomUUID(),descriptor_digest:'sha256:'+'1'.repeat(64),allowed_operations:['read_one'],content_policy:{document:{max_characters:16384},source:{media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608}},lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,checked_at:1000,expires_at:61000};
 const authority:ConstructorParameters<typeof AppExperienceResourceContentService>[0]={
  async sourceRecord(c,s,k,id){if(!state.live||JSON.stringify(c)!==JSON.stringify(caller)||s!==session||k!=='inbox'||id!==record)throw new AppError('Unavailable','APP_ACTION_UNAVAILABLE',409);return structuredClone({...source,record:{...source.record,revision:state.changed?'changed':source.record.revision}});},
  async connectionSetup(c,s,p,_signal,purpose){assert.deepEqual(c,caller);assert.equal(s,session);assert.deepEqual(p,pins);assert.equal(purpose,'read_source');if(!state.live)throw new AppError('Unavailable','APP_ACTION_UNAVAILABLE',409);return structuredClone(projection);}
 };
 const files=[{file_ref:'a'.repeat(64),filename:'controlled.txt',media_type:'text/plain',size_bytes:7,disposition:'attachment',preview:'text'}];
 const adapter={handle:async()=>{throw Error('No send/connect allowed');},readSourceFiles:async(input:{file_ref?:string})=>{state.calls++;if(input.file_ref)return {files,bytes:new Uint8Array(Buffer.from('Fixture')),file_ref:input.file_ref};return {files};}} as unknown as AppConnectionAdapter;
 const service=new AppExperienceResourceContentService(authority,async()=>new AppConnectionRegistry([{pins,adapter}]),()=>state.time,15000,readingPolicy);
 return {caller,session,record,source,state,projection,adapter,files,service,read:(operation='list_files',extra={})=>service.read(caller,session,'inbox',{operation,record_id:record,...extra})};
}

test('provider-backed file inspection crosses the current source-read service without a saved projection',async()=>{
 const f=fixture(),output=await f.read();assert.equal(output.kind,'files');assert.deepEqual((output as unknown as {files:unknown}).files,f.files);assert.equal(f.state.calls,1);
 assert.equal(output.exposure_id,f.source.exposure_id);
});
test('legacy file/presentation contracts preserve optional omission and plain fallback notices without weakening exact selection',async()=>{
 const f=fixture();f.adapter.readSourceFiles=async(input:any)=>input.file_ref?{files:f.files,omitted_file_count:1,file_ref:input.file_ref,bytes:new Uint8Array(Buffer.from('Fixture'))}:{files:f.files,omitted_file_count:1};
 const files=await f.read();assert.equal(files.kind,'files');assert.equal((files as any).omitted_file_count,1);
 assert.equal((await f.read('read_file',{file_ref:f.files[0]!.file_ref})).kind,'file');
 f.adapter.readSourceFiles=async()=>({files:f.files,omitted_file_count:1,presentation:{format:'plain',content:'Body',plain_text:'Body',truncated:false,rendering_fallback:'plain_text',images:[],headers:[]}});
 const shown=await f.read('read_presentation');assert.equal(shown.kind,'presentation');if(shown.kind==='presentation'){assert.equal(shown.presentation.omitted_file_count,1);assert.equal(shown.presentation.rendering_fallback,'plain_text');}
 for(const count of [-1,257,1.2,'1']){f.adapter.readSourceFiles=async()=>({files:f.files,omitted_file_count:count});await assert.rejects(f.read());}
 for(const change of [{format:'html',images:[]},{format:'plain',images:[{image_ref:'b'.repeat(64),kind:'remote',index:0,alt:''}]}]){f.adapter.readSourceFiles=async()=>({files:f.files,presentation:{format:'plain',content:'Body',plain_text:'Body',truncated:false,rendering_fallback:'plain_text',images:[],headers:[],...change}});await assert.rejects(f.read('read_presentation'));}
});

test('saved image choice is attached only by host after strict provider parsing and final source authority checks',async()=>{
 let policyCalls=0;
 const f=fixture(async input=>{policyCalls++;assert.equal(input.record.record_id,f.record);assert.deepEqual(input.entry.pins.resource_binding_id,f.source.resource_binding_id);return 'always';});
 const presentation={format:'plain',content:'Fixture',plain_text:'Fixture',truncated:false,images:[],headers:[]};
 f.adapter.readSourceFiles=async()=>({files:f.files,presentation});
 const output=await f.read('read_presentation');assert.equal(output.kind,'presentation');if(output.kind==='presentation')assert.equal(output.presentation.external_images,'always');assert.equal(policyCalls,1);
 f.adapter.readSourceFiles=async()=>({files:f.files,presentation:{...presentation,external_images:'always'}});
 await assert.rejects(f.read('read_presentation'));assert.equal(policyCalls,1,'Adapter cannot grant its own loading policy');
 for(const condition of ['revoked','changed','expired']){
  const g=fixture(async()=>{if(condition==='revoked')g.state.live=false;if(condition==='changed')g.state.changed=true;if(condition==='expired')g.state.time=61001;return 'always';});
  g.adapter.readSourceFiles=async()=>({files:g.files,presentation});await assert.rejects(g.read('read_presentation'));
 }
});
test('file selection is bounded and exact; changed source, account or review never hands bytes to the caller',async()=>{
 const f=fixture(),download=await f.read('read_file',{file_ref:f.files[0]!.file_ref});assert.equal(download.kind,'file');if(download.kind==='file')assert.equal(Buffer.from(download.bytes).toString(),'Fixture');
 for(const wrong of [{...f.caller,org_id:randomUUID()},{...f.caller,user_id:randomUUID()},{...f.caller,sid:randomUUID()}])await assert.rejects(f.service.read(wrong,f.session,'inbox',{operation:'list_files',record_id:f.record}));
 await assert.rejects(f.read('read_file',{file_ref:'f'.repeat(64)}));
 const captured=new Uint8Array(Buffer.from('Fixture'));f.adapter.readSourceFiles=async()=>{f.state.changed=true;return {files:f.files,file_ref:f.files[0]!.file_ref,bytes:captured};};
 await assert.rejects(f.read('read_file',{file_ref:f.files[0]!.file_ref}));assert.ok(captured.every(byte=>byte===0));
});
test('held I/O revocation/abort/expiry clears selected bytes; missing source review denies before provider I/O',async()=>{
 for(const condition of ['revoked','aborted','expired']){const f=fixture(),controller=new AbortController(),bytes=new Uint8Array(Buffer.from('Fixture'));f.adapter.readSourceFiles=async()=>{if(condition==='revoked')f.state.live=false;if(condition==='aborted')controller.abort();if(condition==='expired')f.state.time=61001;return {files:f.files,file_ref:f.files[0]!.file_ref,bytes};};await assert.rejects(f.service.read(f.caller,f.session,'inbox',{operation:'read_file',record_id:f.record,file_ref:f.files[0]!.file_ref},controller.signal));assert.ok(bytes.every(byte=>byte===0));}
 const f=fixture();delete f.projection.content_policy!.source;await assert.rejects(f.read());assert.equal(f.state.calls,0);
});
test('file outputs reject dishonest sizes, duplicate selectors, unsafe filenames and unauthorized extra fields',async()=>{
 for(const change of [(files:typeof fixture extends never?never:ReturnType<typeof fixture>['files'])=>{files[0]!.filename='folder/file.txt';},(files:ReturnType<typeof fixture>['files'])=>{files[0]!.filename='bad\r\nheader';},(files:ReturnType<typeof fixture>['files'])=>{files.push({...files[0]!});},(files:ReturnType<typeof fixture>['files'])=>{files[0]!.size_bytes=8388609;}]){const f=fixture();change(f.files);await assert.rejects(f.read());}
 const f=fixture();f.adapter.readSourceFiles=async()=>({files:f.files,provider_url:'https://private.test/'});await assert.rejects(f.read());
});
