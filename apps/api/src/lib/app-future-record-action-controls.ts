import {sql} from 'drizzle-orm';
import {AppFutureRecordActionLookupSchema,AppFutureRecordActionCancelSchema} from '@deft/app-kit/core';
import {db} from './db.js';
import {appDataDenied,appDataDigest} from './app-data-authority.js';
import {PostgresFutureRecordActionStore,type FutureReleaseRow} from './app-future-record-action-store.js';
import {futureRecordActionStatus} from './app-future-record-action-service.js';
import {futureRecordActionLocalInput} from './app-future-record-action-local.js';
import type {AppDataService} from './app-data-service.js';
import type {AppRunTransaction} from './app-run-repository.js';
export class AppFutureRecordActionControls{
 constructor(readonly data:AppDataService){}
 async assertSession(tx:AppRunTransaction,experience:string,target:string,row:FutureReleaseRow){
  await this.data.guard(tx);
  const scope=row.reviewed_authority.scope as {installation_id:string;app_version_id:string;grant_snapshot_id:string;target_key:string};
  const session=await tx.execute(sql<{current:boolean}>`SELECT expires_at>clock_timestamp() AND revoked_at IS NULL AS current FROM app_experience_sessions WHERE org_id=${this.data.caller.org_id} AND user_id=${this.data.caller.user_id} AND web_session_id=${this.data.caller.sid} AND id=${experience} AND app_installation_id=${scope.installation_id} AND app_version_id=${scope.app_version_id} AND grant_snapshot_id=${scope.grant_snapshot_id} FOR SHARE`);
  if(session.rows[0]?.current!==true||scope.target_key!==target)throw appDataDenied();
 }
 async read(experience:string,target:string,raw:unknown){
  const request=AppFutureRecordActionLookupSchema.parse(raw),store=new PostgresFutureRecordActionStore();
  return db.transaction(async tx=>{const row=await store.read(tx,this.data.caller.org_id,this.data.caller.user_id,request.request_id);
   if(!row||request.run_id&&row.run_id!==request.run_id)throw appDataDenied();await this.assertSession(tx,experience,target,row);return futureRecordActionStatus(row);});
 }
 async local(experience:string,target:string,requestId:string,phase:'commit'|'restore',signal?:AbortSignal){
  const store=new PostgresFutureRecordActionStore();
  const row=await db.transaction(async tx=>{const row=await store.read(tx,this.data.caller.org_id,this.data.caller.user_id,requestId);if(!row)throw appDataDenied();await this.assertSession(tx,experience,target,row);return row;});
  const phaseRequest=phase==='commit'?row.freeze_request_id:row.restore_request_id,connection=row.reviewed_authority.connection as {session_id:string;account_ref:string};
  let connectionSessionId=connection.session_id;if(phase==='restore'){const scope=row.reviewed_authority.scope as {installation_id:string;target_key:string};const context=await this.data.context(scope.installation_id,{targetKey:scope.target_key,includeIdentities:false});const target=context.targets.find(target=>target.account.account_ref===connection.account_ref&&target.stores.some(store=>store.declaration.key===row.reviewed_authority.store_key&&store.consent));if(!target)throw appDataDenied();connectionSessionId=target.session_id;}
  const journal=await db.transaction(async tx=>{await this.data.guard(tx);return (await tx.execute(sql`SELECT request_id FROM app_data_invocations WHERE org_id=${row.org_id} AND owner_user_id=${row.owner_user_id} AND request_id=${phaseRequest}`)).rows[0];});
  if(journal){
   // Once attempted, only the original runtime request's status may recover
   // its durable local receipt. No blind repeat or replacement UUID exists.
   await this.data.invoke(connectionSessionId,{schema_version:'deft.app_data_request.v1',request_id:crypto.randomUUID(),operation:'request_status',input:{store_key:row.reviewed_authority.store_key,request_id:phaseRequest}},undefined,signal);
  }else{
   if(phase==='commit'&&row.state!=='pending_local_commit'||phase==='restore'&&(row.state!=='cancelled'||row.local_state!=='restore_pending'))return futureRecordActionStatus(row);
   await this.data.invoke(connectionSessionId,{schema_version:'deft.app_data_request.v1',request_id:phaseRequest,operation:phase==='commit'?'prepared_action_commit':'prepared_action_restore',input:futureRecordActionLocalInput(row,phase)},undefined,signal);
  }
  return this.read(experience,target,{request_id:row.request_id,run_id:row.run_id});
 }
 async cancel(experience:string,target:string,raw:unknown,signal?:AbortSignal){
  const request=AppFutureRecordActionCancelSchema.parse(raw),store=new PostgresFutureRecordActionStore(),{getAppRunRuntime}=await import('./app-run-runtime.js'),runtime=await getAppRunRuntime();
  const status=await db.transaction(async tx=>{
   const run=await runtime.repository.lockRun(tx,this.data.caller.org_id,request.run_id),row=await store.lock(tx,this.data.caller.org_id,request.run_id);
   if(!run||!row||row.owner_user_id!==this.data.caller.user_id||row.request_id!==request.request_id)throw appDataDenied();await this.assertSession(tx,experience,target,row);
   const cancelled=await store.cancelLocked(tx,row,request.request_id,request.expected_revision,row.restore_request_id,new Date());
   if(!cancelled.cancelled)return futureRecordActionStatus(row);
   if(['pending','pending_approval'].includes(run.state))await runtime.repository.transition(tx,{run,state:'cancelled',actor:{actor_type:'human',user_id:this.data.caller.user_id},now:new Date(),error_code:'APP_RUN_CANCELLED',safe_outcome:{success:false,provider_call_attempted:false,result_status:'unavailable',error_code:'APP_RUN_CANCELLED'}});
   return futureRecordActionStatus(cancelled.row!);
  });
  if(status.state==='cancelled'&&status.local_state==='restore_pending')return this.local(experience,target,status.request_id,'restore',signal);
  return status;
 }
}
