import {appConsentDeadline} from '@deft/app-kit';
import {and,eq} from 'drizzle-orm';
import {appRuntimeSessions,appRuns,appRunAttempts,appSyncIntents,appSyncCheckpoints} from '@deft/db/schema';
import {ResourceObservationAuthorityRequestSchema,ResourceObservationAuthorityResultSchema} from '../../../../packages/app-kit/src/resource-observation.js';
import {getAppAttachmentRuntime} from './app-attachment-runtime.js';
import {hashAppAttachmentSessionToken} from './app-attachment-policy.js';
import {loadLiveAttachmentSyncAuthority} from './app-attachment-sync-authority.js';
import {currentResourceObservationRun,observationDenied} from './app-resource-observation-authority.js';
import {attachmentFinalAuthorityIsCurrent} from './app-attachment-authority.js';
import {db} from './db.js';
import {digestAppGrantValue} from './app-grant-service.js';
/** Existing v3 credential and claim, separately versioned read-only projection.
 * It never mints a session, admits a Run or invokes a provider. */
export async function resourceObservationRuntimeAuthority(raw:unknown,authorization:string|undefined){
 const input=ResourceObservationAuthorityRequestSchema.parse(raw),token=/^AppRuntime ([A-Za-z0-9_-]{32,512})$/u.exec(authorization??'')?.[1];
 if(!token||Date.parse(input.expires_at)<=Date.now()||Date.parse(input.expires_at)>Date.now()+30000)throw observationDenied();
 const runtime=await getAppAttachmentRuntime();
 const {expires_at:requestedExpiry,schema_version:requestVersion,...attemptInput}=input;
 const heartbeat=await runtime.channel.heartbeat({...attemptInput,schema_version:'deft.app_runtime_channel.v3',session_token:token});
 if(!heartbeat)throw observationDenied();
 const tokenHash=hashAppAttachmentSessionToken(token);
 const [locator]=await db.select({org_id:appRuntimeSessions.org_id}).from(appRuntimeSessions).where(and(
  eq(appRuntimeSessions.id,input.session_id),eq(appRuntimeSessions.token_hash,tokenHash))).limit(1);
 if(!locator)throw observationDenied();
 return runtime.repository.transaction(async tx=>{
  const [run]=await tx.select().from(appRuns).where(and(eq(appRuns.org_id,locator.org_id),eq(appRuns.id,input.run_id))).limit(1).for('update');
  if(!run||run.state!=='running'||run.cancel_requested_at||!run.execution_released_at)throw observationDenied();
  const authority=await loadLiveAttachmentSyncAuthority(tx,{org_id:locator.org_id,session_id:input.session_id,token_hash:tokenHash,clock:()=>new Date()});
  if(!authority||run.origin_resource_binding_id!==authority.binding.id)throw observationDenied();
  const observed=await currentResourceObservationRun(tx,locator.org_id,run.id,authority,()=>new Date());
  if(!observed)throw observationDenied();
  const [attempt]=await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id,locator.org_id),eq(appRunAttempts.run_id,run.id),eq(appRunAttempts.id,input.attempt_id))).limit(1).for('share');
  if(!attempt||attempt.state!=='provider_call_started'||attempt.claim_token!==input.claim_token||attempt.runtime_sequence!==input.sequence
   ||attempt.runtime_session_id!==input.session_id||attempt.runtime_session_epoch!==authority.session.session_epoch
   ||attempt.runtime_epoch!==authority.registration.runtime_epoch||attempt.resource_binding_id!==authority.binding.id||!attempt.lease_expires_at)throw observationDenied();
  const [intent]=await tx.select().from(appSyncIntents).where(and(eq(appSyncIntents.org_id,locator.org_id),eq(appSyncIntents.run_id,run.id),eq(appSyncIntents.resource_binding_id,authority.binding.id))).limit(1);
  if(!intent)throw observationDenied();
  const [checkpoint]=await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,locator.org_id),eq(appSyncCheckpoints.id,intent.checkpoint_id),eq(appSyncCheckpoints.resource_binding_id,authority.binding.id))).limit(1).for('share');
  if(!checkpoint||checkpoint.state!=='active'||checkpoint.generation!==intent.generation||checkpoint.cursor_sequence!==intent.expected_cursor_sequence
   ||checkpoint.cursor_hmac_key_version!==intent.expected_cursor_hmac_key_version||checkpoint.cursor_hmac!==intent.expected_cursor_hmac)throw observationDenied();
  const deadline=Math.min(Date.parse(input.expires_at),appConsentDeadline(observed.snapshot.expires_at,observed.snapshot.consent_lifetime),run.input_expires_at.getTime(),
   run.result_expires_at.getTime(),authority.session.expires_at.getTime(),attempt.lease_expires_at.getTime());
  if(deadline<=Date.now()||!await attachmentFinalAuthorityIsCurrent(tx,[authority.binding.owner_user_id,authority.registration.operator_user_id],
   {expires_at:[new Date(deadline)]}))throw observationDenied();
  return ResourceObservationAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(deadline).toISOString(),
   snapshot:observed.snapshot,consent_digest:digestAppGrantValue(observed.snapshot)});
 });
}
