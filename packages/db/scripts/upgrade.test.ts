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
  moduleInstallations,
  moduleMutationReceipts,
  moduleRecordRelations,
  moduleRecords,
  moduleSavedViews,
  moduleVersions,
  orgMembers,
} from '../src/schema.ts';

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
