import { sql } from 'drizzle-orm';
import { db } from './db.js';

/** A permanent seal blocks ordinary turns even after the private feature or
 * purpose grant ends. The SQL trigger is the concurrent write fence. */
export async function isPrivateDeftySpace(orgId: string, spaceId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT id FROM app_private_defty_seals WHERE org_id=${orgId} AND space_id=${spaceId} LIMIT 1`);
  return result.rows.length !== 0;
}

export function hasReservedPrivateDeftyMetadata(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'schema_version')
    && typeof (value as Record<string, unknown>).schema_version === 'string'
    && String((value as Record<string, unknown>).schema_version).startsWith('deft.private_defty');
}
