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
  '0082_module_relations_views.sql',
  '0083_agent_channel_leases.sql',
  '0084_wiki_memory_sync.sql',
  '0085_agent_channel_runtime_reconciliation.sql',
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

    const requiredConstraints = [
      'org_member_unique',
      'module_installations_org_id_id_unique',
      'module_versions_org_installation_id_unique',
      'module_records_org_installation_id_unique',
      'module_versions_org_installation_fk',
      'module_records_org_installation_fk',
      'module_records_validated_version_fk',
      'module_mutation_receipts_org_installation_fk',
      'module_mutation_receipts_record_fk',
      'module_record_relations_org_installation_fk',
      'module_record_relations_source_record_fk',
      'module_record_relations_target_record_fk',
      'module_saved_views_org_installation_fk',
      'module_saved_views_owner_member_fk',
    ];
    const installedConstraints = await client.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conname = ANY($1::text[])`,
      [requiredConstraints],
    );
    const installedConstraintNames = new Set(installedConstraints.rows.map((row) => row.conname));
    const missingConstraints = requiredConstraints.filter((name) => !installedConstraintNames.has(name));
    if (missingConstraints.length > 0) {
      throw new Error(`required database constraints are missing: ${missingConstraints.join(', ')}`);
    }
    console.log('[apply-extras] verified composite module foreign-key constraints');

    const requiredIndexes = [
      'org_member_unique',
      'module_installations_org_id_id_unique',
      'module_versions_org_installation_id_unique',
      'module_records_org_installation_id_unique',
      'module_versions_one_active_unique',
      'module_records_create_idempotency_unique',
      'module_record_relations_active_unique',
      'module_saved_views_active_name_unique',
    ];
    const installedIndexes = await client.query<{ relname: string }>(
      `SELECT relname
         FROM pg_class
        WHERE relkind IN ('i', 'I')
          AND relname = ANY($1::text[])`,
      [requiredIndexes],
    );
    const installedIndexNames = new Set(installedIndexes.rows.map((row) => row.relname));
    const missingIndexes = requiredIndexes.filter((name) => !installedIndexNames.has(name));
    if (missingIndexes.length > 0) {
      throw new Error(`required database indexes are missing: ${missingIndexes.join(', ')}`);
    }
    console.log('[apply-extras] verified module and membership indexes');

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
