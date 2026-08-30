import { z } from 'zod';
import type { JobHandler } from '../workers/types.js';
import type { AppRunAttemptRunner } from './app-run-attempt-runner.js';

const AppRunJobSchema = z.object({
  orgId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
  attemptId: z.string().min(1).max(512),
}).strict();

// C0 deliberately keeps this injectable factory out of the production worker
// registry. C4 owns provider/queue wiring and C5 owns the cutover decision.
export function createAppRunAttemptJobHandler(runner: AppRunAttemptRunner): JobHandler {
  return async (job) => {
    const payload = AppRunJobSchema.parse(job.data);
    await runner.run(payload.orgId, payload.runId, payload.attemptId, `job:${job.id}`, job.signal);
  };
}
