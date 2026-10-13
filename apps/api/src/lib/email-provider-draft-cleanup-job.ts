import {z} from 'zod';
import type {JobHandler} from '../workers/types.js';
import type {EmailScope} from './email-mailbox-service.js';
import type {EmailServiceLease} from './email-mailbox-authority.js';
const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const EmailProviderDraftCleanupJobSchema=z.strictObject({org_id:id,owner_user_id:id,account_id:id,draft_id:z.string().uuid(),
  revision:z.number().int().min(1).max(2147483647),operation_id:z.string().uuid(),generation:z.number().int().min(1).max(2147483647),
  authority_revision:z.number().int().min(1).max(2147483647),mode:z.enum(['delete','reconcile'])});
export type EmailProviderDraftCleanupJobInput=z.infer<typeof EmailProviderDraftCleanupJobSchema>;
export const EMAIL_PROVIDER_DRAFT_CLEANUP_JOB='native-email-draft-cleanup';
type Ports={enabled:()=>boolean;defer:(message:string,delay:number)=>Error;
  run:(scope:EmailScope,draftId:string,revision:number,operationId:string,lease:EmailServiceLease,signal?:AbortSignal)=>Promise<unknown>;
  reconcile:(scope:EmailScope,draftId:string,revision:number,operationId:string,lease:EmailServiceLease,signal?:AbortSignal)=>Promise<unknown>};
/** A single exact accepted-send cleanup claim. Uncertain work is moved to the
 * inspect-only path by explicit recovery; queue retry cannot issue DELETE twice. */
export function createEmailProviderDraftCleanupJobHandler(ports:Ports):JobHandler{
  return async job=>{
    if(job.name!==EMAIL_PROVIDER_DRAFT_CLEANUP_JOB||!job.id||!job.lockToken)throw Error('EMAIL_DRAFT_CLEANUP_LEASE_REQUIRED');
    const parsed=EmailProviderDraftCleanupJobSchema.safeParse(job.data);if(!parsed.success)throw Error('EMAIL_DRAFT_CLEANUP_JOB_INVALID');
    if(!ports.enabled())throw ports.defer('Native email draft cleanup is disabled',60000);
    const input=parsed.data;job.signal?.throwIfAborted();
    const scope={org_id:input.org_id,owner_user_id:input.owner_user_id,account_id:input.account_id};
    const lease:EmailServiceLease={job_id:job.id,lock_token:job.lockToken,job_name:EMAIL_PROVIDER_DRAFT_CLEANUP_JOB,
      draft_id:input.draft_id,revision:input.revision,operation_id:input.operation_id,mode:input.mode,generation:input.generation};
    try{
      if(input.mode==='reconcile')await ports.reconcile(scope,input.draft_id,input.revision,input.operation_id,lease,job.signal);
      else await ports.run(scope,input.draft_id,input.revision,input.operation_id,lease,job.signal);
    }catch{if(job.signal?.aborted)throw job.signal.reason;throw Error('EMAIL_DRAFT_CLEANUP_UNAVAILABLE');}
  };
}
