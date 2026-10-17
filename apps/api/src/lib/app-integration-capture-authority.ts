import {and,eq,sql} from 'drizzle-orm';
import {jobQueue} from '@deft/db/schema';
import {appIntegrationCapturePolicies as policies} from '../../../../packages/db/src/app-integration-capture-schema.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import {appIntegrationSourceDigest,type AppIntegrationSourceCaller} from './app-integration-source.js';
import type {AppIntegrationSourceIdentity} from '../../../../packages/app-kit/src/app-integration-source.js';
export const APP_INTEGRATION_CAPTURE_JOB='app-integration-knowledge';
/** Host-only queue identity. The gateway invokes this AFTER its established
 * member/App/account locks, including original-UUID callback validation. */
export async function assertAppIntegrationCaptureDelivery(tx:Tx,caller:AppIntegrationSourceCaller,account:Pick<AppIntegrationSourceIdentity,'installation_id'|'account_ref'|'store_key'>,now=Date.now()){
 const denied=()=>new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED'),delivery=caller.capture_delivery;
 if(caller.kind!=='capture_policy'||!delivery||!delivery.job_id||!delivery.lock_token||!Number.isSafeInteger(delivery.policy_revision)||delivery.policy_revision<1)throw denied();
 const [policy]=await tx.select().from(policies).where(and(eq(policies.org_id,caller.org_id),eq(policies.owner_user_id,caller.user_id),eq(policies.installation_id,account.installation_id),eq(policies.account_ref,account.account_ref),eq(policies.store_key,account.store_key),eq(policies.id,caller.principal_id),eq(policies.enabled,true),eq(policies.revision,delivery.policy_revision))).limit(1).for('share');
 if(!policy)throw denied();
 const [job]=await tx.select({expires:jobQueue.lock_expires_at}).from(jobQueue).where(and(eq(jobQueue.id,delivery.job_id),eq(jobQueue.org_id,caller.org_id),eq(jobQueue.queue,'scheduled-jobs'),eq(jobQueue.name,APP_INTEGRATION_CAPTURE_JOB),eq(jobQueue.status,'running'),eq(jobQueue.lock_token,delivery.lock_token),sql`${jobQueue.data}->>'policy_id'=${policy.id}`,sql`${jobQueue.data}->>'policy_revision'=${String(policy.revision)}`)).limit(1).for('share');
 if(!job?.expires||job.expires.getTime()<=now)throw denied();return {policy,expires:job.expires.getTime()};
}
export function createAppIntegrationCapturePolicyAuthority(input:{transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;clock?:()=>number}){
 return async(caller:AppIntegrationSourceCaller,account:Pick<AppIntegrationSourceIdentity,'installation_id'|'account_ref'|'store_key'>,tx?:Tx)=>{
  const check=async(transaction:Tx)=>{const value=await assertAppIntegrationCaptureDelivery(transaction,caller,account,(input.clock??Date.now)());return {identity:appIntegrationSourceDigest([value.policy.id,value.policy.revision,caller.capture_delivery]),expires_at:value.expires};};return tx?check(tx):input.transaction(check);
 };
}
