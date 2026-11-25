/**
 * Planning-memory measurement for database tests: how much a fresh backend
 * grows planning one statement. Moved from
 * attention-visibility-narrowing-db.test.ts, unchanged except that the
 * statement is now always given.
 *
 * Why it matters: PostgreSQL plans every branch of a condition whatever the
 * row, and a backend keeps the memory planning took until its connection
 * closes. One oversized condition, planned by four pooled connections at
 * once, ran a 512 MB database machine out of memory (releases 145 to 149).
 * Every list query built on an access check gets a test with this.
 */
import pg from 'pg';
import { safeTestDatabaseUrl } from './safe-test-database.js';

const url = safeTestDatabaseUrl();
/** In CI the database is there: a failure to read /proc on its Linux image fails instead of skipping. */
const inCi = process.env.CI === 'true';

export type Growth = { anon: number; peak: number };

/**
 * How much a fresh backend grows (kB) planning `statement`: its private
 * memory (`RssAnon`, which the backend keeps after the statement) and its
 * peak resident size (`VmHWM`, which also counts the shared catalog pages a
 * new backend reads). Null when the session cannot read /proc.
 *
 * With JIT off, as the API's connections run (lib/db.ts): on a database with
 * rows and statistics the estimated cost of these statements passes
 * jit_above_cost, and even a plain EXPLAIN then sets up JIT compilation,
 * which adds ~50 MB that has nothing to do with planning.
 */
export async function planningGrowth(statement: { sql: string; params: unknown[] }): Promise<Growth | null> {
  if (!url) throw new Error('planningGrowth needs DEFT_TEST_DATABASE_URL set to a disposable test database');
  const backend = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await backend.connect();
  try {
    await backend.query('SET jit = off');
    const read = async (): Promise<Growth | null> => {
      const { rows } = await backend.query(`SELECT substring(s from 'RssAnon:\\s*([0-9]+)')::int AS anon,
        substring(s from 'VmHWM:\\s*([0-9]+)')::int AS peak FROM pg_read_file('/proc/self/status') s`);
      return rows[0]?.anon == null || rows[0]?.peak == null ? null : { anon: rows[0].anon, peak: rows[0].peak };
    };
    let before: Growth | null;
    try { before = await read(); } catch (error) { if (inCi) throw error; return null; }
    if (before == null) { if (inCi) throw new Error('/proc/self/status gave no RssAnon or VmHWM'); return null; }
    await backend.query(`EXPLAIN ${statement.sql}`, statement.params);
    const afterPlanning = (await read())!;
    return { anon: afterPlanning.anon - before.anon, peak: afterPlanning.peak - before.peak };
  } finally {
    await backend.end();
  }
}
