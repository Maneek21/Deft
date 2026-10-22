import {continuationSourceIsAvailable,continuationSourceCondition} from './app-connection-consent-continuation-fence.js';
import {appConnectionFormSourceIsAvailable,appConnectionFormCurrentSourceCondition,appConnectionFormPendingSourceCondition,appConnectionFormCarrierJoin} from './app-connection-form-fence.js';
import {appConnectionCredentialRepairPurposeIsAvailable,appConnectionCredentialRepairSourceIsSuperseded} from './app-connection-credential-repair-fence.js';
import {and,eq,sql,exists} from 'drizzle-orm';
import {appConnectionSessions,appConnectionForms,appConnectionConsentContinuations} from '@deft/db/schema';
import type {AppRunTransaction} from './app-run-repository.js';
/** A consumed OAuth upgrade owns its source. A receipt supersedes that source
 * permanently; unfinished or uncertain custody blocks all effects on the same
 * resource. No lease makes an unknown upgrade retryable. */
type ConnectionSourceLocator={org_id:string;owner_user_id?:string;session_id?:string;resource_binding_id?:string;continuation_session_id?:string;purpose?:'effect'|'saved_read'};
const sourceCondition=(input:ConnectionSourceLocator)=>and(eq(appConnectionSessions.org_id,input.org_id),
 eq(appConnectionSessions.session_id,input.session_id!),input.owner_user_id?eq(appConnectionSessions.owner_user_id,input.owner_user_id):undefined);
const upgradeReservationCondition=(input:ConnectionSourceLocator)=>and(
 eq(appConnectionSessions.org_id,input.org_id),input.owner_user_id?eq(appConnectionSessions.owner_user_id,input.owner_user_id):undefined,
 sql`${appConnectionSessions.record}->'upgrade'->'begin_consumed'='true'::jsonb`,
 input.session_id?sql`(${appConnectionSessions.record}->'upgrade'->'receipt' <> 'null'::jsonb
  OR ${appConnectionSessions.record}->>'state' NOT IN ('not_connected','disconnected'))`:
  sql`${appConnectionSessions.record}->>'state' NOT IN ('not_connected','disconnected')`,
 input.session_id?sql`${appConnectionSessions.record}->'upgrade'->'source'->>'session_id'=${input.session_id}`:
  and(sql`${appConnectionSessions.record}->'upgrade'->'source'->'scope'->>'resource_binding_id'=${input.resource_binding_id!}`,
   sql`${appConnectionSessions.record}->'upgrade'->'receipt'='null'::jsonb`));

/** Explicit saved reads retain source/resource custody locks. Only the scoped
 * absence facts are batched, freshly AFTER those waits. Current form journals
 * still pass the existing locked pair validator; a wait there causes another
 * fresh absence read. No result is retained for a later authority boundary. */
async function savedReadSourceIsAvailable(tx:AppRunTransaction,input:ConnectionSourceLocator){
 const [source]=await tx.select({resource_binding_id:sql<string|null>`${appConnectionSessions.record}->'scope'->>'resource_binding_id'`})
  .from(appConnectionSessions).where(sourceCondition(input)).limit(1).for('share');
 // Preserve legacy missing-locator behavior through the original reader below.
 if(!source)return undefined;
 const resource=input.resource_binding_id??source.resource_binding_id;
 if(!resource)return false;
 const sources=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${resource}`,
  sql`(${appConnectionSessions.record}->'credential_repair' IS NULL OR ${appConnectionSessions.record}->'credential_repair'->>'reservation_closed'='true')`)).for('share');
 if(!sources.length)return false;
 const capture=async()=>{
  const [flags]=await tx.select({
   upgrade:exists(tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(upgradeReservationCondition(input))),
   pending_form:exists(tx.select({id:appConnectionForms.session_id}).from(appConnectionForms).where(appConnectionFormPendingSourceCondition(input))),
   continuation:exists(tx.select({id:appConnectionConsentContinuations.session_id}).from(appConnectionConsentContinuations).where(continuationSourceCondition(input))),
   current_form:exists(tx.select({id:appConnectionForms.session_id}).from(appConnectionForms).innerJoin(appConnectionSessions,appConnectionFormCarrierJoin()).where(appConnectionFormCurrentSourceCondition(input))),
  }).from(appConnectionSessions).where(sourceCondition(input)).limit(1);
  return flags;
 };
 let flags=await capture();
 if(!flags||flags.upgrade||flags.pending_form||flags.continuation)return false;
 if(flags.current_form){
  if(!await appConnectionFormSourceIsAvailable(tx,input))return false;
  flags=await capture();
 }
 return !!flags&&!flags.upgrade&&!flags.pending_form&&!flags.continuation;
}

export async function appConnectionUpgradeSourceIsAvailable(tx:AppRunTransaction,input:ConnectionSourceLocator){
 if(!input.session_id&&!input.resource_binding_id)return false;
 if(input.purpose==='saved_read'&&input.session_id){const current=await savedReadSourceIsAvailable(tx,input);if(current!==undefined)return current;}
 if(input.session_id)await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions)
  .where(and(eq(appConnectionSessions.org_id,input.org_id),eq(appConnectionSessions.session_id,input.session_id),
   input.owner_user_id?eq(appConnectionSessions.owner_user_id,input.owner_user_id):undefined)).limit(1).for('share');
 else await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${input.resource_binding_id!}`,
  sql`(${appConnectionSessions.record}->'credential_repair' IS NULL OR ${appConnectionSessions.record}->'credential_repair'->>'reservation_closed'='true')`)).for('share');
 if(input.session_id&&input.purpose!=='saved_read'&&await appConnectionCredentialRepairSourceIsSuperseded(tx,{org_id:input.org_id,session_id:input.session_id}))return false;
 const [row]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(upgradeReservationCondition(input)).limit(1);
 let resource=input.resource_binding_id;
 if(!resource&&input.session_id){const [source]=await tx.select({record:appConnectionSessions.record}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),eq(appConnectionSessions.session_id,input.session_id))).limit(1);
  resource=(source?.record as {scope?:{resource_binding_id?:string}}|undefined)?.scope?.resource_binding_id;}
 return !row&&!!resource&&await appConnectionCredentialRepairPurposeIsAvailable(tx,{org_id:input.org_id,resource_binding_id:resource,
  owner_user_id:input.owner_user_id,session_id:input.session_id,purpose:input.purpose??'effect'})
  &&await appConnectionFormSourceIsAvailable(tx,input)&&await continuationSourceIsAvailable(tx,input);
}
