import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  baselineChecksum,
  describeMissingRequirements,
  parseUpgradeArgs,
  validateAppliedMigrations,
} from './upgrade.ts';
import { upgradeManifest } from '../upgrades/manifest.ts';
import {
  attachmentDerivatives,
  agentEmployees,
  agentChannelEvents,
  agentChannelConnections,
  appInstallations,
  appModuleBindings,
  appRunAttempts,
  appRunEvents,
  appRunReceipts,
  appRuns,
  appRunSecretPayloads,
  appVersions,
  capabilityProviderSnapshots,
  agentActions,
  moduleInstallations,
  moduleMutationReceipts,
  moduleRecordRelations,
  moduleRecords,
  moduleSavedViews,
  moduleVersions,
  resourceRelationEdges,
  resourceRelationReceipts,
  resourceRelationSets,
  files,
  messageAttachments,
  messages,
  mcpConnections,
  mcpTokens,
  mcpToolOverrides,
  oauthAccessTokens,
  orgMembers,
  taskAttachments,
  tasks,
} from '../src/schema.ts';

test('App v0 schema keeps active versions and Module ownership tenant-bound', () => {
  const installation = getTableConfig(appInstallations);
  const version = getTableConfig(appVersions);
  const binding = getTableConfig(appModuleBindings);
  const foreignKeyNames = (config: ReturnType<typeof getTableConfig>) =>
    config.foreignKeys.map((key) => key.getName());

  assert.ok(installation.uniqueConstraints.some((item) => item.name === 'app_installations_org_id_id_unique'));
  assert.ok(foreignKeyNames(version).includes('app_versions_org_installation_fk'));
  assert.deepEqual(
    foreignKeyNames(binding).filter((name) => name.startsWith('app_module_bindings_')).sort(),
    [
      'app_module_bindings_app_installation_fk',
      'app_module_bindings_app_version_fk',
      'app_module_bindings_module_installation_fk',
      'app_module_bindings_module_version_fk',
    ],
  );
  assert.ok(version.indexes.some((item) => item.config.name === 'app_versions_one_active_unique'));
  assert.ok(binding.indexes.some((item) => item.config.name === 'app_module_bindings_owned_module_unique'));
});

test('App v0 supported upgrade contains the same tables and constraints as fresh schema', () => {
  const migration = upgradeManifest.migrations.find((item) => item.version === '0.3.0-preview.16');
  assert.ok(migration);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  for (const table of ['app_installations', 'app_versions', 'app_module_bindings']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
  }
  for (const constraint of [
    'app_installations_active_version_fk',
    'app_versions_one_active_unique',
    'app_module_bindings_app_version_fk',
    'app_module_bindings_module_version_fk',
  ]) {
    assert.match(sql, new RegExp(constraint, 'i'));
  }
  assert.match(applyExtrasSource, /0\.3\.0-preview\.16-declarative-apps-v0\.sql/);
});

test('governed App Run fresh schema is tenant-bound and keeps ciphertext separate', () => {
  const foreignKeyNames = (config: ReturnType<typeof getTableConfig>) =>
    config.foreignKeys.map((key) => key.getName());
  const run = getTableConfig(appRuns);
  const attempt = getTableConfig(appRunAttempts);
  const secret = getTableConfig(appRunSecretPayloads);
  const event = getTableConfig(appRunEvents);
  const receipt = getTableConfig(appRunReceipts);
  const snapshot = getTableConfig(capabilityProviderSnapshots);
  const action = getTableConfig(agentActions);

  assert.ok(snapshot.uniqueConstraints.some(
    (item) => item.name === 'capability_provider_snapshots_org_id_id_unique',
  ));
  assert.ok(run.uniqueConstraints.some((item) => item.name === 'app_runs_org_id_id_unique'));
  assert.ok(foreignKeyNames(run).includes('app_runs_org_provider_snapshot_fk'));
  assert.ok(foreignKeyNames(run).includes('app_runs_org_root_run_fk'));
  assert.ok(foreignKeyNames(run).includes('app_runs_org_parent_run_fk'));
  assert.ok(foreignKeyNames(attempt).includes('app_run_attempts_org_run_fk'));
  assert.ok(attempt.indexes.some((item) => item.config.name === 'app_run_attempts_one_active_unique'));
  assert.deepEqual(
    foreignKeyNames(secret).filter((name) => name.startsWith('app_run_secret_payloads_')).sort(),
    ['app_run_secret_payloads_org_attempt_fk', 'app_run_secret_payloads_org_run_fk'],
  );
  assert.ok(foreignKeyNames(event).includes('app_run_events_org_run_fk'));
  assert.deepEqual(
    foreignKeyNames(receipt).filter((name) => name.startsWith('app_run_receipts_')).sort(),
    ['app_run_receipts_org_attempt_fk', 'app_run_receipts_org_run_fk'],
  );
  assert.ok(foreignKeyNames(action).includes('agent_actions_org_app_run_fk'));
  assert.ok(action.indexes.some((item) => item.config.name === 'agent_action_app_run_unique'));

  const safeRunColumnNames = new Set(run.columns.map((column) => column.name));
  for (const secretColumn of ['nonce_b64', 'ciphertext_b64', 'auth_tag_b64']) {
    assert.equal(safeRunColumnNames.has(secretColumn), false);
  }
  const secretColumnNames = new Set(secret.columns.map((column) => column.name));
  assert.ok(secretColumnNames.has('ciphertext_b64'));
});

test('governed App Run supported upgrade preserves dormant and immutable boundaries', () => {
  const migration = upgradeManifest.migrations.find((item) => item.version === '0.3.0-preview.17');
  assert.ok(migration);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');

  for (const table of [
    'capability_provider_snapshots',
    'app_runs',
    'app_run_attempts',
    'app_run_secret_payloads',
    'app_run_events',
    'app_run_receipts',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
  }
  for (const boundary of [
    'app_runs_org_root_run_fk',
    'app_runs_org_parent_run_fk',
    'agent_actions_org_app_run_fk',
    'agent_action_app_run_unique',
    'app_runs_app_origin_disabled_check',
    'app_runs_contract_version_check',
    'app_runs_state_identity_trigger',
    'app_run_attempts_state_identity_trigger',
    'app_run_secret_payloads_append_only_trigger',
    'app_run_secret_payloads_size_check',
    'app_run_events_version_check',
    'app_run_events_type_check',
    'app_run_receipts_version_check',
    'app_run_events_append_only_trigger',
    'app_run_receipts_append_only_trigger',
    'APP_RUN_ILLEGAL_TRANSITION',
    'APP_RUN_IMMUTABLE_FIELD',
    'APP_RUN_APPEND_ONLY',
  ]) {
    assert.match(sql, new RegExp(boundary, 'i'));
  }
  assert.match(sql, /ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS app_run_id text/i);
  assert.doesNotMatch(sql, /UPDATE\s+agent_actions/i);
  assert.doesNotMatch(sql, /^\s*UPDATE\s+/im);
  assert.match(applyExtrasSource, /0\.3\.0-preview\.17-governed-app-runs-foundation\.sql/);
});

test('governed App Run engine hardening is additive and fences replay and attempts', () => {
  const migration = upgradeManifest.migrations.find((item) => item.version === '0.3.0-preview.18');
  assert.ok(migration);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');

  for (const boundary of [
    'idempotency_expires_at',
    'attempt_limit',
    'cancel_requested_at',
    'retry_of_attempt_id',
    'app_run_attempts_retry_of_fk',
    'app_run_attempts_one_active_unique',
    'app_runs_idempotency_expiry_check',
    'app_run_attempts_retry_shape_check',
    'cancellation_requested',
    'APP_RUN_IMMUTABLE_FIELD',
  ]) {
    assert.match(sql, new RegExp(boundary, 'i'));
  }
  assert.doesNotMatch(sql, /ALTER TABLE agent_actions/i);
  assert.match(applyExtrasSource, /0\.3\.0-preview\.18-governed-app-run-engine-hardening\.sql/);
});

test('governed App Run cutover gate is additive and fails closed before integration', () => {
  const migration = upgradeManifest.migrations.find((item) => item.version === '0.3.0-preview.19');
  assert.ok(migration);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  const run = getTableConfig(appRuns);
  const action = getTableConfig(agentActions);

  for (const boundary of [
    'execution_release_kind',
    'execution_released_at',
    'budget_reserved_at',
    'budget_reserved_count',
    'budget_limit_at_reservation',
    'app_runs_execution_release_shape_check',
    'app_runs_budget_reservation_shape_check',
    'app_run_attempts_execution_release_trigger',
    'APP_RUN_EXECUTION_NOT_RELEASED',
    'agent_actions_app_run_shape_check',
    'app_runs_idempotency_lookup_idx',
  ]) {
    assert.match(sql, new RegExp(boundary, 'i'));
  }
  assert.match(sql, /DROP INDEX IF EXISTS app_runs_idempotency_unique/i);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX[^;]+app_runs_idempotency_lookup_idx/is);
  assert.doesNotMatch(sql, /^\s*UPDATE\s+app_runs/im);
  assert.doesNotMatch(sql, /^\s*UPDATE\s+agent_actions/im);
  assert.match(applyExtrasSource, /0\.3\.0-preview\.19-governed-app-run-cutover-gate\.sql/);
  assert.match(applyExtrasSource, /'app_runs_idempotency_lookup_idx'/);
  assert.match(applyExtrasSource, /'app_run_attempts_execution_release_trigger'/);
  assert.doesNotMatch(applyExtrasSource, /'app_runs_idempotency_unique'/);
  for (const column of [
    'execution_release_kind',
    'execution_released_at',
    'budget_reserved_at',
    'budget_reserved_count',
    'budget_limit_at_reservation',
  ]) {
    assert.ok(run.columns.some((item) => item.name === column));
  }
  assert.ok(run.indexes.some((item) => item.config.name === 'app_runs_idempotency_lookup_idx'));
  assert.equal(run.indexes.some((item) => item.config.name === 'app_runs_idempotency_unique'), false);
  assert.ok(run.checks.some((item) => item.name === 'app_runs_execution_release_shape_check'));
  assert.ok(run.checks.some((item) => item.name === 'app_runs_budget_reservation_shape_check'));
  assert.ok(action.checks.some((item) => item.name === 'agent_actions_app_run_shape_check'));
});

test('App Run live authority versions are additive, monotonic, and ignore ordinary counters', () => {
  const migration = upgradeManifest.migrations.find((item) => item.version === '0.3.0-preview.20');
  assert.ok(migration);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');

  for (const boundary of [
    'org_members_app_run_authorization_version_trigger',
    'agent_employees_app_run_authorization_version_trigger',
    'mcp_connections_app_run_authorization_version_trigger',
    'mcp_tool_overrides_app_run_authorization_version_trigger',
    'mcp_tokens_app_run_authorization_version_trigger',
    'oauth_access_tokens_app_run_authorization_version_trigger',
  ]) assert.match(sql, new RegExp(boundary, 'i'));

  assert.match(sql, /NEW\.max_daily_actions/i);
  assert.match(sql, /NEW\.revoked_at/i);
  assert.doesNotMatch(sql, /NEW\.daily_action_count/i);
  assert.doesNotMatch(sql, /NEW\.daily_cost_cents/i);
  assert.doesNotMatch(sql, /NEW\.last_used_at/i);
  assert.doesNotMatch(sql, /^\s*UPDATE\s+(?:org_members|agent_employees|mcp_connections|mcp_tool_overrides|mcp_tokens|oauth_access_tokens)/im);
  assert.match(applyExtrasSource, /0\.3\.0-preview\.20-app-run-live-authority-versions\.sql/);

  for (const table of [
    orgMembers,
    agentEmployees,
    mcpConnections,
    mcpToolOverrides,
    mcpTokens,
    oauthAccessTokens,
  ]) {
    const config = getTableConfig(table);
    assert.ok(config.columns.some((column) => column.name === 'app_run_authorization_version'));
  }
});

test('App Run ancestry upgrade guards lineage, ceilings, and root budget continuity', () => {
  const migration = upgradeManifest.migrations.find((item) => item.version === '0.3.0-preview.21');
  assert.ok(migration);
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');

  for (const invariant of [
    'app_runs_ancestry_insert_trigger',
    'APP_RUN_ANCESTRY_INVALID',
    'APP_RUN_AUTHORIZATION_CEILING',
    'APP_RUN_POLICY_CEILING',
    'APP_RUN_BUDGET_CONTINUITY',
  ]) assert.match(sql, new RegExp(invariant, 'i'));
  assert.match(sql, /parent_row\.state NOT IN \('running', 'waiting_external'\)/i);
  assert.match(sql, /jsonb_array_elements\(NEW\.authorization_snapshot->'authority_refs'\)/i);
  assert.doesNotMatch(sql, /^\s*UPDATE\s+app_runs/im);
  assert.match(applyExtrasSource, /0\.3\.0-preview\.21-app-run-ancestry-guard\.sql/);
  assert.match(applyExtrasSource, /'app_runs_ancestry_insert_trigger'/);
});

test('parseUpgradeArgs recognizes status and dry run', () => {
  assert.deepEqual(parseUpgradeArgs(['--status']), { status: true, dryRun: false });
  assert.deepEqual(parseUpgradeArgs(['--dry-run']), { status: false, dryRun: true });
  assert.throws(() => parseUpgradeArgs(['--surprise']), /Unknown option/);
});

test('baseline checksum is deterministic', () => {
  assert.match(baselineChecksum(), /^[a-f0-9]{64}$/);
  assert.equal(baselineChecksum(), baselineChecksum());
});

test('missing schema requirements are described precisely', () => {
  const requirements = [
    { table: 'orgs' },
    { table: 'users', column: 'notification_preferences' },
  ];
  assert.deepEqual(describeMissingRequirements(requirements, new Set(['orgs'])), [
    'users.notification_preferences',
  ]);
});

test('applied migration validation rejects unknown and changed versions', () => {
  assert.throws(
    () => validateAppliedMigrations(
      [{ version: '9.9.9', checksum: 'x', kind: 'migration' }],
      [],
      new Map(),
    ),
    /newer than this Deft build/,
  );
  assert.throws(
    () => validateAppliedMigrations(
      [{ version: '0.2.0-preview.1', checksum: 'changed', kind: 'baseline' }],
      [],
      new Map(),
    ),
    /Checksum mismatch/,
  );
});

test('security redaction upgrade removes every legacy cached excerpt surface', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.2.0-preview.4',
  );
  assert.ok(migration, 'security redaction migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  assert.match(sql, /UPDATE cross_references[\s\S]*SET context = NULL/i);
  assert.match(sql, /UPDATE task_comments[\s\S]*SET is_deleted = true/i);
  assert.match(sql, /position\(cr\.context in tc\.content\) > 0/i);
  assert.match(sql, /UPDATE reminders[\s\S]*message = 'Message reminder'/i);
  assert.match(sql, /UPDATE notifications[\s\S]*title = 'Message reminder'/i);
  assert.match(sql, /UPDATE messages[\s\S]*metadata = m\.metadata - 'clip_summary'/i);
  assert.match(sql, /UPDATE clips[\s\S]*SET summary = NULL/i);
  assert.ok(
    sql.indexOf('UPDATE task_comments') < sql.indexOf('UPDATE cross_references'),
    'generated comments must be correlated with stored excerpts before the excerpts are redacted',
  );
});

test('module schema keeps tenant and installation lineage in composite foreign keys', () => {
  const orgMemberConfig = getTableConfig(orgMembers);
  const installationConfig = getTableConfig(moduleInstallations);
  const versionConfig = getTableConfig(moduleVersions);
  const recordConfig = getTableConfig(moduleRecords);
  const mutationReceiptConfig = getTableConfig(moduleMutationReceipts);

  assert.ok(
    orgMemberConfig.uniqueConstraints.some((item) => item.name === 'org_member_unique'),
    'org membership composite identity must be an inline unique constraint',
  );

  assert.deepEqual(
    installationConfig.columns.map((column) => column.name),
    [
      'id',
      'org_id',
      'module_id',
      'slug',
      'source',
      'is_enabled',
      'disabled_at',
      'agent_access',
      'installed_by_user_id',
      'installed_by_actor_type',
      'installed_by_actor_id',
      'updated_by_actor_type',
      'updated_by_actor_id',
      'is_deleted',
      'deleted_at',
      'deleted_by_actor_type',
      'deleted_by_actor_id',
      'created_at',
      'updated_at',
    ],
  );
  assert.ok(
    versionConfig.indexes.some((item) => item.config.name === 'module_versions_one_active_unique'),
    'each installation must have at most one active version',
  );
  assert.ok(
    versionConfig.checks.some(
      (item) => item.name === 'module_versions_manifest_digest_sha256_check',
    ),
    'manifest digests must be constrained to canonical lowercase sha256 values',
  );
  assert.deepEqual(
    versionConfig.foreignKeys.map((key) => ({
      name: key.getName(),
      columns: key.reference().columns.map((column) => column.name),
      foreignColumns: key.reference().foreignColumns.map((column) => column.name),
    })),
    [{
      name: 'module_versions_org_installation_fk',
      columns: ['org_id', 'installation_id'],
      foreignColumns: ['org_id', 'id'],
    }],
  );
  assert.deepEqual(
    recordConfig.foreignKeys.map((key) => ({
      name: key.getName(),
      columns: key.reference().columns.map((column) => column.name),
      foreignColumns: key.reference().foreignColumns.map((column) => column.name),
    })),
    [
      {
        name: 'module_records_org_installation_fk',
        columns: ['org_id', 'installation_id'],
        foreignColumns: ['org_id', 'id'],
      },
      {
        name: 'module_records_validated_version_fk',
        columns: ['org_id', 'installation_id', 'validated_version_id'],
        foreignColumns: ['org_id', 'installation_id', 'id'],
      },
    ],
  );
  assert.ok(
    recordConfig.columns.some((column) => column.name === 'search_vector' && column.generated),
    'search_vector must be generated rather than supplied by callers',
  );
  assert.ok(
    recordConfig.uniqueConstraints.some(
      (item) => item.name === 'module_records_org_installation_id_unique',
    ),
    'receipts need a tenant- and installation-bound record reference target',
  );
  assert.ok(
    installationConfig.uniqueConstraints.some(
      (item) => item.name === 'module_installations_org_id_id_unique',
    ),
    'installation composite FK targets must be inline unique constraints',
  );
  assert.ok(
    versionConfig.uniqueConstraints.some(
      (item) => item.name === 'module_versions_org_installation_id_unique',
    ),
    'version composite FK targets must be inline unique constraints',
  );
  assert.deepEqual(
    mutationReceiptConfig.columns.map((column) => column.name),
    [
      'id',
      'org_id',
      'installation_id',
      'agent_action_id',
      'actor_type',
      'actor_id',
      'operation',
      'idempotency_key',
      'input_digest',
      'record_id',
      'result_revision',
      'result_manifest_digest',
      'result_archived',
      'changed_fields',
      'created_at',
    ],
  );
  assert.deepEqual(
    mutationReceiptConfig.foreignKeys.map((key) => ({
      name: key.getName(),
      columns: key.reference().columns.map((column) => column.name),
      foreignColumns: key.reference().foreignColumns.map((column) => column.name),
    })),
    [
      {
        name: 'module_mutation_receipts_agent_action_id_agent_actions_id_fk',
        columns: ['agent_action_id'],
        foreignColumns: ['id'],
      },
      {
        name: 'module_mutation_receipts_org_installation_fk',
        columns: ['org_id', 'installation_id'],
        foreignColumns: ['org_id', 'id'],
      },
      {
        name: 'module_mutation_receipts_record_fk',
        columns: ['org_id', 'installation_id', 'record_id'],
        foreignColumns: ['org_id', 'installation_id', 'id'],
      },
    ],
  );
  assert.ok(
    mutationReceiptConfig.indexes.some(
      (item) => item.config.name === 'module_mutation_receipts_idempotency_unique',
    ),
    'mutation retries must have one durable receipt per principal, operation, and key',
  );
  assert.ok(
    mutationReceiptConfig.indexes.some(
      (item) => item.config.name === 'module_mutation_receipts_agent_action_unique',
    ),
    'an agent action must reconcile to at most one committed module mutation',
  );
});

test('module fresh-install and supported-upgrade SQL stay identical and enforce v1 gates', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.2.0-preview.6',
  );
  assert.ok(migration, 'modules v1 migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(resolve(scriptsDir, '..', 'drizzle', '0081_modules_v1.sql'), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql, 'fresh installs and supported upgrades must create the same module schema');
  assert.match(
    applyExtrasSource,
    /'0081_modules_v1\.sql'/,
    'db:push-full must apply module SQL that drizzle-kit cannot express',
  );
  assert.match(
    applyExtrasSource,
    /module_versions_immutable_fields_trigger/,
    'db:push-full must verify the immutable module-version boundary',
  );
  assert.match(upgradeSql, /ADD COLUMN IF NOT EXISTS approved_by_user_id text/i);
  assert.match(upgradeSql, /agent_actions_approved_by_user_id_fkey/i);
  assert.match(upgradeSql, /receipt_action_decision_unique[\s\S]*action_id, decision/i);

  assert.match(
    upgradeSql,
    /FOREIGN KEY \(org_id, installation_id\)[\s\S]*REFERENCES module_installations \(org_id, id\)/i,
  );
  assert.match(
    upgradeSql,
    /FOREIGN KEY \(org_id, installation_id, validated_version_id\)[\s\S]*REFERENCES module_versions \(org_id, installation_id, id\)/i,
  );
  assert.match(
    upgradeSql,
    /module_versions_one_active_unique[\s\S]*WHERE is_active = true/i,
  );
  assert.match(
    upgradeSql,
    /module_versions_manifest_digest_sha256_check[\s\S]*manifest_digest ~ '\^sha256:\[a-f0-9\]\{64\}\$'/,
  );
  assert.match(
    upgradeSql,
    /CREATE TRIGGER module_versions_immutable_fields_trigger[\s\S]*BEFORE UPDATE ON module_versions[\s\S]*EXECUTE FUNCTION enforce_module_version_immutability\(\)/i,
  );
  const versionImmutabilitySql = upgradeSql.slice(
    upgradeSql.indexOf('CREATE OR REPLACE FUNCTION enforce_module_version_immutability()'),
    upgradeSql.indexOf('DROP TRIGGER IF EXISTS module_versions_immutable_fields_trigger'),
  );
  for (const column of [
    'id',
    'org_id',
    'installation_id',
    'version',
    'manifest',
    'manifest_digest',
    'created_by_actor_type',
    'created_by_actor_id',
    'created_at',
  ]) {
    assert.match(
      versionImmutabilitySql,
      new RegExp(`NEW\\.${column} IS DISTINCT FROM OLD\\.${column}`, 'i'),
      `${column} must be immutable after a module version is inserted`,
    );
  }
  for (const column of ['is_active', 'activated_at', 'updated_at']) {
    assert.doesNotMatch(
      versionImmutabilitySql,
      new RegExp(`NEW\\.${column} IS DISTINCT FROM OLD\\.${column}`, 'i'),
      `${column} must remain mutable lifecycle state`,
    );
  }
  assert.match(
    upgradeSql,
    /module_records_create_idempotency_unique[\s\S]*WHERE create_idempotency_key IS NOT NULL/i,
  );
  assert.match(
    upgradeSql,
    /search_vector tsvector GENERATED ALWAYS AS[\s\S]*to_tsvector\('simple'::regconfig[\s\S]*\) STORED/i,
  );
  assert.match(upgradeSql, /module_records USING GIN \(search_vector\)/i);
  assert.match(upgradeSql, /agent_access text NOT NULL DEFAULT 'none'/i);
  assert.match(upgradeSql, /agent_access IN \('none', 'read', 'write'\)/i);
  assert.match(
    upgradeSql,
    /module_records_org_installation_id_unique[\s\S]*ON module_records \(org_id, installation_id, id\)/i,
  );
  assert.match(
    upgradeSql,
    /FOREIGN KEY \(org_id, installation_id, record_id\)[\s\S]*REFERENCES module_records \(org_id, installation_id, id\)/i,
  );
  assert.match(
    upgradeSql,
    /module_mutation_receipts_idempotency_unique[\s\S]*org_id,[\s\S]*actor_type,[\s\S]*actor_id,[\s\S]*operation,[\s\S]*idempotency_key/i,
  );
  assert.match(upgradeSql, /input_digest ~ '\^sha256:\[a-f0-9\]\{64\}\$'/i);
  assert.match(upgradeSql, /result_manifest_digest ~ '\^sha256:\[a-f0-9\]\{64\}\$'/i);
  assert.match(upgradeSql, /idempotency_key ~ '\^sha256:\[a-f0-9\]\{64\}\$'/i);
  assert.match(
    upgradeSql,
    /create_idempotency_key IS NULL OR create_idempotency_key ~ '\^sha256:\[a-f0-9\]\{64\}\$'/i,
  );
  assert.match(upgradeSql, /operation IN \('create', 'update', 'archive'\)/i);
  assert.match(
    upgradeSql,
    /\(operation = 'archive' AND result_archived\)[\s\S]*\(operation IN \('create', 'update'\) AND NOT result_archived\)/i,
  );
  const receiptSql = upgradeSql.slice(upgradeSql.indexOf('CREATE TABLE IF NOT EXISTS module_mutation_receipts'));
  assert.doesNotMatch(receiptSql, /\bjsonb\b|request_json|result_json|record_data/i);
  assert.doesNotMatch(upgradeSql, /search_manifest_digest/i);
});

test('module relation and saved-view schema keeps tenant and installation boundaries', () => {
  const relationConfig = getTableConfig(moduleRecordRelations);
  const savedViewConfig = getTableConfig(moduleSavedViews);
  const relationForeignKeys = relationConfig.foreignKeys.map((key) => ({
    name: key.getName(),
    columns: key.reference().columns.map((column) => column.name),
    foreignColumns: key.reference().foreignColumns.map((column) => column.name),
  }));

  assert.deepEqual(relationForeignKeys, [
    {
      name: 'module_record_relations_org_installation_fk',
      columns: ['org_id', 'installation_id'],
      foreignColumns: ['org_id', 'id'],
    },
    {
      name: 'module_record_relations_source_record_fk',
      columns: ['org_id', 'installation_id', 'source_record_id'],
      foreignColumns: ['org_id', 'installation_id', 'id'],
    },
    {
      name: 'module_record_relations_target_record_fk',
      columns: ['org_id', 'installation_id', 'target_record_id'],
      foreignColumns: ['org_id', 'installation_id', 'id'],
    },
  ]);
  assert.ok(
    relationConfig.indexes.some((item) => item.config.name === 'module_record_relations_active_unique'),
    'active relation targets must be unique per source field',
  );
  assert.ok(
    savedViewConfig.columns.some((column) => column.name === 'owner_user_id' && column.notNull),
    'v1 saved views must always have a personal owner',
  );
  assert.ok(
    savedViewConfig.foreignKeys.some((key) => {
      const reference = key.reference();
      return key.getName() === 'module_saved_views_owner_member_fk'
        && reference.columns.map((column) => column.name).join(',') === 'org_id,owner_user_id'
        && reference.foreignColumns.map((column) => column.name).join(',') === 'org_id,user_id';
    }),
    'saved-view owners must be active identities in the same organization boundary',
  );
  assert.ok(
    savedViewConfig.checks.some((item) => item.name === 'module_saved_views_config_type_check'),
    'saved view config type and indexed view_type must agree',
  );
});

test('module relations/views fresh-install and supported-upgrade SQL stay identical', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.2.0-preview.7',
  );
  assert.ok(migration, 'module relations/views migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(resolve(scriptsDir, '..', 'drizzle', '0082_module_relations_views.sql'), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql);
  assert.match(applyExtrasSource, /'0082_module_relations_views\.sql'/);
  assert.match(
    upgradeSql,
    /FOREIGN KEY \(org_id, installation_id, source_record_id\)[\s\S]*REFERENCES module_records \(org_id, installation_id, id\)/i,
  );
  assert.match(
    upgradeSql,
    /FOREIGN KEY \(org_id, installation_id, target_record_id\)[\s\S]*REFERENCES module_records \(org_id, installation_id, id\)/i,
  );
  assert.match(
    upgradeSql,
    /module_record_relations_active_unique[\s\S]*WHERE is_deleted = false/i,
  );
  assert.match(upgradeSql, /owner_user_id text NOT NULL REFERENCES users\(id\)/i);
  assert.match(
    upgradeSql,
    /FOREIGN KEY \(org_id, owner_user_id\)[\s\S]*REFERENCES org_members \(org_id, user_id\)/i,
  );
  for (const constraint of [
    'org_member_unique',
    'module_installations_org_id_id_unique',
    'module_versions_org_installation_id_unique',
    'module_records_org_installation_id_unique',
  ]) {
    assert.match(
      upgradeSql,
      new RegExp(`ADD CONSTRAINT ${constraint}[\\s\\S]*UNIQUE USING INDEX ${constraint}`, 'i'),
      `${constraint} must converge from an 0081 index to a fresh-schema constraint`,
    );
  }
  assert.match(upgradeSql, /config->>'type' = view_type/i);
  assert.match(
    upgradeSql,
    /module_saved_views_active_name_unique[\s\S]*owner_user_id,[\s\S]*name[\s\S]*WHERE is_deleted = false/i,
  );
});

test('resource relation substrate is additive, tenant-bound, and replay-safe', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.22',
  );
  assert.ok(migration, 'resource relation migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.match(applyExtrasSource, /0\.3\.0-preview\.22-resource-relations\.sql/);
  assert.match(upgradeSql, /resource_relation_sets_identity_unique/i);
  assert.match(upgradeSql, /resource_relation_edges_active_target_unique[\s\S]*WHERE is_deleted = false/i);
  assert.match(upgradeSql, /resource_relation_edges_active_position_unique[\s\S]*WHERE is_deleted = false/i);
  assert.match(upgradeSql, /FOREIGN KEY \(org_id, relation_set_id\)[\s\S]*REFERENCES resource_relation_sets\(org_id, id\)/i);
  assert.match(upgradeSql, /source_provider_instance_id = 'tasks'[\s\S]*source_resource_type = 'task'/i);
  assert.match(upgradeSql, /target_provider_instance_id = 'tasks'[\s\S]*target_resource_type = 'task'/i);
  assert.doesNotMatch(upgradeSql, /ALTER TABLE module_record_relations|UPDATE module_record_relations/i);

  const sets = getTableConfig(resourceRelationSets);
  const edges = getTableConfig(resourceRelationEdges);
  const receipts = getTableConfig(resourceRelationReceipts);
  assert.ok(sets.uniqueConstraints.some((item) => item.name === 'resource_relation_sets_org_id_id_unique'));
  assert.ok(sets.indexes.some((item) => item.config.name === 'resource_relation_sets_identity_unique'));
  assert.deepEqual(edges.foreignKeys.map((key) => key.getName()), ['resource_relation_edges_org_set_fk']);
  assert.ok(edges.indexes.some((item) => item.config.name === 'resource_relation_edges_active_target_unique'));
  assert.ok(edges.indexes.some((item) => item.config.name === 'resource_relation_edges_active_position_unique'));
  assert.deepEqual(receipts.foreignKeys.map((key) => key.getName()), ['resource_relation_receipts_org_set_fk']);
  assert.ok(receipts.indexes.some((item) => item.config.name === 'resource_relation_receipts_idempotency_unique'));
});

test('Agent Channel lease schema converges across fresh installs and supported upgrades', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.4',
  );
  assert.ok(migration, 'Agent Channel lease migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(resolve(scriptsDir, '..', 'drizzle', '0083_agent_channel_leases.sql'), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql);
  assert.match(applyExtrasSource, /'0083_agent_channel_leases\.sql'/);
  assert.match(upgradeSql, /claim_token text/i);
  assert.match(upgradeSql, /lease_expires_at timestamp/i);
  assert.match(upgradeSql, /agent_channel_event_claim_shape_check/i);
  assert.match(upgradeSql, /work_outcome IN \('completed', 'needs_human', 'blocked', 'failed', 'cancelled'\)/i);
  assert.match(upgradeSql, /agent_channel_event_lease_idx/i);

  const table = getTableConfig(agentChannelEvents);
  assert.ok(table.checks.some((item) => item.name === 'agent_channel_event_claim_shape_check'));
  assert.ok(table.checks.some((item) => item.name === 'agent_channel_event_work_outcome_check'));
  assert.ok(table.indexes.some((item) => item.config.name === 'agent_channel_event_lease_idx'));
});

test('wiki memory sync schema converges across fresh installs and supported upgrades', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.5',
  );
  assert.ok(migration, 'wiki memory sync migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(resolve(scriptsDir, '..', 'drizzle', '0084_wiki_memory_sync.sql'), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql);
  assert.match(applyExtrasSource, /'0084_wiki_memory_sync\.sql'/);
  assert.match(upgradeSql, /wiki_memory_sync_identity_unique/i);
  assert.match(upgradeSql, /content_digest/i);
  assert.match(upgradeSql, /page_version/i);
});

test('runtime reconciliation outcome converges across fresh installs and supported upgrades', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.7',
  );
  assert.ok(migration, 'runtime reconciliation migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(
    resolve(scriptsDir, '..', 'drizzle', '0085_agent_channel_runtime_reconciliation.sql'),
    'utf8',
  );
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql);
  assert.match(applyExtrasSource, /'0085_agent_channel_runtime_reconciliation\.sql'/);
  assert.match(upgradeSql, /ADD COLUMN IF NOT EXISTS channel_event_id text/i);
  assert.match(upgradeSql, /agent_action_runtime_request_idx/i);
  assert.match(upgradeSql, /agent_channel_attempt_active_runtime_unique/i);
  assert.match(upgradeSql, /work_completed_handoff_uncertain/i);
});

test('tenant-bound attachment links converge across fresh installs and supported upgrades', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.14',
  );
  assert.ok(migration, 'attachment link migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(resolve(scriptsDir, '..', 'drizzle', '0086_attachment_links.sql'), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql);
  assert.match(applyExtrasSource, /'0086_attachment_links\.sql'/);
  assert.match(upgradeSql, /INSERT INTO "message_attachments"/i);
  assert.match(upgradeSql, /INSERT INTO "task_attachments"/i);
  assert.match(upgradeSql, /ON CONFLICT \("message_id", "file_id"\) DO NOTHING/i);

  const messageConfig = getTableConfig(messageAttachments);
  const taskConfig = getTableConfig(taskAttachments);
  assert.deepEqual(
    messageConfig.foreignKeys.map((key) => key.getName()).sort(),
    ['message_attachments_org_file_fk', 'message_attachments_org_message_fk'],
  );
  assert.deepEqual(
    taskConfig.foreignKeys.map((key) => key.getName()).sort(),
    ['task_attachments_org_file_fk', 'task_attachments_org_task_fk'],
  );
  assert.match(upgradeSql, /ADD CONSTRAINT "messages_org_id_id_unique"/i);
  assert.match(upgradeSql, /ADD CONSTRAINT "files_org_id_id_unique"/i);
  assert.match(upgradeSql, /ADD CONSTRAINT "tasks_org_id_id_unique"/i);
  assert.ok(getTableConfig(messages).uniqueConstraints.some((item) => item.name === 'messages_org_id_id_unique'));
  assert.ok(getTableConfig(files).uniqueConstraints.some((item) => item.name === 'files_org_id_id_unique'));
  assert.ok(getTableConfig(tasks).uniqueConstraints.some((item) => item.name === 'tasks_org_id_id_unique'));
});

test('bounded attachment processing converges across fresh installs and supported upgrades', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.15',
  );
  assert.ok(migration, 'attachment processing migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  const freshSql = readFileSync(resolve(scriptsDir, '..', 'drizzle', '0087_attachment_processing.sql'), 'utf8');
  const applyExtrasSource = readFileSync(resolve(scriptsDir, 'apply-extras.ts'), 'utf8');
  assert.equal(upgradeSql, freshSql);
  assert.match(applyExtrasSource, /'0087_attachment_processing\.sql'/);
  assert.match(upgradeSql, /CREATE TYPE "attachment_processing_status"/i);
  assert.match(upgradeSql, /CREATE TABLE IF NOT EXISTS "attachment_derivatives"/i);
  assert.match(upgradeSql, /attachment_derivatives_org_file_fk/i);

  const fileConfig = getTableConfig(files);
  for (const columnName of [
    'detected_mime_type',
    'attachment_kind',
    'content_sha256',
    'processing_status',
    'processing_error',
    'processed_at',
    'staged_expires_at',
  ]) {
    assert.ok(fileConfig.columns.some((column) => column.name === columnName), `missing files.${columnName}`);
  }
  const derivativeConfig = getTableConfig(attachmentDerivatives);
  assert.deepEqual(
    derivativeConfig.foreignKeys.map((key) => key.getName()),
    ['attachment_derivatives_org_file_fk'],
  );
});

test('Agent Channel v2 is the fresh-install default and supported upgrade boundary', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.3.0-preview.6',
  );
  assert.ok(migration, 'Agent Channel v2 migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const upgradeSql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  assert.match(upgradeSql, /ALTER COLUMN "protocol_version" SET DEFAULT 'deft\.agent_channel\.v2'/i);
  assert.match(upgradeSql, /SET "status" = 'disconnected'/i);

  const table = getTableConfig(agentChannelConnections);
  const protocolColumn = table.columns.find((column) => column.name === 'protocol_version');
  assert.equal(protocolColumn?.default, 'deft.agent_channel.v2');
});
