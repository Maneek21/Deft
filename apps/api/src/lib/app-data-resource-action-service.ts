import {captureResourceBatchDataFence,assertResourceBatchDataFence} from './app-resource-batch-data-fence.js';
import type {AppRunSafeView,AppRunTransaction} from './app-run-repository.js';
import type {HumanActionAuthority} from './app-experience-human-action-service.js';
import {isDeepStrictEqual} from 'node:util';
import {AppResourceActionPrepareSchema,AppResourceActionReviewSchema,AppResourceActionReleasedInputSchema,
  AppDataPreparedResourceActionSchema} from '@deft/app-kit';
import {AppDataActionService} from './app-data-action-service.js';
import {appDataDenied,appDataDigest} from './app-data-authority.js';
import {HumanActionConfirmSchema,humanActionDigest,openHumanActionTicket} from './app-experience-human-action-contract.js';

/** Plans carry immutable references only. Independent current action review
 * and the existing human-release Run remain the sole effect authority. */
export class AppDataResourceActionService extends AppDataActionService {
 private readonly batchPreflights=new WeakSet<object>();
 async prepareResource(sessionId:string,target:string,action:string,raw:unknown,signal?:AbortSignal){
  const request=AppResourceActionPrepareSchema.parse(raw),before=await this.data.current(request.connection_session_id,request.store_key,true,'prepare_resource_action');
  if(request.resource_key!==before.scope.resource_key)throw appDataDenied();
  const references=[...(request.record_sources??[]),...(request.destination?[request.destination]:[]),...(request.labels?[...request.labels.add,...request.labels.remove]:[])];
  const recheckReferences=async()=>{for(const store of new Set(references.map(ref=>ref.store_key))){const current=await this.data.current(request.connection_session_id,store,true,'prepare_resource_action');if(current.connection.account_ref!==before.connection.account_ref||current.connection.session_id!==before.connection.session_id||current.connection.session_revision!==before.connection.session_revision||!current.consent)throw appDataDenied();}signal?.throwIfAborted();};
  await recheckReferences();
  await this.assertTarget(sessionId,target,action,before,signal);signal?.throwIfAborted();
  const {prepared:rawPrepared,authority}=await this.data.prepareResource(request.connection_session_id,{
    store_key:request.store_key,resource_key:request.resource_key,action_key:action,operation_key:request.operation_key,sources:request.sources,...(request.record_sources?{record_sources:request.record_sources}:{}),...(request.parameters?{parameters:request.parameters}:{}),
    ...(request.destination?{destination:request.destination}:{}),...(request.labels?{labels:request.labels}:{}),...(request.undo?{undo:request.undo}:{})});
  const prepared=AppDataPreparedResourceActionSchema.parse(rawPrepared);
  if(!authority.consent||prepared.action_key!==action||prepared.resource_key!==request.resource_key
    ||prepared.account_ref!==authority.connection.account_ref||prepared.operation_key!==request.operation_key
    ||prepared.source_manifest_digest!==appDataDigest(request.sources)||prepared.item_count!==request.sources.length+(request.record_sources?.length??0)
    ||!isDeepStrictEqual(prepared.preview.items.map(item=>item.record_id),[...request.sources,...(request.record_sources??[])].map(source=>source.record_id))
    ||!isDeepStrictEqual(prepared.record_refs??[],references))throw appDataDenied();
  await this.assertTarget(sessionId,target,action,authority,signal);signal?.throwIfAborted();
  await recheckReferences();
  const input=AppResourceActionReleasedInputSchema.parse({...prepared.input,resource_action_version:prepared.schema_version,
    resource_store_key:request.store_key,connection_session_id:authority.connection.session_id,
    connection_revision:authority.connection.session_revision,data_consent_id:authority.consent.consent_id,
    data_consent_digest:authority.consent.consent_digest,prepared_digest:prepared.snapshot_digest});
  const ticket=await this.human.prepareReviewedResource(this.data.caller,sessionId,action,{input,idempotency_key:request.idempotency_key},signal);
  const expires_at=new Date(Math.min(Date.parse(ticket.expires_at),Date.parse(prepared.expires_at),authority.expires_at)).toISOString();
  if(Date.parse(expires_at)<=Date.now())throw appDataDenied();
  await this.assertTarget(sessionId,target,action,await this.data.current(request.connection_session_id,request.store_key,true,'prepare_resource_action'),signal);
  return AppResourceActionReviewSchema.parse({schema_version:'deft.app_resource_action_review.v1',prepared,input,
    ticket:ticket.ticket,input_digest:ticket.input_digest,expires_at});
 }
 async confirmResource(sessionId:string,target:string,raw:unknown,signal?:AbortSignal){return this.confirmResourceInternal(sessionId,target,raw,signal);}
 async confirmResourceBatchChild(sessionId:string,target:string,raw:unknown,transaction:AppRunTransaction,
  beforeApprove:(tx:AppRunTransaction,run:AppRunSafeView,authority:HumanActionAuthority)=>Promise<void>,signal?:AbortSignal,preflight?:Awaited<ReturnType<AppDataResourceActionService['preflightResourceBatchChild']>>){return this.confirmResourceInternal(sessionId,target,raw,signal,transaction,beforeApprove,false,preflight);}
 async registerResourceBatchChild(sessionId:string,target:string,raw:unknown,transaction:AppRunTransaction,
  beforeApprove:(tx:AppRunTransaction,run:AppRunSafeView,authority:HumanActionAuthority)=>Promise<void>,signal?:AbortSignal,preflight?:Awaited<ReturnType<AppDataResourceActionService['preflightResourceBatchChild']>>){return this.confirmResourceInternal(sessionId,target,raw,signal,transaction,beforeApprove,true,preflight);}
 async preflightResourceBatchChild(sessionId:string,target:string,raw:unknown,signal?:AbortSignal){
  const preflight=await this.resourceConfirmPreflight(sessionId,target,raw,signal);this.batchPreflights.add(preflight);return preflight;
 }
 private async resourceConfirmPreflight(sessionId:string,target:string,raw:unknown,signal?:AbortSignal){
  const request=HumanActionConfirmSchema.parse(raw),ticket=openHumanActionTicket(this.keys,request.ticket),caller=this.data.caller;
  if(ticket.org_id!==caller.org_id||ticket.user_id!==caller.user_id||ticket.sid!==caller.sid||ticket.session_id!==sessionId
    ||ticket.input_digest!==request.expected_input_digest||ticket.input_digest!==humanActionDigest(ticket.input)
    ||Date.parse(ticket.expires_at)<=Date.now())throw appDataDenied();
  const input=AppResourceActionReleasedInputSchema.parse(ticket.input),before=await this.data.current(input.connection_session_id,input.resource_store_key);
  await this.assertTarget(sessionId,target,ticket.action_key,before,signal);
  const {prepared:rawPrepared,authority}=await this.data.readPreparedResource(input.connection_session_id,{
    store_key:input.resource_store_key,resource_key:before.scope.resource_key,snapshot_id:input.snapshot_id,snapshot_digest:input.prepared_digest});
  const prepared=AppDataPreparedResourceActionSchema.parse(rawPrepared);
  for(const store of new Set((prepared.record_refs??[]).map(ref=>ref.store_key))){const current=await this.data.current(input.connection_session_id,store);if(current.connection.account_ref!==before.connection.account_ref||current.connection.session_id!==before.connection.session_id||current.connection.session_revision!==before.connection.session_revision||!current.consent)throw appDataDenied();}
  const expected=AppResourceActionReleasedInputSchema.parse({...prepared.input,resource_action_version:prepared.schema_version,
    resource_store_key:input.resource_store_key,connection_session_id:authority.connection.session_id,
    connection_revision:authority.connection.session_revision,data_consent_id:authority.consent?.consent_id,
    data_consent_digest:authority.consent?.consent_digest,prepared_digest:prepared.snapshot_digest});
  if(prepared.action_key!==ticket.action_key||!isDeepStrictEqual(input,expected)||Date.parse(prepared.expires_at)<=Date.now())throw appDataDenied();
  await this.assertTarget(sessionId,target,ticket.action_key,authority,signal);signal?.throwIfAborted();
  const fence=await captureResourceBatchDataFence(caller,authority);
  return {request,ticket,input,authority,prepared,fence,sessionId,target};
 }
 private async confirmResourceInternal(sessionId:string,target:string,raw:unknown,signal?:AbortSignal,transaction?:AppRunTransaction,
  beforeApprove?:(tx:AppRunTransaction,run:AppRunSafeView,authority:HumanActionAuthority)=>Promise<void>,deferApproval=false,
  preflight?:Awaited<ReturnType<AppDataResourceActionService['preflightResourceBatchChild']>>){
  const request=HumanActionConfirmSchema.parse(raw),caller=this.data.caller;
  if(transaction){
   if(!preflight||!this.batchPreflights.has(preflight)||!isDeepStrictEqual(request,preflight.request)||sessionId!==preflight.sessionId||target!==preflight.target)throw appDataDenied();
   if(Math.min(Date.parse(preflight.ticket.expires_at),Date.parse(preflight.prepared.expires_at),preflight.fence.expires_at)<=Date.now())throw appDataDenied();
   await assertResourceBatchDataFence(transaction,preflight.fence);signal?.throwIfAborted();
  }else await this.resourceConfirmPreflight(sessionId,target,raw,signal);
  return transaction&&beforeApprove?(deferApproval?this.human.registerPreparedResourceBatchChild(caller,sessionId,request,transaction,beforeApprove,signal):this.human.confirmPreparedResourceBatchChild(caller,sessionId,request,transaction,beforeApprove,signal)):this.human.confirm(caller,sessionId,request,signal);
 }
}
