import {and,eq,sql} from 'drizzle-orm';
import {appConnectionSessions} from '../../../../packages/db/src/app-connection-session-schema.js';
import type {AppRunTransaction} from './app-run-repository.js';

/** Candidate seam: call inside the effect admission/dispatch transaction.
 * Saved reads still require their existing current authority checks. */
export async function appConnectionCredentialRepairPurposeIsAvailable(tx:AppRunTransaction,input:{
 org_id:string;resource_binding_id:string;purpose:'effect'|'saved_read';owner_user_id?:string;session_id?:string;
}){
 const sources=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),
  sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${input.resource_binding_id}`,
  sql`(${appConnectionSessions.record}->'credential_repair' IS NULL OR ${appConnectionSessions.record}->'credential_repair'->>'reservation_closed'='true')`)).for('share');
 if(!sources.length){
  // Explicit session operations still require custody. Resource-only legacy
  // callers have no managed session; classify current reviewed identity only.
  // This reader grants no effect authority and never extends consent expiry.
  if(input.session_id)return false;
  const [{loadConsentContinuationBindingIdentity},{assertLegacyOwnerConnectionResourcePolicies}]=await Promise.all([
   import('./app-attachment-sync-authority.js'),import('./app-owner-connection-contract.js')]);
  const authority=await loadConsentContinuationBindingIdentity(tx,{org_id:input.org_id,
   resource_binding_id:input.resource_binding_id,clock:()=>new Date()});
  if(!authority||authority.connection_profile_required!==false
   ||input.owner_user_id&&authority.binding.owner_user_id!==input.owner_user_id)return false;
  try{const {parseAttachmentAppManifest}=await import('@deft/app-kit/core');
   const manifest=parseAttachmentAppManifest(authority.version.manifest);
   assertLegacyOwnerConnectionResourcePolicies(manifest.owner_connections,authority.binding.resource_key);}
  catch{return false;}
  // Absence of custody must not restore a consumed repair reservation.
  return !await appConnectionCredentialRepairReservation(tx,input);
 }
 if(input.purpose==='saved_read')return true;
 return !await appConnectionCredentialRepairReservation(tx,input);
}
/** Caller already holds its source UPDATE when mutating a source. Do not acquire
 * other session SHARE locks after that UPDATE: competing CAS could invert locks. */
export async function appConnectionCredentialRepairReservation(tx:AppRunTransaction,input:{org_id:string;resource_binding_id:string}){
 const [repair]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),
  sql`${appConnectionSessions.record}->'credential_repair'->>'schema_version'='deft.app_connection_credential_repair.v1'`,
  sql`${appConnectionSessions.record}->'credential_repair'->'source'->'scope'->>'resource_binding_id'=${input.resource_binding_id}`,
  sql`COALESCE(${appConnectionSessions.record}->'credential_repair'->>'reservation_closed','false')<>'true'`)).limit(1);
 return repair??null;
}
export async function appConnectionCredentialRepairSourceIsSuperseded(tx:AppRunTransaction,input:{org_id:string;session_id:string}){
 const [repair]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),
  sql`${appConnectionSessions.record}->'credential_repair'->'source'->>'session_id'=${input.session_id}`,
  sql`${appConnectionSessions.record}->'credential_repair'->'receipt' IS NOT NULL AND ${appConnectionSessions.record}->'credential_repair'->'receipt'<>'null'::jsonb`)).limit(1);
 return !!repair;
}
