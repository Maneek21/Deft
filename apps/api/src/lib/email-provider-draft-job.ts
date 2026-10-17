import {z} from 'zod';
import type {JobHandler} from '../workers/types.js';
import type {EmailScope} from './email-mailbox-service.js';
import type {EmailServiceLease} from './email-mailbox-authority.js';
const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const EmailProviderDraftJobSchema=z.strictObject({org_id:id,owner_user_id:id,account_id:id,draft_id:z.string().uuid(),
 revision:z.number().int().min(1).max(2147483647),authority_revision:z.number().int().min(1).max(2147483647),
 mode:z.enum(['sync','reconcile']).optional(),generation:z.number().int().min(1).max(2147483647).optional()})
 .refine(value=>value.mode==='reconcile'?value.generation!==undefined:value.generation===undefined);
export type EmailProviderDraftJobInput=z.infer<typeof EmailProviderDraftJobSchema>;
export const EMAIL_PROVIDER_DRAFT_JOB='native-email-draft-sync';
type Ports={enabled:()=>boolean;defer:(message:string,delay:number)=>Error;
 run:(scope:EmailScope,draftId:string,revision:number,lease:EmailServiceLease,signal?:AbortSignal)=>Promise<unknown>};
/** One exact draft revision per delivery. Domain claims, not queue retries,
 * decide whether any provider mutation remains permissible. */
export function createEmailProviderDraftJobHandler(ports:Ports):JobHandler{
 return async job=>{
  if(job.name!==EMAIL_PROVIDER_DRAFT_JOB||!job.id||!job.lockToken)throw Error('EMAIL_DRAFT_SYNC_JOB_LEASE_REQUIRED');
  const parsed=EmailProviderDraftJobSchema.safeParse(job.data);if(!parsed.success)throw Error('EMAIL_DRAFT_SYNC_JOB_INVALID');
  if(!ports.enabled())throw ports.defer('Native email draft sync is disabled',60000);
  const input=parsed.data;job.signal?.throwIfAborted();
  try{await ports.run({org_id:input.org_id,owner_user_id:input.owner_user_id,account_id:input.account_id},input.draft_id,input.revision,
   {job_id:job.id,lock_token:job.lockToken,job_name:EMAIL_PROVIDER_DRAFT_JOB,draft_id:input.draft_id,revision:input.revision,
    ...(input.mode?{mode:input.mode}:{}),...(input.generation!==undefined?{generation:input.generation}:{})},job.signal);}
  catch{throw Error('EMAIL_DRAFT_SYNC_UNAVAILABLE');}
 };
}
