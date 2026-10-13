import {z} from 'zod';
import {getAppRunRuntime} from './app-run-runtime.js';
import {AppExperienceExposureService} from './app-experience-exposure.js';
import {AppExperienceHumanActionService} from './app-experience-human-action-service.js';
import {HumanActionConfirmSchema,openHumanActionTicket} from './app-experience-human-action-contract.js';
import {readOriginalPrepared} from './app-integration-tool-prepared.js';
import {readIntegrationTool} from './app-integration-tool-store.js';
import type {ExperienceCaller} from './app-experience-service.js';
const id=z.uuid(),denied=()=>Error('APP_INTEGRATION_PREPARED_AUTHORITY_STALE');
export async function integrationToolReviewService(caller:ExperienceCaller){
 const runtime=await getAppRunRuntime(),authority=new AppExperienceExposureService(runtime.keys),human=new AppExperienceHumanActionService(authority,runtime);
 async function assertHuman(session:string,invocation:string){
  const row=await readIntegrationTool(invocation);if(!row?.prepared||row.metadata.caller.org_id!==caller.org_id||row.metadata.caller.user_id!==caller.user_id)throw denied();
  await authority.withHumanAction(caller,session,row.prepared.action_key,async(tx,h,final)=>{
   const m=row.metadata;if(h.session.app_installation_id!==m.target.installation_id||h.session.app_version_id!==m.envelope.scope.app_version_id
    ||h.session.grant_snapshot_id!==m.envelope.scope.grant_snapshot_id||h.session.resource_target_key!==m.envelope.scope.target_key)throw denied();await final(tx);
  });return row;
 }
 return {
  async prepare(sessionRaw:unknown,invocationRaw:unknown,signal?:AbortSignal){
   const session=id.parse(sessionRaw),invocation=id.parse(invocationRaw);await assertHuman(session,invocation);
   const {prepared,provenance,row}=await readOriginalPrepared(caller,invocation,signal),m=row.metadata,record=provenance.prepared_kind==='record';
   const reserved=['record_action_version','resource_action_version','record_store_key','resource_store_key','connection_session_id','connection_revision','data_consent_id','data_consent_digest','prepared_digest'];
   if(Object.keys(prepared.input).some(key=>reserved.includes(key)))throw denied();
   const input={...prepared.input,...(record?{record_action_version:prepared.schema_version,record_store_key:m.target.store_key}:{resource_action_version:prepared.schema_version,resource_store_key:m.target.store_key}),
    connection_session_id:m.envelope.connection.session_id,connection_revision:m.envelope.connection.session_revision,data_consent_id:m.grant.id,data_consent_digest:m.grant.digest,prepared_digest:prepared.snapshot_digest};
   const ticket=await human.prepareReviewedIntegration(caller,session,prepared.action_key,{input,idempotency_key:invocation},provenance,signal);
   return {schema_version:'deft.app_integration_tool_review.v1',request_id:invocation,prepared,input,ticket:ticket.ticket,input_digest:ticket.input_digest,expires_at:ticket.expires_at};
  },
  async confirm(sessionRaw:unknown,raw:unknown,signal?:AbortSignal){
   const session=id.parse(sessionRaw),request=HumanActionConfirmSchema.parse(raw),ticket=openHumanActionTicket(runtime.keys,request.ticket);
   const p=ticket.integration_prepared_action;if(!p||ticket.org_id!==caller.org_id||ticket.user_id!==caller.user_id||ticket.sid!==caller.sid||ticket.session_id!==session)throw denied();
   await assertHuman(session,p.invocation_id);await readOriginalPrepared(caller,p.invocation_id,signal);
   return human.confirmPreparedIntegration(caller,session,request,signal);
  },
  async status(sessionRaw:unknown,invocationRaw:unknown,signal?:AbortSignal){
   const session=id.parse(sessionRaw),invocation=id.parse(invocationRaw),row=await assertHuman(session,invocation);
   // Uses the existing idempotency lookup. No Runtime preparation or provider IO.
   return human.lookup(caller,session,row.prepared!.action_key,invocation,signal);
  }
 };
}
