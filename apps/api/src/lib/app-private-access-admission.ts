import { sql } from 'drizzle-orm';
import type { AppRunTransaction } from './app-run-repository.js';
import { ACCESS_LIMITS, PrivateResourceAccessError } from './app-resource-access-contract.js';

/** Both accept paths hold owner + destination memberships UPDATE. A new
 * disclosure purpose cannot double the existing tenant-scoped admission caps. */
export async function assertPrivateAccessAdmission(tx: AppRunTransaction, org: string, owner: string, app: string, subject: string) {
  const rows = await tx.execute(sql`
    SELECT count(*) FILTER(WHERE owner_user_id=${owner} AND app_installation_id=${app})::int AS owner_retained,
      count(*) FILTER(WHERE subject_user_id=${subject})::int AS recipient_retained,
      count(*) FILTER(WHERE owner_user_id=${owner} AND app_installation_id=${app} AND revoked_at IS NULL AND expires_at>clock_timestamp())::int AS owner_active,
      count(*) FILTER(WHERE subject_user_id=${subject} AND revoked_at IS NULL AND expires_at>clock_timestamp())::int AS recipient_active
    FROM (
      SELECT owner_user_id,app_installation_id,recipient_user_id AS subject_user_id,revoked_at,expires_at
      FROM app_resource_access_grants WHERE org_id=${org} AND ((owner_user_id=${owner} AND app_installation_id=${app}) OR recipient_user_id=${subject})
      UNION ALL
      SELECT owner_user_id,app_installation_id,subject_user_id,revoked_at,expires_at
      FROM app_private_mcp_grants WHERE org_id=${org} AND ((owner_user_id=${owner} AND app_installation_id=${app}) OR subject_user_id=${subject})
    ) bounded_grants`);
  const counts = rows.rows[0];
  if (!counts || Number(counts.owner_retained) >= ACCESS_LIMITS.owner_retained
    || Number(counts.recipient_retained) >= ACCESS_LIMITS.recipient_retained
    || Number(counts.owner_active) >= ACCESS_LIMITS.owner_active
    || Number(counts.recipient_active) >= ACCESS_LIMITS.recipient_active) {
    throw new PrivateResourceAccessError('APP_RESOURCE_ACCESS_LIMIT', 409);
  }
}
