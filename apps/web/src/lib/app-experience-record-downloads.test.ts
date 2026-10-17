import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import {frameAppData,APP_DATA_FRAME_MEDIA_TYPE} from '../../../../packages/app-kit/src/app-data';
import {createExperienceRecordDownloads} from './app-experience-record-downloads';
import {DeftExperienceRecordFormNodeSchema} from '../../../../packages/app-kit/src/app-data';
import type {ExperienceRecordRow} from './app-experience-record-writer';
const id='11111111-1111-4111-8111-111111111111',fileId='22222222-2222-4222-8222-222222222222',digest='sha256:'+'a'.repeat(64);
export const node=DeftExperienceRecordFormNodeSchema.parse({kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:1,content_digest:digest,action_key:'send_message',profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}});
export async function fixture(status:ExperienceRecordRow['status']='draft'){
 const original=new TextEncoder().encode('synthetic exact file\n'),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',original)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const file={file_id:fileId,filename:'synthetic.txt',media_type:'text/plain',size_bytes:original.length,sha256:sha};
 const row:ExperienceRecordRow={record_id:id,revision:7,content_digest:digest,status,value:{to:'recipient@example.test',subject:'Synthetic',body:'  unchanged\ttext\n\n',body_html:'',attachments:[file]},files:[{file_id:fileId,upload_revision:3,sha256:'sha256:'+sha}]};
 return {original,file,row};
}
const savedDocument=globalThis.document,savedCreate=URL.createObjectURL,savedRevoke=URL.revokeObjectURL;
let downloads:{href:string;download:string}[]=[],created=0,revoked=0;
test.beforeEach(()=>{downloads=[];created=0;revoked=0;Object.assign(globalThis,{document:{createElement:()=>({href:'',download:'',click(){downloads.push({href:this.href,download:this.download});}})}});URL.createObjectURL=()=>{created++;return 'blob:owned';};URL.revokeObjectURL=()=>{revoked++;};});
test.after(()=>{Object.assign(globalThis,{document:savedDocument});URL.createObjectURL=savedCreate;URL.revokeObjectURL=savedRevoke;});
test('draft, submitted and archived download exact catalog bytes through read only and clear buffers/URLs',async()=>{
 for(const status of ['draft','submitted','archived'] as const){const f=await fixture(status),bytes=new Uint8Array(f.original),abort=new AbortController();let reads=0;
  const host=createExperienceRecordDownloads({node,row:()=>f.row,current:()=>true,signal:abort.signal,read:async(row,file,signal)=>{reads++;assert.equal(signal.aborted,false);assert.equal(row.revision,7);assert.equal(row.files?.[0].upload_revision,3);assert.equal(file.sha256,f.file.sha256);return bytes;}});
  assert.equal(await host.download(f.file),true);assert.equal(reads,1);assert.equal(downloads.at(-1)?.download,'synthetic.txt');assert.ok(bytes.every(byte=>byte===0));host.dispose();
 }assert.equal(created,3);assert.equal(revoked,3);
});
test('foreign record, missing catalog, changed digest or unlisted metadata deny before IO',async()=>{
 for(const change of ['record','missing','digest','upload_revision','filename'] as const){const f=await fixture();let reads=0;const row=structuredClone(f.row) as any;
  if(change==='record')row.record_id=fileId;if(change==='missing')row.files=[];if(change==='digest')row.files[0].sha256='sha256:'+'b'.repeat(64);if(change==='upload_revision')row.files[0].upload_revision=0;if(change==='filename')row.value.attachments[0].filename='other.txt';
  const host=createExperienceRecordDownloads({node,row:()=>row,current:()=>true,signal:new AbortController().signal,read:async()=>{reads++;return f.original;}});
  assert.equal(await host.download(f.file),false,change);assert.equal(reads,0);host.dispose();
 }assert.equal(downloads.length,0);
});
test('changed revision, content, upload version, status or revoked current scope discard late bytes',async()=>{
 for(const change of ['revision','content','upload','status','current'] as const){const f=await fixture(),abort=new AbortController();let row=structuredClone(f.row),live=true,release!:(bytes:Uint8Array)=>void;
  const host=createExperienceRecordDownloads({node,row:()=>row,current:()=>live,signal:abort.signal,read:()=>new Promise(resolve=>{release=resolve;})});
  const result=host.download(f.file),bytes=new Uint8Array(f.original);if(change==='revision')row={...row,revision:8};if(change==='content')row={...row,content_digest:'sha256:'+'b'.repeat(64)};if(change==='upload')row={...row,files:[{...row.files![0],upload_revision:4}]};if(change==='status')row={...row,status:'submitted'};if(change==='current')live=false;
  release(bytes);assert.equal(await result,false,change);assert.ok(bytes.every(byte=>byte===0));host.dispose();
 }assert.equal(created,0);
});
test('abort/dispose settle a held read, clear late bytes, reject duplicate and subsequent reads',async()=>{
 for(const how of ['abort','dispose'] as const){const f=await fixture(),abort=new AbortController();let release!:(bytes:Uint8Array)=>void,reads=0;
  const host=createExperienceRecordDownloads({node,row:()=>f.row,current:()=>true,signal:abort.signal,read:()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
  const first=host.download(f.file);assert.equal(await host.download(f.file),false);if(how==='abort')abort.abort();else host.dispose();assert.equal(await first,false);assert.equal(await host.download(f.file),false);assert.equal(reads,1);
  const late=new Uint8Array(f.original);release(late);await new Promise(resolve=>setImmediate(resolve));assert.ok(late.every(byte=>byte===0));host.dispose();
 }assert.equal(downloads.length,0);
});
test('wrong byte count/hash denied and bytes cleared; failed read never auto retries',async()=>{
 const f=await fixture();for(const bytes of [new Uint8Array([1]),new Uint8Array(f.original.length).fill(1)]){
  const host=createExperienceRecordDownloads({node,row:()=>f.row,current:()=>true,signal:new AbortController().signal,read:async()=>bytes});assert.equal(await host.download(f.file),false);assert.ok(bytes.every(byte=>byte===0));host.dispose();
 }let reads=0;const host=createExperienceRecordDownloads({node,row:()=>f.row,current:()=>true,signal:new AbortController().signal,read:async()=>{reads++;throw Error('Read unavailable');}});assert.equal(await host.download(f.file),false);assert.equal(reads,1);host.dispose();assert.equal(created,0);
});
test('actual host client public binary port preserves upload revision and digest for submitted history download',async()=>{
 const f=await fixture('submitted'),connection='33333333-3333-4333-8333-333333333333',installation='44444444-4444-4444-8444-444444444444',operations:string[]=[];
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
  if((path.endsWith('/context')||path.endsWith('/resolve')))return new Response(JSON.stringify({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:'mailbox',account:{account_ref:id,label:'Synthetic account'},resource_key:'inbox',identities:[],stores:[{declaration:{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400},consent:{consent_id:id,consent_digest:digest,expires_at:new Date(Date.now()+60000).toISOString()}}]}]}),{headers:{'content-type':'application/json'}});
  assert.equal(path,`/api/app-data/connections/${connection}/requests`);const request=JSON.parse(String(options.body));operations.push(request.operation);
  assert.deepEqual(request.input,{store_key:'drafts',record_id:id,file_id:fileId,upload_revision:3,sha256:'sha256:'+f.file.sha256});
  return new Response(new Uint8Array(frameAppData({schema_version:'deft.app_data_binary.v1',request_id:request.request_id,operation:'file_read',input_digest:await appDataInputDigest('file_read',request.input),record_id:id,file_id:fileId,upload_revision:3,sha256:'sha256:'+f.file.sha256,size_bytes:f.original.length,media_type:f.file.media_type,filename:f.file.filename},f.original)).buffer,{headers:{'content-type':APP_DATA_FRAME_MEDIA_TYPE}});
 }});
 const host=createExperienceRecordDownloads({node,row:()=>f.row,current:()=>true,signal:new AbortController().signal,read:(row,file,signal)=>client.ports.readFile(node,row,file,signal)});
 assert.equal(await host.download(f.file),true);assert.deepEqual(operations,['file_read']);assert.equal(downloads.length,1);assert.equal(await host.downloadArchive(),true);assert.deepEqual(operations,['file_read','file_read']);assert.equal(downloads.length,2);host.dispose();
});
test('bounded held read times out without replay and wipes a late reply',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture();let release!:(bytes:Uint8Array)=>void,reads=0;
 const host=createExperienceRecordDownloads({node,row:()=>f.row,current:()=>true,signal:new AbortController().signal,read:()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
 const pending=host.download(f.file);t.mock.timers.tick(30000);assert.equal(await pending,false);assert.equal(reads,1);const bytes=new Uint8Array(f.original);release(bytes);await Promise.resolve();assert.ok(bytes.every(byte=>byte===0));assert.equal(created,0);host.dispose();
});

test('record handoff disposes old scope, discards held bytes and binds fresh catalog only',async()=>{
 const f=await fixture(),abort=new AbortController();let release!:(bytes:Uint8Array)=>void,row=f.row;
 const old=createExperienceRecordDownloads({node,row:()=>row,current:()=>true,signal:abort.signal,read:()=>new Promise(resolve=>{release=resolve;})});
 const pending=old.download(f.file);old.dispose();assert.equal(await pending,false);
 const record='77777777-7777-4777-8777-777777777777',nextNode={...node,record_id:record};row={...f.row,record_id:record};
 const next=createExperienceRecordDownloads({node:nextNode,row:()=>row,current:()=>true,signal:new AbortController().signal,read:async pinned=>{assert.equal(pinned.record_id,record);return new Uint8Array(f.original);}});
 assert.equal(await next.download(f.file),true);const late=new Uint8Array(f.original);release(late);await new Promise(resolve=>setImmediate(resolve));assert.ok(late.every(byte=>byte===0));assert.equal(downloads.length,1);assert.equal(await old.download(f.file),false);next.dispose();
});
