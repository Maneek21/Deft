import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';

const { Client } = pg;

loadRootEnv(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '..', 'drizzle');
const upgradesDir = resolve(__dirname, '..', 'upgrades');
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
  '0086_attachment_links.sql',
  '0087_attachment_processing.sql',
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

    const appsV0File = '0.3.0-preview.16-declarative-apps-v0.sql';
    await client.query(readFileSync(resolve(upgradesDir, appsV0File), 'utf8'));
    console.log(`[apply-extras] applied ${appsV0File}`);

    const appRunsFoundationFile = '0.3.0-preview.17-governed-app-runs-foundation.sql';
    await client.query(readFileSync(resolve(upgradesDir, appRunsFoundationFile), 'utf8'));
    console.log(`[apply-extras] applied ${appRunsFoundationFile}`);

    const appRunEngineHardeningFile = '0.3.0-preview.18-governed-app-run-engine-hardening.sql';
    await client.query(readFileSync(resolve(upgradesDir, appRunEngineHardeningFile), 'utf8'));
    console.log(`[apply-extras] applied ${appRunEngineHardeningFile}`);

    const appRunCutoverGateFile = '0.3.0-preview.19-governed-app-run-cutover-gate.sql';
    await client.query(readFileSync(resolve(upgradesDir, appRunCutoverGateFile), 'utf8'));
    console.log(`[apply-extras] applied ${appRunCutoverGateFile}`);

    const appRunLiveAuthorityFile = '0.3.0-preview.20-app-run-live-authority-versions.sql';
    await client.query(readFileSync(resolve(upgradesDir, appRunLiveAuthorityFile), 'utf8'));
    console.log(`[apply-extras] applied ${appRunLiveAuthorityFile}`);

    const appRunAncestryGuardFile = '0.3.0-preview.21-app-run-ancestry-guard.sql';
    await client.query(readFileSync(resolve(upgradesDir, appRunAncestryGuardFile), 'utf8'));
    console.log(`[apply-extras] applied ${appRunAncestryGuardFile}`);

    const resourceRelationsFile = '0.3.0-preview.22-resource-relations.sql';
    await client.query(readFileSync(resolve(upgradesDir, resourceRelationsFile), 'utf8'));
    console.log(`[apply-extras] applied ${resourceRelationsFile}`);

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
      'app_installations_active_version_fk',
      'app_versions_org_installation_fk',
      'app_module_bindings_app_installation_fk',
      'app_module_bindings_app_version_fk',
      'app_module_bindings_module_installation_fk',
      'app_module_bindings_module_version_fk',
      'app_developer_pairings_creator_member_fk',
      'capability_provider_snapshots_org_id_id_unique',
      'app_runs_org_id_id_unique',
      'app_runs_org_provider_snapshot_fk',
      'app_runs_org_root_run_fk',
      'app_runs_org_parent_run_fk',
      'app_run_attempts_org_run_fk',
      'app_run_attempts_org_run_id_unique',
      'app_run_attempts_retry_of_fk',
      'app_runs_idempotency_expiry_check',
      'app_runs_attempt_limit_check',
      'app_runs_cancel_request_check',
      'app_runs_execution_release_shape_check',
      'app_runs_budget_reservation_shape_check',
      'app_run_attempts_retry_shape_check',
      'app_run_secret_payloads_org_run_fk',
      'app_run_secret_payloads_org_attempt_fk',
      'app_run_events_org_run_fk',
      'app_run_receipts_org_run_fk',
      'app_run_receipts_org_attempt_fk',
      'agent_actions_org_app_run_fk',
      'agent_actions_app_run_shape_check',
      'org_members_app_run_authorization_version_check',
      'agent_employees_app_run_authorization_version_check',
      'mcp_connections_app_run_authorization_version_check',
      'mcp_tool_overrides_app_run_authorization_version_check',
      'mcp_tokens_app_run_authorization_version_check',
      'oauth_access_tokens_app_run_authorization_version_check',
      'resource_relation_sets_org_id_id_unique',
      'resource_relation_edges_org_set_fk',
      'resource_relation_receipts_org_set_fk',
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
      'app_installations_org_app_id_unique',
      'app_installations_org_lineage_unique',
      'app_versions_one_active_unique',
      'app_module_bindings_app_module_unique',
      'app_module_bindings_owned_module_unique',
      'app_developer_pairings_code_hash_unique',
      'app_developer_pairings_session_hash_unique',
      'capability_provider_snapshots_identity_digest_unique',
      'app_runs_idempotency_lookup_idx',
      'app_run_attempts_number_unique',
      'app_run_attempts_one_active_unique',
      'app_runs_idempotency_expiry_idx',
      'app_run_secret_payloads_input_unique',
      'app_run_secret_payloads_output_unique',
      'app_run_events_sequence_unique',
      'app_run_receipts_key_unique',
      'agent_action_app_run_unique',
      'resource_relation_sets_identity_unique',
      'resource_relation_edges_active_target_unique',
      'resource_relation_edges_active_position_unique',
      'resource_relation_receipts_idempotency_unique',
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

    const requiredAppRunTriggers = [
      'capability_provider_snapshots_append_only_trigger',
      'app_runs_state_identity_trigger',
      'app_run_attempts_state_identity_trigger',
      'app_run_secret_payloads_append_only_trigger',
      'app_run_events_append_only_trigger',
      'app_run_receipts_append_only_trigger',
      'app_runs_cutover_gate_trigger',
      'app_run_attempts_execution_release_trigger',
      'app_runs_ancestry_insert_trigger',
      'org_members_app_run_authorization_version_trigger',
      'agent_employees_app_run_authorization_version_trigger',
      'mcp_connections_app_run_authorization_version_trigger',
      'mcp_tool_overrides_app_run_authorization_version_trigger',
      'mcp_tokens_app_run_authorization_version_trigger',
      'oauth_access_tokens_app_run_authorization_version_trigger',
    ];
    const installedAppRunTriggers = await client.query<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])`,
      [requiredAppRunTriggers],
    );
    const installedAppRunTriggerNames = new Set(installedAppRunTriggers.rows.map((row) => row.tgname));
    const missingAppRunTriggers = requiredAppRunTriggers.filter(
      (name) => !installedAppRunTriggerNames.has(name),
    );
    if (missingAppRunTriggers.length > 0) {
      throw new Error(`required App Run triggers are missing: ${missingAppRunTriggers.join(', ')}`);
    }
    console.log('[apply-extras] verified dormant App Run constraints, indexes, and triggers');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[apply-extras] failed against ${maskDatabaseUrl(databaseUrl)}:`, err);
  process.exit(1);
});
