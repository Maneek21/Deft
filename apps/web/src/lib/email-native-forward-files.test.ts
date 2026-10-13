import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeForwardFiles,type NativeForwardFiles} from './email-native-forward-files';
import {createNativeDraftWriter,emptyNativeDraft,type NativeDraft,type NativeDraftContent} from './email-native-drafts';
import {createNativeReplyCompose} from './email-native-reply';
import type {NativeReaderPresentation} from './email-native-reader';
const draftId='11111111-1111-4111-8111-111111111111',logical='mail_'+'a'.repeat(64),ref='b'.repeat(64);
const origin:NativeForwardFiles={account_id:'account/one',logical_message_id:logical,source_digest:'c'.repeat(64),files:[{file_ref:ref,filename:'report.txt',media_type:'text/plain',size_bytes:5,disposition:'attachment',preview:'text'}]};
const content:NativeDraftContent={...emptyNativeDraft(),mode:'forward',reply_record_id:logical,body:'Original quoted text',to:'recipient@example.com'};
const row=(value:NativeDraftContent,revision:number):NativeDraft=>({draft_id:draftId,revision,status:'draft',content:structuredClone(value),origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'});
const binary=()=>new Response('Exact',{headers:{'Content-Type':'text/plain','X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="report.txt"','Content-Length':'5'}});
test('busy Forward file fetch preserves quoted draft and gives explicit retry without denial or automatic upload/replay',async()=>{
 let requests=0;const s=setup({fetch:async()=>{requests++;return Response.json({code:'EMAIL_SOURCE_BUSY'},{status:503,headers:{'Retry-After':'2'}});}});await s.controller.include([ref]);
 assert.equal(requests,1);assert.equal(s.uploads(),0);assert.notEqual(s.writer.snapshot().state,'denied');assert.equal(s.writer.snapshot().content.body,content.body);assert.equal(s.writer.snapshot().content.reply_record_id,logical);assert.equal(s.controller.snapshot().files[0].state,'failed');assert.match(s.controller.snapshot().files[0].notice,/Message loading is busy\. Try again shortly\./);assert.equal(s.controller.snapshot().blocked,true);s.dispose();
});
test('35 MiB source-only inventory preserves quoted Forward and synthetic Include cannot save, fetch or upload',async()=>{
 const s=setup();s.controller.dispose();let requests=0;
 const controller=createNativeForwardFiles({origin:{...origin,files:[{...origin.files[0],size_bytes:35*1024*1024}]},accountId:origin.account_id,writer:()=>s.writer,current:()=>true,locked:()=>false,fetch:async()=>{requests++;return binary();},change:()=>{},saved:()=>{}});
 assert.equal(controller.snapshot().files[0].state,'source_only');assert.equal(controller.snapshot().blocked,false);assert.match(controller.snapshot().files[0].notice,/25 MiB.*original/);await controller.include([ref]);assert.equal(requests,0);assert.equal(s.uploads(),0);assert.deepEqual(s.events,[]);assert.equal(s.writer.snapshot().content.body,content.body);assert.equal(s.writer.snapshot().content.reply_record_id,logical);controller.dispose();s.dispose();
});
test('combined supported originals above25 MiB remain listed and selection fails before saving or fetching',async()=>{
 const s=setup();s.controller.dispose();const second='d'.repeat(64);let requests=0;
 const controller=createNativeForwardFiles({origin:{...origin,files:[{...origin.files[0],size_bytes:18*1024*1024},{...origin.files[0],file_ref:second,size_bytes:16*1024*1024}]},accountId:origin.account_id,writer:()=>s.writer,current:()=>true,locked:()=>false,fetch:async()=>{requests++;return binary();},change:()=>{},saved:()=>{}});
 assert.deepEqual(controller.snapshot().files.map(file=>file.state),['available','available']);await controller.include([ref,second]);assert.equal(requests,0);assert.equal(s.uploads(),0);assert.deepEqual(s.events,[]);assert.match(controller.snapshot().notice,/25 MiB.*fewer/);assert.equal(controller.snapshot().blocked,false);controller.dispose();s.dispose();
});
test('actual large supported original is included once with exact bytes and retained source body',async()=>{
 const size=9*1024*1024,large={...origin,files:[{...origin.files[0],size_bytes:size}]};let saved=row(content,0),uploads=0;
 const writer=createNativeDraftWriter({accountId:origin.account_id,draftId,initialContent:content,current:()=>true,change:()=>{},api:{read:async()=>saved,save:async(_a,_d,revision,value)=>saved=row(value,revision+1)},files:{upload:async(_a,_d,revision,input)=>{uploads++;assert.equal(input.file.size_bytes,size);const bytes=new Uint8Array(await input.blob.arrayBuffer());assert.equal(bytes.length,size);assert.ok(bytes.every(byte=>byte===73));bytes.fill(0);saved=row({...saved.content,attachments:[input.file]},revision+1);return {revision:saved.revision,file:input.file};},detach:async()=>{throw Error('Unused');}}});
 let requests=0;const controller=createNativeForwardFiles({origin:large,accountId:origin.account_id,writer:()=>writer,current:()=>true,locked:()=>false,fetch:async(_path,init)=>{requests++;assert.deepEqual(JSON.parse(init.body as string),{source_digest:origin.source_digest,file_ref:ref});return new Response(new Uint8Array(size).fill(73),{headers:{'Content-Type':'text/plain','Content-Length':String(size),'Content-Disposition':'attachment;','X-Content-Type-Options':'nosniff'}});},change:()=>{},saved:()=>{}});
 await controller.include([ref]);await controller.include([ref]);assert.equal(requests,1);assert.equal(uploads,1);assert.equal(controller.snapshot().files[0].state,'saved');assert.equal(saved.content.body,content.body);assert.equal(saved.content.reply_record_id,logical);controller.dispose();writer.dispose();
});
function setup(options:{fetch?:(path:string,init:RequestInit)=>Promise<Response>;uploadWait?:()=>Promise<void>;lostAck?:boolean;current?:()=>boolean}={}){
 let saved=row(content,0),uploads=0,reads=0;const events:string[]=[],current=options.current??(()=>true);
 const writer=createNativeDraftWriter({accountId:origin.account_id,draftId,initialContent:content,current,change:()=>{},api:{read:async()=>{reads++;return saved;},save:async(_a,_d,revision,value)=>{events.push('save:'+revision);saved=row(value,revision+1);return saved;}},files:{upload:async(_a,_d,revision,input)=>{uploads++;events.push('upload:'+revision);assert.equal(await input.blob.text(),'Exact');await options.uploadWait?.();saved=row({...saved.content,attachments:[...saved.content.attachments,input.file]},revision+1);if(options.lostAck)throw Error('lost acknowledgement');return {revision:saved.revision,file:input.file};},detach:async()=>{throw Error('unused');}}});
 const controller=createNativeForwardFiles({origin,accountId:origin.account_id,writer:()=>writer,current,locked:()=>false,fetch:options.fetch??(async(path,init)=>{events.push('file');assert.equal(path,`/api/email/accounts/account%2Fone/messages/${logical}/file`);assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body as string),{source_digest:origin.source_digest,file_ref:ref});assert.equal(saved.revision,1);return binary();}),change:()=>{},saved:()=>{}});
 return {writer,controller,events,uploads:()=>uploads,reads:()=>reads,saved:()=>saved,dispose:()=>{controller.dispose();writer.dispose();}};
}
test('no attachment access before explicit inclusion; exact guarded source follows account-bound scalar save',async()=>{
 const s=setup();assert.equal(s.events.length,0);assert.equal(s.controller.snapshot().files[0].state,'available');assert.equal(s.controller.snapshot().blocked,false);
 await s.controller.include([ref]);assert.deepEqual(s.events,['save:0','file','upload:1']);assert.equal(s.controller.snapshot().files[0].state,'saved');assert.equal(s.controller.snapshot().blocked,false);assert.equal(s.saved().content.reply_record_id,logical);assert.equal(s.saved().content.to,content.to);s.dispose();
});
test('typing during held forwarded-file upload survives serialized revision acknowledgement and autosave',async()=>{
 let release!:()=>void;const s=setup({uploadWait:()=>new Promise<void>(done=>{release=done;})}),held=s.controller.include([ref]);
 while(!release)await new Promise(done=>setImmediate(done));assert.equal(s.controller.snapshot().busy,true);assert.equal(s.controller.snapshot().blocked,true);assert.equal(s.controller.snapshot().files[0].state,'uploading');
 s.writer.edit({...s.writer.snapshot().content,body:'New typing during file copy'});release();await held;
 assert.equal(s.saved().content.body,'New typing during file copy');assert.equal(s.saved().content.attachments.length,1);assert.equal(s.writer.snapshot().dirty,false);assert.deepEqual(s.events,['save:0','file','upload:1','save:2']);s.dispose();
});
test('lost successful upload keeps original UUID and blocks Send until exact draft read proves it; no second upload',async()=>{
 const s=setup({lostAck:true});await s.controller.include([ref]);const pending=s.writer.snapshot().fileMutation!;
 assert.equal(s.controller.snapshot().files[0].state,'unconfirmed');assert.equal(s.controller.snapshot().blocked,true);s.controller.omit(ref);assert.equal(s.controller.snapshot().files[0].state,'unconfirmed');
 await s.controller.include([ref]);assert.equal(s.uploads(),1);s.writer.edit({...s.writer.snapshot().content,body:'Unsaved text'});await s.controller.check();
 assert.equal(s.reads(),1);assert.equal(s.uploads(),1);assert.equal(s.saved().content.attachments[0].file_id,pending.fileId);assert.equal(s.saved().content.body,'Unsaved text');assert.equal(s.controller.snapshot().blocked,false);s.dispose();
});
test('failed source size/media is not uploaded and must be retried or explicitly omitted',async()=>{
 const s=setup({fetch:async()=>new Response('Wrong',{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment;','X-Content-Type-Options':'nosniff'}})});
 await s.controller.include([ref]);assert.equal(s.uploads(),0);assert.equal(s.controller.snapshot().files[0].state,'failed');assert.equal(s.controller.snapshot().blocked,true);s.controller.omit(ref);assert.equal(s.controller.snapshot().blocked,false);assert.deepEqual(s.saved().content.attachments,[]);s.dispose();
});
test('late source response after session/account disposal is cancelled without attachment upload',async()=>{
 let release!:(value:Response)=>void,current=true;const s=setup({current:()=>current,fetch:async()=>new Promise(done=>{release=done;})}),held=s.controller.include([ref]);
 while(!release)await new Promise(done=>setImmediate(done));current=false;s.controller.dispose();const response=binary();release(response);await held;assert.equal(s.uploads(),0);assert.equal(response.body?.locked,false);assert.deepEqual(s.writer.snapshot().content.attachments,[]);s.dispose();
});
test('source permission denial immediately denies writer and cannot upload private bytes',async()=>{
 const s=setup({fetch:async()=>new Response('',{status:403})});await s.controller.include([ref]);assert.equal(s.writer.snapshot().state,'denied');assert.equal(s.writer.snapshot().content.body,'');assert.equal(s.uploads(),0);s.dispose();
});
test('foreign source account or logical parent is refused before source/file mutation',async()=>{
 assert.throws(()=>createNativeForwardFiles({origin,accountId:'foreign',writer:()=>null,current:()=>true,locked:()=>false,fetch:async()=>binary(),change:()=>{},saved:()=>{}}));
 const s=setup();s.writer.edit({...s.writer.snapshot().content,reply_record_id:'mail_'+'d'.repeat(64)});await assert.rejects(s.controller.include([ref]));assert.equal(s.events.length,0);s.dispose();
});
test('existing 32 attachment references stop forwarding before any source read or new draft mutation',async()=>{
 let reads=0,saves=0;
 const existing=Array.from({length:32},(_,index)=>({file_id:`reference-${index}`,filename:`saved-${index}.txt`,media_type:'text/plain',size_bytes:0,sha256:'e'.repeat(64)}));
 const writer=createNativeDraftWriter({accountId:origin.account_id,draftId,initial:row({...content,attachments:existing},1),current:()=>true,change:()=>{},api:{read:async()=>{throw Error('unused');},save:async()=>{saves++;throw Error('must not save');}}});
 const controller=createNativeForwardFiles({origin,accountId:origin.account_id,writer:()=>writer,current:()=>true,locked:()=>false,fetch:async()=>{reads++;return binary();},change:()=>{},saved:()=>{}});
 await controller.include([ref]);assert.equal(reads,0);assert.equal(saves,0);assert.match(controller.snapshot().notice,/32-file/);assert.equal(writer.snapshot().content.attachments.length,32);controller.dispose();writer.dispose();
});
test('original attachment status follows a later confirmed detach instead of claiming the file is still saved',async()=>{
 let saved=row(content,1);const writer=createNativeDraftWriter({accountId:origin.account_id,draftId,initial:saved,current:()=>true,change:()=>{},api:{read:async()=>saved,save:async(_a,_d,revision,value)=>saved=row(value,revision+1)},files:{upload:async(_a,_d,revision,input)=>{saved=row({...saved.content,attachments:[input.file]},revision+1);return {revision:saved.revision,file:input.file};},detach:async(_a,_d,revision)=>{saved=row({...saved.content,attachments:[]},revision+1);return {revision:saved.revision};}}});
 const controller=createNativeForwardFiles({origin,accountId:origin.account_id,writer:()=>writer,current:()=>true,locked:()=>false,fetch:async()=>binary(),change:()=>{},saved:()=>{}});
 await controller.include([ref]);await writer.detach(writer.snapshot().content.attachments[0].file_id);controller.sync();assert.equal(controller.snapshot().files[0].state,'omitted');assert.equal(controller.snapshot().blocked,false);controller.dispose();writer.dispose();
});
test('only Forward carries a cloned exact original-file descriptor; Reply and Reply all never copy files',()=>{
 const source:NativeReaderPresentation={schema_version:'deft.email_presentation.v1',...origin,provider:'gmail',content_trust:'unsanitized',presentation:{format:'plain',content:'Message',plain_text:'Message',truncated:false,images:[],headers:[],metadata:{account_id:origin.account_id,primary_address:'owner@example.com',verified_sender_identities:'["owner@example.com"]',reply_from:'sender@example.com',reply_to_list:'owner@example.com'}}};
 const forward=createNativeReplyCompose(source,'forward');assert.deepEqual(forward.forwardFiles,origin);forward.forwardFiles!.files[0].filename='edited.txt';assert.equal(source.files[0].filename,'report.txt');assert.deepEqual(forward.initialContent.attachments,[]);assert.equal(createNativeReplyCompose(source,'reply').forwardFiles,undefined);assert.equal(createNativeReplyCompose(source,'reply_all').forwardFiles,undefined);
});
