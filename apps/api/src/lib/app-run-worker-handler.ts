import { z } from 'zod';
import type { JobHandler } from '../workers/types.js';
import type { AppRunAttemptRunner } from './app-run-attempt-runner.js';

const AppRunJobSchema = z.object({
  orgId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
}).strict();

// PR B deliberately exports an injectable factory without registering it in
// the production worker registry. PR C owns the cutover decision.
export function createAppRunAttemptJobHandler(runner: AppRunAttemptRunner): JobHandler {
  return async (job) => {
    const payload = AppRunJobSchema.parse(job.data);
    await runner.run(payload.orgId, payload.runId, `job:${job.id}`, job.signal);
  };
}
