import assert from 'node:assert/strict';
import test from 'node:test';
import {ExperienceAuthorityUnavailable} from './app-experience-connection';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import {APP_DATA_FRAME_MEDIA_TYPE,frameAppData,parseAppDataFrame,type AppDataRequest,type DeftExperienceRecordFormNode,type RecordStoreDeclaration} from '../../../../packages/app-kit/src/app-data';
import type {RecordFormFile} from './app-experience-record-form';
const id='11111111-1111-4111-8111-111111111111',connection='22222222-2222-4222-8222-222222222222',installation='33333333-3333-4333-8333-333333333333',hash='sha256:'+'a'.repeat(64),fileId='44444444-4444-4444-8444-444444444444';
const date=new Date().toISOString(),expires=new Date(Date.now()+60000).toISOString();
const store:RecordStoreDeclaration={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400};
const node:DeftExperienceRecordFormNode={kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:7,content_digest:hash,
 profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}};
const context=(target='mailbox',declaration:RecordStoreDeclaration=store)=>({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:target,account:{account_ref:id,label:'Own Gmail'},resource_key:'inbox',identities:[{address:'own@example.test',label:'Own Gmail'}],stores:[{declaration,consent:{consent_id:id,consent_digest:hash,expires_at:expires}}]}]});
const row=(status:'draft'|'submitted'|'archived'='draft')=>({schema_version:'deft.app_record.v1',store_key:'drafts',record_id:id,revision:7,content_revision:4,content_digest:hash,status,value:{to:'person@example.test',subject:'Native',body:'full body '.repeat(18000),body_html:'',attachments:[]},files:[],created_at:date,updated_at:date});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function result(request:AppDataRequest,record:unknown=row()){return {schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',record,identities:[{address:'own@example.test',label:'Own Gmail'}]};}

test('immediately reused target denies an account switch or stale target before dispatch and before disclosure',async()=>{
 for(const mode of ['account_before','account_after','target','store'] as const){let expected=id,requests=0;
  const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',accountRef:()=>expected,current:()=>true,fetch:async(path,options)=>{
   if(path.endsWith('/resolve'))return json(context());requests++;if(mode==='account_after')expected=connection;return json(await result(JSON.parse(String(options.body))));
  }});
  const selected=await client.select('drafts',new AbortController().signal);
  if(mode==='account_before')expected=connection;
  if(mode==='target')selected.target_key='other';
  if(mode==='store')selected.stores=[];
  await assert.rejects(client.request('drafts','record_read',{store_key:'drafts',record_id:id},new AbortController().signal,undefined,undefined,false,selected),/scope|account|target|store/i);
  assert.equal(requests,mode==='account_after'?1:0,mode);
 }
});
test('large full record uses host port; unsupported quota and foreign selected target deny before record reads',async()=>{
 const calls:string[]=[];const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{calls.push(path);return (path.endsWith('/context')||path.endsWith('/resolve'))?json(context()):json(await result(JSON.parse(String(options.body))));}});
 const opened=await client.ports.load(node,new AbortController().signal);assert.equal(opened.record.value.body,row().value.body);assert.ok(String(opened.record.value.body).length>65536);
 assert.ok(calls.every(path=>path.startsWith('/api/app-data/')));assert.equal(calls.some(path=>path.includes('/api/email')),false);
 let reads=0;const denied=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async path=>{if(!(path.endsWith('/context')||path.endsWith('/resolve')))reads++;return json(context('other'));}});
 await assert.rejects(denied.ports.load(node,new AbortController().signal));assert.equal(reads,0);
 const quota=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async()=>json(context('mailbox',{...store,max_record_bytes:16384}))});
 await assert.rejects(quota.ports.load(node,new AbortController().signal));
});
test('binary file read pins catalog upload revision, digest and bytes through requests route',async()=>{
 const bytes=new Uint8Array(90000).fill(5),sha='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const file:RecordFormFile={file_id:fileId,filename:'image.png',media_type:'image/png',size_bytes:bytes.length,sha256:sha.slice(7)};
 const record={...row(),files:[{...file,sha256:sha,upload_revision:3}]};let readInput:Record<string,unknown>|undefined;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
  if((path.endsWith('/context')||path.endsWith('/resolve')))return json(context());assert.ok(path.endsWith('/requests'));const request=JSON.parse(String(options.body));readInput=request.input;
  return new Response(new Uint8Array(frameAppData({schema_version:'deft.app_data_binary.v1',request_id:request.request_id,operation:'file_read',input_digest:await appDataInputDigest('file_read',request.input),record_id:id,file_id:fileId,upload_revision:3,sha256:sha,size_bytes:bytes.length,media_type:'image/png',filename:file.filename},bytes)).buffer,{headers:{'content-type':APP_DATA_FRAME_MEDIA_TYPE}});
 }});
 assert.deepEqual(await client.ports.readFile(node,record,file,new AbortController().signal),bytes);assert.equal(readInput?.upload_revision,3);assert.equal(readInput?.sha256,sha);assert.notEqual(readInput?.upload_revision,record.revision);
 await assert.rejects(client.ports.readFile(node,{...record,files:[]},file,new AbortController().signal));
});
test('upload sends a framed exact file digest and CAS, and late scope replies are discarded',async()=>{
 const file=new File([new Uint8Array(100000).fill(7)],'native.bin',{type:'application/octet-stream'}),bytes=new Uint8Array(await file.arrayBuffer()),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const metadata:RecordFormFile={file_id:fileId,filename:file.name,media_type:file.type,size_bytes:file.size,sha256:sha};let uploaded=false;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
  if((path.endsWith('/context')||path.endsWith('/resolve')))return json(context());assert.ok(path.endsWith('/binary'));assert.equal((options.headers as Record<string,string>)['Content-Type'],APP_DATA_FRAME_MEDIA_TYPE);
  const parsed=parseAppDataFrame(new Uint8Array(options.body as ArrayBuffer)),request=parsed.header as AppDataRequest;assert.equal(request.input.expected_revision,7);assert.equal(request.input.sha256,'sha256:'+sha);assert.deepEqual(parsed.bytes,bytes);uploaded=true;
  return json(await result(request,{...row(),revision:8}));}});
 assert.equal((await client.ports.upload(node,row(),metadata,file,new AbortController().signal)).revision,8);assert.equal(uploaded,true);
 let live=true;const late=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>live,fetch:async(path,options)=>{if((path.endsWith('/context')||path.endsWith('/resolve')))return json(context());live=false;return json(await result(JSON.parse(String(options.body))));}});
 await assert.rejects(late.ports.load(node,new AbortController().signal));
});
test('fresh submitted or archived row loads for authoritative read-only history even if author nominated an old editable revision',async()=>{
 for(const status of ['submitted','archived'] as const){const calls:string[]=[];
  const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
   if((path.endsWith('/context')||path.endsWith('/resolve')))return json(context());const request=JSON.parse(String(options.body));calls.push(request.operation);
   return json(await result(request,{...row(status),revision:8}));}});
  const opened=await client.ports.load({...node,action_key:'send_message'},new AbortController().signal);
  assert.equal(opened.record.status,status);assert.equal(opened.record.revision,8);assert.deepEqual(calls,['record_read']);
 }
});

test('saved automatic image choice requires exact current human receipt/account/reference and own consent',async()=>{
 const {createHash}=await import('node:crypto');const value={external_images:'always'},digest='sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const pref={...row(),store_key:'preferences',record_id:fileId,revision:2,content_revision:2,content_digest:digest,value};
 const proof={request_id:id,store_key:'preferences',record_id:fileId,revision:2,content_digest:digest};
 const document={kind:'record_document' as const,id:'document',profile_version:'deft.record_document.v1' as const,store_key:'drafts',resource_key:'inbox',record_id:id,content_digest:hash,image_policy:{store_key:'preferences',record_id:fileId,expected_revision:2,content_digest:digest,field:'external_images',automatic_value:'always'}};
 const source={...store,key:'preferences',max_record_bytes:8192,max_files:0,max_file_bytes:1,max_total_file_bytes:1};
 for(const kind of ['valid','no_policy','forged_policy','no_receipt','old_revision','foreign_receipt','archived','ask','revoked','foreign_account','late'] as const){let live=true,resolves=0;
  const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>live,fetch:async(path,options)=>{
   if(path.endsWith('/resolve')){resolves++;const request=JSON.parse(String(options.body)),ctx=context();ctx.targets[0].stores.push({declaration:source,consent:kind==='revoked'?null:ctx.targets[0].stores[0].consent} as typeof ctx.targets[0]['stores'][number]);if(kind==='foreign_account'&&request.store_key==='preferences')ctx.targets[0].account.account_ref=fileId;return json(ctx);}
   const request=JSON.parse(String(options.body));if(kind==='late')live=false;return json({...(kind==='no_policy'?{}:{document_policy:{schema_version:'deft.app_record_document_policy.v1',field:'external_images',automatic_value:kind==='forged_policy'?'ask':'always'}}),...await result(request,({...pref,...(kind==='old_revision'?{revision:1,content_revision:1}:kind==='archived'?{status:'archived'}:kind==='ask'?{value:{external_images:'ask'}}:{})})),...(kind==='no_receipt'?{}:{human_save:{...proof,...(kind==='foreign_receipt'?{record_id:id}:{})}})});
  }});
  if(kind==='late')await assert.rejects(client.automaticImages(document,new AbortController().signal));else assert.equal(await client.automaticImages(document,new AbortController().signal),kind==='valid',kind);
  if(kind==='valid')assert.equal(resolves,2,'reuse the exact preference target already validated in this operation');
 }
});
test('initial source selection uses explicit verified primary instead of first alias and denies ambiguous identity rows',async()=>{
 const primary='primary@example.test',alias='alias@example.test',source={...store,key:'signatures',max_record_bytes:65536,max_files:0,max_file_bytes:1,max_total_file_bytes:1};
 const initial={...node,initial_change:{operation_key:'signature_default',source_store_key:'signatures',source_identity_field:'address'}};
 const record={...row(),revision:1,content_revision:1},destination={...store,record_changes:[{key:'signature_default',source_store_key:'signatures'}]};
 for(const kind of ['primary','absent','unverified','duplicate'] as const){
  const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
   if(path.endsWith('/resolve')){const ctx=context('mailbox',destination);ctx.targets[0].stores.push({declaration:source,consent:ctx.targets[0].stores[0].consent});return json(ctx);}
   const request=JSON.parse(String(options.body)),base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
   if(request.operation==='connection_metadata')return json({...base,identities:[{address:alias,label:'Alias'},{address:primary,label:'Primary'}],...(kind==='absent'?{}:{primary_identity:{address:kind==='unverified'?'foreign@example.test':primary,label:'Primary'}})});
   const meta={schema_version:'deft.app_record.v1',store_key:'signatures',record_id:fileId,revision:4,content_revision:4,content_digest:hash,status:'draft',summary:{address:primary},created_at:date,updated_at:date};return json({...base,items:[meta,...(kind==='duplicate'?[{...meta,record_id:connection}]:[])],next_cursor:null});
  }});
  if(kind==='unverified'){await assert.rejects(client.ports.initialSource!(initial,record,new AbortController().signal));continue;}const found=await client.ports.initialSource!(initial,record,new AbortController().signal);assert.equal(found?.record_id,kind==='primary'?fileId:undefined,kind);
 }
});


test('an author cannot reinterpret a saved Ask choice as automatic image authority',async()=>{
 const {createHash}=await import('node:crypto');const value={external_images:'ask'},digest='sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const pref={...row(),store_key:'preferences',record_id:fileId,revision:2,content_revision:2,content_digest:digest,value};
 const document={kind:'record_document' as const,id:'document',profile_version:'deft.record_document.v1' as const,store_key:'drafts',resource_key:'inbox',record_id:id,content_digest:hash,image_policy:{store_key:'preferences',record_id:fileId,expected_revision:2,content_digest:digest,field:'external_images',automatic_value:'ask'}};
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
  if(path.endsWith('/resolve')){const ctx=context();ctx.targets[0].stores.push({declaration:{...store,key:'preferences',max_record_bytes:8192,max_files:0,max_file_bytes:1,max_total_file_bytes:1},consent:ctx.targets[0].stores[0].consent});return json(ctx);}
  const request=JSON.parse(String(options.body));return json({...await result(request,pref),document_policy:{schema_version:'deft.app_record_document_policy.v1',field:'external_images',automatic_value:'always'},human_save:{request_id:id,store_key:'preferences',record_id:fileId,revision:2,content_digest:digest}});
 }});assert.equal(await client.automaticImages(document,new AbortController().signal),false);
});


test('actual public Prepare carries sealed initial mode and rejects a manual or altered mode acknowledgement',async()=>{
 const sourceRef={store_key:'signatures',record_id:fileId,expected_revision:3,expected_content_digest:hash};
 const initial={...node,initial_change:{operation_key:'signature_default',source_store_key:'signatures',source_identity_field:'address'}};
 const original={...row(),revision:1,content_revision:1,value:{to:'person@example.test',subject:'Native',body:'',body_html:'',attachments:[]}};
 const source={...store,key:'signatures',max_record_bytes:65536,max_files:0,max_file_bytes:1,max_total_file_bytes:1},destination={...store,record_changes:[{key:'signature_default',source_store_key:'signatures'}]};
 for(const kind of ['initial','missing','manual'] as const){let calls=0;
  const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{
   if(path.endsWith('/resolve')){const ctx=context('mailbox',destination);ctx.targets[0].stores.push({declaration:source,consent:ctx.targets[0].stores[0].consent});return json(ctx);}
   const request=JSON.parse(String(options.body));calls++;assert.equal(request.input.invocation_mode,kind==='manual'?undefined:'initial');
   const snapshot={schema_version:'deft.app_prepared_record_change.v1',prepared_id:request.request_id,operation_key:'signature_default',...(kind==='missing'?{}:{invocation_mode:'initial'}),account_ref:id,destination:{store_key:'drafts',record_id:id,expected_revision:1,expected_content_digest:hash},source:sourceRef,authorization_digest:hash,value:original.value,preview:{title:'Default signature',description:'',warnings:[]},expires_at:new Date(Date.now()+30000).toISOString()};
   const {canonicalAppDataJson}=await import('../../../../packages/app-kit/src/app-data');const prepared_digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalAppDataJson(snapshot)))),byte=>byte.toString(16).padStart(2,'0')).join('');
   return json({...await result(request),record:undefined,prepared_change:{...snapshot,prepared_digest}});
  }});
  const call=client.ports.prepareChange!(initial,original,{operation_key:'signature_default',source_store_key:'signatures',label:'Default'}, {...sourceRef,label:'Own'},id,new AbortController().signal,kind==='manual'?undefined:'initial');
  if(kind==='initial')assert.equal((await call).invocation_mode,'initial');else await assert.rejects(call);
  assert.equal(calls,1);
 }
});

test('unsaved full record blank flush writes nothing; first file creates once; create ACK loss only reconciles exact original UUID',async()=>{
 const {createExperienceRecordWriter}=await import('./app-experience-record-writer');const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}};let saved:any=null,accepted:any=null,createCalls=0,statusCalls=0,lose=true;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/resolve')||path.endsWith('/context'))return json(context());const request=JSON.parse(String(options.body)),base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
 if(request.operation==='record_read')return json(saved?{...base,record:saved}:{...base,outcome:'not_found'});if(request.operation==='connection_metadata')return json({...base,identities:[{address:'own@example.test',label:'Own'}]});if(request.operation==='record_create'){createCalls++;accepted=request;saved={...row(),revision:1,content_revision:1,value:request.input.value};if(lose){lose=false;throw Error('lost ACK');}return json({...base,record:saved});}if(request.operation==='request_status'){statusCalls++;assert.equal(request.input.request_id,accepted.request_id);return json({...base,request_status:{request_id:accepted.request_id,operation:'record_create',input_digest:await appDataInputDigest('record_create',accepted.input),state:'completed',record_id:id,revision:1,content_digest:hash}});}throw Error('unexpected '+request.operation);}});
 const opened=await client.ports.load(seed,signal);assert.equal(opened.record.revision,0);const writer=createExperienceRecordWriter({initial:opened.record,current:()=>true,signal,validate:()=>{},read:async()=>(await client.ports.load(seed,signal)).record,save:(revision,value,rid,digest)=>client.ports.save(seed,revision,value,rid,digest,signal),recoverSave:(revision,value,rid,digest)=>client.ports.saveStatus!(seed,revision,value,rid,digest,signal),change:()=>{}});assert.equal(await writer.save(),true);assert.equal(createCalls,0);let fileCalls=0;assert.equal(await writer.mutate(async revision=>{fileCalls++;assert.equal(revision,1);return {...saved,revision:2};}),false);assert.equal(createCalls,1);assert.equal(fileCalls,0);assert.equal(await writer.save(true),false);assert.equal(createCalls,1);assert.equal(await writer.reconcileSave(),true);assert.equal(statusCalls,1);assert.equal(createCalls,1);assert.equal(await writer.mutate(async revision=>{fileCalls++;assert.equal(revision,1);return {...saved,revision:2};}),true);assert.equal(fileCalls,1);assert.equal(createCalls,1);writer.dispose();
});

test('revision zero is explicit seed only and cannot carry record source claims',async()=>{
 const {DeftExperienceRecordFormNodeSchema}=await import('../../../../packages/app-kit/src/app-data');const seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1',value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}};assert.equal(DeftExperienceRecordFormNodeSchema.safeParse(seed).success,true);const {seed:unused,...without}=seed;assert.equal(DeftExperienceRecordFormNodeSchema.safeParse(without).success,false);assert.equal(DeftExperienceRecordFormNodeSchema.safeParse({...seed,expected_revision:1}).success,false);assert.equal(DeftExperienceRecordFormNodeSchema.safeParse({...seed,source_refs:[{resource_key:'inbox',record_id:id,revision:1,content_digest:hash}]}).success,false);
});
test('denied signature source cannot leak its value into an unsaved seed; malformed admitted seed is rejected',async()=>{
 const seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}},initial_change:{operation_key:'signature_default',source_store_key:'signatures',source_identity_field:'address'}};let sourceRequests=0;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/resolve'))return json(context('mailbox',{...store,record_changes:[{key:'signature_default',source_store_key:'signatures'}]}));const request=JSON.parse(String(options.body)),base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};if(request.input.store_key==='signatures'){sourceRequests++;throw Error('must not access denied source');}return json(request.operation==='record_read'?{...base,outcome:'not_found'}:{...base,identities:[]});}});const opened=await client.ports.load(seed,new AbortController().signal);assert.equal(opened.record.value.body,'');assert.equal(sourceRequests,0);assert.match(String(opened.record.summary?.initial_value_notice),/unavailable/);assert.doesNotMatch(String(opened.record.summary?.initial_value_notice),/unsaved|not saved/);await assert.rejects(client.ports.load({...seed,seed:{...seed.seed,value:{...seed.seed.value,attachments:[{file_id:id}]}}},new AbortController().signal));
});

test('known unsaved recovery scope freshly checks account and consent without duplicating the full recovery proof',async()=>{
 const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}};
 const calls:string[]=[];let denied:'none'|'consent'|'account'|'target'='none';
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',accountRef:()=>id,principal:{orgId:id,userId:id},current:()=>true,fetch:async(path,options)=>{
  if(path.endsWith('/resolve')){calls.push('resolve');const ctx=context(denied==='target'?'foreign':'mailbox');if(denied==='account')ctx.targets[0].account.account_ref=connection;if(denied==='consent')(ctx.targets[0].stores[0] as any).consent=null;return json(ctx);}
  const request=JSON.parse(String(options.body));calls.push(request.operation);const base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
  if(request.operation==='record_read')return json({...base,outcome:'not_found'});if(request.operation==='connection_metadata')return json({...base,identities:[]});throw Error('unexpected mutation');
 }});
 await client.ports.load(seed,signal);calls.length=0;
 assert.equal((await client.ports.recoveryScope!(seed,signal)).accountId,id);assert.deepEqual(calls,['resolve']);
 calls.length=0;await client.ports.load(seed,signal);assert.equal(calls.filter(v=>v==='record_read').length,1);assert.equal(calls.filter(v=>v==='connection_metadata').length,1);
 for(const kind of ['consent','account','target'] as const){denied=kind;calls.length=0;await assert.rejects(client.ports.recoveryScope!(seed,signal));assert.deepEqual(calls,['resolve']);}
 denied='none';for(const other of [node,{...seed,record_id:fileId}]){calls.length=0;await assert.rejects(client.ports.recoveryScope!(other,signal));assert.equal(calls.filter(v=>v==='record_read').length,1);}
 const aborted=new AbortController();aborted.abort();calls.length=0;await assert.rejects(client.ports.recoveryScope!(seed,aborted.signal));assert.deepEqual(calls,[]);
});

test('recovery snapshot uses one fresh scope and exact read, preserving the original unsaved base without identity/default reloads',async()=>{
 const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}};
 const calls:string[]=[];let saved=false;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',accountRef:()=>id,principal:{orgId:id,userId:id},current:()=>true,fetch:async(path,options)=>{
  if(path.endsWith('/resolve')){calls.push('resolve');return json(context());}const request=JSON.parse(String(options.body));calls.push(request.operation);
  if(request.operation==='record_read')return json(saved?await result(request,{...row(),revision:8}):{...await result(request),record:undefined,identities:undefined,outcome:'not_found'});
  if(request.operation==='connection_metadata')return json({...await result(request),record:undefined,identities:[]});throw Error('unexpected mutation');
 }});
 const opened=await client.ports.load(seed,signal),digest=opened.record.content_digest;opened.record.value.subject='local mutation';calls.length=0;
 const proof=await client.ports.recoverySnapshot!(seed,signal);assert.deepEqual(calls,['resolve','record_read']);assert.equal(proof.record.revision,0);assert.equal(proof.record.content_digest,digest);assert.equal(proof.record.value.subject,'');
 assert.deepEqual(proof.scope,{orgId:id,userId:id,installationId:installation,accountId:id,stateKey:'drafts',recordId:id,resourceTargetKey:'mailbox'});
 saved=true;calls.length=0;const current=await client.ports.recoverySnapshot!(seed,signal);assert.equal(current.record.revision,8);assert.deepEqual(calls,['resolve','record_read']);
 saved=false;await assert.rejects(client.ports.recoverySnapshot!(seed,signal));
});

test('recovery snapshot denies lost authority and unconfirmed reads instead of treating them as an absent seed',async()=>{
 const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}};
 for(const mode of ['consent','account','target','profile','changes','late','changed_account','expired_during_read','permission','network','conflict','foreign_record','foreign_store','wrong_digest','unloaded_seed','saved_missing','seed_binding'] as const){
  let checking=false,live=true,expected=id,reads=0;
  const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',accountRef:mode==='seed_binding'?undefined:()=>expected,principal:{orgId:id,userId:id},current:()=>live,fetch:async(path,options)=>{
   if(path.endsWith('/resolve')){const ctx=context(checking&&mode==='target'?'foreign':'mailbox',checking&&mode==='profile'?{...store,max_record_bytes:16384}:store);
    if(checking&&(mode==='account'||mode==='seed_binding'))ctx.targets[0].account.account_ref=connection;if(checking&&mode==='consent')(ctx.targets[0].stores[0] as any).consent=null;
    if(checking&&mode==='expired_during_read')ctx.targets[0].stores[0].consent!.expires_at=new Date(Date.now()+2).toISOString();return json(ctx);}
   const request=JSON.parse(String(options.body)),base={...await result(request),record:undefined,identities:undefined};
   if(request.operation==='connection_metadata')return json({...base,identities:[]});assert.equal(request.operation,'record_read');reads++;
   if(checking){if(mode==='late')live=false;if(mode==='changed_account')expected=connection;if(mode==='expired_during_read')await new Promise(resolve=>setTimeout(resolve,5));if(mode==='permission')return new Response('',{status:403});if(mode==='network')throw Error('network');
    if(mode==='conflict')return json({...base,outcome:'conflict'});if(mode==='foreign_record')return json({...base,record:{...row(),record_id:fileId}});if(mode==='foreign_store')return json({...base,record:{...row(),store_key:'foreign'}});if(mode==='wrong_digest')return json({...base,outcome:'not_found',input_digest:'sha256:'+'b'.repeat(64)});}
   return json({...base,outcome:'not_found'});
  }});
  if(mode!=='unloaded_seed')await client.ports.load(seed,signal);checking=true;reads=0;
  const candidate=mode==='saved_missing'?node:mode==='changes'?{...seed,record_changes:[{operation_key:'unknown',source_store_key:'absent',label:'Unknown'}]}:seed;
  await assert.rejects(client.ports.recoverySnapshot!(candidate,signal),Error,mode);if(['consent','account','target','profile','changes'].includes(mode))assert.equal(reads,0,mode);
 }
 const absent=createExperienceDataClient({installationId:installation,current:()=>true,fetch:async()=>{throw Error('unexpected read');}});assert.equal(absent.ports.recoverySnapshot,undefined);
});

test('recovery snapshot returns fresh revision and file custody and enforces the nominated original source',async()=>{
 const signal=new AbortController().signal,files=[{file_id:fileId,filename:'original.pdf',media_type:'application/pdf',size_bytes:8,sha256:hash,upload_revision:8}],source={resource_key:'inbox',record_id:fileId,content_digest:hash};let mismatch=false;
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',principal:{orgId:id,userId:id},current:()=>true,fetch:async(path,options)=>{
  if(path.endsWith('/resolve'))return json(context());return json(await result(JSON.parse(String(options.body)),{...row(),revision:8,files,source_refs:mismatch?[]:[source]}));
 }});
 const owned={...node,source_refs:[source]},proof=await client.ports.recoverySnapshot!(owned,signal);assert.equal(proof.record.revision,8);assert.equal(proof.record.content_digest,hash);assert.deepEqual(proof.record.files,files);
 mismatch=true;await assert.rejects(client.ports.recoverySnapshot!(owned,signal));
 const aborted=new AbortController();aborted.abort();await assert.rejects(client.ports.recoverySnapshot!(owned,aborted.signal));
});


test('actual data client admits explicit until-revoked draft consent but never missing mode or revoked store',async()=>{
 for(const mode of ['persistent','missing','revoked'] as const){let reads=0;const value:any=context();value.targets[0].stores[0].consent=mode==='revoked'?null:{consent_id:id,consent_digest:hash,expires_at:null,...(mode==='persistent'?{consent_lifetime:'until_revoked'}:{})};
 const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/context')||path.endsWith('/resolve'))return json(value);reads++;return json(await result(JSON.parse(String(options.body))));}});
 if(mode==='persistent'){const opened=await client.ports.load(node,new AbortController().signal);assert.equal(opened.record.value.subject,row().value.subject);assert.equal(reads,1);}else{await assert.rejects(client.ports.load(node,new AbortController().signal));assert.equal(reads,0);}}
});


test('temporary account resolution blocks every record request without treating the account as revoked',async()=>{
 for(const status of [408,429,500,503,401,403,404,410]){
  let requests=0;const client=createExperienceDataClient({installationId:installation,targetKey:'mailbox',current:()=>true,fetch:async path=>{
   if(path.endsWith('/resolve'))return new Response('{}',{status});requests++;throw Error('Record request must not dispatch');
  }});
  await assert.rejects(client.request('drafts','record_read',{store_key:'drafts',record_id:id},new AbortController().signal),error=>{
   assert.equal(error instanceof ExperienceAuthorityUnavailable,[408,429,500,503].includes(status));return true;
  });assert.equal(requests,0);
 }
});


test('opaque source seed is hydrated by the current Runtime without a create, then first save preserves edited value',async()=>{
 const signal=new AbortController().signal,marker={schema_version:'example.source_seed.v1',source:{resource_key:'inbox',record_id:connection,content_digest:hash}},seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[],record_seed:marker}}},calls:AppDataRequest[]=[];
 const hydrated={...seed.seed.value,to:'sender@example.test',subject:'Reply subject',body:'Original quoted body',record_seed:{...marker,source_digest:hash}};
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/resolve'))return json(context('primary'));const request=JSON.parse(String(options.body)) as AppDataRequest;calls.push(request);const base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};if(request.operation==='record_read')return json({...base,outcome:'not_found'});if(request.operation==='connection_metadata'){assert.deepEqual(request.input.seed,{operation_key:'record_seed',destination_store_key:'drafts',value:seed.seed.value});return json({...base,record_seed_value:hydrated,identities:[]});}assert.equal(request.operation,'record_create');return json({...base,record:{...row(),revision:1,value:request.input.value}});}});
 const opened=await client.ports.load(seed,signal);assert.equal(opened.record.revision,0);assert.deepEqual(opened.record.value,hydrated);assert.equal(calls.some(call=>call.operation==='record_create'),false);
 const edited={...opened.record.value,subject:'Human edit',body:'Exact human body'},saved=await client.ports.save(seed,0,edited,id,opened.record.content_digest,signal);assert.deepEqual(saved.value,edited);assert.equal(calls.filter(call=>call.operation==='record_create').length,1);
});


test('seed existence, identities and optional defaults start together; all current authority checks complete before opening',async()=>{
 const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}},initial_change:{operation_key:'signature_default',source_store_key:'signatures',source_identity_field:'address'}},calls:string[]=[],releases:(()=>void)[]=[],destination={...store,record_changes:[{key:'signature_default',source_store_key:'signatures'}]};
 const source={...store,key:'signatures',max_record_bytes:65536,max_files:0,max_file_bytes:1,max_total_file_bytes:1};let opened=false;
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/resolve')){const value=context('primary',destination);value.targets[0].stores.push({declaration:source,consent:{consent_id:id,consent_digest:hash,expires_at:expires}});return json(value);}const request=JSON.parse(String(options.body)) as AppDataRequest;calls.push(request.operation+':'+request.input.store_key);await new Promise<void>(resolve=>releases.push(resolve));const base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};return json(request.operation==='record_read'?{...base,outcome:'not_found'}:request.input.store_key==='signatures'?{...base,record_seed_value:{...seed.seed.value,body:'Approved default'}}:{...base,identities:[]});}});
 const opening=client.ports.load(seed,signal).then(result=>{opened=true;return result;});for(let tick=0;tick<20&&calls.length<3;tick++)await new Promise(setImmediate);
 assert.deepEqual(calls.sort(),['connection_metadata:drafts','connection_metadata:signatures','record_read:drafts']);assert.equal(opened,false);releases.forEach(release=>release());const result=await opening;assert.equal(result.record.value.body,'Approved default');assert.equal(calls.some(call=>call.startsWith('record_create:')),false);
});


test('parallel seed preflight denies late revocation before any hydrated value or writable form is returned',async()=>{
 const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[],record_seed:{schema_version:'example.source_seed.v1'}}}};let current=true,release:()=>void=()=>{},entered:()=>void=()=>{},writes=0;const started=new Promise<void>(resolve=>entered=resolve);
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',current:()=>current,fetch:async(path,options)=>{if(path.endsWith('/resolve'))return json(context('primary'));const request=JSON.parse(String(options.body)) as AppDataRequest,base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};if(request.operation==='record_read')return json({...base,outcome:'not_found'});if(request.operation==='record_create')writes++;entered();await new Promise<void>(resolve=>release=resolve);return json({...base,record_seed_value:{...seed.seed.value,body:'Must never be disclosed'},identities:[]});}});
 const opening=client.ports.load(seed,signal);await started;current=false;release();await assert.rejects(opening,/scope ended/);assert.equal(writes,0);
});


test('seed locator begins fresh target and pinned metadata checks together before a stalled target read resolves',async()=>{
 const signal=new AbortController().signal,seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}},calls:string[]=[];let resolveReads=0,release:()=>void=()=>{};
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',principal:{orgId:id,userId:connection},current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/resolve')){calls.push('resolve');if(++resolveReads===2)await new Promise<void>(resolve=>release=resolve);const fresh=context('primary');if(resolveReads===2)fresh.targets[0].session_id=fileId;return json(fresh);}calls.push('metadata');const request=JSON.parse(String(options.body)) as AppDataRequest;assert.equal(path,`/api/app-data/connections/${connection}/requests`);assert.equal(request.operation,'connection_metadata');return json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',identities:[]});}});
 const opening=client.ports.resolveSeed!(seed,signal);for(let tick=0;tick<20&&!calls.includes('metadata');tick++)await new Promise(setImmediate);
 assert.deepEqual(calls,['resolve','resolve','metadata']);release();await assert.rejects(opening,/Seed visibility ended/);
});

test('seed locator denies a fresh session, account, target, resource, store declaration or consent pin change before browser storage',async()=>{
 const seed={...node,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1' as const,value:{to:'',subject:'',body:'',body_html:'',attachments:[]}}};
 for(const changed of ['session','account','target','resource','store','consent','expired','missing'] as const){let resolves=0,metadata=0;
  const client=createExperienceDataClient({installationId:installation,targetKey:'primary',principal:{orgId:id,userId:connection},current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/resolve')){const fresh=context('primary');if(++resolves>1){const target=fresh.targets[0];if(changed==='session')target.session_id=fileId;if(changed==='account')target.account.account_ref=fileId;if(changed==='target')target.target_key='changed';if(changed==='resource')target.resource_key='other';if(changed==='store')target.stores[0].declaration={...store,max_record_bytes:491519};if(changed==='consent')target.stores[0].consent.consent_digest='sha256:'+'b'.repeat(64);if(changed==='expired')target.stores[0].consent.expires_at=new Date(Date.now()-1000).toISOString();if(changed==='missing')delete (target.stores[0] as any).consent;}return json(fresh);}metadata++;const request=JSON.parse(String(options.body)) as AppDataRequest;return json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',identities:[]});}});
  await assert.rejects(client.ports.resolveSeed!(seed,new AbortController().signal),/Seed visibility ended|scope changed|Invalid input/,changed);assert.equal(metadata,1,changed);
 }
});
