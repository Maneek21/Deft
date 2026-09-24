import { z } from 'zod';
import type { AppRunSafeView } from './app-run-repository.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import { AppRunError } from './app-run-errors.js';

export const ReviewedRuntimeInvokeSchema = z.strictObject({
  runtime_binding_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  input: z.unknown(),
});
export type ReviewedRuntimeInvoke = z.infer<typeof ReviewedRuntimeInvokeSchema>;
export type ReviewedRuntimeCaller = Readonly<{ org_id: string; user_id: string }>;

export interface ReviewedRuntimeRunPort {
  submitReviewedRuntime(caller: ReviewedRuntimeCaller, request: ReviewedRuntimeInvoke): Promise<AppRunSafeView>;
  reviewRuntimeInput(caller: ReviewedRuntimeCaller, runId: string): Promise<unknown>;
}

const lazyRuns: ReviewedRuntimeRunPort = {
  async submitReviewedRuntime(caller, request) {
    return (await getAppRunRuntime()).service.submitReviewedRuntime(caller, request);
  },
  async reviewRuntimeInput(caller, runId) {
    return (await getAppRunRuntime()).service.reviewRuntimeInput(caller, runId);
  },
};

/** An authenticated human requests one reviewed Runtime action. Every binding,
 * policy and provider fact is rederived by AppRunService; none comes from the
 * request except the opaque binding ID, bounded input and idempotency key. */
export class AppRuntimeActionService {
  constructor(private readonly runs: ReviewedRuntimeRunPort = lazyRuns) {}

  invoke(caller: ReviewedRuntimeCaller, raw: unknown): Promise<AppRunSafeView> {
    if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
    const request = ReviewedRuntimeInvokeSchema.parse(raw);
    return this.runs.submitReviewedRuntime(caller, request);
  }

  review(caller: ReviewedRuntimeCaller, runId: string): Promise<unknown> {
    if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
    return this.runs.reviewRuntimeInput(caller, z.string().uuid().parse(runId));
  }
}

export const appRuntimeActionService = new AppRuntimeActionService();
