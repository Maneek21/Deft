/**
 * Minimal drizzle client for audit scripts. Reuses the schema from
 * @deft/db but opens its own pg connection (audits may run while the
 * API is also running).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL not set — check root .env');
}

const pool = new pg.Pool({ connectionString });

export const db = drizzle(pool, { schema });
export { schema };
