import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';

const sourceUrl = process.env.DEFT_TEST_DATABASE_URL;
const targetName = process.env.DEFT_SYNC_RESTORE_TARGET_DATABASE ?? 'gate_g_20260926_restore_target';
const artifactRoot = process.env.DEFT_SYNC_RESTORE_ARTIFACT_DIR;
const assigned = sourceUrl === process.env.DATABASE_URL
  && sourceUrl === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_restore_source'
  && /^gate_g_20260926_restore_target(?:_[a-z0-9]{1,16})?$/.test(targetName) && artifactRoot;

type Message = { phase: string; [key: string]: any };
type Command = { action: string; state_path: string; ledger_path: string; pause?: string; revision?: number };
function launch(command: Command, databaseUrl: string, configPath: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, DEFT_TEST_DATABASE_URL: databaseUrl,
    DEFT_SYNC_RESTORE_CONFIG: configPath, TZ: 'UTC' };
  delete env.DEFT_APP_RUN_KEYRINGS;
  const child = fork(fileURLToPath(new URL('./fixtures/resource-sync-restore-child.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env,
  });
  const messages: Message[] = [];
  child.on('message', (message) => messages.push(message as Message));
  let stderr = '';
  child.stderr?.on('data', (value) => { stderr = (stderr + value).slice(-4_000); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.send(command);
  const wait = async (phase: string): Promise<Message> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const message = messages.find((item) => item.phase === phase || item.phase === 'error');
      if (message) {
        if (message.phase === 'error' && phase !== 'error') throw new Error(JSON.stringify(message));
        return message;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before ${phase}: ${stderr}`);
      await delay(25);
    }
    throw new Error(`Child timed out before ${phase}: ${stderr}`);
  };
  return { child, wait, exited };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
async function one(command: Command, databaseUrl: string, configPath: string, phase: string) {
  const running = launch(command, databaseUrl, configPath);
  try {
    const value = await running.wait(phase);
    await running.wait('done');
    await running.exited;
    assert.equal(running.child.exitCode, 0);
    return value;
  } finally { await kill(running.child); }
}
async function rows(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const table of ['app_resource_bindings', 'app_sync_checkpoints', 'app_sync_intents',
      'app_resource_projections', 'app_runs', 'app_run_attempts', 'app_run_secret_payloads', 'app_run_receipts']) {
      counts[table] = (await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
    }
    return counts;
  } finally { await client.end(); }
}
async function observations(path: string) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function waitUntil(iso: string) {
  while (Date.now() < new Date(iso).getTime()) await delay(Math.min(1_000, new Date(iso).getTime() - Date.now()));
}
async function wslPg(tool: 'pg_dump' | 'pg_restore', args: string[]) {
  const result = await promisify(execFile)('wsl', ['-d', 'Deft-CRM-Test', '--',
    `/usr/lib/postgresql/16/bin/${tool}`, ...args], { timeout: 120_000, windowsHide: true });
  assert.equal(result.stderr.trim(), '', `${tool} emitted unexpected diagnostics`);
}

test('private sync survives real process loss and DB plus keyring restore without unsafe replay', {
  skip: !assigned, timeout: 480_000,
}, async (t) => {
  const root = resolve(artifactRoot!);
  assert.ok(!root.startsWith(resolve(import.meta.dirname, '..', '..', '..')), 'artifacts must stay outside repository');
  await mkdir(root, { recursive: true });
  const configPath = resolve(root, 'source-config.json');
  const restoredConfig = resolve(root, 'restored-config.json');
  const missingConfig = resolve(root, 'missing-key-config.json');
  const statePath = resolve(root, 'state.json');
  const ledgerPath = resolve(root, 'provider-observations.jsonl');
  const dumpPath = resolve(root, 'source.dump');
  assert.match(dumpPath, /^C:\\/i, 'WSL proof uses an explicit C drive artifact');
  const linuxDump = `/mnt/c/${dumpPath.slice(3).replaceAll('\\', '/')}`;
  const config = { schema_version: 'deft.synthetic_restore_config.v1', flags: {
    DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true' }, keyring: JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'restore-enc', keys: { 'restore-enc': Buffer.from(digest('restore-encryption'), 'hex').toString('base64') } },
    receipt_signing: { current: 'restore-sig', keys: { 'restore-sig': Buffer.from(digest('restore-signing'), 'hex').toString('base64') } },
    fingerprint: { current: 'restore-fp', keys: { 'restore-fp': Buffer.from(digest('restore-fingerprint'), 'hex').toString('base64') } } }) };
  await writeFile(configPath, JSON.stringify(config), { flag: 'wx' });
  const admin = new pg.Client({ connectionString: 'postgresql://gate_g_test@127.0.0.1:55435/postgres' });
  await admin.connect();
  try { assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetName])).rows.length, 0,
    'restore destination must be new; this proof never drops an existing DB'); }
  finally { await admin.end(); }
  const command = (action: string, extra: Partial<Command> = {}): Command => ({ action,
    state_path: statePath, ledger_path: ledgerPath, ...extra });
  const children: ChildProcess[] = [];
  t.after(async () => { await Promise.allSettled(children.map(kill)); });
  console.log('RESTORE_PHASE source settlement then process kill');
  const source = launch(command('bootstrap', { pause: 'after_commit', revision: 1 }), sourceUrl!, configPath);
  children.push(source.child);
  const sourceSettled = await source.wait('settled');
  assert.equal(sourceSettled.cursor_sequence, 1);
  assert.equal(sourceSettled.terminal_receipts, 1);
  await kill(source.child);
  assert.equal((await observations(ledgerPath)).length, 1);
  const sourceRows = await rows(sourceUrl!);
  console.log('RESTORE_PHASE consistent dump and fresh target restore');
  await wslPg('pg_dump', ['-h', '127.0.0.1', '-p', '55435', '-U', 'gate_g_test', '-Fc', '--no-owner', '--no-acl',
    '-f', linuxDump, 'gate_g_20260926_restore_source']);
  const creator = new pg.Client({ connectionString: 'postgresql://gate_g_test@127.0.0.1:55435/postgres' });
  await creator.connect();
  try { await creator.query(`CREATE DATABASE ${targetName}`); } finally { await creator.end(); }
  await wslPg('pg_restore', ['-h', '127.0.0.1', '-p', '55435', '-U', 'gate_g_test', '--exit-on-error',
    '--no-owner', '--no-acl', '-d', targetName, linuxDump]);
  await copyFile(configPath, restoredConfig);
  assert.equal(digest(await readFile(configPath)), digest(await readFile(restoredConfig)));
  const targetUrl = `postgresql://gate_g_test@127.0.0.1:55435/${targetName}`;
  assert.deepEqual(await rows(targetUrl), sourceRows, 'all selected encrypted execution/projection counts survive restore');
  const bad = JSON.parse(config.keyring);
  bad.run_encryption = { current: 'missing-original', keys: { 'missing-original': Buffer.alloc(32, 7).toString('base64') } };
  await writeFile(missingConfig, JSON.stringify({ ...config, keyring: JSON.stringify(bad) }), { flag: 'wx' });
  const missing = launch(command('verify'), targetUrl, missingConfig);
  children.push(missing.child);
  const missingError = await missing.wait('error');
  await missing.exited;
  assert.equal(missingError.code, 'APP_RUN_KEY_VERSION_UNAVAILABLE');
  console.log('RESTORE_PHASE new process private reads receipts and exact callback replay');
  const restored = await one(command('verify'), targetUrl, restoredConfig, 'verified');
  assert.equal(restored.cursor_sequence, 1);
  assert.equal(restored.projection_id, sourceSettled.projection_id);
  assert.deepEqual(restored.ref, sourceSettled.ref);
  assert.equal(restored.terminal_receipts, 1);
  const replay = await one(command('replay'), targetUrl, restoredConfig, 'replayed');
  assert.equal(replay.cursor_sequence, 1);
  assert.equal((await observations(ledgerPath)).length, 1);
  assert.deepEqual(await rows(targetUrl), sourceRows, 'exact callback replay does not duplicate durable state');
  await waitUntil(new Date(Date.parse(sourceSettled.admitted_at) + 61_000).toISOString());
  console.log('RESTORE_PHASE newly due restored cursor settles once');
  const next = launch(command('next', { pause: 'after_commit', revision: 2 }), targetUrl, restoredConfig);
  children.push(next.child);
  const nextSettled = await next.wait('settled');
  await kill(next.child);
  assert.equal(nextSettled.cursor_sequence, 2);
  assert.equal(nextSettled.projection_id, sourceSettled.projection_id);
  assert.deepEqual(nextSettled.ref, sourceSettled.ref);
  assert.equal(nextSettled.terminal_receipts, 2);
  assert.equal((await observations(ledgerPath)).length, 2);
  const replayNext = await one(command('replay'), targetUrl, restoredConfig, 'replayed');
  assert.equal(replayNext.cursor_sequence, 2);
  assert.equal((await observations(ledgerPath)).length, 2);
  await waitUntil(new Date(Date.parse(nextSettled.admitted_at) + 61_000).toISOString());
  console.log('RESTORE_PHASE process killed after input release and fsynced source observation');
  const crashed = launch(command('next', { pause: 'after_observation', revision: 3 }), targetUrl, restoredConfig);
  children.push(crashed.child);
  const observed = await crashed.wait('observed');
  await kill(crashed.child);
  assert.equal(observed.cursor_sequence, 2);
  assert.equal((await observations(ledgerPath)).length, 3);
  await waitUntil(new Date(Date.parse(observed.lease_expires_at) + 250).toISOString());
  const recovered = await one(command('recover'), targetUrl, restoredConfig, 'recovered');
  assert.equal(recovered.state, 'unknown_outcome');
  assert.equal(recovered.cursor_sequence, 2);
  assert.equal(recovered.revision, 'revision-2');
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.admission_blocked, true);
  assert.equal((await observations(ledgerPath)).length, 3);
  const revoked = await one(command('revoke'), targetUrl, restoredConfig, 'revoked');
  assert.equal(revoked.read_denied, true);
  const ledger = await observations(ledgerPath);
  assert.equal(new Set(ledger.map((item) => item.run_id)).size, 3);
  const evidence = { schema_version: 'deft.gate_g.private_sync_restore.v1',
    source_database: new URL(sourceUrl!).pathname.slice(1), restored_database: targetName,
    source_rows: sourceRows, dump_sha256: digest(await readFile(dumpPath)),
    restored_config_sha256: digest(await readFile(restoredConfig)),
    missing_key_denied: missingError.code, source: sourceSettled, restored, replay,
    newly_due: nextSettled, crash: { ...observed, ...recovered }, revoked,
    observations: ledger, crash_windows: ['after_atomic_commit_before_ack', 'after_input_observation_before_commit'],
    service_boundary_only: true };
  await writeFile(resolve(root, 'restore-evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  t.diagnostic(JSON.stringify({ restored_private_projection: true, source_observations: ledger.length,
    settled_runs: 2, unknown_runs: 1, unchanged_cursor_blocked: true }));
});
