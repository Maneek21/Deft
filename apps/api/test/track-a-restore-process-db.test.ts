import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';

type State = Readonly<{
  org_id: string; owner_user_id: string; app_installation_id: string;
  definition_id: string; definition_epoch: number; scheduled_at: string;
  connection_id: string; provider_outbox: string; provider_effect_checkpoint: string;
}>;
type ChildCommand = Readonly<{
  action: 'scan' | 'fire' | 'attempt' | 'recover' | 'verify' | 'cleanup';
  org_id: string; definition_id: string; connection_id: string;
  now?: string; run_id?: string;
  pause_before_dispatch?: boolean; pause_after_receipt?: boolean;
}>;
type ChildMessage = Readonly<{ phase: string; [key: string]: unknown }>;

const sourceUrl = process.env.DEFT_TEST_DATABASE_URL;
const statePath = process.env.DEFT_TRACK_A_BOOTSTRAP_STATE_FILE;
const evidencePath = process.env.DEFT_TRACK_A_EVIDENCE_FILE;
const restoreName = process.env.DEFT_TRACK_A_RESTORE_DB_NAME;
function isAssignedTestSource(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1' && url.port === '55435'
      && url.search === '' && url.hash === ''
      && /^\/gate_g_phase5_test_c03b_runtime_a03a04_\d+$/.test(url.pathname);
  } catch { return false; }
}
const safe = sourceUrl && sourceUrl === process.env.DATABASE_URL && statePath
  && evidencePath && restoreName
  && isAssignedTestSource(sourceUrl)
  && /^gate_g_phase5_test_c03b_runtime_a03a04_restore_\d+$/.test(restoreName);

function launch(command: ChildCommand, databaseUrl: string, keyring: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/track-a-restore-child.ts', import.meta.url)), {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, DATABASE_URL: databaseUrl, DEFT_TEST_DATABASE_URL: databaseUrl,
      DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
      DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_AUTOMATIONS_ENABLED: 'true',
      DEFT_SELF_HOSTED: 'true', DEFT_MCP_ENABLE_UNSAFE_STDIO: 'true',
      MCP_STDIO_ALLOWED_COMMANDS: process.execPath, DEFT_APP_RUN_KEYRINGS: keyring },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
  const inbox: ChildMessage[] = [];
  const listeners: Array<(message: ChildMessage) => void> = [];
  child.on('message', (raw) => {
    const message = raw as ChildMessage;
    inbox.push(message);
    for (const listener of listeners.splice(0)) listener(message);
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  child.send(command);
  async function waitFor(phase: string, timeoutMs = 40_000): Promise<ChildMessage> {
    const existing = inbox.find((message) => message.phase === phase || message.phase === 'error');
    if (existing) {
      if (existing.phase === 'error') throw new Error(`Track A child: ${existing.message}; ${stderr}`);
      return existing;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<ChildMessage>((resolve, reject) => {
          const listener = (message: ChildMessage) => {
            if (message.phase === 'error') reject(new Error(`Track A child: ${message.message}; ${stderr}`));
            else if (message.phase === phase) resolve(message);
            else listeners.push(listener);
          };
          listeners.push(listener);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Track A ${phase} timeout; ${stderr}`)), timeoutMs);
        }),
        exited.then((code) => { throw new Error(`Track A child exited ${code} before ${phase}; ${stderr}`); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  return { child, waitFor, exited, stderr: () => stderr };
}

async function one(command: ChildCommand, databaseUrl: string, keyring: string) {
  console.log('TRACK_A_START', command.action, new URL(databaseUrl).pathname);
  const process = launch(command, databaseUrl, keyring);
  try {
    const done = await process.waitFor('done');
    assert.equal(await process.exited, 0, process.stderr());
    console.log('TRACK_A_DONE', command.action, new URL(databaseUrl).pathname);
    return done;
  } finally {
    if (process.child.exitCode === null) process.child.kill('SIGKILL');
    await process.exited;
  }
}

async function fireRun(databaseUrl: string, state: State, day: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ id: string; state: string; app_run_id: string | null }>(
      `SELECT id, state, app_run_id FROM app_automation_fires
       WHERE org_id = $1 AND definition_id = $2 AND logical_local_date = $3`,
      [state.org_id, state.definition_id, day]);
    assert.equal(result.rows.length, 1);
    return result.rows[0]!;
  } finally { await client.end(); }
}

async function effectRows(path: string): Promise<Array<{ idempotency_key: string }>> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForEffect(path: string, count: number) {
  for (let elapsed = 0; elapsed < 20_000; elapsed += 25) {
    if ((await effectRows(path)).length >= count) return;
    await delay(25);
  }
  throw new Error(`External effect ledger did not reach ${count}`);
}

async function waitForFile(path: string) {
  for (let elapsed = 0; elapsed < 20_000; elapsed += 25) {
    if (existsSync(path)) return;
    await delay(25);
  }
  throw new Error(`Provider checkpoint did not appear: ${path}`);
}

function wslPg(tool: string, ...args: string[]) {
  return execFileSync('wsl', ['-d', 'Deft-CRM-Test', '--',
    `/usr/lib/postgresql/16/bin/${tool}`, ...args], { timeout: 90_000, encoding: 'utf8' });
}

test('Track A production automation survives process kills and DB/keyring restore', {
  skip: !safe, timeout: 480_000,
}, async (t) => {
  const state = JSON.parse(await readFile(statePath!, 'utf8')) as State;
  const liveChildren = new Set<ReturnType<typeof launch>>();
  const trackedLaunch = (command: ChildCommand, databaseUrl: string, keyring: string) => {
    const running = launch(command, databaseUrl, keyring);
    liveChildren.add(running);
    void running.exited.then(() => liveChildren.delete(running));
    return running;
  };
  t.after(async () => {
    for (const running of liveChildren) running.child.kill('SIGKILL');
    await Promise.allSettled([...liveChildren].map((running) => running.exited));
    if (existsSync(state.provider_effect_checkpoint)
      && !existsSync(`${state.provider_effect_checkpoint}.release`)) {
      const marker = JSON.parse(await readFile(state.provider_effect_checkpoint, 'utf8')) as { pid: number };
      try { globalThis.process.kill(marker.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
  });
  const { databaseCompleteAppRunTestKeyringFixture } = await import('./fixtures/app-run-test-keyrings.js');
  const fixture = await databaseCompleteAppRunTestKeyringFixture('loop5-lifecycle');
  const keyring = fixture.environment;
  fixture.keys.destroy();
  const base = new Date(state.scheduled_at);
  const atDay = (days: number) => new Date(base.getTime() + days * 86_400_000 + 60_000).toISOString();
  const day = (days: number) => atDay(days).slice(0, 10);
  const command = (action: ChildCommand['action'], extra: Partial<ChildCommand> = {}): ChildCommand => ({
    action, org_id: state.org_id, definition_id: state.definition_id,
    connection_id: state.connection_id, ...extra,
  });

  // Crash before the queued fire is dispatched. The claimed queue job is
  // rearmed by production lease cleanup in a fresh process.
  await one(command('scan', { now: atDay(0) }), sourceUrl!, keyring);
  const beforeDispatch = trackedLaunch(command('fire', { now: atDay(0), pause_before_dispatch: true }),
    sourceUrl!, keyring);
  await beforeDispatch.waitFor('fire_claimed');
  beforeDispatch.child.kill('SIGKILL');
  await beforeDispatch.exited;
  assert.equal((await effectRows(state.provider_outbox)).length, 0);
  await delay(1_200);
  assert.equal((await one(command('cleanup'), sourceUrl!, keyring)).recovered_jobs, 1);
  await delay(5_200);
  await one(command('fire', { now: atDay(0) }), sourceUrl!, keyring);
  const firstFire = await fireRun(sourceUrl!, state, day(0));
  assert.equal(firstFire.state, 'run_created');
  assert.ok(firstFire.app_run_id);

  // The sandbox MCP provider fsyncs its independent outbox, then waits before
  // replying. Kill the actual App Run worker in that gap.
  const afterEffect = trackedLaunch(command('attempt', { run_id: firstFire.app_run_id }), sourceUrl!, keyring);
  await afterEffect.waitFor('attempt_claimed');
  await waitForEffect(state.provider_outbox, 1);
  await waitForFile(state.provider_effect_checkpoint);
  const marker = JSON.parse(await readFile(state.provider_effect_checkpoint, 'utf8')) as { pid: number };
  afterEffect.child.kill('SIGKILL');
  await afterEffect.exited;
  try { globalThis.process.kill(marker.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  assert.equal((await effectRows(state.provider_outbox)).length, 1);
  const recovered = await one(command('recover', { run_id: firstFire.app_run_id }), sourceUrl!, keyring);
  assert.equal(recovered.recovered, 1);
  await one(command('attempt', { run_id: firstFire.app_run_id }), sourceUrl!, keyring);
  assert.equal((await effectRows(state.provider_outbox)).length, 1,
    'idempotency-bound recovery must not create a second external effect');
  const firstVerified = await one(command('verify', { run_id: firstFire.app_run_id }), sourceUrl!, keyring);
  assert.equal(firstVerified.run_state, 'succeeded');
  assert.ok(Number(firstVerified.verified_receipts) >= 1);

  // A second daily fire reaches a durable receipt; kill its worker before it
  // acknowledges the queue job. Re-delivery cannot repeat the effect.
  await writeFile(`${state.provider_effect_checkpoint}.release`, 'release', { flag: 'wx' });
  await one(command('scan', { now: atDay(1) }), sourceUrl!, keyring);
  await one(command('fire', { now: atDay(1) }), sourceUrl!, keyring);
  const secondFire = await fireRun(sourceUrl!, state, day(1));
  assert.ok(secondFire.app_run_id);
  const afterReceipt = trackedLaunch(command('attempt', { run_id: secondFire.app_run_id,
    pause_after_receipt: true }), sourceUrl!, keyring);
  await afterReceipt.waitFor('receipt_committed');
  afterReceipt.child.kill('SIGKILL');
  await afterReceipt.exited;
  assert.equal((await effectRows(state.provider_outbox)).length, 2);
  assert.equal((await one(command('verify', { run_id: secondFire.app_run_id }),
    sourceUrl!, keyring)).run_state, 'succeeded');
  await delay(10_200);
  await one(command('cleanup'), sourceUrl!, keyring);
  await delay(5_200);
  await one(command('attempt', { run_id: secondFire.app_run_id }), sourceUrl!, keyring);
  assert.equal((await effectRows(state.provider_outbox)).length, 2);

  // Physical data copy into a fresh database. The provider outbox is NOT in
  // the dump and the exact synthetic keyring is passed to the new process.
  const dumpPath = `/tmp/deft-track-a-${randomUUID()}.dump`;
  wslPg('pg_dump', '-h', '127.0.0.1', '-p', '55435', '-U', 'gate_g_test',
    '-Fc', '-f', dumpPath, new URL(sourceUrl!).pathname.slice(1));
  wslPg('createdb', '-h', '127.0.0.1', '-p', '55435', '-U', 'gate_g_test', restoreName!);
  wslPg('pg_restore', '-h', '127.0.0.1', '-p', '55435', '-U', 'gate_g_test',
    '-d', restoreName!, dumpPath);
  const restoredUrl = new URL(sourceUrl!);
  restoredUrl.pathname = `/${restoreName!}`;
  const targetUrl = restoredUrl.toString();
  assert.equal((await one(command('verify', { run_id: firstFire.app_run_id }),
    targetUrl, keyring)).run_state, 'succeeded');
  assert.equal((await one(command('verify', { run_id: secondFire.app_run_id }),
    targetUrl, keyring)).run_state, 'succeeded');
  await one(command('scan', { now: atDay(2) }), targetUrl, keyring);
  await one(command('fire', { now: atDay(2) }), targetUrl, keyring);
  const thirdFire = await fireRun(targetUrl, state, day(2));
  assert.ok(thirdFire.app_run_id);
  await one(command('attempt', { run_id: thirdFire.app_run_id }), targetUrl, keyring);
  assert.equal((await one(command('verify', { run_id: thirdFire.app_run_id }),
    targetUrl, keyring)).run_state, 'succeeded');
  const ledger = await effectRows(state.provider_outbox);
  assert.equal(ledger.length, 3);
  assert.equal(new Set(ledger.map((row) => row.idempotency_key)).size, 3);
  await writeFile(evidencePath!, JSON.stringify({
    source_database: new URL(sourceUrl!).pathname.slice(1), restored_database: restoreName,
    dump_path: dumpPath, keyring_sha256: createHash('sha256').update(keyring).digest('hex'),
    source_runs: [firstFire.app_run_id, secondFire.app_run_id], restored_run: thirdFire.app_run_id,
    provider_outbox: state.provider_outbox, external_effects: ledger.length,
    crash_windows: ['before_fire_dispatch', 'after_effect_before_response', 'after_receipt_before_queue_ack'],
  }, null, 2), { flag: 'wx' });
});
