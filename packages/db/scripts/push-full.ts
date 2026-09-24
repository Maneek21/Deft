import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';
import { LOCK_ID, baselineChecksum, sha256 } from './upgrade.ts';
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

      await run(['pnpm', 'exec', 'tsx', 'scripts/ensure-pgvector.ts']);
      await run(['pnpm', 'exec', 'drizzle-kit', 'push', '--force']);
      await run(['pnpm', 'exec', 'tsx', 'scripts/apply-extras.ts']);

      // Only this verified-empty invocation, after every schema step succeeds,
      // may assert that the complete current manifest is present. A crash
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
        await client.query(`INSERT INTO deft_schema_migrations
          (version, description, checksum, kind) VALUES ($1,$2,$3,'baseline')`,
        [upgradeManifest.baseline.version,
          `Supported schema baseline ${upgradeManifest.baseline.releaseTag}`,
          baselineChecksum()]);
        for (const migration of upgradeManifest.migrations) {
          await client.query(`INSERT INTO deft_schema_migrations
            (version, description, checksum, kind) VALUES ($1,$2,$3,'migration')`,
          [migration.version, migration.description,
            sha256(readFileSync(resolve(upgradesDir, migration.file), 'utf8'))]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`[OK] Recorded ${upgradeManifest.migrations.length + 1} current schema ledger version(s).`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
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
