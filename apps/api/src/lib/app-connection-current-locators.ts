import {and,eq,sql} from 'drizzle-orm';
import {appResourceBindings,appInstallations,appConnectionSessions} from '@deft/db/schema';
import type {AppRunTransaction} from './app-run-repository.js';

/** Successful custody transitions retain their source rows. Only a published
 * success receipt removes that source from metadata nomination; pending and
 * uncertain work still reaches the existing locked availability fences. */
function noPublishedConnectionSuccessor(){
 return and(
  sql`NOT EXISTS (SELECT 1 FROM app_connection_sessions published_successor
   WHERE published_successor.org_id=${appConnectionSessions.org_id}
   AND published_successor.owner_user_id=${appConnectionSessions.owner_user_id}
   AND ((published_successor.record->'upgrade'->>'schema_version'='deft.app_connection_upgrade.v1'
    AND published_successor.record->'upgrade'->'begin_consumed'='true'::jsonb
    AND published_successor.record->'upgrade'->'source'->>'session_id'=${appConnectionSessions.session_id}
    AND jsonb_typeof(published_successor.record->'upgrade'->'receipt')='object')
   OR (published_successor.record->'credential_repair'->>'schema_version'='deft.app_connection_credential_repair.v1'
    AND published_successor.record->'credential_repair'->'source'->>'session_id'=${appConnectionSessions.session_id}
    AND jsonb_typeof(published_successor.record->'credential_repair'->'receipt')='object')))`,
  sql`NOT EXISTS (SELECT 1 FROM app_connection_consent_continuations published_continuation
   WHERE published_continuation.org_id=${appConnectionSessions.org_id}
   AND published_continuation.owner_user_id=${appConnectionSessions.owner_user_id}
   AND published_continuation.source_session_id=${appConnectionSessions.session_id}
   AND published_continuation.record->'activation_started'='true'::jsonb
   AND published_continuation.record->>'state'='connected'
   AND published_continuation.record->'result'->>'state'='connected'
   AND published_continuation.record->'result'->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$')`,
  sql`NOT EXISTS (SELECT 1 FROM app_connection_forms published_form
   WHERE published_form.org_id=${appConnectionSessions.org_id}
   AND published_form.owner_user_id=${appConnectionSessions.owner_user_id}
   AND published_form.record->'source'->>'session_id'=${appConnectionSessions.session_id}
   AND published_form.record->'begin_consumed'='true'::jsonb
   AND published_form.record->>'state'='connected'
   AND jsonb_typeof(published_form.record->'receipt')='object')`);
}

export function currentConnectionBindingLocators(tx:Pick<AppRunTransaction,'select'>,
 caller:{org_id:string;user_id:string},nomination:{installation_id:string;target_key?:string}){
 // Unlocked locators only. The live authority reader still takes human/App/
 // registration/binding locks and independently reconstructs the full grant.
 return tx.select({id:appResourceBindings.id,target_key:appResourceBindings.target_key}).from(appResourceBindings)
 .innerJoin(appInstallations,and(eq(appResourceBindings.org_id,appInstallations.org_id),
  eq(appResourceBindings.app_installation_id,appInstallations.id))).where(and(
  eq(appResourceBindings.org_id,caller.org_id),eq(appResourceBindings.owner_user_id,caller.user_id),
  eq(appResourceBindings.app_installation_id,nomination.installation_id),eq(appResourceBindings.state,'active'),
  nomination.target_key===undefined?undefined:eq(appResourceBindings.target_key,nomination.target_key),
  eq(appInstallations.state,'active'),eq(appInstallations.active_grant_snapshot_kind,'effective'),
  eq(appResourceBindings.app_version_id,appInstallations.active_version_id),
  eq(appResourceBindings.grant_snapshot_id,appInstallations.active_grant_snapshot_id)));
}

/** Metadata nomination only; the caller still proves fresh locked authority. */
export function currentConsentContinuationSourceLocators(tx:Pick<AppRunTransaction,'select'>,
 caller:{org_id:string;user_id:string},binding:{id:string;consent_expires_at:Date|null;consent_lifetime?:'until_revoked'|null}){
 return tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,caller.org_id),
  eq(appConnectionSessions.owner_user_id,caller.user_id),
  sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${binding.id}`,
  sql`${appConnectionSessions.record}->>'state'='connected'`,
  sql`${appConnectionSessions.record}->'scope'->>'consent_expires_at' IS NOT DISTINCT FROM ${binding.consent_expires_at?.toISOString()??null}`,
  sql`${appConnectionSessions.record}->'scope'->>'consent_lifetime' IS NOT DISTINCT FROM ${binding.consent_lifetime??null}`,
  noPublishedConnectionSuccessor()));
}

/** Retained old account rows remain durable, but cannot enter the current data
 * catalog or trigger provider metadata I/O after an app upgrade. */
export function currentConnectionSessionLocators(tx:Pick<AppRunTransaction,'select'>,
 caller:{org_id:string;user_id:string},installationId:string,targetKey?:string){
 return tx.select({session:appConnectionSessions}).from(appConnectionSessions).innerJoin(appInstallations,and(
  eq(appConnectionSessions.org_id,appInstallations.org_id),
  eq(sql`${appConnectionSessions.record}->'scope'->>'installation_id'`,sql`${appInstallations.id}::text`))).where(and(
  eq(appConnectionSessions.org_id,caller.org_id),eq(appConnectionSessions.owner_user_id,caller.user_id),
  eq(appInstallations.id,installationId),targetKey===undefined?undefined:eq(sql`${appConnectionSessions.record}->'scope'->>'target_key'`,targetKey),eq(appInstallations.state,'active'),eq(appInstallations.active_grant_snapshot_kind,'effective'),
  eq(sql`${appConnectionSessions.record}->'scope'->>'app_version_id'`,sql`${appInstallations.active_version_id}::text`),
  eq(sql`${appConnectionSessions.record}->'scope'->>'grant_snapshot_id'`,sql`${appInstallations.active_grant_snapshot_id}::text`),
  noPublishedConnectionSuccessor(),
  eq(sql`${appConnectionSessions.record}->>'state'`,'connected')));
}
