import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { APP_RUN_LIMITS } from '@deft/shared';
import { db } from './db.js';
import type { AppRunKeyReference } from './app-run-keyrings.js';

const ReferenceRowSchema = z.strictObject({
  purpose: z.enum(['run_encryption', 'fingerprint']),
  key_id: z.string().min(1).max(APP_RUN_LIMITS.key_id_chars)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
});

/**
 * Inventories all retained resource-sync key references, including revoked
 * bindings and tombstones. This global scan is for bootstrap and explicit
 * keyring retirement checks, not per-Run submission;
 * locator discovery for one page still needs a checkpoint-locked inventory of
 * every retained projection locator key version.
 */
export async function listAppResourceSyncKeyReferences(
  orgId?: string,
): Promise<readonly AppRunKeyReference[]> {
  const selectedOrgId = orgId === undefined ? null : z.string().uuid().parse(orgId);
  const result = await db.execute(sql<{ purpose: string; key_id: string }>`
    WITH selected_org AS (SELECT ${selectedOrgId}::text AS id), retained_refs AS (
      SELECT 'fingerprint'::text AS purpose, cp.cursor_hmac_key_version AS key_id
        FROM app_sync_checkpoints cp CROSS JOIN selected_org scope
        WHERE scope.id IS NULL OR cp.org_id = scope.id
      UNION ALL
      SELECT 'run_encryption'::text, cp.cursor_key_version
        FROM app_sync_checkpoints cp CROSS JOIN selected_org scope
        WHERE cp.cursor_state = 'value' AND cp.cursor_key_version IS NOT NULL
          AND (scope.id IS NULL OR cp.org_id = scope.id)
      UNION ALL
      SELECT 'fingerprint'::text, projection.resource_id_hmac_key_version
        FROM app_resource_projections projection CROSS JOIN selected_org scope
        WHERE scope.id IS NULL OR projection.org_id = scope.id
      UNION ALL
      SELECT 'run_encryption'::text, projection.provider_id_key_version
        FROM app_resource_projections projection CROSS JOIN selected_org scope
        WHERE scope.id IS NULL OR projection.org_id = scope.id
      UNION ALL
      SELECT 'run_encryption'::text, projection.body_key_version
        FROM app_resource_projections projection CROSS JOIN selected_org scope
        WHERE projection.body_key_version IS NOT NULL
          AND (scope.id IS NULL OR projection.org_id = scope.id)
      UNION ALL
      SELECT 'fingerprint'::text, intent.expected_cursor_hmac_key_version
        FROM app_sync_intents intent
        INNER JOIN app_runs run ON run.org_id = intent.org_id AND run.id = intent.run_id
        CROSS JOIN selected_org scope
        WHERE run.state IN ('pending', 'pending_approval', 'running',
                            'waiting_external', 'unknown_outcome')
          AND (scope.id IS NULL OR intent.org_id = scope.id)
    )
    SELECT DISTINCT purpose, key_id FROM retained_refs ORDER BY purpose, key_id
  `);
  return Object.freeze(result.rows.map((row) =>
    Object.freeze(ReferenceRowSchema.parse(row))));
}
