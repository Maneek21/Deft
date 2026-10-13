import {assertFutureRecordActionLocalRequest,acknowledgeFutureRecordActionLocal} from './app-future-record-action-local.js';
import {futureRecordActionWindowDeadline,assertPreparedFutureRecordAction} from './app-future-record-action-window.js';
import {invokeRecordChange} from './app-data-record-change-service.js';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and,eq} from 'drizzle-orm';
import {AppDataRequestSchema,AppDataOperationInputSchema,AppDataRuntimeRequestSchema,AppDataRuntimeAuthorityRequestSchema,
 AppDataConsentSnapshotSchema,AppDataConsentReviewRequestSchema,AppDataConsentActivateRequestSchema,AppDataContextSchema,AppDataResolveInputSchema,
 APP_DATA_LIMITS,type AppDataResult,type AppDataRequest} from '@deft/app-kit';
import {currentConnectionSessionLocators} from './app-connection-current-locators.js';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {PostgresAppDataStore} from './app-data-store.js';
import {appDataDenied,appDataDigest,appDataRequiresConsent,currentAppDataAuthority,type CurrentAppDataAuthority} from './app-data-authority.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import {withAppDataBinaryIo} from './app-data-io-limits.js';
import {appDataSourceWithinStore,appDataRecordSourcesWithinStore} from './app-data-file-copy-guards.js';
import {appDataConsentExpiry} from './app-data-consent-lifetime.js';
import {appDataConnectionActionSelection} from './app-data-read-authority.js';
const invalid=()=>new AppError('Invalid App data request','APP_ACTION_INVALID',400);
const conflict=()=>new AppError('App data request already exists; reconcile its status','APP_STATE_CONFLICT',409);
export class AppDataService {
 constructor(readonly caller:ExperienceCaller,readonly guard:WebAuthorityGuard){}
 async current(session:string,store:string,requiresConsent:boolean|'optional'=true,operation?:string,expectedConsentId?:string){return currentAppDataAuthority(this.caller,session,store,this.guard,requiresConsent,expectedConsentId,appDataConnectionActionSelection(operation));}
 async review(sessionId:string,raw:unknown){const input=AppDataConsentReviewRequestSchema.parse(raw),authority=await this.current(sessionId,input.store_key,false);
  const expiry=appDataConsentExpiry(input.expires_at,authority.scope.consent_expires_at,authority.consent_max_seconds);
  const snapshot=AppDataConsentSnapshotSchema.parse({schema_version:'deft.app_data_consent.v1',consent_id:randomUUID(),scope:authority.scope,
   connection:authority.connection,store:authority.store,data_policy_digest:authority.data_policy_digest,purpose:'human_record_write',expires_at:new Date(expiry).toISOString()});
  const digest=appDataDigest(snapshot),now=new Date();await new PostgresAppDataStore(this.caller).propose({org_id:this.caller.org_id,owner_user_id:this.caller.user_id,
   consent_id:snapshot.consent_id,connection_session_id:sessionId,store_key:input.store_key,state:'proposed',consent_digest:digest,snapshot,expires_at:new Date(expiry),created_at:now,updated_at:now});
  return {snapshot,review_digest:digest};
 }
 async activate(sessionId:string,raw:unknown){const input=AppDataConsentActivateRequestSchema.parse(raw),authority=await this.current(sessionId,input.store_key,false),store=new PostgresAppDataStore(this.caller),row=await store.consent(input.consent_id);
  if(!row||row.connection_session_id!==sessionId||row.store_key!==input.store_key||row.consent_digest!==input.expected_review_digest||row.expires_at.toISOString()!==input.expires_at)throw appDataDenied();
  const snapshot=AppDataConsentSnapshotSchema.parse(row.snapshot);
  if(!isDeepStrictEqual(snapshot.scope,authority.scope)||!isDeepStrictEqual(snapshot.store,authority.store)||snapshot.connection.account_ref!==authority.connection.account_ref
   ||snapshot.connection.runtime_session_ref!==authority.connection.runtime_session_ref||appDataDigest(snapshot)!==row.consent_digest
   ||row.expires_at.getTime()>Date.parse(authority.scope.consent_expires_at)||row.expires_at.getTime()>row.created_at.getTime()+authority.consent_max_seconds*1000)throw appDataDenied();
  if(!await store.activate(input.consent_id,input.expected_review_digest))throw conflict();return {consent_id:row.consent_id,consent_digest:row.consent_digest,expires_at:row.expires_at.toISOString()};
 }
 async revoke(sessionId:string,id:string){const store=new PostgresAppDataStore(this.caller),row=await store.consent(id);if(!row||row.connection_session_id!==sessionId)throw appDataDenied();await store.revoke(id);return {revoked:true};}
 async invoke(sessionId:string,raw:unknown,bytes?:Uint8Array,signal?:AbortSignal){
  const request=AppDataRequestSchema.parse(raw);return withAppDataBinaryIo(this.caller,request.operation,()=>this.invokeOwned(sessionId,request,bytes,signal));
 }
 private async invokeOwned(sessionId:string,raw:unknown,bytes?:Uint8Array,signal?:AbortSignal){
  const input=AppDataRequestSchema.parse(raw),operation=AppDataOperationInputSchema.parse({operation:input.operation,input:input.input}),storeKey=operation.input.store_key;
  if((input.operation==='file_upload')!==(bytes!==undefined))throw invalid();
  if(input.operation==='record_prepare_change'||input.operation==='record_apply_change'){const journal=new PostgresAppDataStore(this.caller);
   return invokeRecordChange(input,signal,{current:store=>this.current(sessionId,store,true,input.operation),
    begin:async(request,context,digest)=>{const now=new Date();return journal.begin({org_id:this.caller.org_id,owner_user_id:this.caller.user_id,request_id:request.request_id,
     connection_session_id:sessionId,operation:request.operation,input_digest:digest,state:'inflight',revision:0,web_session_id:this.caller.sid,
     access_expires_at:new Date(this.caller.access_expires_at!),expires_at:new Date(request.expires_at),context,created_at:now,updated_at:now});},
    finish:(id,state,metadata)=>journal.finish(id,state,metadata),
    dispatch:async(authority,request,signal)=>(await getAppConnectionSessionRegistry()).dataRuntime(authority.scope,authority.profile).request(request,signal)});
  }
  const authority=await this.current(sessionId,storeKey,input.operation==='connection_metadata'?'optional':appDataRequiresConsent(input.operation),input.operation);
  if((input.operation.startsWith('resource_')||['prepare_resource_action','read_prepared_resource_action'].includes(input.operation))
   &&(!authority.store.resource_content||!('resource_key' in operation.input)||operation.input.resource_key!==authority.scope.resource_key))throw appDataDenied();
  if('value' in operation.input&&Buffer.byteLength(JSON.stringify(operation.input.value))>authority.store.max_record_bytes)throw invalid();
  if(!appDataSourceWithinStore(operation,authority.scope.resource_key,authority.store))throw appDataDenied();
  if(operation.operation==='file_upload'&&(bytes!.byteLength!==operation.input.size_bytes||bytes!.byteLength>authority.store.max_file_bytes
   ||`sha256:${createHash('sha256').update(bytes!).digest('hex')}`!==operation.input.sha256))throw invalid();
  const futurePrepare=operation.operation==='prepare_action'&&operation.input.execution_window!==undefined?futureRecordActionWindowDeadline(authority,operation.input.action_key,operation.input.execution_window):null;
  if(futurePrepare&&operation.operation==='prepare_action'&&Date.parse(operation.input.prepare_expires_at??'')!==futurePrepare.deadline)throw invalid();
  if(!futurePrepare&&(operation.operation==='prepare_action'||operation.operation==='prepare_resource_action')&&operation.input.prepare_expires_at!==undefined&&(Date.parse(operation.input.prepare_expires_at)>authority.expires_at
   ||Date.parse(operation.input.prepare_expires_at)>Date.now()+300000||Date.parse(operation.input.prepare_expires_at)<=Date.now()))throw invalid();
  if(['prepared_action_commit','prepared_action_restore'].includes(input.operation))await db.transaction(async tx=>{await this.guard(tx);await assertFutureRecordActionLocalRequest(tx,authority,input.request_id,input.operation,input.input);});
  const digest=appDataDigest({operation:input.operation,input:input.input});
  const deadline=Math.min(authority.expires_at,Date.now()+30000);const request=AppDataRuntimeRequestSchema.parse({schema_version:'deft.app_data_runtime.v1',
   request_id:input.request_id,scope:authority.scope,connection:authority.connection,authority:{consent_id:authority.consent?.consent_id??null,
   consent_digest:authority.consent?.consent_digest??null,data_policy_digest:authority.data_policy_digest},operation:input.operation,input:input.input,expires_at:new Date(deadline).toISOString()});
  const {input:unusedInput,...authorityEnvelope}=request;void unusedInput;
  const context=AppDataRuntimeAuthorityRequestSchema.parse({...authorityEnvelope,schema_version:'deft.app_data_authority.v1',input_digest:digest});
  const store=new PostgresAppDataStore(this.caller),now=new Date();
  if(!await store.begin({org_id:this.caller.org_id,owner_user_id:this.caller.user_id,request_id:input.request_id,connection_session_id:sessionId,
   operation:input.operation,input_digest:digest,state:'inflight',revision:0,web_session_id:this.caller.sid,access_expires_at:new Date(this.caller.access_expires_at!),
   expires_at:new Date(deadline),context,created_at:now,updated_at:now}))throw conflict();
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
  try{
   await this.assertCurrent(authority,sessionId,storeKey,input.operation);controller.signal.throwIfAborted();
   const reply=await (await getAppConnectionSessionRegistry()).dataRuntime(authority.scope,authority.profile).request(request,controller.signal,bytes);
   controller.signal.throwIfAborted();await this.assertCurrent(authority,sessionId,storeKey,input.operation);
   const envelope=reply.result??reply.metadata;if(!envelope||envelope.request_id!==input.request_id||envelope.operation!==input.operation||envelope.input_digest!==digest)throw invalid();
   if(reply.metadata){const meta=reply.metadata,cap=input.operation==='resource_read_source'?authority.store.resource_content!.max_source_bytes:
     input.operation==='resource_read_image'?authority.store.resource_content!.max_image_bytes:input.operation==='resource_read_file'?authority.store.resource_content!.max_file_bytes:authority.store.max_file_bytes;
    if(!reply.bytes||reply.bytes.byteLength!==meta.size_bytes||meta.size_bytes>cap||`sha256:${createHash('sha256').update(reply.bytes).digest('hex')}`!==meta.sha256
      ||!('record_id' in operation.input)||meta.record_id!==operation.input.record_id||operation.operation==='file_read'&&(meta.file_id!==operation.input.file_id||meta.upload_revision!==operation.input.upload_revision||meta.sha256!==operation.input.sha256))throw invalid();
   }
   if(reply.result?.record&&!appDataRecordSourcesWithinStore(reply.result.record,authority.scope.resource_key,authority.store))throw appDataDenied();
   if(reply.result?.items?.some(row=>'store_key' in row&&!appDataRecordSourcesWithinStore(row,authority.scope.resource_key,authority.store)))throw appDataDenied();
   if(reply.result?.record){const row=reply.result.record;if(row.store_key!==storeKey||'record_id' in operation.input&&row.record_id!==operation.input.record_id
    ||Buffer.byteLength(JSON.stringify(row.value))>authority.store.max_record_bytes||row.files.length>authority.store.max_files
    ||row.files.some(file=>file.size_bytes>authority.store.max_file_bytes)||row.files.reduce((sum,file)=>sum+file.size_bytes,0)>authority.store.max_total_file_bytes)throw invalid();}
   const prepared=reply.result?.prepared;
   if(prepared?.future_release)assertPreparedFutureRecordAction(authority,prepared);
   if(prepared&&(!prepared.future_release&&Date.parse(prepared.expires_at)>authority.expires_at||operation.operation==='prepare_action'&&prepared.action_key!==operation.input.action_key
    ||operation.operation==='read_prepared'&&(prepared.snapshot_id!==operation.input.snapshot_id||prepared.snapshot_digest!==operation.input.snapshot_digest)))throw invalid();
   if(prepared?.required_action_consents?.some(required=>!authority.action_consents?.some(active=>isDeepStrictEqual(active,required))||Date.parse(required.expires_at)<=Date.now()))throw invalid();
   const resourcePrepared=reply.result?.prepared_resource;
   if(resourcePrepared&&(Date.parse(resourcePrepared.expires_at)>authority.expires_at||resourcePrepared.account_ref!==authority.connection.account_ref
    ||resourcePrepared.resource_key!==authority.scope.resource_key
    ||operation.operation==='prepare_resource_action'&&(resourcePrepared.action_key!==operation.input.action_key
      ||resourcePrepared.operation_key!==operation.input.operation_key||resourcePrepared.item_count!==operation.input.sources.length+(operation.input.record_sources?.length??0)
      ||resourcePrepared.source_manifest_digest!==appDataDigest(operation.input.sources)
      ||!isDeepStrictEqual(resourcePrepared.preview.items.map(item=>item.record_id),[...operation.input.sources,...(operation.input.record_sources??[])].map(source=>source.record_id)))
    ||operation.operation==='read_prepared_resource_action'&&(resourcePrepared.snapshot_id!==operation.input.snapshot_id
      ||resourcePrepared.snapshot_digest!==operation.input.snapshot_digest)))throw invalid();
   const metadata:Record<string,unknown>={request_id:input.request_id,operation:input.operation,input_digest:digest,outcome:reply.result?.outcome??'completed',
    ...(reply.result?.prepared_action_receipt?{prepared_action_receipt:reply.result.prepared_action_receipt}:{}),
    ...(reply.result?.record?{store_key:storeKey,record_id:reply.result.record.record_id,revision:reply.result.record.revision,content_digest:reply.result.record.content_digest}:{}),
    ...(prepared?{prepared:{schema_version:prepared.schema_version,snapshot_id:prepared.snapshot_id,snapshot_digest:prepared.snapshot_digest,
      record_id:prepared.record_id,revision:prepared.revision,action_key:prepared.action_key,input:prepared.input,expires_at:prepared.expires_at,
      ...(prepared.future_release?{future_release:prepared.future_release}:{}),...(prepared.copy_effect?{copy_effect:prepared.copy_effect}:{}),...(prepared.required_action_consents?{required_action_consents:prepared.required_action_consents}:{})}}:{}),
    ...(resourcePrepared?{prepared_resource:{schema_version:resourcePrepared.schema_version,snapshot_id:resourcePrepared.snapshot_id,
      snapshot_digest:resourcePrepared.snapshot_digest,account_ref:resourcePrepared.account_ref,action_key:resourcePrepared.action_key,
      resource_key:resourcePrepared.resource_key,operation_key:resourcePrepared.operation_key,source_manifest_digest:resourcePrepared.source_manifest_digest,
      item_count:resourcePrepared.item_count,input:resourcePrepared.input,expires_at:resourcePrepared.expires_at}}:{})};
   if(!await store.finish(input.request_id,reply.result?.outcome==='indeterminate'?'indeterminate':'completed',metadata))throw conflict();
   await this.assertCurrent(authority,sessionId,storeKey,input.operation);
   const localReceipt=reply.result?.prepared_action_receipt??reply.result?.request_status?.prepared_action_receipt;
   if(localReceipt)await db.transaction(async tx=>{await this.guard(tx);await acknowledgeFutureRecordActionLocal(tx,this.caller.org_id,this.caller.user_id,localReceipt);});
   if(reply.result){delete reply.result.human_save;
    if(input.operation==='record_read'&&reply.result.outcome==='completed'&&reply.result.record){const human=await store.humanSave(authority,reply.result.record);controller.signal.throwIfAborted();await this.assertCurrent(authority,sessionId,storeKey,input.operation);if(human)reply.result.human_save=human;}}
   return {...reply,authority};
  }catch(error){await store.finish(input.request_id,'indeterminate',null);throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 private async assertCurrent(previous:CurrentAppDataAuthority,session:string,store:string,operation:string){const current=await this.current(session,store,operation==='connection_metadata'?previous.consent!==null:appDataRequiresConsent(operation),operation,previous.consent?.consent_id);
  if(!isDeepStrictEqual(current.scope,previous.scope)||!isDeepStrictEqual(current.connection,previous.connection)||current.data_policy_digest!==previous.data_policy_digest
    ||current.consent?.consent_id!==previous.consent?.consent_id||current.consent?.consent_digest!==previous.consent?.consent_digest)throw appDataDenied();}
 async prepare(sessionId:string,input:Record<string,unknown>){const authority=await this.current(sessionId,String(input.store_key));const reply=await this.invoke(sessionId,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'prepare_action',input:{...input,prepare_expires_at:new Date(input.execution_window?futureRecordActionWindowDeadline(authority,String(input.action_key),input.execution_window).deadline:Math.min(authority.expires_at,Date.now()+300000)).toISOString()}});
  if(!reply.result?.prepared||reply.result.outcome!=='completed'||Date.parse(reply.result.prepared.expires_at)<=Date.now())throw invalid();return {prepared:reply.result.prepared,authority:reply.authority};}
 async readPrepared(sessionId:string,input:Record<string,unknown>){const reply=await this.invoke(sessionId,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'read_prepared',input});
  if(!reply.result?.prepared||reply.result.outcome!=='completed'||Date.parse(reply.result.prepared.expires_at)<=Date.now())throw invalid();return {prepared:reply.result.prepared,authority:reply.authority};}
 async prepareResource(sessionId:string,input:Record<string,unknown>){const authority=await this.current(sessionId,String(input.store_key),true,'prepare_resource_action');
  const reply=await this.invoke(sessionId,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'prepare_resource_action',
    input:{...input,prepare_expires_at:new Date(Math.min(authority.expires_at,Date.now()+300000)).toISOString()}});
  if(!reply.result?.prepared_resource||reply.result.outcome!=='completed'||Date.parse(reply.result.prepared_resource.expires_at)<=Date.now())throw invalid();
  return {prepared:reply.result.prepared_resource,authority:reply.authority};}
 async readPreparedResource(sessionId:string,input:Record<string,unknown>){const reply=await this.invoke(sessionId,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'read_prepared_resource_action',input});
  if(!reply.result?.prepared_resource||reply.result.outcome!=='completed'||Date.parse(reply.result.prepared_resource.expires_at)<=Date.now())throw invalid();return {prepared:reply.result.prepared_resource,authority:reply.authority};}
 async resolve(installationId:string,raw:unknown){const input=AppDataResolveInputSchema.parse(raw);
  const result=await this.context(installationId,{targetKey:input.target_key,storeKey:input.store_key,includeIdentities:false});
  const target=result.targets[0];
  if(result.targets.length!==1||!target||!target.stores.some(store=>store.declaration.key===input.store_key))throw appDataDenied();
  return result;
 }
 async context(installationId:string,options:{targetKey?:string;storeKey?:string;includeIdentities?:boolean}={}){const rows=await currentConnectionSessionLocators(db,this.caller,installationId,options.targetKey).limit(33);
  if(rows.length>32)throw invalid();
  const targets=[];for(const {session:row} of rows){const session=AppConnectionSessionRecordSchema.parse(row.record);if(session.scope.installation_id!==installationId||session.state!=='connected'||!session.account)continue;
   const {appVersions}=await import('@deft/db/schema');const [version]=await db.select().from(appVersions).where(and(eq(appVersions.org_id,this.caller.org_id),eq(appVersions.id,session.scope.app_version_id)));
   const {parseAttachmentAppManifest}=await import('@deft/app-kit');const declarations=parseAttachmentAppManifest(version?.manifest).record_stores??[],stores=[];
   // Resolve nominates one declared store; preserve its signed saved-content
   // dependencies for trusted forms without reading every unrelated store.
   const requested=options.storeKey===undefined?undefined:declarations.find(item=>item.key===options.storeKey&&item.resource_key===session.scope.resource_key);
   const selected=options.storeKey===undefined?null:new Set([options.storeKey,...(requested?.record_changes??[]).map(change=>change.source_store_key)]);
   let identities:NonNullable<AppDataResult['identities']>=[];for(const declaration of declarations){if(declaration.resource_key!==session.scope.resource_key||selected&&!selected.has(declaration.key))continue;
    try{const authority=await this.current(session.session_id,declaration.key,'optional','connection_metadata');const consent=authority.consent?{consent_id:authority.consent.consent_id,consent_digest:authority.consent.consent_digest,expires_at:authority.consent.expires_at.toISOString()}:null;
     if(options.includeIdentities!==false&&!identities.length){const metadata=await this.invoke(session.session_id,{schema_version:'deft.app_data_request.v1',request_id:randomUUID(),operation:'connection_metadata',input:{store_key:declaration.key}});identities=metadata.result?.identities??[];}
     stores.push({declaration:authority.store,consent});
    }catch(error){if(!(error instanceof AppError))throw error;}
   }
   if(stores.length)targets.push({session_id:session.session_id,target_key:session.scope.target_key,account:session.account,resource_key:session.scope.resource_key,identities,stores});
  }return AppDataContextSchema.parse({schema_version:'deft.app_data_context.v1',installation_id:installationId,targets});
 }
}
