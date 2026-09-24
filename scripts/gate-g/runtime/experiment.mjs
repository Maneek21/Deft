import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  attempts, cancel, claim, complete, heartbeat, identity, openHost, recover, run, seed,
} from './state.mjs';

const outIndex = process.argv.indexOf('--out');
const outputDir = outIndex >= 0 ? process.argv[outIndex + 1] : mkdtempSync(join(tmpdir(), 'deft-gate-g-runtime-'));
if (!outputDir) throw new Error('--out requires a directory');
if (outIndex >= 0) {
  if (existsSync(outputDir)) throw new Error(`output directory must be fresh: ${outputDir}`);
  mkdirSync(outputDir, { recursive: true });
}
const hostPath = join(outputDir, 'simulated-host.sqlite');
const providerPath = join(outputDir, 'external-provider-effects.sqlite');
const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const providerPathScript = fileURLToPath(new URL('./provider.mjs', import.meta.url));
const db = openHost(hostPath);
const observations = [];
const activeWorkers = new Set();

function provider(command, key = 'unused') {
  return Number(execFileSync(process.execPath,
    [providerPathScript, command, providerPath, key],
    { encoding: 'utf8', timeout: 12_000, maxBuffer: 64 * 1024 }).trim());
}
function replayProviderEffect(runId) {
  execFileSync(process.execPath, [providerPathScript, 'effect', providerPath,
    `idempotent:${runId}`], { encoding: 'utf8', timeout: 12_000, maxBuffer: 64 * 1024 });
}
function lookup(runId) { return provider('lookup', `idempotent:${runId}`) === 1; }
function record(caseName, runId, recovery, extra = {}) {
  observations.push({ case: caseName, recovery, run: run(db, runId).state,
    attempts: attempts(db, runId).map(({ number, state }) => ({ number, state })),
    provider_effect_count: provider('count'), ...extra });
}
function worker(runId, mode, retryClass) {
  const child = fork(workerPath, [hostPath, providerPath, runId, mode, retryClass],
    { silent: true });
  activeWorkers.add(child);
  child.once('exit', () => activeWorkers.delete(child));
  child.once('error', () => activeWorkers.delete(child));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}
function message(child, event, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup(); reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const onMessage = (value) => {
      if (value.event !== event) return;
      cleanup(); resolve(value);
    };
    const onExit = (code) => { cleanup(); reject(new Error(`worker exited ${code} before ${event}`)); };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit);
      child.off('error', onError);
    }
    child.on('message', onMessage); child.on('exit', onExit); child.on('error', onError);
  });
}
async function kill(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`worker ${child.pid} did not exit`)), 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  child.kill('SIGKILL');
  await exit;
}
async function pauseAt(runId, mode, retryClass) {
  const child = worker(runId, mode, retryClass);
  const first = await message(child, 'claim');
  assert.equal(first.accepted, true);
  await message(child, 'heartbeat');
  await message(child, mode);
  return { child, claim: first.claim, process_id: first.process_id };
}
async function finish(runId, retryClass) {
  const child = worker(runId, 'complete', retryClass);
  const first = await message(child, 'claim');
  assert.equal(first.accepted, true);
  const completed = await message(child, 'completion');
  assert.equal(completed.accepted, true);
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`worker ${child.pid} did not exit`)), 5_000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
async function leaseExpire() { await delay(1_700); }

try {
  // All three processes are real OS processes: this coordinator, a runtime
  // worker, and a provider CLI process with its own persistent effect file.
  seed(db, 'before', 'idempotent_with_key');
  const before = await pauseAt('before', 'before_effect', 'idempotent_with_key');
  if (process.argv.includes('--fail-after-first-pause')) {
    writeFileSync(join(outputDir, 'injected-worker-pid.txt'), String(before.process_id));
    throw new Error('injected failure after first worker pause');
  }
  assert.equal(claim(db, 'before'), null, 'double claim must be denied');
  assert.equal(provider('count'), 0);
  await kill(before.child);
  await leaseExpire();
  assert.equal(recover(db, 'before', lookup), 'retry_prepared');
  assert.equal(heartbeat(db, before.claim.id, before.claim.token, 2), false);
  assert.equal(complete(db, before.claim.id, before.claim.token), false);
  await finish('before', 'idempotent_with_key');
  assert.equal(provider('count'), 1);
  record('kill_before_effect', 'before', 'retry_prepared', {
    killed_worker_process_id: before.process_id,
    stale_heartbeat_denied: true, stale_completion_denied: true, double_claim_denied: true,
  });

  seed(db, 'after', 'idempotent_with_key');
  const after = await pauseAt('after', 'after_effect', 'idempotent_with_key');
  assert.equal(provider('count'), 2);
  await kill(after.child);
  await leaseExpire();
  assert.equal(recover(db, 'after', lookup), 'reconciled_success');
  assert.equal(complete(db, after.claim.id, after.claim.token), false);
  assert.equal(claim(db, 'after'), null);
  replayProviderEffect('after');
  assert.equal(provider('count'), 2);
  record('kill_after_effect_before_ack', 'after', 'reconciled_success', {
    killed_worker_process_id: after.process_id,
    stale_completion_denied: true, provider_replay_deduplicated: true, no_second_effect: true,
  });

  seed(db, 'unsupported', 'unsafe_or_unknown');
  const unsupported = await pauseAt('unsupported', 'after_effect', 'unsafe_or_unknown');
  assert.equal(provider('count'), 3);
  await kill(unsupported.child);
  await leaseExpire();
  assert.equal(recover(db, 'unsupported', lookup), 'unknown_outcome');
  assert.equal(claim(db, 'unsupported'), null);
  assert.equal(provider('count'), 3);
  record('unsupported_reconciliation', 'unsupported', 'unknown_outcome', {
    killed_worker_process_id: unsupported.process_id,
    no_unsafe_retry: true,
  });

  seed(db, 'cancel', 'idempotent_with_key');
  const canceled = await pauseAt('cancel', 'before_effect', 'idempotent_with_key');
  cancel(db, 'cancel');
  assert.equal(heartbeat(db, canceled.claim.id, canceled.claim.token, 2), false);
  assert.equal(complete(db, canceled.claim.id, canceled.claim.token), false);
  await kill(canceled.child);
  await leaseExpire();
  assert.equal(recover(db, 'cancel', lookup), 'no_work');
  assert.equal(claim(db, 'cancel'), null);
  assert.equal(provider('count'), 3);
  record('cancellation_before_effect', 'cancel', 'no_work', { callback_denied: true });

  seed(db, 'identity', 'idempotent_with_key');
  for (const field of ['org_id', 'actor_id', 'installation_id', 'version_id', 'grant_id', 'epoch']) {
    assert.equal(claim(db, 'identity', { ...identity, [field]: field === 'epoch' ? 8 : 'foreign' }), null,
      `${field} substitution must be denied`);
  }
  assert.equal(attempts(db, 'identity')[0].state, 'pending');
  record('identity_substitution', 'identity', 'not_claimed', { substitutions_denied: 6 });

  const result = {
    kind: 'simulated_external_runtime_experiment',
    source: 'scripts/gate-g/runtime',
    generated_at: new Date().toISOString(),
    node: process.version,
    coordinator_process_id: process.pid,
    processes: 'coordinator, forked runtime worker, separately spawned durable provider CLI',
    host_ledger: hostPath,
    provider_ledger: providerPath,
    observations,
    caveat: 'This fixture models a proposed external claim protocol. It does not call production App Run services and cannot certify R03/R05.',
  };
  writeFileSync(join(outputDir, 'results.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  const cleanup = await Promise.allSettled([...activeWorkers].map(kill));
  db.close();
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(
    failures.map((result) => result.reason), 'failed to stop runtime workers');
}
