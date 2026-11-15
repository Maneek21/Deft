import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const UPGRADE = resolve(import.meta.dirname, '../../../../packages/db/upgrades/0.3.0-preview.138-two-step-verification.sql');

/**
 * The two-step tables are created by upgrade 0.3.0-preview.138 (db:push-full
 * and db:upgrade both apply it). A disposable test database whose setup
 * stopped before the upgrade tail has none of them, so apply that same
 * upgrade file once. Returns true when it had to.
 */
export async function ensureTwoStepTables(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.user_two_step') IS NOT NULL AS present");
    if (present.rows[0]?.present) return false;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(UPGRADE, 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return true;
  } finally {
    await client.end();
  }
}
