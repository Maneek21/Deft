import {continuationSourceIsAvailable} from './app-connection-consent-continuation-fence.js';
import {appConnectionFormSourceIsAvailable} from './app-connection-form-fence.js';
import {appConnectionCredentialRepairPurposeIsAvailable,appConnectionCredentialRepairSourceIsSuperseded} from './app-connection-credential-repair-fence.js';
import {and,eq,sql} from 'drizzle-orm';
import {appConnectionSessions} from '@deft/db/schema';
import type {AppRunTransaction} from './app-run-repository.js';
/** A consumed OAuth upgrade owns its source. A receipt supersedes that source
 * permanently; unfinished or uncertain custody blocks all effects on the same
 * resource. No lease makes an unknown upgrade retryable. */
export async function appConnectionUpgradeSourceIsAvailable(tx:AppRunTransaction,input:{org_id:string;
 owner_user_id?:string;session_id?:string;resource_binding_id?:string;continuation_session_id?:string;purpose?:'effect'|'saved_read'}){
 if(!input.session_id&&!input.resource_binding_id)return false;
 if(input.session_id)await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions)
  .where(and(eq(appConnectionSessions.org_id,input.org_id),eq(appConnectionSessions.session_id,input.session_id),
   input.owner_user_id?eq(appConnectionSessions.owner_user_id,input.owner_user_id):undefined)).limit(1).for('share');
 else await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${input.resource_binding_id!}`,
  sql`(${appConnectionSessions.record}->'credential_repair' IS NULL OR ${appConnectionSessions.record}->'credential_repair'->>'reservation_closed'='true')`)).for('share');
 if(input.session_id&&input.purpose!=='saved_read'&&await appConnectionCredentialRepairSourceIsSuperseded(tx,{org_id:input.org_id,session_id:input.session_id}))return false;
 const [row]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),input.owner_user_id?eq(appConnectionSessions.owner_user_id,input.owner_user_id):undefined,
  sql`${appConnectionSessions.record}->'upgrade'->'begin_consumed'='true'::jsonb`,
  input.session_id?sql`(${appConnectionSessions.record}->'upgrade'->'receipt' <> 'null'::jsonb
    OR ${appConnectionSessions.record}->>'state' NOT IN ('not_connected','disconnected'))`:
   sql`${appConnectionSessions.record}->>'state' NOT IN ('not_connected','disconnected')`,
  input.session_id?sql`${appConnectionSessions.record}->'upgrade'->'source'->>'session_id'=${input.session_id}`:
   and(sql`${appConnectionSessions.record}->'upgrade'->'source'->'scope'->>'resource_binding_id'=${input.resource_binding_id!}`,
     sql`${appConnectionSessions.record}->'upgrade'->'receipt'='null'::jsonb`))).limit(1);
 let resource=input.resource_binding_id;
 if(!resource&&input.session_id){const [source]=await tx.select({record:appConnectionSessions.record}).from(appConnectionSessions).where(and(
  eq(appConnectionSessions.org_id,input.org_id),eq(appConnectionSessions.session_id,input.session_id))).limit(1);
  resource=(source?.record as {scope?:{resource_binding_id?:string}}|undefined)?.scope?.resource_binding_id;}
 return !row&&!!resource&&await appConnectionCredentialRepairPurposeIsAvailable(tx,{org_id:input.org_id,resource_binding_id:resource,purpose:input.purpose??'effect'})
  &&await appConnectionFormSourceIsAvailable(tx,input)&&await continuationSourceIsAvailable(tx,input);
}
