import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const { Client } = pg;

// drizzle.config.ts loads the repo-root .env, so `drizzle-kit push` sees
// DATABASE_URL. apply-extras.ts runs as a separate `tsx` invocation in the
// `db:push-full` chain and didn't — so a fresh-clone `pnpm db:push-full`
// would push the schema, then die at the extras step. Load the same .env
// here so both halves of push-full see the same env.
const __filename = fileURLToPath(import.meta.url);
loadEnv({ path: resolve(dirname(__filename), '..', '..', '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[apply-extras] DATABASE_URL is required');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '..', 'drizzle');

const files = [
  '0020_wiki_search_vector.sql',
  '0033_tasks_embedding.sql',
];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(resolve(drizzleDir, file), 'utf8');
      await client.query(sql);
      console.log(`[apply-extras] applied ${file}`);
    }

    // Expression-based unique indexes can't be declared in schema.ts, so
    // `drizzle-kit push` silently drops them — migrate-built DBs have them,
    // push-built DBs don't. Re-create the ones the app depends on so both
    // paths behave identically. (migration 0051: org-scoped template slug
    // uniqueness — COALESCE keeps first-party rows globally unique per slug.)
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS agent_employee_templates_org_slug_uniq
         ON agent_employee_templates (COALESCE(org_id, ''), slug)`,
    );
    console.log('[apply-extras] ensured agent_employee_templates_org_slug_uniq');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[apply-extras] failed:', err);
  process.exit(1);
});
