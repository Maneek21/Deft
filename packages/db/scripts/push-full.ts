import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertReviewedFreshBootstrap, convergeReviewedRelease } from './lineage-convergence.mjs';
import { reconcileFreshSchemaContracts } from './fresh-schema-contracts.mjs';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';
import { LOCK_ID, baselineChecksum, sha256, applyManifestTailMigrations } from './upgrade.ts';
import { upgradeManifest } from '../upgrades/manifest.ts';

const { Client } = pg;
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upgradesDir = resolve(packageDir, 'upgrades');

async function run(command: readonly string[]) {
  const [program, ...args] = command;
  const exitCode = await new Promise<number>((resolveCode, reject) => {
    // Windows pnpm is a .cmd shim. Use cmd only for these fixed literals;
    // no URL or caller-controlled text enters the command line.
    const windows = process.platform === 'win32';
    const child = spawn(windows ? process.env.ComSpec || 'cmd.exe' : program!,
      windows ? ['/d', '/s', '/c', command.join(' ')] : args, {
      cwd: packageDir,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => resolveCode(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`${command.slice(0, 2).join(' ')} failed (${exitCode})`);
}

const FRESH_BOOTSTRAP_VERSION = '0.3.0-preview.117';

type Queryable = { query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * What to tell the operator when fresh initialization stops after it began
 * building: the database is incomplete, and which recorded upgrades it lacks.
 * Without this, a stop (for example E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED on a
 * server whose Postgres or pgvector version differs from the supported image)
 * leaves tables from schema.ts in place but none from the upgrades after
 * 0.3.0-preview.117 (ics_publish_tokens, seat_statements, user_two_step, ...),
 * and the database looks usable. Read-only.
 */
export async function describeIncompleteFreshInit(client: Queryable, error: unknown): Promise<string[]> {
  let recorded = new Set<string>();
  try {
    const ledger = await client.query("SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS present");
    if (ledger.rows[0]?.present) {
      recorded = new Set((await client.query('SELECT version FROM deft_schema_migrations')).rows.map((row) => String(row.version)));
    }
  } catch {
    // Reported as "none recorded" below.
  }
  // push-full builds the schema through the bootstrap directly; the upgrades
  // after it run only once that schema is recognized and recorded.
  const bootstrapEnd = upgradeManifest.migrations.findIndex((migration) => migration.version === FRESH_BOOTSTRAP_VERSION);
  const missing = upgradeManifest.migrations.slice(bootstrapEnd + 1).filter((migration) => !recorded.has(migration.version));
  const lines = [
    'push-full stopped before it finished. This database is INCOMPLETE: do not use it for tests, a stage or an install.',
    missing.length
      ? `${missing.length} upgrade(s) after ${FRESH_BOOTSTRAP_VERSION} were not applied (${missing[0]!.version} to ${missing.at(-1)!.version}): `
        + 'tables they create, for example ics_publish_tokens, seat_statements and user_two_step, are missing, so it does not match an install built by db:upgrade.'
      : 'Every upgrade was applied, but the final step failed.',
  ];
  if (error instanceof Error && /^E5_\w*CATALOG_UNRECOGNIZED/u.test(error.message)) {
    try {
      const server = (await client.query("SELECT current_setting('server_version') AS version")).rows[0]?.version;
      const extensions = (await client.query('SELECT extname, extversion FROM pg_extension ORDER BY extname')).rows
        .map((row) => `${row.extname} ${row.extversion}`).join(', ');
      lines.push(`This server's schema catalog is not one push-full recognizes (Postgres ${server}; extensions: ${extensions}). `
        + 'The recognized catalogs depend on the exact Postgres and pgvector versions: use the pgvector/pgvector image pinned in docker-compose.yml and CI, with only the vector extension installed.');
    } catch {
      // The versions are a hint only.
    }
  }
  lines.push(recorded.has(upgradeManifest.baseline.version)
    ? 'Its upgrade ledger was recorded, so pnpm db:upgrade may finish it. If that refuses, drop this database, create an empty one and run pnpm db:push-full again.'
    : 'Drop this database, create an empty one and run pnpm db:push-full again.');
  return lines;
}

export async function main() {
  loadRootEnv(import.meta.url);
  const databaseUrl = resolveDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Hold the same lock as db:upgrade across the whole fresh operation.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      const result = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'`);
      const tableCount = Number(result.rows[0]?.count ?? 0);
      if (tableCount !== 0) {
        throw new Error(`Refusing fresh initialization: ${tableCount} application table(s) already exist at ${maskDatabaseUrl(databaseUrl)}. Use db:upgrade only for a supported, ledgered release or a verified v0.2.0-preview.1 baseline.`);
      }
      console.log(`[OK] Fresh database confirmed at ${maskDatabaseUrl(databaseUrl)}.`);
      try {
        await buildFreshSchema(client);
      } catch (error) {
        for (const line of await describeIncompleteFreshInit(client, error)) console.error(`[FAIL] ${line}`);
        throw error;
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}

async function buildFreshSchema(client: InstanceType<typeof Client>) {
  await run(['pnpm', 'exec', 'tsx', 'scripts/ensure-pgvector.ts']);
  await run(['pnpm', 'exec', 'drizzle-kit', 'push', '--force']);
  await run(['pnpm', 'exec', 'tsx', 'scripts/apply-extras.ts', '--fresh-init']);

  // Only this verified-empty invocation, after every schema step succeeds,
  // may attest the immutable schema117 bootstrap. A crash
  // before this transaction leaves an unledgered schema that both fresh
  // initialization and the upgrader refuse to auto-certify.
  await client.query('BEGIN');
  try {
    const existing = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS present");
    if (existing.rows[0]?.present) throw new Error('Fresh migration ledger already exists');
    await client.query(`CREATE TABLE deft_schema_migrations (
      version text PRIMARY KEY,
      description text NOT NULL,
      checksum text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('baseline', 'migration')),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await reconcileFreshSchemaContracts(client);
    await client.query(`INSERT INTO deft_schema_migrations
      (version, description, checksum, kind) VALUES ($1,$2,$3,'baseline')`,
    [upgradeManifest.baseline.version,
      `Supported schema baseline ${upgradeManifest.baseline.releaseTag}`,
      baselineChecksum()]);
    const bootstrapEnd = upgradeManifest.migrations.findIndex(row => row.version === FRESH_BOOTSTRAP_VERSION);
    if (bootstrapEnd < 0) throw new Error('Reviewed schema117 bootstrap missing');
    for (const migration of upgradeManifest.migrations.slice(0, bootstrapEnd + 1)) {
      await client.query(`INSERT INTO deft_schema_migrations
        (version, description, checksum, kind) VALUES ($1,$2,$3,'migration')`,
      [migration.version, migration.description,
        sha256(readFileSync(resolve(upgradesDir, migration.file), 'utf8'))]);
    }
    await assertReviewedFreshBootstrap(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  // A failure here leaves an exactly reviewed117 ledger that db:upgrade
  // can recover. Never stamp118 before its SQL and final catalog succeed.
  await convergeReviewedRelease(client);
  await applyManifestTailMigrations(client);
  console.log(`[OK] Recorded ${upgradeManifest.migrations.length + 1} current schema ledger version(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('[FAIL]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
