import test from 'node:test';import assert from 'node:assert/strict';
import {createOriginalFileCopies,recordCopySource,verifyFileCopy,type FileCopyNode,type OriginalFileState} from './app-experience-file-copy';
import {createExperienceRecordWriter,type ExperienceRecordRow} from './app-experience-record-writer';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import {AppDataOperationInputSchema,AppDataRecordMetaSchema,AppDataSourceFileSchema,DeftExperienceRecordFormNodeSchema,APP_DATA_LIMITS} from '../../../../packages/app-kit/src/app-data';
import {createDeftRecordFormNode} from '../../../../packages/app-kit/src/experience-sdk';
import {createExperienceBridge,parseExperienceView,type ExperiencePin} from './app-experience-bridge';
const id='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222',originId='33333333-3333-4333-8333-333333333333',hash='sha256:'+'a'.repeat(64);
const source={resource_key:'inbox',record_id:originId,content_digest:hash},file={file_ref:'sha256:'+'b'.repeat(64),filename:'synthetic.pdf',media_type:'application/pdf',size_bytes:1840,disposition:'attachment' as const,preview:'pdf' as const};
const node=DeftExperienceRecordFormNodeSchema.parse({kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:1,content_digest:hash,source_refs:[source],profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}});
const initial=():ExperienceRecordRow=>({record_id:id,revision:1,content_digest:hash,status:'draft',source_refs:[source],value:{subject:'Synthetic',body:'  preserved\ttext\n\n',body_html:'',attachments:[],mode:'forward',reply_record_id:'private-origin'},files:[]});
const copied=(before:ExperienceRecordRow,fileId:string)=>({...before,revision:before.revision+1,content_digest:'sha256:'+'c'.repeat(64),value:{...before.value,attachments:[...(before.value.attachments as unknown[]),{file_id:fileId,filename:file.filename,media_type:file.media_type,size_bytes:file.size_bytes,sha256:'d'.repeat(64)}]},files:[...(before.files??[]),{file_id:fileId,upload_revision:before.revision+1,sha256:'sha256:'+'d'.repeat(64)}]});
function fixture({lost=false,closed=false,locked=false,list=[file]}:{lost?:boolean;closed?:boolean;locked?:boolean;list?:any[]}={}){
 let live=true,calls=0,statuses=0,saves=0,stored=initial(),last:any,files:readonly OriginalFileState[]=[];if(closed)stored={...stored,status:'submitted'};
 const writer=closed?null:createExperienceRecordWriter({initial:stored,current:()=>live,signal:new AbortController().signal,validate:()=>{},read:async()=>stored,save:async(revision,value)=>{saves++;stored={...stored,revision:revision+1,value};return stored;},change:()=>{}});
 const ports={listOriginals:async()=>list,copyOriginal:async(_node:any,before:any,source:any,file:any,fileId:string,requestId:string)=>{calls++;last={before,source,file,fileId,requestId};stored=copied(before,fileId);if(lost)throw Error('Lost acknowledgement');return stored;},copyStatus:async(_node:any,before:any,source:any,file:any,fileId:string,requestId:string)=>{statuses++;assert.equal(requestId,last.requestId);assert.equal(fileId,last.fileId);return stored;}};
 const controller=createOriginalFileCopies({node,writer:()=>writer,ports,current:()=>live,locked:()=>locked,signal:new AbortController().signal,change:next=>files=next});return {controller,writer,ports,files:()=>files,counts:()=>({calls,statuses,saves}),revoke:()=>live=false,stored:()=>stored};
}
test('copy contract/source metadata is bounded and exact; negotiated source nomination must be declared',()=>{
 const input={store_key:'drafts',record_id:id,expected_revision:1,expected_content_digest:hash,file_id:sid,source:{...source,file_ref:file.file_ref}};assert.equal(AppDataOperationInputSchema.safeParse({operation:'file_copy',input}).success,true);
 for(const patch of [{url:'https://private.test'}, {source:{...input.source,url:'https://private.test'}},{file_id:'provider-file'}])assert.equal(AppDataOperationInputSchema.safeParse({operation:'file_copy',input:{...input,...patch}}).success,false);
 assert.equal(AppDataSourceFileSchema.parse({...file,size_bytes:APP_DATA_LIMITS.source_bytes}).size_bytes,APP_DATA_LIMITS.source_bytes);assert.equal(APP_DATA_LIMITS.file_bytes,25*1024*1024);
 const {kind,...inputNode}=node;assert.deepEqual(createDeftRecordFormNode(inputNode,['record_form.v1']),node);const view={schema_version:'deft.experience_view.v2',capabilities:['record_form.v1'],root:node};assert.ok(parseExperienceView(view,{capabilities:['record_form.v1'],storeKeys:['drafts'],resourceKeys:['inbox']}));assert.equal(parseExperienceView(view,{capabilities:['record_form.v1'],storeKeys:['drafts'],resourceKeys:['foreign']}),null);
 assert.deepEqual(recordCopySource(node,initial()),source);assert.equal(recordCopySource({...node,source_refs:undefined},initial()),null);assert.throws(()=>recordCopySource(node,{...initial(),source_refs:[]}));assert.throws(()=>recordCopySource(node,{...initial(),record_id:sid}));
});
test('actual CAS writer saves dirty text first; copied file preserves body/source/old files and commits once',async()=>{
 const f=fixture();await f.controller.load();f.writer!.edit({...f.writer!.snapshot.value,body:'Latest dirty body'});assert.equal(await f.controller.include(file.file_ref),true);assert.deepEqual(f.counts(),{calls:1,statuses:0,saves:1});assert.equal(f.stored().value.body,'Latest dirty body');assert.equal(f.files()[0].state,'saved');assert.equal(await f.controller.include(file.file_ref),false);f.controller.dispose();
});
test('lost copy reply fences every further Include, then same UUID status reconciles without replay',async()=>{
 const f=fixture({lost:true});await f.controller.load();assert.equal(await f.controller.include(file.file_ref),false);assert.equal(f.writer!.snapshot.state,'blocked');assert.equal(f.files()[0].state,'unconfirmed');assert.equal(await f.controller.include(file.file_ref),false);assert.equal(await f.controller.check(),true);assert.equal(f.writer!.snapshot.state,'saved');assert.deepEqual(f.counts(),{calls:1,statuses:1,saves:0});assert.equal(f.files()[0].state,'saved');f.controller.dispose();
});
test('readonly/locked/revoked, source-only originals and malformed copy results cannot mutate a draft',async()=>{
 for(const options of [{closed:true},{locked:true},{list:[{...file,size_bytes:26*1024*1024}]}]){const f=fixture(options);await f.controller.load();assert.equal(await f.controller.include(file.file_ref),false);assert.equal(f.counts().calls,0);f.controller.dispose();}
 const f=fixture();await f.controller.load();f.revoke();assert.equal(await f.controller.include(file.file_ref),false);assert.equal(f.counts().calls,0);
 const before=initial(),next=copied(before,sid);for(const changed of [{...next,status:'submitted'},{...next,revision:3},{...next,source_refs:[{...source,record_id:sid}]},{...next,value:{...next.value,body:'Changed'}},{...next,files:[{...next.files[0],upload_revision:1}]}])assert.throws(()=>verifyFileCopy(node,before,changed as ExperienceRecordRow,source,file,sid));
});
test('actual host client copies through JSON metadata only and checks lost status without resubmitting copy',async()=>{
 const before=initial(),next=copied(before,sid),date=new Date().toISOString(),ops:string[]=[];const declaration={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400,resource_content:{max_presentation_bytes:262144,max_source_bytes:36700160,max_file_bytes:26214400,max_image_bytes:2097152}};
 const input={store_key:'drafts',record_id:id,expected_revision:1,expected_content_digest:hash,file_id:sid,source:{...source,file_ref:file.file_ref}},copyId='44444444-4444-4444-8444-444444444444';
 const client=createExperienceDataClient({installationId:id,targetKey:'sender',current:()=>true,fetch:async(path,options)=>{if((path.endsWith('/context')||path.endsWith('/resolve')))return Response.json({schema_version:'deft.app_data_context.v1',installation_id:id,targets:[{session_id:sid,target_key:'sender',resource_key:'inbox',account:{account_ref:'own',label:'Own sender'},identities:[],stores:[{declaration,consent:{consent_id:sid,consent_digest:hash,expires_at:new Date(Date.now()+60000).toISOString()}}]}]});
  assert.ok(path.endsWith('/requests'));assert.equal(typeof options.body,'string');assert.ok(String(options.body).length<1000);const request=JSON.parse(String(options.body));ops.push(request.operation);const base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
  if(request.operation==='resource_list_files')return Response.json({...base,files:[file]});if(request.operation==='file_copy'){assert.deepEqual(request.input,input);throw Error('Lost');}
  if(request.operation==='request_status')return Response.json({...base,request_status:{request_id:copyId,operation:'file_copy',input_digest:await appDataInputDigest('file_copy',input),state:'completed',record_id:id,revision:2,content_digest:next.content_digest}});
  return Response.json({...base,record:{...next,schema_version:'deft.app_record.v1',store_key:'drafts',content_revision:2,created_at:date,updated_at:date,files:next.files!.map(f=>({...f,filename:file.filename,media_type:file.media_type,size_bytes:file.size_bytes}))}});
 }});
 assert.deepEqual(await client.ports.listOriginals!(node,before,new AbortController().signal),[file]);await assert.rejects(client.ports.copyOriginal!(node,before,source,file,sid,copyId,new AbortController().signal));assert.equal((await client.ports.copyStatus!(node,before,source,file,sid,copyId,new AbortController().signal))!.revision,2);assert.deepEqual(ops,['resource_list_files','file_copy','request_status','record_read']);assert.doesNotMatch(JSON.stringify(input),/preserved|private-origin/);
 const {value,files,...metadata}= {...next, schema_version:'deft.app_record.v1',store_key:'drafts',content_revision:2,created_at:date,updated_at:date};assert.ok(AppDataRecordMetaSchema.parse(metadata).source_refs);assert.doesNotMatch(JSON.stringify(metadata),/private-origin|preserved/);
});
test('actual Worker bridge refuses file_copy before dispatch and never carries full bytes/body',()=>{
 let calls=0;const sent:any[]=[];const port={onmessage:null as ((event:MessageEvent)=>void)|null,postMessage:(value:any)=>sent.push(value),close:()=>{}},pin:ExperiencePin={org_id:'org',user_id:'owner',app_installation_id:id,app_version_id:'version',grant_snapshot_id:'grant',lifecycle_epoch:1,grant_epoch:1,session_id:'session_12345678',session_epoch:1};
 const bridge=createExperienceBridge({port,pin,resourceKeys:['inbox'],storeKeys:['drafts'],actionKeys:[],onView:()=>{},broker:{isLive:()=>true,appData:async()=>{calls++;return {private:'bytes'};}}});port.onmessage!({data:{version:'deft.experience_bridge.v1',kind:'request',session_id:pin.session_id,sequence:1,request_id:'request_1',operation:'app_data',key:'drafts',input:{operation:'file_copy',input:{store_key:'drafts',record_id:id}}}} as MessageEvent);assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(sent),/private|bytes/);bridge.revoke();
});


test('actual trusted selector renders per-file availability and status-only uncertain recovery',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{ExperienceRecordOriginalFilesView}=await import('../components/apps/experience-record-original-files');
 const render=(state:OriginalFileState['state'],disabled=false,current=true)=>renderToStaticMarkup(React.createElement(ExperienceRecordOriginalFilesView,{files:[{file,state,notice:''}],busy:false,notice:'',disabled,current,include:()=>{},omit:()=>{},check:()=>{}}));
 assert.match(render('available'),/>Include<.*>Omit</);assert.doesNotMatch(render('saved'),/>Include<|>Check status<\/button>/);assert.match(render('saved'),/>Included</);assert.doesNotMatch(render('source_only'),/>Include</);
 assert.match(render('unconfirmed',true),/<button type="button">Check status<\/button>/);assert.match(render('unconfirmed',true,false),/<button type="button" disabled="">Check status<\/button>/);
 assert.match(render('available',true),/disabled=""[^>]*>Include</);
});

test('late source/copy results after disposal or revocation publish no saved draft state',async()=>{
 let release!:(value:any)=>void;const f=fixture();await f.controller.load();f.ports.copyOriginal=async(_node,before,_source,_file,fileId)=>new Promise(resolve=>release=()=>resolve(copied(before,fileId)));
 const result=f.controller.include(file.file_ref);await new Promise(resolve=>setImmediate(resolve));f.revoke();f.controller.dispose();release(null);assert.equal(await result,false);assert.notEqual(f.files()[0].state,'saved');
});


test('status recovery cannot adopt a later raced revision instead of the exact completed copy receipt',async()=>{
 let stored=initial(),copyCalls=0,statusCalls=0;const signal=new AbortController().signal;
 const writer=createExperienceRecordWriter({initial:stored,current:()=>true,signal,validate:()=>{},read:async()=>({...stored,revision:3,content_digest:'sha256:'+'e'.repeat(64)}),save:async()=>stored,change:()=>{}});
 const controller=createOriginalFileCopies({node,writer:()=>writer,current:()=>true,locked:()=>false,signal,change:()=>{},ports:{listOriginals:async()=>[file],copyOriginal:async(_n,before,_s,_f,fileId)=>{copyCalls++;stored=copied(before,fileId);throw Error('Lost reply');},copyStatus:async()=>{statusCalls++;return stored;}}});
 await controller.load();assert.equal(await controller.include(file.file_ref),false);assert.equal(await controller.check(),false);assert.equal(writer.snapshot.state,'blocked');assert.equal(writer.snapshot.row.revision,1);assert.equal(await controller.include(file.file_ref),false);assert.equal(copyCalls,1);assert.equal(statusCalls,1);controller.dispose();writer.dispose();
});
