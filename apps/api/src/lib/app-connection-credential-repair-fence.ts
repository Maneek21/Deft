import {and,eq,sql} from 'drizzle-orm';
import {appConnectionSessions} from '../../../../packages/db/src/app-connection-session-schema.js';
import type {AppRunTransaction} from './app-run-repository.js';

/** Candidate seam: call inside the effect admission/dispatch transaction.
 * Saved reads still require their existing current authority checks. */
export async function appConnectionCredentialRepairPurposeIsAvailable(tx:AppRunTransaction,input:{
 org_id:string;resource_binding_id:string;purpose:'effect'|'saved_read';
}){
 const sources=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),
  sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${input.resource_binding_id}`,
  sql`(${appConnectionSessions.record}->'credential_repair' IS NULL OR ${appConnectionSessions.record}->'credential_repair'->>'reservation_closed'='true')`)).for('share');
 if(!sources.length)return false;
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
