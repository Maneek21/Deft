import {recordSeedSnapshotValue,recordSeedSnapshotResult} from './app-experience-record-seed-snapshot';
import {traceExperienceRead} from './app-experience-read-trace';
import {readAppRequestError} from './app-request-error';
import {experienceAuthorityResponse,ExperienceAuthorityUnavailable} from './app-experience-connection';
import {appConsentDeadline} from '../../../../packages/app-kit/src/consent-lifetime';
import {createRecordSeedLocator} from './app-experience-record-seed';
import {AppPreparedRecordChangeSchema,AppRecordPrepareChangeInputSchema,AppRecordApplyChangeInputSchema} from '../../../../packages/app-kit/src/record-change';
import {AppDataRecordMetaSchema} from '../../../../packages/app-kit/src/app-data';
import {RecordChangeNotApplied,verifyRecordChangeReceipt,type RecordChangePorts} from './app-experience-record-changes';
import {recordFormFields,recordFormIdentity,recordFormLabels,recordFormFiles,validateRecordFormValue} from './app-experience-record-form';
import {AppDataContextSchema,AppDataResolveInputSchema,AppDataRequestSchema,AppDataResultSchema,AppDataBinaryMetadataSchema,
 APP_DATA_FRAME_MEDIA_TYPE,APP_DATA_LIMITS,canonicalAppDataJson,frameAppData,parseAppDataFrame,
 AppDataSourceFileSchema,type AppDataRequest,type AppDataResult,type AppDataRecord,type DeftExperienceRecordDocumentNode} from '../../../../packages/app-kit/src/app-data';
import type {ExperienceRecordFormPorts,ExperienceRecordFormNode,ExperienceRecordFormReference} from '../components/apps/experience-record-form';
import type {ExperienceRecordRow} from './app-experience-record-writer';
import {recordCopySource,verifyFileCopy,type FileCopyNode} from './app-experience-file-copy';
import type {RecordFormFile} from './app-experience-record-form';

class OptionalDefaultDenied extends Error {}
const sha=async(bytes:Uint8Array)=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('');
export async function appDataInputDigest(operation:string,input:Record<string,unknown>){return sha(new TextEncoder().encode(canonicalAppDataJson({operation,input})));}
async function boundedBytes(response:Response,max:number,signal:AbortSignal){
 if(!response.ok||!response.body)throw Error('App data unavailable');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>max)throw Error('App data limit');chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;chunk.fill(0);}return bytes;
 }catch(error){await reader.cancel().catch(()=>{});for(const chunk of chunks)chunk.fill(0);throw error;}finally{reader.releaseLock();}
}
/** This client runs only in the trusted host and resolves its current connected
 * account itself. The Worker cannot nominate a URL, token or connection handle. */
export function createExperienceDataClient(options:{installationId:string;targetKey?:string;accountRef?:()=>string|undefined;principal?:{orgId:string;userId:string};current:()=>boolean;
 fetch:(path:string,options:RequestInit)=>Promise<Response>;review?:ExperienceRecordFormPorts['review']}){
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(!options.current())throw Error('App data scope ended');};
 const context=async(signal:AbortSignal,storeKey?:string)=>{check(signal);
  const resolve=options.targetKey!==undefined&&storeKey!==undefined;
  const input=resolve?AppDataResolveInputSchema.parse({schema_version:'deft.app_data_resolve.v1',target_key:options.targetKey,store_key:storeKey}):null;
  const response=await traceExperienceRead(signal,resolve?'data.resolve':'data.context',()=>options.fetch(`/api/app-data/installations/${encodeURIComponent(options.installationId)}/${resolve?'resolve':'context'}`,{signal,cache:'no-store',...(input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{})}));
  if(experienceAuthorityResponse(response)==='unavailable')throw new ExperienceAuthorityUnavailable();
  const bytes=await traceExperienceRead(signal,'data.body',()=>boundedBytes(response,65536,signal));try{const value=AppDataContextSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));check(signal);
   if(value.installation_id!==options.installationId||input&&(value.targets.length!==1||value.targets[0].target_key!==input.target_key||!value.targets[0].stores.some(store=>store.declaration.key===input.store_key)))throw Error('App data scope changed');return value;}finally{bytes.fill(0);}};
 const select=async(storeKey:string,signal:AbortSignal)=>{const value=await context(signal,storeKey),candidates=value.targets.filter(target=>target.stores.some(store=>store.declaration.key===storeKey));
  const exact=options.targetKey?candidates.filter(target=>target.target_key===options.targetKey):candidates;
  const targets=options.targetKey?exact:candidates;if(targets.length!==1)throw Error('Choose a connected account');const expected=options.accountRef?.();if(expected!==undefined&&targets[0].account.account_ref!==expected)throw Error('Source account changed');return targets[0];};
 const request=async(storeKey:string,operation:AppDataRequest['operation'],input:Record<string,unknown>,signal:AbortSignal,requestId:string=crypto.randomUUID(),upload?:File,allowSettled=false,selected?:Awaited<ReturnType<typeof select>>,rejectDenied=false):Promise<AppDataResult>=>{
  check(signal);let target=selected??await select(storeKey,signal),data=AppDataRequestSchema.parse({schema_version:'deft.app_data_request.v1',request_id:requestId,operation,input});
  // A target may be reused only by its immediate trusted operation. Recheck
  // local account pins at dispatch and disclosure; Runtime still independently
  // verifies current authority for this exact request.
  const targetCurrent=()=>{const expected=options.accountRef?.();if(options.targetKey!==undefined&&target.target_key!==options.targetKey||expected!==undefined&&target.account.account_ref!==expected||!target.stores.some(store=>store.declaration.key===storeKey))throw Error('App data account or target changed');};targetCurrent();
  let frame:Uint8Array|undefined,bytes:Uint8Array|undefined;
  try{if(upload){bytes=new Uint8Array(await upload.arrayBuffer());frame=frameAppData(data,bytes);}
   const dispatch=()=>traceExperienceRead(signal,'data.request',()=>options.fetch(`/api/app-data/connections/${encodeURIComponent(target.session_id)}/${upload?'binary':'requests'}`,{
    method:'POST',signal,headers:{'Content-Type':upload?APP_DATA_FRAME_MEDIA_TYPE:'application/json'},body:frame?new Uint8Array(frame).buffer:JSON.stringify(data)}),requestId);
   let response=await dispatch();
   if(!upload&&['resource_list','record_list'].includes(operation)&&!response.ok){
    const error=await readAppRequestError(response.clone(),'App data could not be loaded.');
    const authorityChanged=response.status===403&&error.code==='APP_RUNTIME_ACCESS_DENIED'&&/^[A-Z][A-Z0-9]{0,23}_RUNTIME_AUTHORITY_DENIED$/u.test(error.runtimeCode??'');
    const unavailable=error.retryable&&['APP_PROVIDER_UNAVAILABLE','APP_RUNTIME_UNAVAILABLE','APP_EXPERIENCE_BUSY'].includes(error.code);
    if(authorityChanged||unavailable){
     check(signal);const fresh=await select(storeKey,signal);
     const pins=(value:typeof target)=>canonicalAppDataJson({session_id:value.session_id,target_key:value.target_key,resource_key:value.resource_key,account_ref:value.account.account_ref,stores:value.stores});
     if(pins(fresh)!==pins(target))throw Error('App data retry authority changed');
     target=fresh;targetCurrent();check(signal);
     // Reads get one new invocation after fresh, identical authority. The
     // original journal remains immutable; writes are never replayed here.
     void response.body?.cancel().catch(()=>{});requestId=crypto.randomUUID();data={...data,request_id:requestId};response=await dispatch();
    }
   }
   if(rejectDenied&&[401,403,409,410].includes(response.status)){void response.body?.cancel().catch(()=>{});throw new OptionalDefaultDenied('App data access ended');}
   if(response.headers.get('content-type')?.split(';')[0]!=='application/json')throw Error('App data result unavailable');
   const resultBytes=await traceExperienceRead(signal,'data.body',()=>boundedBytes(response,APP_DATA_LIMITS.result_json_bytes,signal));try{const result=AppDataResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(resultBytes)));check(signal);targetCurrent();
    if(result.request_id!==requestId||result.operation!==operation||result.input_digest!==await appDataInputDigest(operation,input)||result.outcome!=='completed'&&!(allowSettled&&['conflict','not_found'].includes(result.outcome))||result.record&&input.store_key!==undefined&&result.record.store_key!==input.store_key)throw Error('App data result not confirmed');return result;
   }finally{resultBytes.fill(0);}
  }finally{bytes?.fill(0);frame?.fill(0);}
 };
 const binary=async(storeKey:string,operation:AppDataRequest['operation'],input:Record<string,unknown>,signal:AbortSignal)=>{
  check(signal);const target=await select(storeKey,signal),requestId=crypto.randomUUID(),data=AppDataRequestSchema.parse({schema_version:'deft.app_data_request.v1',request_id:requestId,operation,input});
  const response=await traceExperienceRead(signal,'data.binary',()=>options.fetch(`/api/app-data/connections/${encodeURIComponent(target.session_id)}/requests`,{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),requestId);
  if(response.headers.get('content-type')?.split(';')[0]!==APP_DATA_FRAME_MEDIA_TYPE)throw Error('App data frame unavailable');
  const raw=await traceExperienceRead(signal,'data.body',()=>boundedBytes(response,4+APP_DATA_LIMITS.frame_header_bytes+APP_DATA_LIMITS.source_bytes,signal));
  try{const parsed=parseAppDataFrame(raw),header=AppDataBinaryMetadataSchema.parse(parsed.header);check(signal);
   if(header.request_id!==requestId||header.operation!==operation||header.input_digest!==await appDataInputDigest(operation,input)
    ||header.record_id!==input.record_id||header.size_bytes!==parsed.bytes.length||header.sha256!==await sha(parsed.bytes)
    ||input.file_id!==undefined&&(header.file_id!==input.file_id||header.upload_revision!==input.upload_revision||header.sha256!==input.sha256))throw Error('App data binary changed');
   return {bytes:new Uint8Array(parsed.bytes),media_type:header.media_type,filename:header.filename};
  }finally{raw.fill(0);}
 };
 const row=(result:AppDataResult,recordId:string):AppDataRecord=>{if(!result.record||result.record.record_id!==recordId)throw Error('Record unavailable');return result.record;};
 const locator=(node:{store_key:string;record_id:string})=>({store_key:node.store_key,record_id:node.record_id});
 const fileLocator=(node:ExperienceRecordFormNode,record:ExperienceRecordRow,file:RecordFormFile)=>{
  const owned=record.files?.find(item=>item.file_id===file.file_id&&item.sha256==='sha256:'+file.sha256);if(!owned)throw Error('File custody changed');
  return {...locator(node),file_id:file.file_id,upload_revision:owned.upload_revision,sha256:owned.sha256};};
 const copyInput=(node:FileCopyNode,record:ExperienceRecordRow,source:NonNullable<ReturnType<typeof recordCopySource>>,file:{file_ref:string},fileId:string)=>{
  if(record.status!=='draft'||JSON.stringify(recordCopySource(node,record))!==JSON.stringify(source))throw Error('Original source unavailable');
  return {...locator(node),expected_revision:record.revision,expected_content_digest:record.content_digest,file_id:fileId,source:{...source,file_ref:file.file_ref}};
 };
 const checkedChangeTarget=(node:ExperienceRecordFormNode,control:{operation_key:string;source_store_key:string},target:Awaited<ReturnType<typeof select>>)=>{
  const destination=target.stores.find(item=>item.declaration.key===node.store_key),source=target.stores.find(item=>item.declaration.key===control.source_store_key);
  if(!(node.record_changes?.some(item=>item.operation_key===control.operation_key&&item.source_store_key===control.source_store_key)||node.initial_change?.operation_key===control.operation_key&&node.initial_change.source_store_key===control.source_store_key)
   ||!destination?.declaration.record_changes?.some(item=>item.key===control.operation_key&&item.source_store_key===control.source_store_key)
   ||!source||source.declaration.resource_key!==destination.declaration.resource_key||source.declaration.runtime_requirement_key!==destination.declaration.runtime_requirement_key
   ||!destination.consent||!source.consent||Math.min(appConsentDeadline(destination.consent.expires_at,destination.consent.consent_lifetime),appConsentDeadline(source.consent.expires_at,source.consent.consent_lifetime))<=Date.now())throw Error('Saved-content access ended');return {target,destination,source};
 };
 const changeTarget=async(node:ExperienceRecordFormNode,control:{operation_key:string;source_store_key:string},signal:AbortSignal)=>checkedChangeTarget(node,control,await select(node.store_key,signal));
 const changeInput=(node:ExperienceRecordFormNode,record:ExperienceRecordRow,control:{operation_key:string},source:{store_key:string;record_id:string;expected_revision:number;expected_content_digest:string},invocationMode?:'initial',parameters?:Record<string,string>)=>{
  if(record.status!=='draft'||record.record_id!==node.record_id)throw Error('Saved draft changed');return AppRecordPrepareChangeInputSchema.parse({...locator(node),expected_revision:record.revision,expected_content_digest:record.content_digest,operation_key:control.operation_key,...(invocationMode?{invocation_mode:invocationMode}:{}),...(parameters!==undefined?{parameters}:{}),source:{store_key:source.store_key,record_id:source.record_id,expected_revision:source.expected_revision,expected_content_digest:source.expected_content_digest}});};
 const changePorts:RecordChangePorts={
  listChanges:async(node,control,signal,cursor=null)=>{await changeTarget(node,control,signal);const result=await request(control.source_store_key,'record_list',{store_key:control.source_store_key,cursor,limit:25},signal);
   const rows=(result.items??[]).map(item=>AppDataRecordMetaSchema.parse(item));if(rows.some(item=>item.store_key!==control.source_store_key)||new Set(rows.map(item=>item.record_id)).size!==rows.length)throw Error('Saved content changed');
   return {choices:rows.filter(row=>row.status==='draft').map(row=>({store_key:row.store_key,record_id:row.record_id,expected_revision:row.revision,expected_content_digest:row.content_digest,
    label:typeof row.summary?.title==='string'?row.summary.title:typeof row.summary?.address==='string'?row.summary.address:'Saved content'})),next_cursor:result.next_cursor??null};},
  prepareChange:async(node,record,control,source,requestId,signal,invocationMode,parameters)=>{const {target,destination,source:sourceStore}=await changeTarget(node,control,signal);
   if(invocationMode==='initial'&&(!node.initial_change||node.initial_change.operation_key!==control.operation_key||node.initial_change.source_store_key!==control.source_store_key||record.revision!==1||record.content_revision!==1))throw Error('Initial change nomination changed');
   if((control.parameters==='runtime_prompt')!==(parameters!==undefined))throw Error('Parameter prompt nomination changed');
   const input=changeInput(node,record,control,source,invocationMode,parameters),reply=await request(node.store_key,'record_prepare_change',input,signal,requestId),prepared=AppPreparedRecordChangeSchema.parse(reply.prepared_change);
   const {prepared_digest,...snapshot}=prepared,{source:sourceRef,operation_key,invocation_mode,parameters:enteredParameters,...destinationRef}=input;
   if(prepared.prepared_digest!==await sha(new TextEncoder().encode(canonicalAppDataJson(snapshot)))||prepared.account_ref!==target.account.account_ref
    ||prepared.schema_version!==(enteredParameters===undefined?'deft.app_prepared_record_change.v1':'deft.app_prepared_record_change.v2')||prepared.schema_version==='deft.app_prepared_record_change.v2'&&canonicalAppDataJson(prepared.parameters)!==canonicalAppDataJson(enteredParameters)||prepared.invocation_mode!==invocation_mode||prepared.operation_key!==operation_key||canonicalAppDataJson(prepared.source)!==canonicalAppDataJson(sourceRef)||canonicalAppDataJson(prepared.destination)!==canonicalAppDataJson(destinationRef)
    ||Date.parse(prepared.expires_at)<=Date.now()||Date.parse(prepared.expires_at)>Math.min(Date.now()+300000,appConsentDeadline(destination.consent!.expires_at,destination.consent!.consent_lifetime),appConsentDeadline(sourceStore.consent!.expires_at,sourceStore.consent!.consent_lifetime))
    ||new TextEncoder().encode(canonicalAppDataJson(prepared.value)).length>node.profile.max_record_bytes)throw Error('Saved-content preview changed');
   validateRecordFormValue(prepared.value,node.profile);check(signal);return prepared;},
  applyChange:async(node,record,prepared,requestId,signal)=>{const control={operation_key:prepared.operation_key,source_store_key:prepared.source.store_key},{target}=await changeTarget(node,control,signal);
   if(prepared.schema_version==='deft.app_prepared_record_change.v2'&&!node.record_changes?.some(item=>item.operation_key===prepared.operation_key&&item.source_store_key===prepared.source.store_key&&item.parameters==='runtime_prompt'))throw Error('Parameter control unavailable');
   if(target.account.account_ref!==prepared.account_ref||Date.parse(prepared.expires_at)<=Date.now()||prepared.invocation_mode==='initial'&&(!node.initial_change||node.initial_change.operation_key!==prepared.operation_key||node.initial_change.source_store_key!==prepared.source.store_key||record.revision!==1||record.content_revision!==1))throw Error('Preview access ended');
   const input=AppRecordApplyChangeInputSchema.parse({...changeInput(node,record,control,prepared.source,prepared.invocation_mode,prepared.schema_version==='deft.app_prepared_record_change.v2'?prepared.parameters:undefined),prepared_id:prepared.prepared_id,prepared_digest:prepared.prepared_digest});
   const result=await request(node.store_key,'record_apply_change',input,signal,requestId,undefined,true);
   if(result.outcome!=='completed'){if(Object.keys(result).some(key=>!['schema_version','request_id','operation','input_digest','outcome'].includes(key)))throw Error('Saved change result changed');throw new RecordChangeNotApplied();}
   return verifyRecordChangeReceipt(record,row(result,node.record_id),prepared);},
  changeStatus:async(node,record,prepared,requestId,signal)=>{const control={operation_key:prepared.operation_key,source_store_key:prepared.source.store_key},target=await select(node.store_key,signal),store=target.stores.find(item=>item.declaration.key===node.store_key);
   if(!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now())throw Error('Saved-draft access ended');
   if(target.account.account_ref!==prepared.account_ref)throw Error('Saved-content account changed');
   const input=AppRecordApplyChangeInputSchema.parse({...changeInput(node,record,control,prepared.source,prepared.invocation_mode,prepared.schema_version==='deft.app_prepared_record_change.v2'?prepared.parameters:undefined),prepared_id:prepared.prepared_id,prepared_digest:prepared.prepared_digest});
   const reply=await request(node.store_key,'request_status',{store_key:node.store_key,request_id:requestId},signal),status=reply.request_status;
   if(!status||status.state!=='completed')return null;if(status.request_id!==requestId||status.operation!=='record_apply_change'||status.input_digest!==await appDataInputDigest('record_apply_change',input)
    ||status.record_id!==node.record_id||status.revision!==record.revision+1)throw Error('Saved change status changed');
   const next=row(await request(node.store_key,'record_read',locator(node),signal),node.record_id);if(next.revision!==status.revision||next.content_digest!==status.content_digest)throw Error('Saved change record changed');return verifyRecordChangeReceipt(record,next,prepared);},
 };
 const recordTarget=async(node:ExperienceRecordFormReference,signal:AbortSignal)=>{
  const target=await select(node.store_key,signal),store=target.stores.find(store=>store.declaration.key===node.store_key);
  if(!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now()||node.profile.max_record_bytes>store.declaration.max_record_bytes
   ||(node.profile.schema_version!=='deft.record_form_profile.v2'&&node.profile.files&&(node.profile.files.max_files>store.declaration.max_files||node.profile.files!.max_file_bytes>store.declaration.max_file_bytes
   ||node.profile.files.max_total_bytes>store.declaration.max_total_file_bytes))||node.profile.schema_version==='deft.record_form_profile.v2'&&store.declaration.max_files!==0||node.profile.schema_version==='deft.record_form_profile.v3'&&!node.profile.files&&store.declaration.max_files!==0)throw Error('Draft profile is not admitted');
  if(node.profile.schema_version!=='deft.record_form_profile.v2'&&'record_changes' in node&&node.record_changes?.some(change=>!store.declaration.record_changes?.some(declared=>declared.key===change.operation_key&&declared.source_store_key===change.source_store_key)||!target.stores.some(item=>item.declaration.key===change.source_store_key)))throw Error('Saved-content control not admitted');
  return target;
 };
 const checkedRecord=(node:ExperienceRecordFormReference,result:AppDataResult)=>{const record=row(result,node.record_id);if(node.profile.schema_version!=='deft.record_form_profile.v2')recordCopySource(node as ExperienceRecordFormNode,record);
  if(node.profile.schema_version==='deft.record_form_profile.v2'&&(record.files?.length||record.source_refs?.length))throw Error('Settings file/source custody unavailable');return record;};
 const seedRows=new Map<string,{record:ExperienceRecordRow;accountId:string;resourceTargetKey:string}>(),seedLocators=new Map<string,ReturnType<typeof createRecordSeedLocator>>();
 const ports:ExperienceRecordFormPorts={
  ...changePorts,
  ...(options.principal?{openSeed:async(node:ExperienceRecordFormNode,signal:AbortSignal)=>{
   const value=recordSeedSnapshotValue(node);if(!value||!node.seed)throw Error('Seed snapshot nomination changed');
   const started=Date.now(),target=await recordTarget(node,signal),pinnedStore=target.stores.find(item=>item.declaration.key===node.store_key);
   const scope={...options.principal!,installationId:options.installationId,accountId:target.account.account_ref,stateKey:node.store_key,resourceTargetKey:target.target_key,formId:node.id+':'+await sha(new TextEncoder().encode(canonicalAppDataJson(node.seed.value)))};
   let expiry=Math.min(started+30000,appConsentDeadline(pinnedStore!.consent!.expires_at,pinnedStore!.consent!.consent_lifetime));
   const checkPins=()=>{check(signal);const expected=options.accountRef?.();if(expected!==undefined&&expected!==scope.accountId||expiry<=Date.now())throw Error('Seed visibility ended');};
   let snapshot:AppDataResult|undefined,openingProofActive=true;
   // The initial select is the current pre-storage account/store/consent proof.
   // The compound read after reservation repeats full current Host + Runtime
   // authority and proves existence/source without separate discarded probes.
   const seedLocator=createRecordSeedLocator({scope,authorize:async(recordId,phase)=>{if(phase==='confirm'){if(openingProofActive&&snapshot){checkPins();return;}
    const current=await select(node.store_key,signal),store=current.stores.find(item=>item.declaration.key===node.store_key);check(signal);
    if(current.account.account_ref!==scope.accountId||current.session_id!==target.session_id||current.target_key!==target.target_key||current.resource_key!==target.resource_key||!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now()||canonicalAppDataJson(store)!==canonicalAppDataJson(pinnedStore))throw Error('Seed visibility ended');return;
   }checkPins();if(recordId!==undefined){snapshot=await request(node.store_key,'connection_metadata',{store_key:node.store_key,seed:{operation_key:'record_seed_snapshot',destination_store_key:node.store_key,value:{schema_version:'deft.record_seed_snapshot_request.v1',record_id:recordId,expected:{account_ref:scope.accountId,target_key:target.target_key,data_policy_digest:await sha(new TextEncoder().encode(canonicalAppDataJson(pinnedStore!.declaration))),consent_id:pinnedStore!.consent!.consent_id,consent_digest:pinnedStore!.consent!.consent_digest},value}}},signal,undefined,undefined,false,target);checkPins();}}});
   const record_id=await seedLocator.reserve(node.record_id),resolved={...node,record_id};checkPins();if(!snapshot)throw Error('Seed snapshot unavailable');
   const opened=recordSeedSnapshotResult(snapshot,resolved,scope.accountId);expiry=Math.min(expiry,opened.expiresAt);checkPins();let record:ExperienceRecordRow;
   if(opened.record){record=checkedRecord(resolved,{...snapshot,record:opened.record});await seedLocator.confirmed(record_id);seedRows.delete(record_id);}
   else{let initial=opened.value!,initialNotice='';
    if(resolved.initial_change){let appliedDefault=false;
     // The initial fresh target contains both declarations and consents. This
     // immediate source read retains its own Host and Runtime authority checks;
     // the destination is checked again before any opened bytes are disclosed.
     try{checkedChangeTarget(resolved,resolved.initial_change,target);checkPins();
      const defaults=await request(resolved.initial_change.source_store_key,'connection_metadata',{store_key:resolved.initial_change.source_store_key,seed:{operation_key:resolved.initial_change.operation_key,destination_store_key:resolved.store_key,value:initial}},signal,undefined,undefined,false,target,true);
      checkPins();checkedChangeTarget(resolved,resolved.initial_change,target);if(defaults.record_seed_value){initial=defaults.record_seed_value;appliedDefault=true;}
     }catch(error){checkPins();if(error instanceof OptionalDefaultDenied)throw error;initialNotice=recordFormLabels(resolved.profile).initial_change_unavailable;}
     // A source metadata request proves its own store only. Recheck the exact
     // destination after waiting, even when an optional default was unavailable.
     const current=await recordTarget(resolved,signal),store=current.stores.find(item=>item.declaration.key===resolved.store_key);checkPins();
     if(current.account.account_ref!==scope.accountId||current.session_id!==target.session_id||current.target_key!==target.target_key||current.resource_key!==target.resource_key||canonicalAppDataJson(store)!==canonicalAppDataJson(pinnedStore))throw Error('Seed visibility ended');
     if(appliedDefault&&canonicalAppDataJson(checkedChangeTarget(resolved,resolved.initial_change,current).source)!==canonicalAppDataJson(checkedChangeTarget(resolved,resolved.initial_change,target).source))throw Error('Seed source changed');
    }
    validateRecordFormValue(initial,resolved.profile);if(recordFormFiles(initial,resolved.profile).length)throw Error('Seed files must be empty');
    for(const field of recordFormFields(resolved.profile)){if(field.kind!=='verified_identity')continue;const identity=recordFormIdentity(initial,field);if(identity&&!snapshot.identities?.some(item=>item.address===identity))throw Error('Seed identity changed');}
    record={record_id,revision:0,content_digest:await sha(new TextEncoder().encode(canonicalAppDataJson(initial))),status:'draft',value:initial,files:[],summary:{initial_value_notice:initialNotice}};
    seedRows.set(record_id,{record:structuredClone(record),accountId:scope.accountId,resourceTargetKey:scope.resourceTargetKey});seedLocators.set(record_id,seedLocator);
   }
   checkPins();openingProofActive=false;const recoveryScope={...options.principal!,installationId:options.installationId,accountId:scope.accountId,stateKey:node.store_key,recordId:record_id,resourceTargetKey:scope.resourceTargetKey};
   return {node:resolved,record,identities:snapshot.identities??[],primaryIdentity:snapshot.primary_identity??null,openingRecovery:{scope:recoveryScope,row:structuredClone(record),expiresAt:Math.min(expiry,opened.expiresAt)}};
  },resolveSeed:async(node:ExperienceRecordFormNode,signal:AbortSignal)=>{if(!node.seed)return node;const target=await select(node.store_key,signal),scope={...options.principal!,installationId:options.installationId,accountId:target.account.account_ref,stateKey:node.store_key,resourceTargetKey:target.target_key,formId:node.id+(Object.hasOwn(node.seed.value,'record_seed')?':'+await sha(new TextEncoder().encode(canonicalAppDataJson(node.seed.value))):'')};const pinnedStore=target.stores.find(item=>item.declaration.key===node.store_key);const locator=createRecordSeedLocator({scope,authorize:async()=>{
   if(!pinnedStore?.consent||appConsentDeadline(pinnedStore.consent.expires_at,pinnedStore.consent.consent_lifetime)<=Date.now())throw Error('Seed visibility ended');
   // Both reads independently authorize the pinned account. The fresh target
   // must still match every original pin before browser storage can be used.
   const [current]=await Promise.all([select(node.store_key,signal),request(node.store_key,'connection_metadata',{store_key:node.store_key},signal,undefined,undefined,false,target)]);check(signal);
   const store=current.stores.find(item=>item.declaration.key===node.store_key);
   if(current.account.account_ref!==scope.accountId||current.session_id!==target.session_id||current.target_key!==target.target_key||current.resource_key!==target.resource_key||!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now()||canonicalAppDataJson(store)!==canonicalAppDataJson(pinnedStore))throw Error('Seed visibility ended');
  }});const record_id=await locator.reserve(node.record_id);seedLocators.set(record_id,locator);return {...node,record_id};},recoveryScope:async(node:ExperienceRecordFormNode,signal:AbortSignal)=>{const target=await select(node.store_key,signal),store=target.stores.find(v=>v.declaration.key===node.store_key);if(!store?.consent||appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)<=Date.now())throw Error('Recovery visibility ended');if(!node.seed||!seedRows.has(node.record_id))await request(node.store_key,'record_read',locator(node),signal);check(signal);return {...options.principal!,installationId:options.installationId,accountId:target.account.account_ref,stateKey:node.store_key,recordId:node.record_id,resourceTargetKey:target.target_key};},
   recoverySnapshot:async(node:ExperienceRecordFormNode,signal:AbortSignal)=>{const target=await recordTarget(node,signal),accountId=target.account.account_ref,resourceTargetKey=target.target_key;
    // One fresh authority path and exact record read; seed defaults and identities are not recovery evidence.
    const result=await request(node.store_key,'record_read',locator(node),signal,crypto.randomUUID(),undefined,!!node.seed,target);check(signal);
    const expected=options.accountRef?.(),consent=target.stores.find(store=>store.declaration.key===node.store_key)?.consent;if(expected!==undefined&&expected!==accountId||!consent||appConsentDeadline(consent.expires_at,consent.consent_lifetime)<=Date.now())throw Error('Recovery account changed');
    let record:ExperienceRecordRow;
    if(result.outcome==='completed'){record=checkedRecord(node,result);seedRows.delete(node.record_id);}
    else{const known=seedRows.get(node.record_id);if(result.outcome!=='not_found'||!node.seed||!known||known.accountId!==accountId||known.resourceTargetKey!==resourceTargetKey||known.record.revision!==0||known.record.status!=='draft')throw Error('Recovery record unavailable');record=structuredClone(known.record);}
    return {scope:{...options.principal!,installationId:options.installationId,accountId,stateKey:node.store_key,recordId:node.record_id,resourceTargetKey},record};},
   submissionStatus:async(node:ExperienceRecordFormNode,attempt:import('./app-experience-record-browser-recovery').RecordSubmissionAttempt,scope:import('./app-experience-draft-recovery').RecordRecoveryScope,signal:AbortSignal)=>{const target=await select(node.store_key,signal);if(target.account.account_ref!==scope.accountId||attempt.key!==node.record_id||attempt.actionKey!==node.action_key)throw Error('Submission account changed');await request(node.store_key,'record_read',locator(node),signal);const reply=await options.fetch(`/api/app-experiences/sessions/${encodeURIComponent(attempt.sessionId)}/human-actions/${encodeURIComponent(attempt.actionKey)}/submissions/${encodeURIComponent(attempt.submissionId)}`,{signal,cache:'no-store'});const bytes=await boundedBytes(reply,65536,signal);try{const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)),run=value.run??value;check(signal);return typeof run.id==='string'&&typeof run.state==='string';}finally{bytes.fill(0);}}
  }:{}),
  initialSource:async(node,record,signal)=>{
   const control=node.initial_change;if(!control||record.status!=='draft'||record.revision!==1||record.content_revision!==1) return null;
   await changeTarget(node,control,signal);const metadata=await request(node.store_key,'connection_metadata',{store_key:node.store_key},signal);
   const mapped=recordFormFields(node.profile).find(field=>field.kind==='verified_identity');
   const address=mapped?.kind==='verified_identity'?recordFormIdentity(record.value,mapped):metadata.primary_identity?.address;
   if(!address||!metadata.identities?.some(item=>item.address===address))return null;
   let cursor:string|null=null,pages=0;const matches:import('./app-experience-record-changes').RecordChangeChoice[]=[];
   do{if(++pages>2)throw Error('Saved default catalog exceeds its limit');const result=await request(control.source_store_key,'record_list',{store_key:control.source_store_key,cursor,limit:25},signal);
    for(const raw of result.items??[]){const row=AppDataRecordMetaSchema.parse(raw);if(row.store_key!==control.source_store_key)throw Error('Saved default store changed');if(row.status==='draft'&&row.summary?.[control.source_identity_field]===address)matches.push({store_key:row.store_key,record_id:row.record_id,expected_revision:row.revision,expected_content_digest:row.content_digest,label:address});}
    if(result.next_cursor&&result.next_cursor===cursor)throw Error('Saved default cursor changed');cursor=result.next_cursor??null;
   }while(cursor);check(signal);return matches.length===1?matches[0]:null;
  },
  load:async(node,signal)=>{const target=await recordTarget(node,signal);
   if(node.profile.schema_version!=='deft.record_form_profile.v2'&&'seed' in node&&node.seed){const seedNode=node as ExperienceRecordFormNode;
    // Existence, current identities and optional defaults are independent
    // read-only preflights. Run them together; each retains its own authority
    // checks and nothing is disclosed until all current checks have settled.
    const hydrate=Object.hasOwn(seedNode.seed!.value,'record_seed');
    const defaultValue=async()=>{if(!seedNode.initial_change)return {value:undefined,notice:''};try{
     const pin=(current:Awaited<ReturnType<typeof select>>)=>{if(current.session_id!==target.session_id||current.target_key!==target.target_key||current.account.account_ref!==target.account.account_ref)throw Error('Seed default account changed');};
     pin((await changeTarget(seedNode,seedNode.initial_change,signal)).target);
     const source=await request(seedNode.initial_change.source_store_key,'connection_metadata',{store_key:seedNode.initial_change.source_store_key,seed:{operation_key:seedNode.initial_change.operation_key,destination_store_key:seedNode.store_key,value:seedNode.seed!.value}},signal);
     pin((await changeTarget(seedNode,seedNode.initial_change,signal)).target);return {value:source.record_seed_value,notice:''};
    }catch{return {value:undefined,notice:recordFormLabels(seedNode.profile).initial_change_unavailable};}};
    const [existing,identity,defaults]=await Promise.allSettled([
     request(seedNode.store_key,'record_read',locator(node),signal,crypto.randomUUID(),undefined,true,target),
     request(seedNode.store_key,'connection_metadata',{store_key:seedNode.store_key,...(hydrate?{seed:{operation_key:'record_seed',destination_store_key:seedNode.store_key,value:seedNode.seed!.value}}:{})},signal),
     defaultValue(),
    ]);check(signal);if(existing.status==='rejected')throw existing.reason;const read=existing.value;
    if(read.outcome==='completed'){const record=row(read,seedNode.record_id);await seedLocators.get(seedNode.record_id)?.confirmed(seedNode.record_id);seedLocators.delete(seedNode.record_id);seedRows.delete(seedNode.record_id);return {record,identities:read.identities??[],primaryIdentity:read.primary_identity??null};}
    if(read.outcome!=='not_found')throw Error('Seed record unavailable');if(identity.status==='rejected')throw identity.reason;const metadata=identity.value;
    if(hydrate&&!metadata.record_seed_value)throw Error('Source seed unavailable');if(defaults.status==='rejected')throw defaults.reason;
    const initial=defaults.value.value??metadata.record_seed_value??seedNode.seed!.value,initialNotice=defaults.value.notice;
    validateRecordFormValue(initial,seedNode.profile);if(recordFormFiles(initial,seedNode.profile).length)throw Error('Seed files must be empty');for(const field of recordFormFields(seedNode.profile)){if(field.kind!=='verified_identity')continue;const identity=recordFormIdentity(initial,field);if(identity&&!metadata.identities?.some(item=>item.address===identity))throw Error('Seed identity changed');}
    const record:ExperienceRecordRow={record_id:seedNode.record_id,revision:0,content_digest:await sha(new TextEncoder().encode(canonicalAppDataJson(initial))),status:'draft',value:initial,files:[],summary:{initial_value_notice:initialNotice}};seedRows.set(seedNode.record_id,{record:structuredClone(record),accountId:target.account.account_ref,resourceTargetKey:target.target_key});return {record,identities:metadata.identities??[],primaryIdentity:metadata.primary_identity??null};
   }
   const result=await request(node.store_key,'record_read',locator(node),signal,undefined,undefined,false,target),record=checkedRecord(node,result);
   return {record,identities:result.identities??[],primaryIdentity:result.primary_identity??null};},
  save:async(node,revision,value,requestId,digest,signal)=>{const creating='seed' in node&&!!node.seed&&revision===0;if(revision===0&&!creating)throw Error('Unsaved seed required');const next=row(await request(node.store_key,creating?'record_create':'record_save',creating?{...locator(node),value}:{...locator(node),expected_revision:revision,expected_content_digest:digest,value},signal,requestId),node.record_id);if(creating){if(next.revision!==1)throw Error('Created record changed');await seedLocators.get(node.record_id)?.confirmed(node.record_id);}seedRows.delete(node.record_id);return next;},
  saveStatus:async(node,revision,value,requestId,digest,signal)=>{const creating='seed' in node&&!!node.seed&&revision===0,operation=creating?'record_create':'record_save',input=creating?{...locator(node),value}:{...locator(node),expected_revision:revision,expected_content_digest:digest,value},reply=await request(node.store_key,'request_status',{store_key:node.store_key,request_id:requestId},signal),status=reply.request_status;
   if(!status||status.state!=='completed')return null;if(status.request_id!==requestId||status.operation!==operation||status.input_digest!==await appDataInputDigest(operation,input)||status.record_id!==node.record_id||status.revision!==revision+1)throw Error('Saved status changed');
   const next=row(await request(node.store_key,'record_read',locator(node),signal),node.record_id);if(next.revision!==status.revision||next.content_digest!==status.content_digest)throw Error('Saved record changed');if(creating)await seedLocators.get(node.record_id)?.confirmed(node.record_id);return next;},
  upload:async(node,record,file,bytes,signal)=>row(await request(node.store_key,'file_upload',{...locator(node),expected_revision:record.revision,expected_content_digest:record.content_digest,
   ...file,sha256:'sha256:'+file.sha256},signal,crypto.randomUUID(),bytes),node.record_id),
  detach:async(node,record,file,signal)=>row(await request(node.store_key,'file_detach',{...fileLocator(node,record,file),expected_revision:record.revision,expected_content_digest:record.content_digest},signal),node.record_id),
  readFile:async(node,record,file,signal)=>{const result=await binary(node.store_key,'file_read',fileLocator(node,record,file),signal);
   if(result.media_type!==file.media_type||result.bytes.length!==file.size_bytes){result.bytes.fill(0);throw Error('File metadata changed');}return result.bytes;},
  listOriginals:async(node,record,signal)=>{const source=recordCopySource(node,record);if(!source||record.status!=='draft')throw Error('Original source unavailable');
   const target=await select(node.store_key,signal),store=target.stores.find(item=>item.declaration.key===node.store_key)?.declaration;
   if(target.resource_key!==source.resource_key||!store?.resource_content)throw Error('Original source not admitted');
   const reply=await request(node.store_key,'resource_list_files',{store_key:node.store_key,...source},signal),files=(reply.files??[]).map(file=>AppDataSourceFileSchema.parse(file));
   if(files.length>32||new Set(files.map(file=>file.file_ref)).size!==files.length||files.some(file=>file.size_bytes>store.resource_content!.max_source_bytes))throw Error('Original file catalog changed');return files;},
  copyOriginal:async(node,record,source,file,fileId,requestId,signal)=>{
   if(file.disposition!=='attachment'||file.size_bytes>node.profile.files!.max_file_bytes)throw Error('Original file cannot be copied');
   const input=copyInput(node,record,source,file,fileId),next=row(await request(node.store_key,'file_copy',input,signal,requestId),node.record_id);
   return verifyFileCopy(node,record,next,source,file,fileId);},
  copyStatus:async(node,record,source,file,fileId,requestId,signal)=>{const input=copyInput(node,record,source,file,fileId),reply=await request(node.store_key,'request_status',{store_key:node.store_key,request_id:requestId},signal),status=reply.request_status;
   if(!status||status.state!=='completed')return null;
   if(status.request_id!==requestId||status.operation!=='file_copy'||status.input_digest!==await appDataInputDigest('file_copy',input)||status.record_id!==node.record_id||status.revision!==record.revision+1)throw Error('Copy status changed');
   const next=row(await request(node.store_key,'record_read',locator(node),signal),node.record_id);if(next.revision!==status.revision||next.content_digest!==status.content_digest)throw Error('Copied draft changed');return verifyFileCopy(node,record,next,source,file,fileId);},
  ...(options.review?{review:options.review}:{}),
 };
 const documentInput=(node:DeftExperienceRecordDocumentNode)=>({store_key:node.store_key,resource_key:node.resource_key,record_id:node.record_id,content_digest:node.content_digest});
 return {context,select,request,binary,ports,
  async automaticImages(node:DeftExperienceRecordDocumentNode,signal:AbortSignal){
   const policy=node.image_policy;if(!policy)return undefined;const documentTarget=await select(node.store_key,signal),target=await select(policy.store_key,signal);
   const source=target.stores.find(item=>item.declaration.key===policy.store_key),destination=documentTarget.stores.find(item=>item.declaration.key===node.store_key);
   if(target.session_id!==documentTarget.session_id||target.account.account_ref!==documentTarget.account.account_ref||target.resource_key!==node.resource_key
    ||!source?.consent||appConsentDeadline(source.consent.expires_at,source.consent.consent_lifetime)<=Date.now()||source.declaration.resource_key!==destination?.declaration.resource_key||source.declaration.runtime_requirement_key!==destination.declaration.runtime_requirement_key)return false;
   const result=await request(policy.store_key,'record_read',{store_key:policy.store_key,record_id:policy.record_id},signal,undefined,undefined,false,target),record=result.record,proof=result.human_save,policyMetadata=result.document_policy;
   if(!policyMetadata||policyMetadata.field!==policy.field||policyMetadata.automatic_value!==policy.automatic_value||!record||record.status!=='draft'||record.revision!==policy.expected_revision||record.content_digest!==policy.content_digest||record.content_revision<2||record.files.length||record.source_refs?.length||!proof
    ||proof.store_key!==record.store_key||proof.record_id!==record.record_id||proof.revision!==record.revision||proof.content_digest!==record.content_digest
    ||await sha(new TextEncoder().encode(canonicalAppDataJson(record.value)))!==record.content_digest||record.value[policy.field]!==policy.automatic_value)return false;check(signal);return true;
  },
  async presentation(node:DeftExperienceRecordDocumentNode,signal:AbortSignal){return request(node.store_key,'resource_read_presentation',documentInput(node),signal);},
  async sourceBinary(node:DeftExperienceRecordDocumentNode,input:{operation:'read_image'|'read_source';image_ref?:string},signal:AbortSignal){
   return binary(node.store_key,input.operation==='read_source'?'resource_read_source':'resource_read_image',{
    ...documentInput(node),...(input.operation==='read_image'?{image_ref:input.image_ref,external_images:'allowed'}:{})},signal);
  },
 };
}
