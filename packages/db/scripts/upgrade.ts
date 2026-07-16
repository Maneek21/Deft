import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';
import { upgradeManifest, type SchemaRequirement, type UpgradeMigration } from '../upgrades/manifest.ts';

const { Client } = pg;
const LOCK_ID = 7_314_029_421;
const LEDGER_TABLE = 'deft_schema_migrations';

type AppliedMigration = {
  version: string;
  checksum: string;
  kind: 'baseline' | 'migration';
};

type UpgradeOptions = {
  status: boolean;
  dryRun: boolean;
};

export function parseUpgradeArgs(argv: string[]): UpgradeOptions {
  const options: UpgradeOptions = { status: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--status') options.status = true;
    else if (arg === '--dry-run' || arg === '--check-only') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Deft database upgrade

Usage:
  pnpm db:upgrade
  pnpm db:upgrade --status
  pnpm db:upgrade --dry-run

The first supported baseline is v0.2.0-preview.1. Fresh databases should use
pnpm db:push-full instead.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function baselineChecksum(): string {
  return sha256(JSON.stringify(upgradeManifest.baseline));
}

export function validateAppliedMigrations(
  applied: AppliedMigration[],
  migrations: ReadonlyArray<UpgradeMigration>,
  migrationChecksums: Map<string, string>,
) {
  const knownVersions = new Set([
    upgradeManifest.baseline.version,
    ...migrations.map((migration) => migration.version),
  ]);
  const unknown = applied.filter((row) => !knownVersions.has(row.version));
  if (unknown.length > 0) {
    throw new Error(
      `This database is newer than this Deft build. Unknown applied version(s): ${unknown.map((row) => row.version).join(', ')}.`,
    );
  }

  for (const row of applied) {
    const expected = row.kind === 'baseline'
      ? baselineChecksum()
      : migrationChecksums.get(row.version);
    if (expected && row.checksum !== expected) {
      throw new Error(`Checksum mismatch for applied schema version ${row.version}. Refusing to continue.`);
    }
  }
}

export function describeMissingRequirements(
  requirements: ReadonlyArray<SchemaRequirement>,
  present: Set<string>,
): string[] {
  return requirements
    .map((requirement) => requirement.column ? `${requirement.table}.${requirement.column}` : requirement.table)
    .filter((key) => !present.has(key));
}

async function ledgerExists(client: InstanceType<typeof Client>): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.${LEDGER_TABLE}') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function countPublicTables(client: InstanceType<typeof Client>): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return Number(result.rows[0]?.count || 0);
}

async function inspectBaseline(client: InstanceType<typeof Client>) {
  const present = new Set<string>();
  for (const requirement of upgradeManifest.baseline.requirements) {
    if (requirement.column) {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
         ) AS exists`,
        [requirement.table, requirement.column],
      );
      if (result.rows[0]?.exists) present.add(`${requirement.table}.${requirement.column}`);
    } else {
      const result = await client.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${requirement.table}`],
      );
      if (result.rows[0]?.exists) present.add(requirement.table);
    }
  }

  const extensionResult = await client.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`,
    [upgradeManifest.baseline.requiredExtensions],
  );
  const extensions = new Set(extensionResult.rows.map((row) => row.extname));

  const indexResult = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [upgradeManifest.baseline.requiredIndexes],
  );
  const indexes = new Set(indexResult.rows.map((row) => row.indexname));

  return {
    missingSchema: describeMissingRequirements(upgradeManifest.baseline.requirements, present),
    missingExtensions: upgradeManifest.baseline.requiredExtensions.filter((name) => !extensions.has(name)),
    missingIndexes: upgradeManifest.baseline.requiredIndexes.filter((name) => !indexes.has(name)),
  };
}

function assertCompatibleBaseline(inspection: Awaited<ReturnType<typeof inspectBaseline>>) {
  const missing = [
    ...inspection.missingSchema,
    ...inspection.missingExtensions.map((name) => `extension:${name}`),
    ...inspection.missingIndexes.map((name) => `index:${name}`),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Database does not match the supported ${upgradeManifest.baseline.releaseTag} baseline. Missing: ${missing.join(', ')}. ` +
      'Restore a backup and upgrade from a documented release; do not run schema push against important data.',
    );
  }
}

function migrationDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'upgrades');
}

function loadMigrationChecksums(): Map<string, string> {
  return new Map(
    upgradeManifest.migrations.map((migration) => [
      migration.version,
      sha256(readFileSync(resolve(migrationDirectory(), migration.file), 'utf8')),
    ]),
  );
}

async function readApplied(client: InstanceType<typeof Client>): Promise<AppliedMigration[]> {
  if (!(await ledgerExists(client))) return [];
  const result = await client.query<AppliedMigration>(
    `SELECT version, checksum, kind FROM ${LEDGER_TABLE} ORDER BY applied_at, version`,
  );
  return result.rows;
}

async function ensureLedger(client: InstanceType<typeof Client>) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      version text PRIMARY KEY,
      description text NOT NULL,
      checksum text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('baseline', 'migration')),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function adoptBaseline(client: InstanceType<typeof Client>) {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE} (version, description, checksum, kind)
     VALUES ($1, $2, $3, 'baseline')
     ON CONFLICT (version) DO NOTHING`,
    [
      upgradeManifest.baseline.version,
      `Supported schema baseline ${upgradeManifest.baseline.releaseTag}`,
      baselineChecksum(),
    ],
  );
}

async function applyMigration(
  client: InstanceType<typeof Client>,
  migration: UpgradeMigration,
  checksum: string,
) {
  const sql = readFileSync(resolve(migrationDirectory(), migration.file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO ${LEDGER_TABLE} (version, description, checksum, kind)
       VALUES ($1, $2, $3, 'migration')`,
      [migration.version, migration.description, checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function printStatus(client: InstanceType<typeof Client>, applied: AppliedMigration[]) {
  const tableCount = await countPublicTables(client);
  const inspection = tableCount > 0 ? await inspectBaseline(client) : null;
  const compatible = inspection
    ? inspection.missingSchema.length === 0 &&
      inspection.missingExtensions.length === 0 &&
      inspection.missingIndexes.length === 0
    : false;
  console.log('Deft database upgrade status');
  console.log(`  public tables: ${tableCount}`);
  console.log(`  ledger: ${applied.length > 0 ? `${applied.length} applied version(s)` : 'not initialized'}`);
  console.log(`  baseline: ${compatible ? `${upgradeManifest.baseline.releaseTag} compatible` : 'not compatible'}`);
  console.log(`  pending: ${upgradeManifest.migrations.filter((item) => !applied.some((row) => row.version === item.version)).length}`);
}

export async function main(argv = process.argv.slice(2)) {
  loadRootEnv(import.meta.url);
  const options = parseUpgradeArgs(argv);
  const databaseUrl = resolveDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const appliedBefore = await readApplied(client);
    const migrationChecksums = loadMigrationChecksums();
    validateAppliedMigrations(appliedBefore, upgradeManifest.migrations, migrationChecksums);

    if (options.status) {
      await printStatus(client, appliedBefore);
      return;
    }

    const tableCount = await countPublicTables(client);
    if (tableCount === 0) {
      throw new Error('Database is empty. Use pnpm db:push-full for a fresh install; db:upgrade is for existing supported releases.');
    }

    const inspection = await inspectBaseline(client);
    assertCompatibleBaseline(inspection);
    const hasBaseline = appliedBefore.some((row) => row.version === upgradeManifest.baseline.version);
    const pending = upgradeManifest.migrations.filter(
      (migration) => !appliedBefore.some((row) => row.version === migration.version),
    );

    console.log('Deft database upgrade');
    console.log(`  database: ${maskDatabaseUrl(databaseUrl)}`);
    console.log(`  baseline: ${hasBaseline ? 'already adopted' : `adopt ${upgradeManifest.baseline.releaseTag}`}`);
    console.log(`  migrations: ${pending.length} pending`);
    if (options.dryRun) {
      for (const migration of pending) console.log(`  - ${migration.version}: ${migration.description}`);
      console.log('[OK] Dry run complete. No database changes were made.');
      return;
    }

    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      await ensureLedger(client);
      const appliedLocked = await readApplied(client);
      validateAppliedMigrations(appliedLocked, upgradeManifest.migrations, migrationChecksums);
      const hasLockedBaseline = appliedLocked.some((row) => row.version === upgradeManifest.baseline.version);
      const lockedPending = upgradeManifest.migrations.filter(
        (migration) => !appliedLocked.some((row) => row.version === migration.version),
      );
      if (!hasLockedBaseline) {
        await adoptBaseline(client);
        console.log(`[OK] Adopted baseline ${upgradeManifest.baseline.releaseTag}`);
      }
      for (const migration of lockedPending) {
        const checksum = migrationChecksums.get(migration.version);
        if (!checksum) throw new Error(`Missing checksum for migration ${migration.version}.`);
        await applyMigration(client, migration, checksum);
        console.log(`[OK] Applied ${migration.version}: ${migration.description}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }

    const appliedAfter = await readApplied(client);
    validateAppliedMigrations(appliedAfter, upgradeManifest.migrations, migrationChecksums);
    console.log(`[OK] Database is current at ${appliedAfter.at(-1)?.version || upgradeManifest.baseline.version}.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('[FAIL]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
