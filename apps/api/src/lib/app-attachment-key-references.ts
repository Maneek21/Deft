import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { APP_RUN_LIMITS } from '@deft/shared';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyReference } from './app-run-keyrings.js';

const reference = z.strictObject({ purpose:z.enum(['run_encryption','fingerprint']),
  key_id:z.string().min(1).max(APP_RUN_LIMITS.key_id_chars).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u) });

/** Bootstrap/explicit retirement inventory. Revocation and retirement retain
 * keys until confirmed object purge also clears encrypted metadata. Callers
 * use the bounded attachment pool; default-off hosts never enter this query. */
export async function listAppAttachmentKeyReferences(tx:Pick<AppRunTransaction,'execute'>,orgId?:string):Promise<readonly AppRunKeyReference[]>{
  const selected=orgId===undefined?null:z.uuid().parse(orgId);
  const result=await tx.execute(sql`
    WITH retained AS (
      SELECT fingerprint_key_version,binary_key_version,metadata_envelope
      FROM app_attachment_stages
      WHERE state <> 'purged' AND (${selected}::text IS NULL OR org_id=${selected})
    ), refs AS (
      SELECT 'fingerprint'::text AS purpose,fingerprint_key_version AS key_id FROM retained
      UNION ALL SELECT 'run_encryption',binary_key_version FROM retained WHERE binary_key_version IS NOT NULL
      UNION ALL SELECT 'run_encryption',metadata_envelope->>'key_version' FROM retained WHERE metadata_envelope IS NOT NULL
    ) SELECT DISTINCT purpose,key_id FROM refs ORDER BY purpose,key_id
  `);
  return Object.freeze(result.rows.map(row=>Object.freeze(reference.parse(row))));
}
