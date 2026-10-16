import { sql } from 'drizzle-orm';
import type { AppRunTransaction, AppRunSafeView } from './app-run-repository.js';
/** Last per-effect fence: a batch is never a reusable consent or token grant. */
export async function actionBatchReleaseIsCurrent(tx:AppRunTransaction,run:AppRunSafeView) {
 if(run.provider_kind!=='app_runtime')return true;
 const exists=await tx.execute(sql<{present:boolean}>`SELECT to_regclass('app_action_batches') IS NOT NULL AS present`);if(!exists.rows[0]?.present)return true;
 const membership=await tx.execute(sql`SELECT batch_id FROM app_action_batch_items WHERE org_id=${run.org_id} AND run_id=${run.id}`);if(!membership.rows[0])return true;
 // Acquire the same mutable authority locks used by revocation before deciding.
 await tx.execute(sql`SELECT t.id FROM mcp_tokens t JOIN app_action_batches b ON b.org_id=t.org_id AND b.token_id=t.id AND b.token_kind='mcp' JOIN app_action_batch_items i ON i.org_id=b.org_id AND i.batch_id=b.id WHERE i.org_id=${run.org_id} AND i.run_id=${run.id} FOR SHARE OF t`);
 await tx.execute(sql`SELECT t.id,g.id FROM oauth_access_tokens t JOIN oauth_grants g ON g.id=t.grant_id JOIN app_action_batches b ON b.org_id=t.org_id AND b.token_id=t.id AND b.token_kind='oauth' JOIN app_action_batch_items i ON i.org_id=b.org_id AND i.batch_id=b.id WHERE i.org_id=${run.org_id} AND i.run_id=${run.id} FOR SHARE OF t,g`);
 await tx.execute(sql`SELECT p.runtime_binding_id FROM app_runtime_agent_policies p JOIN app_action_batches b ON b.org_id=p.org_id AND b.owner_user_id=p.owner_user_id AND b.runtime_binding_id=p.runtime_binding_id JOIN app_action_batch_items i ON i.org_id=b.org_id AND i.batch_id=b.id WHERE i.org_id=${run.org_id} AND i.run_id=${run.id} FOR SHARE OF p`);
 const result=await tx.execute(sql<{current:boolean}>`SELECT
   b.state='approved' AND b.cancelled_at IS NULL AND g.revoked_at IS NULL AND g.epoch=b.consent_epoch
   AND g.owner_user_id=b.owner_user_id AND g.app_installation_id=r.origin_app_installation_id AND g.app_version_id=r.origin_app_version_id
   AND EXISTS(SELECT 1 FROM app_runtime_agent_policies p WHERE p.org_id=b.org_id AND p.owner_user_id=b.owner_user_id AND p.runtime_binding_id=b.runtime_binding_id AND p.mode='require_approval' AND p.revision=b.policy_revision AND b.policy_revision>=0)
   AND (b.token_id IS NULL OR CASE WHEN b.token_kind='mcp' THEN EXISTS(SELECT 1 FROM mcp_tokens t WHERE t.org_id=b.org_id AND t.id=b.token_id AND t.revoked_at IS NULL AND t.app_run_authorization_version=b.token_version AND ARRAY['read:apps','invoke:apps']::text[] <@ t.scopes AND ((b.employee_id IS NULL AND t.user_id=b.owner_user_id AND t.principal_kind='human') OR (b.employee_id IS NOT NULL AND t.agent_employee_id=b.employee_id AND t.principal_kind='agent')))
    ELSE EXISTS(SELECT 1 FROM oauth_access_tokens t JOIN oauth_grants og ON og.id=t.grant_id WHERE t.org_id=b.org_id AND t.id=b.token_id AND t.user_id=b.owner_user_id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND t.app_run_authorization_version=b.token_version AND ARRAY['read:apps','invoke:apps']::text[] <@ t.scopes AND og.org_id=b.org_id AND og.user_id=b.owner_user_id AND og.client_id=t.client_id AND ARRAY['read:apps','invoke:apps']::text[] <@ og.scopes AND og.revoked_at IS NULL) END) AS current
  FROM app_action_batch_items i JOIN app_runs r ON r.org_id=i.org_id AND r.id=i.run_id JOIN app_action_batches b ON b.org_id=i.org_id AND b.id=i.batch_id JOIN app_experience_consent_grants g ON g.org_id=b.org_id AND g.id=b.consent_grant_id
  WHERE i.org_id=${run.org_id} AND i.run_id=${run.id} FOR SHARE OF b,g`);
 return result.rows[0]?.current===true;
}
