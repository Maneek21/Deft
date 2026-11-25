import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const UPGRADE = resolve(import.meta.dirname, '../../../../packages/db/upgrades/0.3.0-preview.154-note-files.sql');

/**
 * The note_files table is created by upgrade 0.3.0-preview.154 (db:push-full
 * and db:upgrade both apply it). A disposable test database whose setup
 * stopped before the upgrade tail lacks it, so apply that same upgrade file
 * once. Returns true when it had to.
 */
export async function ensureNoteFilesTable(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('public.note_files') IS NOT NULL AS present");
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
