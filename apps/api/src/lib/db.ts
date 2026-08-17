import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

/** Drain the shared PostgreSQL pool during process shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
}
