import { z } from 'zod';
import type { JobHandler } from '../workers/types.js';
import { APP_RUNS_ENABLED } from './env.js';
import { RetryLaterJobError } from './queues.js';
import type { AppRunAttemptRunner } from './app-run-attempt-runner.js';

const AppRunJobSchema = z.object({
  orgId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
  attemptId: z.string().min(1).max(512),
}).strict();

export function createAppRunAttemptJobHandler(runner: AppRunAttemptRunner): JobHandler {
  return async (job) => {
    const payload = AppRunJobSchema.parse(job.data);
    await runner.run(payload.orgId, payload.runId, payload.attemptId, `job:${job.id}`, job.signal);
  };
}

/** Production handler resolves the single composition root lazily. Queue data
 * carries exact durable identity only; decrypted input never enters a job. */
export const handleAppRunAttempt: JobHandler = async (job) => {
  const payload = AppRunJobSchema.parse(job.data);
  if (!APP_RUNS_ENABLED) {
    throw new RetryLaterJobError('App Runs are disabled; durable attempt paused', 60_000);
  }
  const { getAppRunRuntime } = await import('./app-run-runtime.js');
  const runtime = await getAppRunRuntime();
  await runtime.attemptRunner.run(
    payload.orgId,
    payload.runId,
    payload.attemptId,
    `job:${job.id}`,
    job.signal,
  );
  // The native effect transaction has committed and released all Run locks.
  // Maintenance also discovers this retained association after queue loss.
  try {
    const [{ reconcilePublicCancellationForRun }, { AppRunSecretService }] = await Promise.all([
      import('./app-public-cancellation-reconcile.js'), import('./app-run-secrets.js'),
    ]);
    await runtime.repository.transaction(tx => reconcilePublicCancellationForRun(tx, payload.orgId, payload.runId,
      new AppRunSecretService(runtime.keys)));
  } catch { console.warn('[app-public] Cancellation settlement requires maintenance repair'); }
};
