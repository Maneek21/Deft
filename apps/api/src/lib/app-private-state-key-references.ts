import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import type { AppRunKeyReference } from './app-run-keyrings.js';
/** Retained ciphertext keeps its key even after session, exposure or App revocation. */
export async function listAppPrivateStateKeyReferences(): Promise<readonly AppRunKeyReference[]> {
  const presence = await db.execute(sql<{ present: string | null }>`SELECT to_regclass('public.app_private_state_records')::text AS present`);
  if (!presence.rows[0]?.present) return [];
  const result = await db.execute(sql<{ key_id: string }>`SELECT DISTINCT key_version AS key_id
    FROM app_private_state_records WHERE body IS NOT NULL ORDER BY key_version`);
  return result.rows.map(row => ({ purpose: 'run_encryption' as const, key_id: z.string().min(1).max(128).parse(row.key_id) }));
}
