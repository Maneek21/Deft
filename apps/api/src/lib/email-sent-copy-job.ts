import type {JobHandler} from '../workers/types.js';
import {EMAIL_SENT_COPY_JOB,EmailSentCopyJobSchema,type EmailSentCopyLease} from './email-sent-copy-contract.js';
import type {EmailScope} from './email-mailbox-service.js';
export function createEmailSentCopyJobHandler(ports:{enabled:()=>boolean;defer:(message:string,delayMs:number)=>Error;dispatch:(scope:EmailScope,lease:EmailSentCopyLease,signal?:AbortSignal)=>Promise<{outcome:string}>}):JobHandler{
 return async job=>{if(job.name!==EMAIL_SENT_COPY_JOB||!job.id||!job.lockToken)throw Error('EMAIL_SENT_COPY_LEASE_DENIED');const input=EmailSentCopyJobSchema.parse(job.data);
  if(!ports.enabled())throw ports.defer('Native SMTP Sent copy is disabled',60000);job.signal?.throwIfAborted();const result=await ports.dispatch({org_id:input.org_id,owner_user_id:input.owner_user_id,account_id:input.account_id},
   {job_id:job.id,lock_token:job.lockToken,job_name:EMAIL_SENT_COPY_JOB,outbox_id:input.outbox_id,operation_id:input.operation_id},job.signal);if(result.outcome==='pending')throw ports.defer('Native SMTP Sent copy inspection continues',5000);
 };
}
