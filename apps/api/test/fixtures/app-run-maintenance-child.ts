/** Synthetic separate process. IPC carries transient credentials privately;
 * reports retain only Run/attempt/queue state, never credential values. */
import { writeFile } from 'node:fs/promises';

const database = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (database.username !== 'gate_g_test' || database.hostname !== '127.0.0.1' || database.port !== '55435'
  || !/^\/gate_g_20260926_c12_runtime_maintenance_test(?:_v[0-9]+)?$/.test(database.pathname)) {
  throw Error('Synthetic maintenance child requires dedicated guarded database');
}

// Reject an unsafe target before loading the API dependency graph. Static
// imports run before the guard and delayed rejection past its bounded timeout.
const [{ AppRunAttemptRunner }, { AppRunSecretService }, { PostgresAppRunReceiptWriter },
  { AppResourceSyncChannel }, { AppRuntimeChannel }, { getAppRunRuntime, shutdownAppRunRuntime },
  { closeDb }] = await Promise.all([
  import('../../src/lib/app-run-attempt-runner.js'), import('../../src/lib/app-run-secrets.js'),
  import('../../src/lib/app-run-receipts.js'), import('../../src/lib/app-resource-sync-channel.js'),
  import('../../src/lib/app-runtime-channel.js'), import('../../src/lib/app-run-runtime.js'),
  import('../../src/lib/db.js'),
]);

process.on('message', async (message: any) => {
  try {
    if (message.mode === 'warm') {
      await getAppRunRuntime(); process.send?.({ warmed: true });
    } else if (message.mode === 'provider') {
      const runtime = await getAppRunRuntime(); const secrets = new AppRunSecretService(runtime.keys);
      const runner = new AppRunAttemptRunner(runtime.repository, runtime.secretRepository, secrets,
        { async execute() { throw Error('External provider runs in the child'); } }, undefined, () => new Date(),
        message.leaseMs ?? 1_000, undefined, new PostgresAppRunReceiptWriter(secrets, runtime.secretRepository));
      const channel = message.identity.audience === 'app_resource_sync' ? new AppResourceSyncChannel(runner) : new AppRuntimeChannel(runner);
      const claim = await channel.claim({ ...message.identity, max_claims: 1 }); if (!claim) {
        const error = Error('Claim failed'); error.name = 'APP_TEST_CLAIM_FAILED'; throw error;
      }
      const attempt = { ...message.identity, run_id: claim.run_id, attempt_id: claim.attempt_id,
        claim_token: claim.claim_token, sequence: claim.sequence };
      if (message.started && !await channel.start(attempt)) throw Error('Start failed');
      if (message.started) {
        if (typeof message.ledgerPath !== 'string') throw Error('Synthetic effect ledger required');
        await writeFile(message.ledgerPath, JSON.stringify({ run_id: claim.run_id, effect: 'synthetic_provider_effect' })+'\n', { flag: 'wx' });
      }
      process.send?.({ ready: true, run_id: claim.run_id, attempt_id: claim.attempt_id, released: message.started,
        effect_recorded: message.started });
    } else if (message.mode === 'maintenance') {
      const maintenance = await import('../../src/lib/app-run-maintenance.js');
      await maintenance.runAppRunMaintenance(message.kind); process.send?.({ committed: true });
    } else if (message.mode === 'worker') {
      await (await import('../../src/workers/index.js')).startWorkers(); process.send?.({ ready: true });
    } else if (message.mode === 'stop') {
      await (await import('../../src/workers/index.js')).stopWorkers();
      await (await import('../../src/lib/app-run-maintenance.js')).stopAppRunMaintenance();
      await shutdownAppRunRuntime(); await closeDb(); process.send?.({ stopped: true }); process.exit(0);
    }
  } catch (error) { process.send?.({ failed: true, code: error instanceof Error ? error.name : 'unknown' }); }
});
