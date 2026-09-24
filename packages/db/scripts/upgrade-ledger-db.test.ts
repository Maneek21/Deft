import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { baselineChecksum, sha256 } from './upgrade.ts';
import { upgradeManifest } from '../upgrades/manifest.ts';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upgradesDir = resolve(packageDir, 'upgrades');

const profile = process.env.DEFT_TEST_LEDGER_PROFILE === 'gate_g_c05';
const assignedDatabases = {
  DEFT_TEST_FRESH_DATABASE_URL: 'gate_g_phase5_test_c05_ledger_accept_fresh',
  DEFT_TEST_UNTRACKED_DATABASE_URL: 'gate_g_phase5_test_c05_ledger_accept_untracked',
  DEFT_TEST_PARTIAL_DATABASE_URL: 'gate_g_phase5_test_c05_ledger_accept_partial',
  DEFT_TEST_BASELINE_DATABASE_URL: 'gate_g_phase5_test_c05_ledger_accept_baseline',
} as const;

function assignedUrl(name: keyof typeof assignedDatabases) {
  if (!profile) return null;
  const value = process.env[name];
  if (!value) throw new Error(`Missing assigned synthetic URL ${name}`);
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1'
    || url.port !== '55435' || url.username !== 'gate_g_test'
    || url.password || url.search || url.hash
    || url.pathname !== `/${assignedDatabases[name]}`) {
    throw new Error(`Wrong assigned synthetic URL for ${name}`);
  }
  return value;
}

if (profile) {
  const urls = (Object.keys(assignedDatabases) as Array<keyof typeof assignedDatabases>)
    .map(assignedUrl);
  assert.equal(new Set(urls).size, 4, 'Each ledger case needs its own disposable database');
}

async function command(url: string, args: readonly string[]) {
  return new Promise<{ code: number; output: string }>((resolveCommand, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm',
      windows ? ['/d', '/s', '/c', ['pnpm', ...args].join(' ')] : args, { cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolveCommand({ code: code ?? 1, output }));
  });
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

async function catalogState(client: pg.Client) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::integer FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
    (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n
      ON n.oid=c.connamespace WHERE n.nspname='public') AS constraints,
    (SELECT count(*)::integer FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
    to_regclass('public.deft_schema_migrations') IS NOT NULL AS ledger,
    to_regclass('public.automation_runs') IS NOT NULL AS post_baseline`);
  return rows[0];
}

test('fresh push records exact manifest history and the ordinary upgrader is a no-op', {
  skip: !assignedUrl('DEFT_TEST_FRESH_DATABASE_URL'),
}, async () => {
  const url = assignedUrl('DEFT_TEST_FRESH_DATABASE_URL')!;
  assert.equal((await withClient(url, catalogState)).tables, 0,
    'This test requires a dedicated empty synthetic database');
  const pushed = await command(url, ['run', 'push-full']);
  assert.equal(pushed.code, 0, pushed.output.slice(-2000));
  await withClient(url, async (client) => {
    const { rows } = await client.query(`SELECT version,checksum,kind
      FROM deft_schema_migrations`);
    assert.equal(rows.length, upgradeManifest.migrations.length + 1);
    const found = new Map(rows.map((row) => [row.version, row]));
    assert.equal(found.get(upgradeManifest.baseline.version)?.checksum, baselineChecksum());
    assert.equal(found.get(upgradeManifest.baseline.version)?.kind, 'baseline');
    for (const migration of upgradeManifest.migrations) {
      assert.equal(found.get(migration.version)?.checksum,
        sha256(readFileSync(resolve(upgradesDir, migration.file), 'utf8')),
      migration.version);
    }
  });
  const before = await withClient(url, catalogState);
  const dryRun = await command(url, ['run', 'upgrade', '--dry-run']);
  assert.equal(dryRun.code, 0, dryRun.output);
  assert.match(dryRun.output, /migrations: 0 pending/);
  const upgraded = await command(url, ['run', 'upgrade']);
  assert.equal(upgraded.code, 0, upgraded.output);
  assert.match(upgraded.output, /migrations: 0 pending/);
  assert.match(upgraded.output,
    new RegExp(`current at ${upgradeManifest.migrations.at(-1)!.version.replaceAll('.', '\\.')}`));
  const repeatedPush = await command(url, ['run', 'push-full']);
  assert.notEqual(repeatedPush.code, 0);
  assert.match(repeatedPush.output, /Refusing fresh initialization/);
  assert.deepEqual(await withClient(url, catalogState), before);
});

test('advanced ledgerless schema is rejected before migration-ledger DDL', {
  skip: !assignedUrl('DEFT_TEST_UNTRACKED_DATABASE_URL'),
}, async () => {
  const url = assignedUrl('DEFT_TEST_UNTRACKED_DATABASE_URL')!;
  const before = await withClient(url, catalogState);
  assert.equal(before.ledger, false);
  assert.equal(before.post_baseline, true);
  const status = await command(url, ['run', 'upgrade', '--status']);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /untracked post-baseline schema; reviewed adoption required/);
  assert.match(status.output, /pending: unknown \(ledger missing\)/);
  const dryRun = await command(url, ['run', 'upgrade', '--dry-run']);
  assert.notEqual(dryRun.code, 0);
  assert.match(dryRun.output, /post-baseline schema but no migration history/);
  const upgraded = await command(url, ['run', 'upgrade']);
  assert.notEqual(upgraded.code, 0);
  assert.match(upgraded.output, /post-baseline schema but no migration history/);
  assert.deepEqual(await withClient(url, catalogState), before);
});

test('partial interrupted initialization cannot be stamped as fresh', {
  skip: !assignedUrl('DEFT_TEST_PARTIAL_DATABASE_URL'),
}, async () => {
  const url = assignedUrl('DEFT_TEST_PARTIAL_DATABASE_URL')!;
  assert.equal((await withClient(url, catalogState)).tables, 0,
    'This test requires a dedicated empty synthetic database');
  await withClient(url, async (client) => {
    await client.query('CREATE TABLE synthetic_partial_setup (id integer PRIMARY KEY)');
  });
  const before = await withClient(url, catalogState);
  const pushed = await command(url, ['run', 'push-full']);
  assert.notEqual(pushed.code, 0);
  assert.match(pushed.output, /Refusing fresh initialization/);
  assert.deepEqual(await withClient(url, catalogState), before);
});

test('genuine untracked v0.2.0-preview.1 baseline remains adoptable', {
  skip: !assignedUrl('DEFT_TEST_BASELINE_DATABASE_URL'),
}, async () => {
  const url = assignedUrl('DEFT_TEST_BASELINE_DATABASE_URL')!;
  const before = await withClient(url, catalogState);
  assert.equal(before.ledger, false);
  assert.equal(before.post_baseline, false);
  const dryRun = await command(url, ['run', 'upgrade', '--dry-run']);
  assert.equal(dryRun.code, 0, dryRun.output);
  assert.match(dryRun.output, /baseline: adopt v0\.2\.0-preview\.1/);
  const upgraded = await command(url, ['run', 'upgrade']);
  assert.equal(upgraded.code, 0, upgraded.output);
  assert.match(upgraded.output,
    new RegExp(`current at ${upgradeManifest.migrations.at(-1)!.version.replaceAll('.', '\\.')}`));
  await withClient(url, async (client) => {
    const { rows } = await client.query('SELECT count(*)::integer AS count FROM deft_schema_migrations');
    assert.equal(rows[0].count, upgradeManifest.migrations.length + 1);
  });
});
