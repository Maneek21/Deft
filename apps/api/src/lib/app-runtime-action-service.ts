import { z } from 'zod';
import type { AppRunSafeView } from './app-run-repository.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import { AppRunError } from './app-run-errors.js';
import type { AppRunTransaction } from './app-run-repository.js';

export const ReviewedRuntimeInvokeSchema = z.strictObject({
  runtime_binding_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  input: z.unknown(),
});
export type ReviewedRuntimeInvoke = z.infer<typeof ReviewedRuntimeInvokeSchema>;
export type ReviewedRuntimeCaller = Readonly<{ org_id: string; user_id: string }>;
export type ReviewedRuntimeHostAdmission = (tx: AppRunTransaction) => Promise<void>;

export interface ReviewedRuntimeRunPort {
  submitReviewedRuntime(caller: ReviewedRuntimeCaller, request: ReviewedRuntimeInvoke,
    hostAdmission?: ReviewedRuntimeHostAdmission): Promise<AppRunSafeView>;
  reviewRuntimeInput(caller: ReviewedRuntimeCaller, runId: string): Promise<unknown>;
}

const lazyRuns: ReviewedRuntimeRunPort = {
  async submitReviewedRuntime(caller, request, hostAdmission) {
    return (await getAppRunRuntime()).service.submitReviewedRuntime(caller, request, hostAdmission);
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

  /** Only an in-process host broker may supply this guard. HTTP request data
   * cannot construct callbacks or bypass the normal Runtime authority capture. */
  invokeFromExperience(caller: ReviewedRuntimeCaller, raw: unknown,
    hostAdmission: ReviewedRuntimeHostAdmission): Promise<AppRunSafeView> {
    if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
    const request = ReviewedRuntimeInvokeSchema.parse(raw);
    return this.runs.submitReviewedRuntime(caller, request, hostAdmission);
  }

  review(caller: ReviewedRuntimeCaller, runId: string): Promise<unknown> {
    if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
    return this.runs.reviewRuntimeInput(caller, z.string().uuid().parse(runId));
  }
}

export const appRuntimeActionService = new AppRuntimeActionService();
