import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';
import { freshBootstrapSql } from './fresh-bootstrap-sql.mjs';

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
    const ledgerExists = (await client.query<{ installed: boolean }>(`
      SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS installed
    `)).rows[0]?.installed === true;
    const freshInitialization = !ledgerExists && process.argv.includes('--fresh-init');
    for (const file of files) {
      const sql = readFileSync(resolve(drizzleDir, file), 'utf8');
      await client.query(freshInitialization ? freshBootstrapSql(file,sql) : sql);
      console.log(`[apply-extras] applied ${file}`);
    }

    const connectedLifecycleInstalled = (await client.query<{ installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'app_installations_grant_coherence_trigger'
           AND NOT tgisinternal
      ) AS installed
    `)).rows[0]?.installed === true;
    const connectedFoundationInstalled = (await client.query<{ installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'app_grant_snapshots_lineage_trigger'
           AND NOT tgisinternal
      ) AS installed
    `)).rows[0]?.installed === true;
    const connectedLifecycleRecorded = ledgerExists && (await client.query<{ installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM deft_schema_migrations
         WHERE version = '0.3.0-preview.24'
      ) AS installed
    `)).rows[0]?.installed === true;
    // Fresh pushes already contain the current declarative-App tables from
    // schema.ts, so .16 must not be replayed unchanged: retain its circular
    // active-version FK while omitting the obsolete one-binding-per-Module
    // index. Reconcile the connected lifecycle and cutover migrations whenever either the
    // durable migration ledger or an earlier connected-foundation trigger
    // proves this is an existing App database, even if a .24 trigger is being
    // repaired.
    if (!connectedLifecycleInstalled && !connectedFoundationInstalled && !connectedLifecycleRecorded) {
      const appsV0File = '0.3.0-preview.16-declarative-apps-v0.sql';
      const appsV0Sql = readFileSync(resolve(upgradesDir, appsV0File), 'utf8');
      const currentAppsV0Sql = appsV0Sql.replace(
        /CREATE UNIQUE INDEX IF NOT EXISTS app_module_bindings_owned_module_unique[^;]+;\s*/,
        '',
      );
      if (currentAppsV0Sql === appsV0Sql) {
        throw new Error('failed to remove obsolete App Module owner index from fresh-schema extras');
      }
      await client.query(currentAppsV0Sql);
      console.log(`[apply-extras] applied ${appsV0File} without obsolete owner index`);

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

      const connectedAppGrantsFile = '0.3.0-preview.23-connected-app-grants-foundation.sql';
      await client.query(readFileSync(resolve(upgradesDir, connectedAppGrantsFile), 'utf8'));
      console.log(`[apply-extras] applied ${connectedAppGrantsFile}`);

      const connectedAppReviewFile = '0.3.0-preview.24-connected-app-review-lifecycle.sql';
      await client.query(readFileSync(resolve(upgradesDir, connectedAppReviewFile), 'utf8'));
      console.log(`[apply-extras] applied ${connectedAppReviewFile}`);
    } else {
      const connectedAppReviewFile = '0.3.0-preview.24-connected-app-review-lifecycle.sql';
      await client.query(readFileSync(resolve(upgradesDir, connectedAppReviewFile), 'utf8'));
      console.log(`[apply-extras] reconciled ${connectedAppReviewFile}`);
    }

    const appOriginCutoverFile = '0.3.0-preview.25-app-origin-run-cutover.sql';
    await client.query(readFileSync(resolve(upgradesDir, appOriginCutoverFile), 'utf8'));
    console.log(`[apply-extras] reconciled ${appOriginCutoverFile}`);

    // Track A remains dormant at runtime, but fresh pushes still need the same
    // v2 protocol checks, definition/fire guards, and exact Run lineage as the
    // supported upgrade path. Keep this after .25 because .24/.25 reconciliation
    // restores historical v1-only function bodies and Run checks.
    const appAutomationFoundationFile = '0.3.0-preview.26-app-automation-foundation.sql';
    await client.query(readFileSync(resolve(upgradesDir, appAutomationFoundationFile), 'utf8'));
    console.log(`[apply-extras] reconciled ${appAutomationFoundationFile}`);
    const webSessionFile = '0.3.0-preview.27-web-session-families.sql';
    await client.query(readFileSync(resolve(upgradesDir, webSessionFile), 'utf8'));
    console.log(`[apply-extras] reconciled ${webSessionFile}`);
    const passwordGenerationFile = '0.3.0-preview.28-password-generation.sql';
    await client.query(readFileSync(resolve(upgradesDir, passwordGenerationFile), 'utf8'));
    console.log(`[apply-extras] reconciled ${passwordGenerationFile}`);
    const nativeCreateFile = '0.3.0-preview.29-native-create-requests.sql';
    await client.query(readFileSync(resolve(upgradesDir, nativeCreateFile), 'utf8'));
    console.log(`[apply-extras] reconciled ${nativeCreateFile}`);

    // Drizzle declares the native tables but cannot declare their GIN index
    // or trigger function. Bootstrap only empty, unledgered fresh tables;
    // retained databases must pass the unchanged migration114 shape guard.
    if (!ledgerExists && process.argv.includes('--fresh-init')) {
      const nativeRows = await client.query<{ present: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM native_reference_states LIMIT 1)
          OR EXISTS (SELECT 1 FROM native_mention_deliveries LIMIT 1) AS present
      `);
      if (nativeRows.rows[0]?.present !== false) throw new Error('E5_FRESH_NATIVE_TABLE_NOT_EMPTY');
      const nativeMentionsFile = '0.3.0-preview.61-native-mentions.sql';
      await client.query(readFileSync(resolve(upgradesDir, nativeMentionsFile), 'utf8'));
      console.log(`[apply-extras] reconciled ${nativeMentionsFile}`);
    }

    // These additive, dormant surfaces must follow the historical App Run
    // reconciliations, which restore the predecessor's provider/ancestry checks.
    for (const platformFile of [
      '0.3.0-preview.31-app-runtime-channel.sql',
      '0.3.0-preview.32-app-public-claims.sql',
      '0.3.0-preview.33-app-runtime-authoring.sql',
      '0.3.0-preview.34-app-installed-authoring.sql',
      '0.3.0-preview.35-app-public-runtime.sql',
      '0.3.0-preview.36-app-experience-sessions.sql',
      '0.3.0-preview.37-app-resource-sync.sql',
      '0.3.0-preview.38-app-resource-authoring.sql',
      '0.3.0-preview.39-app-resource-consent.sql',
      '0.3.0-preview.40-app-experience-resource-exposure.sql',
      '0.3.0-preview.41-app-public-availability.sql',
      '0.3.0-preview.42-app-public-budgets.sql',
      '0.3.0-preview.43-app-public-hmac.sql',
      '0.3.0-preview.44-app-native-calendar.sql',
      '0.3.0-preview.45-app-resource-access.sql',
      '0.3.0-preview.46-app-public-control.sql',
      '0.3.0-preview.47-app-attachment-custody.sql',
      '0.3.0-preview.48-app-public-cancellation.sql',
      '0.3.0-preview.49-app-private-mcp.sql',
      '0.3.0-preview.50-app-attachment-grant-admission.sql',
      '0.3.0-preview.51-app-attachment-composition.sql',
      '0.3.0-preview.52-private-defty-context.sql',
      '0.3.0-preview.53-app-private-state.sql',
      '0.3.0-preview.54-app-experience-consent.sql',
      '0.3.0-preview.55-app-action-batches.sql',
      '0.3.0-preview.56-app-action-batch-policy-revision.sql',
      '0.3.0-preview.57-app-owner-targets.sql',
      '0.3.0-preview.58-app-pdf-media.sql',
      '0.3.0-preview.59-app-private-file-custody.sql',
      '0.3.0-preview.60-app-owner-connections.sql',
      '0.3.0-preview.61-owner-resource-page-limits.sql',
      '0.3.0-preview.62-app-action-resources.sql',
      '0.3.0-preview.63-native-email-mailbox.sql',
      '0.3.0-preview.64-email-reading-preferences.sql',
      '0.3.0-preview.65-email-imap-credentials.sql',
      '0.3.0-preview.66-email-native-drafts.sql',
      '0.3.0-preview.67-email-native-operations.sql',
      '0.3.0-preview.68-email-native-send.sql',
      '0.3.0-preview.69-email-native-attachments.sql',
      '0.3.0-preview.70-email-provider-draft-mirrors.sql',
      '0.3.0-preview.71-email-draft-sync-journal.sql',
      '0.3.0-preview.72-email-outbox.sql',
      '0.3.0-preview.73-email-outbox-attempt-markers.sql',
      '0.3.0-preview.74-email-graph-send-upload.sql',
      '0.3.0-preview.76-email-templates.sql',
      '0.3.0-preview.77-email-signatures.sql',
      '0.3.0-preview.78-email-imap-move-aliases.sql',
      '0.3.0-preview.79-email-smtp-sent-copy.sql',
      '0.3.0-preview.80-email-native-timers.sql',
      '0.3.0-preview.81-email-presentation-cache.sql',
      '0.3.0-preview.82-email-standalone-account-consent.sql',
      '0.3.0-preview.83-email-rules.sql',
      '0.3.0-preview.84-email-rule-receipts.sql',
      '0.3.0-preview.85-email-native-connections.sql',
      '0.3.0-preview.87-email-notifications-unread.sql',
      '0.3.0-preview.88-email-calendar-invitations.sql',
      '0.3.0-preview.89-email-context-transfers.sql',
      '0.3.0-preview.90-email-context-transfer-chat.sql',
      '0.3.0-preview.91-email-knowledge.sql',
      '0.3.0-preview.92-email-agent-grants.sql',
      '0.3.0-preview.93-email-folder-management.sql',
      '0.3.0-preview.94-app-connection-sessions.sql',
      '0.3.0-preview.95-app-data.sql',
      '0.3.0-preview.96-app-data-identity-checks.sql',
      '0.3.0-preview.97-app-connection-reattachment.sql',
      '0.3.0-preview.98-app-resource-observation.sql',
      '0.3.0-preview.99-app-connection-upgrade.sql',
      '0.3.0-preview.100-app-record-changes.sql',
      '0.3.0-preview.101-app-connection-forms.sql',
      '0.3.0-preview.102-app-local-jobs.sql',
      '0.3.0-preview.103-app-future-record-actions.sql',
      '0.3.0-preview.104-app-resource-observation-connection-receipts.sql',
      '0.3.0-preview.107-app-run-inspection-leases.sql',
      '0.3.0-preview.105-prepared-resource-action-batches.sql',
      '0.3.0-preview.108-app-connection-upgrade-expiry.sql',
      '0.3.0-preview.109-app-runtime-renewal.sql',
      '0.3.0-preview.110-app-integrations.sql',
      '0.3.0-preview.111-app-connection-consent-continuation.sql',
      '0.3.0-preview.112-native-email-adoption.sql',
      '0.3.0-preview.113-owner-page-lineage-reconciliation.sql',
      '0.3.0-preview.114-native-mentions-lineage-reconciliation.sql',
      '0.3.0-preview.115-restore-safe-helper-references.sql',
      '0.3.0-preview.116-app-connection-credential-repair.sql',
      '0.3.0-preview.117-app-connection-uncertain-exchange.sql',
    ]) {
      await client.query(readFileSync(resolve(upgradesDir, platformFile), 'utf8'));
      console.log(`[apply-extras] reconciled ${platformFile}`);
    }

    // Restore this guard only when its forward migration is already recorded.
    // Fresh initialization must reach the unchanged117 catalog before convergence;
    // standalone extras cannot silently upgrade a retained117 database.
    const supplementalEffectsRecorded = ledgerExists && (await client.query<{ installed: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM deft_schema_migrations WHERE version='0.3.0-preview.118') AS installed
    `)).rows[0]?.installed === true;
    if (supplementalEffectsRecorded) {
      await client.query(readFileSync(resolve(upgradesDir, '0.3.0-preview.118-app-supplemental-effects.sql'), 'utf8'));
      console.log('[apply-extras] restored recorded supplemental effect guards');
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
      'app_resource_bindings_attachment_policy_check',
      'app_resource_projections_attachment_identity_unique',
      'app_attachment_stages_org_id_id_unique', 'app_attachment_stages_retry_unique',
      'app_attachment_stages_checkpoint_fk', 'app_attachment_stages_attempt_fk',
      'app_attachment_stages_projection_fk', 'app_attachment_stages_identity_check',
      'app_attachment_stages_metadata_check', 'app_attachment_stages_state_check',
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
      'module_record_merges_source_fk',
      'module_record_merges_target_fk',
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
      'capability_provider_snapshots_org_provider_id_unique',
      'mcp_connections_org_id_id_unique',
      'mcp_tool_overrides_org_connection_fk',
      'app_installations_org_id_app_id_unique',
      'app_installations_active_grant_snapshot_fk',
      'app_installations_grant_pointer_shape_check',
      'app_versions_org_installation_identity_unique',
      'app_versions_requested_grant_snapshot_fk',
      'app_versions_protocol_supported_check',
      'app_versions_connected_request_check',
      'app_grant_snapshots_app_installation_fk',
      'app_grant_snapshots_app_version_fk',
      'app_grant_snapshots_requested_snapshot_fk',
      'app_grant_snapshots_supersedes_snapshot_fk',
      'app_grant_snapshots_review_shape_check',
      'app_grant_snapshots_supersedes_self_check',
      'app_dependency_locks_grant_snapshot_fk',
      'app_dependency_locks_dependency_app_fk',
      'app_dependency_locks_dependency_version_fk',
      'app_dependency_locks_ownership_check',
      'app_action_bindings_grant_snapshot_fk',
      'app_action_bindings_mcp_connection_fk',
      'app_action_bindings_provider_snapshot_fk',
      'app_action_bindings_run_identity_unique',
      'app_action_bindings_automation_identity_unique',
      'app_action_bindings_interface_check',
      'app_action_bindings_policy_check',
      'app_automation_definitions_org_id_id_unique',
      'app_automation_definitions_app_installation_fk',
      'app_automation_definitions_app_version_fk',
      'app_automation_definitions_grant_snapshot_fk',
      'app_automation_definitions_action_binding_fk',
      'app_automation_definitions_approval_shape_check',
      'app_automation_definitions_json_size_check',
      'app_automation_fires_org_definition_id_unique',
      'app_automation_fires_definition_fk',
      'app_automation_fires_app_run_fk',
      'app_automation_fires_claim_shape_check',
      'app_automation_fires_resolution_check',
      'app_runs_app_installation_fk',
      'app_runs_app_version_fk',
      'app_runs_app_grant_snapshot_fk',
      'app_runs_app_action_binding_fk',
      'app_runs_automation_lineage_unique',
      'app_runs_automation_definition_fk',
      'app_runs_automation_fire_fk',
      'app_runs_app_origin_coherence_check',
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
      'app_attachment_stages_active_checkpoint_idx', 'app_attachment_stages_active_checkpoint_idx', 'app_attachment_stages_cleanup_idx', 'app_attachment_stages_parent_idx',
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
      'app_module_bindings_owner_idx',
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
      'app_grant_snapshots_one_requested_unique',
      'app_grant_snapshots_one_successor_unique',
      'app_grant_snapshots_one_root_unique',
      'app_dependency_locks_grant_key_unique',
      'app_dependency_locks_grant_installation_unique',
      'app_action_bindings_grant_action_unique',
      'app_action_bindings_run_identity_unique',
      'app_automation_definitions_digest_unique',
      'app_automation_definitions_app_request_idx',
      'app_automation_definitions_eligibility_idx',
      'app_automation_fires_identity_unique',
      'app_automation_fires_occurrence_unique',
      'app_automation_fires_definition_day_unique',
      'app_automation_fires_one_active_unique',
      'app_automation_fires_claim_idx',
      'app_automation_fires_org_state_idx',
      'app_runs_automation_lineage_idx',
      'app_runs_automation_fire_unique',
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
      'app_v7_effective_grant_shape_trigger', 'app_v7_effective_grant_shape_trigger', 'app_attachment_binding_policy_guard_trigger',
      'app_attachment_stage_guard_trigger', 'app_attachment_stage_capacity_trigger',
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
      'app_grant_snapshots_lineage_trigger',
      'app_grant_snapshots_append_only_trigger',
      'app_dependency_locks_append_only_trigger',
      'app_action_bindings_append_only_trigger',
      'app_versions_identity_trigger',
      'app_module_bindings_owner_trigger',
      'app_module_bindings_immutable_trigger',
      'app_installations_grant_coherence_trigger',
      'app_installations_epoch_cas_trigger',
      'app_versions_grant_coherence_trigger',
      'mcp_tool_overrides_parent_authorization_trigger',
      'app_automation_definitions_guard_trigger',
      'app_automation_fires_guard_trigger',
      'app_runs_automation_lineage_trigger',
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
    console.log('[apply-extras] verified governed App Run constraints, indexes, and triggers');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[apply-extras] failed against ${maskDatabaseUrl(databaseUrl)}:`, err);
  process.exit(1);
});
