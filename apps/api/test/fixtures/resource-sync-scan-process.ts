// Synthetic scheduler restart consumer. Separate process, real queue and runtime.
import { closeDb } from '../../src/lib/db.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../../src/lib/app-run-runtime.js';
import { dequeueJob, completeJob, QUEUE_NAMES } from '../../src/lib/queues.js';
import { APP_RESOURCE_SYNC_SCAN_JOB, scanAppResourceSyncBindings } from '../../src/lib/app-resource-sync-scanner.js';

if (process.env.DATABASE_URL !== process.env.DEFT_TEST_DATABASE_URL
  || process.env.DATABASE_URL !== 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_scheduler') {
  throw new Error('Scheduler restart fixture requires its dedicated synthetic database');
}
try {
  const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS,
    { jobName: APP_RESOURCE_SYNC_SCAN_JOB, leaseMs: 60_000 });
  if (!job) throw new Error('No due resource sync scan');
  const runtime = await getAppRunRuntime();
  const result = await scanAppResourceSyncBindings(job, runtime.resourceSyncAdmission);
  if (!await completeJob(job.id, job.lockToken)) throw new Error('Lost restart fixture lease');
  console.log(`scheduler-restart:${JSON.stringify(result)}`);
} finally {
  await shutdownAppRunRuntime();
  await closeDb();
}
process.exit(0);
