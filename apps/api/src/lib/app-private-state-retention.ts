import { sql } from 'drizzle-orm';
import { db } from './db.js';
/** Expiry denies reads immediately; this bounded sweep destroys retained ciphertext and tombstones. */
export async function purgeExpiredPrivateAppState(): Promise<number> {
  const presence = await db.execute(sql<{ present: string | null }>`SELECT to_regclass('public.app_private_state_records')::text AS present`);
  if (!presence.rows[0]?.present) return 0;
  const result = await db.execute(sql`WITH expired AS (
    SELECT ctid FROM app_private_state_records WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) DELETE FROM app_private_state_records target USING expired WHERE target.ctid=expired.ctid RETURNING target.record_id`);
  return result.rows.length;
}
