import type {JobHandler} from '../workers/types.js';
import {EMAIL_OUTBOX_JOB,EmailOutboxJobSchema,type EmailOutboxLease} from './email-outbox-contract.js';
import type {EmailScope} from './email-mailbox-service.js';
export function createEmailOutboxJobHandler(ports:{enabled:()=>boolean;defer:(message:string,delayMs:number)=>Error;dispatch:(scope:EmailScope,lease:EmailOutboxLease,signal?:AbortSignal)=>Promise<{state:string;delay_ms?:number}>}):JobHandler{
 return async job=>{
  if(job.name!==EMAIL_OUTBOX_JOB||!job.id||!job.lockToken)throw Error('EMAIL_OUTBOX_LEASE_DENIED');const input=EmailOutboxJobSchema.parse(job.data);
  if(!ports.enabled())throw ports.defer('Native email Outbox is disabled',60000);job.signal?.throwIfAborted();
  const result=await ports.dispatch({org_id:input.org_id,owner_user_id:input.owner_user_id,account_id:input.account_id},{job_id:job.id,lock_token:job.lockToken,job_name:EMAIL_OUTBOX_JOB,outbox_id:input.outbox_id,operation_id:input.operation_id},job.signal);
  if(result.state==='waiting'){if(!Number.isFinite(result.delay_ms)||result.delay_ms!<=0)throw Error('EMAIL_OUTBOX_UNAVAILABLE');throw ports.defer('Native email Outbox waits for its saved deadline',Math.min(result.delay_ms!,86400000));}
 };
}
