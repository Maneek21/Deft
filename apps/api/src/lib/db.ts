import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';
import { closeAppAutomationScanDatabase } from './app-automation-scan-db.js';
import { closeExperienceExposureDatabase } from './app-experience-exposure-db.js';
import { closePrivateSearchDatabase } from './app-resource-private-search-db.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: APP_DATABASE_POOL_BUDGET.ordinary,
});

// Session-scoped advisory locks must not consume the ordinary query pool;
// otherwise enough concurrent long-running workflows could hold every query
// connection while each waits for another query connection.
const advisoryPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: APP_DATABASE_POOL_BUDGET.advisory,
});

export const db = drizzle(pool, { schema });

/**
 * Serialize a crash-resumable workflow across processes while allowing the
 * workflow itself to use ordinary Drizzle transactions. PostgreSQL releases
 * the session lock automatically if the process/connection dies.
 */
export async function withDbAdvisoryLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = await advisoryPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    return await run();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    } finally {
      client.release();
    }
  }
}

export type DbAdvisoryLease = { readonly lost: boolean };

/**
 * Hold a session advisory lock on a dedicated advisory-pool connection for
 * the whole of `run`, so another process can tell with
 * `pg_try_advisory_lock` whether the holder is still alive. With
 * `wait: false` the call returns `{ acquired: false }` immediately when the
 * lock is held elsewhere. If the holder connection fails, `lease.lost`
 * turns true and the broken connection is discarded instead of reused.
 */
export async function withDbAdvisoryLease<T>(
  key: string,
  options: { wait: boolean },
  run: (lease: DbAdvisoryLease) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await advisoryPool.connect();
  let lostError: Error | null = null;
  const onError = (error: Error) => { lostError = error; };
  client.on('error', onError);
  let acquired = false;
  try {
    if (options.wait) {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      acquired = true;
    } else {
      const locked = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [key],
      );
      acquired = locked.rows[0]?.acquired === true;
    }
    if (!acquired) return { acquired: false };
    const lease: DbAdvisoryLease = { get lost() { return lostError !== null; } };
    return { acquired: true, value: await run(lease) };
  } finally {
    let releaseError: Error | undefined = lostError ?? undefined;
    if (acquired && !releaseError) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.off('error', onError);
    client.release(releaseError);
  }
}

/** Drain the shared PostgreSQL pool during process shutdown. */
export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), advisoryPool.end(), closeAppAutomationScanDatabase(), closeExperienceExposureDatabase(), closePrivateSearchDatabase()]);
}
