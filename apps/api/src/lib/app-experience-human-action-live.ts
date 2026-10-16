import { sql } from 'drizzle-orm';
import type { AppRunTransaction, AppRunSafeView } from './app-run-repository.js';

/** Optional trusted-human release provenance; ordinary Worker Runs are unchanged. */
export async function humanActionReleaseIsCurrent(tx: AppRunTransaction, run: AppRunSafeView): Promise<boolean> {
  if (run.provider_kind !== 'app_runtime' || run.initiating_actor_type !== 'human') return true;
  const exists = await tx.execute(sql<{ present: boolean }>`SELECT to_regclass('app_run_human_authorizations') IS NOT NULL AS present`);
  if (!exists.rows[0]?.present) return true;
  // Lock the selected mutable authority before observing its revocation state.
  // LEFT JOIN nullable sides cannot use FOR SHARE; disjoint lookups preserve locks.
  await tx.execute(sql`SELECT g.id FROM app_experience_consent_grants g
    JOIN app_run_human_authorizations h ON h.org_id=g.org_id AND h.consent_grant_id=g.id
    WHERE h.org_id=${run.org_id} AND h.run_id=${run.id} FOR SHARE OF g`);
  await tx.execute(sql`SELECT e.id FROM app_experience_resource_exposures e
    JOIN app_run_human_authorizations h ON h.org_id=e.org_id AND h.exposure_id=e.id
    WHERE h.org_id=${run.org_id} AND h.run_id=${run.id} FOR SHARE OF e`);
  const result = await tx.execute(sql<{ owner_user_id: string; current: boolean }>`
    SELECT h.owner_user_id,
      CASE WHEN h.consent_grant_id IS NOT NULL THEN
        g.id IS NOT NULL AND g.owner_user_id=h.owner_user_id AND g.revoked_at IS NULL AND g.epoch=h.consent_epoch
        AND g.app_installation_id=r.origin_app_installation_id AND g.app_version_id=r.origin_app_version_id
      ELSE e.id IS NOT NULL AND e.owner_user_id=h.owner_user_id AND e.revoked_at IS NULL
        AND e.exposure_epoch=h.exposure_epoch AND e.expires_at>clock_timestamp() END AS current
    FROM app_run_human_authorizations h
    JOIN app_runs r ON r.org_id=h.org_id AND r.id=h.run_id
    LEFT JOIN app_experience_consent_grants g ON g.org_id=h.org_id AND g.id=h.consent_grant_id
    LEFT JOIN app_experience_resource_exposures e ON e.org_id=h.org_id AND e.id=h.exposure_id
    WHERE h.org_id=${run.org_id} AND h.run_id=${run.id}
    FOR SHARE OF h`);
  const link = result.rows[0];
  return !link || (link.owner_user_id === run.initiating_actor_id && link.current === true);
}
