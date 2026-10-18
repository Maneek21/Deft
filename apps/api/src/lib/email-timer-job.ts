import type { JobHandler } from '../workers/types.js';
import { EMAIL_TIMER_JOB, EmailTimerJobSchema, type EmailTimerLease } from './email-timer-types.js';
import type { EmailScope } from './email-mailbox-service.js';

export type EmailTimerJobPorts = Readonly<{
  enabled: () => boolean;
  run: (scope: EmailScope, timerId: string, revision: number, authorityRevision: number, lease: EmailTimerLease,
    signal?: AbortSignal) => Promise<{ state: 'completed' | 'stale' | 'waiting'; delay_ms?: number }>;
  defer: (message: string, delayMs: number) => Error;
}>;

/** A lease consumes one due local timer. Provider APIs are never called by
 * this job; only an idempotent in-app notification and durable completion are possible. */
export function createEmailTimerJobHandler(ports: EmailTimerJobPorts): JobHandler {
  return async job => {
    if (job.name !== EMAIL_TIMER_JOB || !job.id || !job.lockToken || !job.leaseExpiresAt
      || !Number.isFinite(job.leaseExpiresAt.getTime()) || job.leaseExpiresAt <= new Date()) throw new Error('EMAIL_TIMER_JOB_LEASE_REQUIRED');
    const parsed = EmailTimerJobSchema.safeParse(job.data);
    if (!parsed.success) throw new Error('EMAIL_TIMER_JOB_INVALID');
    if (!ports.enabled()) throw ports.defer('Native email timers are disabled', 60_000);
    job.signal?.throwIfAborted();
    const input = parsed.data;
    const lease: EmailTimerLease = { job_id: job.id, lock_token: job.lockToken, lease_expires_at: job.leaseExpiresAt,
      job_name: EMAIL_TIMER_JOB, timer_id: input.timer_id, revision: input.revision };
    let result: Awaited<ReturnType<EmailTimerJobPorts['run']>>;
    try {
      result = await ports.run({ org_id: input.org_id, owner_user_id: input.owner_user_id, account_id: input.account_id },
        input.timer_id, input.revision, input.authority_revision, lease, job.signal);
    } catch (error) {
      if (job.signal?.aborted) throw new Error('EMAIL_TIMER_UNAVAILABLE');
      const code = error instanceof Error && ['EMAIL_ACCESS_DENIED', 'EMAIL_TIMER_ACCESS_DENIED', 'EMAIL_TIMER_UNAVAILABLE'].includes(error.message)
        ? error.message : 'EMAIL_TIMER_UNAVAILABLE';
      throw new Error(code);
    }
    job.signal?.throwIfAborted();
    if (result.state === 'waiting') {
      if (!Number.isFinite(result.delay_ms) || result.delay_ms! < 1) throw new Error('EMAIL_TIMER_UNAVAILABLE');
      throw ports.defer('Native email timer waits until its saved instant', Math.min(result.delay_ms!, 86_400_000));
    }
  };
}
