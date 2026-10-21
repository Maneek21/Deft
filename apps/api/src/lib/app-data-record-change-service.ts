import {AppDataRequestSchema,AppDataResultSchema,AppRecordChangeRuntimeRequestSchema,AppRecordChangeAuthorityRequestSchema,AppRecordPrepareChangeInputSchema,AppRecordApplyChangeInputSchema,canonicalAppDataJson,
 type AppDataRequest,type AppRecordChangeRuntimeRequest,type AppRecordChangeAuthorityRequest} from '@deft/app-kit/core';
import {AppError} from './app-errors.js';
import type {CurrentAppDataAuthority} from './app-data-authority.js';
import {recordChangeAuthorities,sameRecordChangeAuthority,verifyPreparedRecordChange,recordChangeDigest} from './app-data-record-change-guards.js';
const invalid=()=>new AppError('Invalid App data request','APP_ACTION_INVALID',400);
/** New envelope is confined to two operations. No full values enter the journal. */
export async function invokeRecordChange(raw:AppDataRequest,signal:AbortSignal|undefined,ports:{
 current:(store:string)=>Promise<CurrentAppDataAuthority>;
 begin:(request:AppRecordChangeRuntimeRequest,context:AppRecordChangeAuthorityRequest,digest:string)=>Promise<boolean>;
 finish:(requestId:string,state:'completed'|'indeterminate',metadata:Record<string,unknown>|null)=>Promise<boolean>;
 dispatch:(authority:CurrentAppDataAuthority,request:AppRecordChangeRuntimeRequest,signal:AbortSignal)=>Promise<{result?:unknown;metadata?:unknown;bytes?:Uint8Array}>;
}){
 const publicRequest=AppDataRequestSchema.parse(raw);
 if(publicRequest.operation!=='record_prepare_change'&&publicRequest.operation!=='record_apply_change')throw invalid();
 const input=publicRequest.operation==='record_prepare_change'?AppRecordPrepareChangeInputSchema.parse(publicRequest.input):AppRecordApplyChangeInputSchema.parse(publicRequest.input);
 signal?.throwIfAborted();const destination=await ports.current(input.store_key),source=await ports.current(input.source.store_key);
 const proofs=recordChangeAuthorities(destination,source,input),digest=recordChangeDigest({operation:publicRequest.operation,input});
 const deadline=Math.min(destination.expires_at,source.expires_at,Date.now()+30000);
 const request=AppRecordChangeRuntimeRequestSchema.parse({schema_version:'deft.app_data_runtime.v2',request_id:publicRequest.request_id,
 scope:destination.scope,connection:destination.connection,record_authorities:proofs,operation:publicRequest.operation,input,expires_at:new Date(deadline).toISOString()});
 const {input:unused,...envelope}=request;void unused;
 const context=AppRecordChangeAuthorityRequestSchema.parse({...envelope,schema_version:'deft.app_data_authority.v2',input_digest:digest});
 if(!await ports.begin(request,context,digest))throw new AppError('App data request already exists; reconcile its status','APP_STATE_CONFLICT',409);
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
 const check=async()=>{controller.signal.throwIfAborted();sameRecordChangeAuthority(destination,await ports.current(input.store_key));
  sameRecordChangeAuthority(source,await ports.current(input.source.store_key));controller.signal.throwIfAborted();};
 try{
  await check();const reply=await ports.dispatch(destination,request,controller.signal);await check();
  if(reply.metadata||reply.bytes)throw invalid();const result=AppDataResultSchema.parse(reply.result);
  if(result.request_id!==request.request_id||result.operation!==request.operation||result.input_digest!==digest)throw invalid();
  if(result.outcome==='conflict'||result.outcome==='not_found'){
   if(Object.keys(result).some(key=>!['schema_version','request_id','operation','input_digest','outcome'].includes(key)))throw invalid();
   if(!await ports.finish(request.request_id,'completed',{request_id:request.request_id,operation:request.operation,input_digest:digest,outcome:result.outcome}))throw invalid();
   await check();return {result,metadata:undefined,bytes:undefined,authority:destination};
  }
  if(result.outcome!=='completed')throw invalid();
  const resultKeys=['schema_version','request_id','operation','input_digest','outcome',request.operation==='record_prepare_change'?'prepared_change':'record'];
  if(Object.keys(result).some(key=>!resultKeys.includes(key)))throw invalid();
  let metadata:Record<string,unknown>={request_id:request.request_id,operation:request.operation,input_digest:digest,outcome:result.outcome};
  if(request.operation==='record_prepare_change'){
   if(!result.prepared_change||result.record)throw invalid();const prepared=verifyPreparedRecordChange(result.prepared_change,destination,source,input);
   metadata.prepared_change={...(prepared.invocation_mode?{invocation_mode:prepared.invocation_mode}:{}),prepared_id:prepared.prepared_id,prepared_digest:prepared.prepared_digest,operation_key:prepared.operation_key,
    destination:prepared.destination,source:prepared.source,authorization_digest:prepared.authorization_digest,expires_at:prepared.expires_at};
  }else{
   const record=result.record;if(!record||result.prepared_change||record.status!=='draft'||record.store_key!==input.store_key||record.record_id!==input.record_id
    ||record.revision!==input.expected_revision+1||Buffer.byteLength(canonicalAppDataJson(record.value))>destination.store.max_record_bytes
    ||record.files.length>destination.store.max_files||record.files.some(file=>file.size_bytes>destination.store.max_file_bytes)
    ||record.files.reduce((sum,file)=>sum+file.size_bytes,0)>destination.store.max_total_file_bytes
    ||record.source_refs?.some(ref=>ref.resource_key!==destination.scope.resource_key))throw invalid();
   metadata={...metadata,record_id:record.record_id,revision:record.revision,content_digest:record.content_digest};
  }
  if(!await ports.finish(request.request_id,'completed',metadata))throw invalid();await check();return {result,metadata:undefined,bytes:undefined,authority:destination};
 }catch(error){await ports.finish(request.request_id,'indeterminate',null);throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
