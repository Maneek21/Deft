import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';

const { Client } = pg;

loadRootEnv(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '..', 'drizzle');
const databaseUrl = resolveDatabaseUrl();

const files = [
  '0020_wiki_search_vector.sql',
  '0033_tasks_embedding.sql',
  '0074_wiki_provenance_graph_scope.sql',
  // drizzle-kit cannot express the immutable module-version trigger. The SQL
  // is idempotent and also carries the expression/partial indexes that a
  // fresh push must share with the supported upgrade path.
  '0081_modules_v1.sql',
];

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(resolve(drizzleDir, file), 'utf8');
      await client.query(sql);
      console.log(`[apply-extras] applied ${file}`);
    }

    // Expression-based unique indexes can't be declared in schema.ts, so
    // `drizzle-kit push` silently drops them. Re-create the ones the app
    // depends on so pushed and migrated databases behave the same.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS agent_employee_templates_org_slug_uniq
         ON agent_employee_templates (COALESCE(org_id, ''), slug)`,
    );
    console.log('[apply-extras] ensured agent_employee_templates_org_slug_uniq');

    const moduleVersionTrigger = await client.query<{ installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'module_versions_immutable_fields_trigger'
          AND NOT tgisinternal
      ) AS installed
    `);
    if (!moduleVersionTrigger.rows[0]?.installed) {
      throw new Error('module_versions immutability trigger was not installed');
    }
    console.log('[apply-extras] verified module_versions_immutable_fields_trigger');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[apply-extras] failed against ${maskDatabaseUrl(databaseUrl)}:`, err);
  process.exit(1);
});
