import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyReference } from './app-run-keyrings.js';

const reference = z.strictObject({
  purpose: z.enum(['run_encryption', 'fingerprint']),
  key_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
});

/** Retained-message keys survive grant removal, revocation and is_deleted.
 * Fingerprint pins remain required while the purpose grant is retained. */
export async function listPrivateDeftyKeyReferences(tx: Pick<AppRunTransaction, 'execute'>,
  orgId?: string): Promise<readonly AppRunKeyReference[]> {
  const org = orgId === undefined ? null : z.string().uuid().parse(orgId);
  const result = await tx.execute(sql`
    WITH refs AS (
      SELECT 'run_encryption'::text AS purpose,m.metadata#>>'{envelope,key_version}' AS key_id
      FROM messages m INNER JOIN app_private_defty_seals s ON s.org_id=m.org_id AND s.space_id=m.space_id
      WHERE (${org}::text IS NULL OR m.org_id=${org})
      UNION ALL
      SELECT 'fingerprint',snapshot#>>'{model_destination,credential_key_version}'
      FROM app_private_defty_grants WHERE (${org}::text IS NULL OR org_id=${org})
    ) SELECT DISTINCT purpose,key_id FROM refs ORDER BY purpose,key_id
  `);
  return Object.freeze(result.rows.map(row => Object.freeze(reference.parse(row))));
}
