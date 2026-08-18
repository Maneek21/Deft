import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

// Session-scoped advisory locks must not consume the ordinary query pool;
// otherwise enough concurrent long-running workflows could hold every query
// connection while each waits for another query connection.
const advisoryPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 4,
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

/** Drain the shared PostgreSQL pool during process shutdown. */
export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), advisoryPool.end()]);
}
