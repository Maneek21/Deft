import {AppFutureExecutionWindowSchema,type AppDataPreparedRecordAction} from '@deft/app-kit';
import {appDataDenied,appDataDigest,type CurrentAppDataAuthority} from './app-data-authority.js';
import {resolveFutureRecordActionSchedule} from './app-future-record-action-schedule.js';
export function futureRecordActionWindowDeadline(current:CurrentAppDataAuthority,action:string,raw:unknown,resolve=true){
 const window=AppFutureExecutionWindowSchema.parse(raw),policy=current.store.future_record_actions?.find(row=>row.action_key===action);
 const consent=(current.action_consents??(current.action_consent?[current.action_consent]:[])).find(row=>row.action_key===action);
 const deadline=Date.parse(window.dispatch_expires_at);
 if(!policy||!current.consent||!consent||deadline<=Date.now()||window.undo_delay_seconds>policy.max_undo_delay_seconds
 ||deadline>Math.min(Date.parse(current.scope.consent_expires_at),current.consent.expires_at.getTime(),Date.parse(consent.expires_at))
 ||deadline>Date.now()+policy.max_schedule_horizon_seconds*1000+policy.max_dispatch_lifetime_seconds*1000+policy.max_undo_delay_seconds*1000
 ||window.schedule&&!policy.missed_policies.includes(window.schedule.missed_policy))throw appDataDenied();
 if(window.schedule&&resolve){const saved=resolveFutureRecordActionSchedule(window.schedule,Date.now(),policy.max_schedule_horizon_seconds);
  if(Date.parse(saved.instant)>=deadline)throw appDataDenied();}
 return {deadline,window,policy};
}
export function assertPreparedFutureRecordAction(current:CurrentAppDataAuthority,prepared:AppDataPreparedRecordAction){
 const future=prepared.future_release;if(!future)throw appDataDenied();
 const {deadline,policy}=futureRecordActionWindowDeadline(current,prepared.action_key,future.execution_window,false);
 if(Date.parse(prepared.expires_at)!==deadline||Date.parse(future.authority_expires_at)!==deadline
 ||future.policy_digest!==appDataDigest(policy)||future.max_dispatch_lifetime_seconds!==policy.max_dispatch_lifetime_seconds
 ||prepared.required_action_consents?.some(row=>Date.parse(row.expires_at)<deadline))throw appDataDenied();
}
