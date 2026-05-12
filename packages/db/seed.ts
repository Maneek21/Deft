/**
 * Production-safe seeder — idempotent. Inserts ONLY the platform bundle that ships
 * with every Deft install:
 *
 *   - Defty system user (`deft-agent@system.local`) — the well-known account that
 *     authors agent replies in chat threads
 *
 * This is the DB-side prod seed. The full prod seed also includes bundled skills,
 * bundled task templates, and first-party employee templates — those live in
 * `@deft/api` (`apps/api/src/scripts/seed-platform-bundles.ts`) because they import
 * the canonical catalogs from the api package's `lib/bundled-*.ts`. The root
 * `pnpm db:seed` proxy chains both: this script first, then the api-side bundle seed.
 *
 *   - NEVER deletes anything. Re-running on a populated workspace is a near-no-op.
 *   - Uses `ON CONFLICT (email) DO NOTHING` for safety on re-runs.
 *   - NO test users (maneek/rahul/priya/arjun/sara). Those are demo-only — see
 *     `pnpm db:seed:demo`.
 *
 * For the dev experience with demo content (5 test users, demo org, sample
 * messages and tasks), use `pnpm db:seed:demo` — destructive, wipes the DB.
 *
 * Run:
 *   pnpm db:seed
 *   # or directly:
 *   pnpm --filter @deft/db seed
 *
 * Importable: `seedDeftyUser(db)` — used by `seed-demo.ts` to restore the
 * Defty user after the demo wipe.
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './src/schema.js';

const { Pool } = pg;

const AGENT_EMAIL = 'deft-agent@system.local';
const AGENT_NAME = 'Deft';

/**
 * Idempotent seeder for the well-known Defty system user
 * (`deft-agent@system.local`). Safe to call repeatedly — uses
 * ON CONFLICT DO NOTHING on the unique `email` column.
 *
 * Accepts an existing Drizzle handle so demo seeders can chain into this without
 * opening a second connection pool.
 *
 * NOTE: This only seeds the Defty user. Bundled skills / task templates /
 * employee templates live in the api-side orchestrator (also confusingly
 * named `seedPlatformBundles`) at
 * `apps/api/src/scripts/seed-platform-bundles.ts`.
 */
export async function seedDeftyUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<void> {
  console.log('[seed-platform] Upserting Defty system user (deft-agent@system.local)');
  // users.id is text NOT NULL with no DB default — Drizzle generates ids client-
  // side in the typed insert API, but raw SQL bypasses that. Pin a stable id
  // for the well-known system account so other code can reference it directly.
  await db.execute(sql`
    INSERT INTO users (id, email, name, email_verified, is_agent, kind)
    VALUES ('deft-system-agent', ${AGENT_EMAIL}, ${AGENT_NAME}, true, true, 'agent')
    ON CONFLICT (email) DO NOTHING
  `);
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft',
  });
  const db = drizzle(pool, { schema });

  console.log('Seeding database (prod-safe, idempotent)...');
  await seedDeftyUser(db);

  console.log('\nPlatform seed complete.');
  console.log('Next: run `pnpm --filter @deft/api exec tsx src/scripts/seed-platform-bundles.ts`');
  console.log('to upsert bundled skills, task templates, and employee templates.');
  console.log('(The root `pnpm db:seed` proxy already does this for you.)');

  await pool.end();
}

// Run when invoked directly (not when imported by seed-demo.ts).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('seed.ts') || entry.endsWith('seed.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
