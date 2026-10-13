import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeAttachmentApi,nativeAttachmentLimit,prepareNativeAttachment,type PreparedNativeAttachment} from './email-native-attachments';
import {createNativeDraftWriter,emptyNativeDraft,NativeDraftError,type NativeDraft,type NativeDraftContent,type NativeDraftSaveState} from './email-native-drafts';
const draftId='00000000-0000-4000-8000-000000000001',fileId='00000000-0000-4000-8000-000000000002';
const row=(content:NativeDraftContent=emptyNativeDraft(),revision=1):NativeDraft=>({draft_id:draftId,revision,status:'draft',content,origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'});
const input=async()=>prepareNativeAttachment(new Blob(['Exact attachment bytes']),"Résumé '26.txt",'text/plain',fileId);

test('attachment upload uses raw bytes, stable UUID and revision headers with exact metadata acknowledgement',async()=>{
 const prepared=await input(),calls:Array<{path:string;options:RequestInit}>=[];
 const client=createNativeAttachmentApi({current:()=>true,fetch:async(path,options)=>{calls.push({path,options});return Response.json({revision:8,file:prepared.file});}});
 await client.upload('account/one',draftId,7,prepared);assert.equal(calls[0].path,`/api/email/accounts/account%2Fone/drafts/${draftId}/files/${fileId}`);assert.equal(calls[0].options.body,prepared.blob);
 const headers=new Headers(calls[0].options.headers);assert.equal(headers.get('content-type'),'text/plain');assert.equal(headers.get('x-email-filename'),encodeURIComponent(prepared.file.filename));assert.equal(headers.get('x-email-draft-revision'),'7');
 assert.equal(prepared.file.sha256,createHash('sha256').update('Exact attachment bytes').digest('hex'));client.dispose();
});
test('unsupported MIME falls back to a token; unsafe filename and oversize files are rejected before reading bytes',async()=>{
 const fallback=await prepareNativeAttachment(new Blob(['a']),'safe.txt','text/plain; charset=utf-8',fileId);assert.equal(fallback.file.media_type,'application/octet-stream');
 await assert.rejects(prepareNativeAttachment(new Blob(['a']),'../unsafe','text/plain',fileId));
 let read=false;await assert.rejects(prepareNativeAttachment({size:nativeAttachmentLimit+1,arrayBuffer:async()=>{read=true;throw Error();}} as unknown as Blob,'large.bin','',fileId));assert.equal(read,false);
});
test('attachment API rejects changed digest, wrong revision and unacknowledged detach',async()=>{
 const prepared=await input();for(const value of [{revision:2,file:{...prepared.file,sha256:'f'.repeat(64)}},{revision:3,file:prepared.file},{revision:2,file:prepared.file,provider_locator:'private'}]){
  const client=createNativeAttachmentApi({current:()=>true,fetch:async()=>Response.json(value)});await assert.rejects(client.upload('a',draftId,1,prepared));client.dispose();}
 const client=createNativeAttachmentApi({current:()=>true,fetch:async()=>Response.json({revision:1})});await assert.rejects(client.detach('a',draftId,1,fileId));client.dispose();
});
test('scalar autosave and held upload share one CAS queue; typing during upload survives at the new revision',async()=>{
 const prepared=await input(),events:string[]=[],states:NativeDraftSaveState[]=[];let release:()=>void=()=>{},saved=row();
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:saved,current:()=>true,change:state=>states.push(state),api:{read:async()=>saved,save:async(_a,_d,revision,content)=>{events.push('save:'+revision+':'+content.body);saved=row(content,revision+1);return saved;}},
  files:{upload:async(_a,_d,revision,attachment)=>{events.push('upload:'+revision);await new Promise<void>(resolve=>{release=resolve;});saved=row({...saved.content,attachments:[attachment.file]},revision+1);return {revision:saved.revision,file:attachment.file};},detach:async()=>({revision:99})}});
 writer.edit({...emptyNativeDraft(),body:'Before upload'});const upload=writer.upload(prepared);while(!events.some(value=>value.startsWith('upload:')))await new Promise(resolve=>setImmediate(resolve));
 writer.edit({...writer.snapshot().content,body:'Typed during upload'});const queuedSave=writer.save();assert.equal(queuedSave,upload);release();assert.equal(await upload,true);
 assert.deepEqual(events,['save:1:Before upload','upload:2','save:3:Typed during upload']);assert.equal(saved.content.body,'Typed during upload');assert.deepEqual(saved.content.attachments,[prepared.file]);assert.equal(writer.snapshot().revision,4);assert.equal(states.at(-1)?.dirty,false);writer.dispose();
});
test('lost successful upload is reconciled using the same file ID, retaining unsaved text without duplicate bytes',async()=>{
 const prepared=await input();let saved=row(),uploads=0,reads=0;const calls:number[]=[];
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:saved,current:()=>true,change:()=>{},api:{read:async()=>{reads++;return saved;},save:async(_a,_d,revision,content)=>{calls.push(revision);saved=row(content,revision+1);return saved;}},
  files:{upload:async(_a,_d,revision,attachment)=>{uploads++;saved=row({...saved.content,attachments:[attachment.file]},revision+1);throw Error('acknowledgement lost');},detach:async()=>({revision:99})}});
 assert.equal(await writer.upload(prepared),false);assert.equal(writer.snapshot().fileMutation?.fileId,fileId);writer.edit({...writer.snapshot().content,body:'Held local text'});
 assert.equal(await writer.save(),true);assert.equal(uploads,1);assert.equal(reads,1);assert.deepEqual(calls,[2]);assert.equal(saved.content.body,'Held local text');assert.deepEqual(saved.content.attachments,[prepared.file]);writer.dispose();
});
test('uncommitted upload retries only its original pinned blob/UUID after a current draft read',async()=>{
 const prepared=await input();let saved=row(),reads=0;const uploaded:PreparedNativeAttachment[]=[];
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:saved,current:()=>true,change:()=>{},api:{read:async()=>{reads++;return saved;},save:async(_a,_d,revision,content)=>{saved=row(content,revision+1);return saved;}},
  files:{upload:async(_a,_d,revision,attachment)=>{uploaded.push(attachment);if(uploaded.length===1)throw Error('network unavailable');saved=row({...saved.content,attachments:[attachment.file]},revision+1);return {revision:saved.revision,file:attachment.file};},detach:async()=>({revision:99})}});
 await writer.upload(prepared);assert.equal(await writer.save(),true);assert.equal(reads,1);assert.equal(uploaded.length,2);assert.equal(uploaded[0],uploaded[1]);assert.equal(uploaded[1].file.file_id,fileId);writer.dispose();
});
test('lost upload with another editor revision/digest becomes a conflict; no local or provider overwrite',async()=>{
 const prepared=await input();let saved=row(),uploads=0;
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:saved,current:()=>true,change:()=>{},api:{read:async()=>saved,save:async()=>{throw Error('must not overwrite');}},
  files:{upload:async()=>{uploads++;saved=row({...emptyNativeDraft(),body:'Other editor',attachments:[{...prepared.file,sha256:'f'.repeat(64)}]},2);throw Error('response lost');},detach:async()=>({revision:99})}});
 await writer.upload(prepared);writer.edit({...writer.snapshot().content,body:'Local text'});assert.equal(await writer.save(),false);assert.equal(uploads,1);assert.equal(writer.snapshot().state,'conflict');assert.equal(writer.snapshot().content.body,'Local text');writer.dispose();
});
test('detach shares the save queue and lost acknowledgement cannot resurrect the removed attachment',async()=>{
 const prepared=await input();let saved=row({...emptyNativeDraft(),attachments:[prepared.file]}),detaches=0;
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:saved,current:()=>true,change:()=>{},api:{read:async()=>saved,save:async(_a,_d,revision,content)=>{saved=row(content,revision+1);return saved;}},
  files:{upload:async()=>({revision:99,file:prepared.file}),detach:async(_a,_d,revision)=>{detaches++;saved=row({...saved.content,attachments:[]},revision+1);throw Error('response lost');}}});
 await writer.detach(fileId);writer.edit({...writer.snapshot().content,body:'New local text'});assert.equal(await writer.save(),true);assert.equal(detaches,1);assert.deepEqual(saved.content.attachments,[]);assert.equal(saved.content.body,'New local text');writer.dispose();
});
test('held upload discarded on session change and permission denial clears the draft',async()=>{
 const prepared=await input();let release!:(value:{revision:number;file:typeof prepared.file})=>void,current=true;const states:NativeDraftSaveState[]=[];
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:row(),current:()=>current,change:state=>states.push(state),api:{read:async()=>row(),save:async()=>row()},files:{upload:async()=>new Promise(resolve=>{release=resolve;}),detach:async()=>({revision:99})}});
 const held=writer.upload(prepared);while(!release)await new Promise(resolve=>setImmediate(resolve));const count=states.length;current=false;writer.dispose();release({revision:2,file:prepared.file});assert.equal(await held,false);assert.equal(states.length,count);assert.deepEqual(writer.snapshot().content.attachments,[]);
 const denied=createNativeDraftWriter({accountId:'a',draftId,initial:row(),current:()=>true,change:()=>{},api:{read:async()=>row(),save:async()=>row()},files:{upload:async()=>{throw new NativeDraftError('denied');},detach:async()=>({revision:99})}});await denied.upload(prepared);assert.equal(denied.snapshot().state,'denied');assert.equal(await denied.save(),false);assert.deepEqual(denied.snapshot().content.attachments,[]);denied.dispose();
});
test('download verifies exact bytes/media/digest and revokes its owned object URL',async()=>{
 const prepared=await input(),downloads:Array<{url:string;name:string}>=[];const created:string[]=[],revoked:string[]=[];const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
 URL.createObjectURL=()=>{created.push('blob:owned');return 'blob:owned';};URL.revokeObjectURL=url=>{revoked.push(url);};
 try{const binary=()=>new Response('Exact attachment bytes',{headers:{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="safe"','X-Content-Type-Options':'nosniff'}});
  const client=createNativeAttachmentApi({current:()=>true,fetch:async()=>binary(),download:(url,name)=>downloads.push({url,name})});await client.download('a',draftId,prepared.file);assert.deepEqual(downloads,[{url:'blob:owned',name:prepared.file.filename}]);assert.deepEqual(created,revoked);
  await assert.rejects(client.download('a',draftId,{...prepared.file,sha256:'f'.repeat(64)}));assert.equal(downloads.length,1);client.dispose();
 }finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
test('permission denial during a held upload fences its late acknowledgement and cannot restore cleared content',async()=>{
 const prepared=await input();let release!:(value:{revision:number;file:typeof prepared.file})=>void,saves=0;
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:row({...emptyNativeDraft(),body:'Private'}),current:()=>true,change:()=>{},api:{read:async()=>row(),save:async()=>{saves++;return row();}},files:{upload:async()=>new Promise(resolve=>{release=resolve;}),detach:async()=>({revision:99})}});
 const held=writer.upload(prepared);while(!release)await new Promise(resolve=>setImmediate(resolve));writer.deny();release({revision:2,file:prepared.file});assert.equal(await held,false);assert.equal(writer.snapshot().state,'denied');assert.equal(writer.snapshot().content.body,'');assert.equal(saves,0);writer.dispose();
});
test('aggregate attachment limits stop before any file I/O and retain existing saved references',async()=>{
 const prepared=await input();let uploads=0;const existing=Array.from({length:32},(_,index)=>({...prepared.file,file_id:'reference-'+index,size_bytes:0}));
 const writer=createNativeDraftWriter({accountId:'a',draftId,initial:row({...emptyNativeDraft(),attachments:existing}),current:()=>true,change:()=>{},api:{read:async()=>row(),save:async()=>row()},files:{upload:async()=>{uploads++;return {revision:2,file:prepared.file};},detach:async()=>({revision:99})}});
 assert.equal(await writer.upload(prepared),false);assert.equal(uploads,0);assert.equal(writer.snapshot().content.attachments.length,32);writer.dispose();
});
