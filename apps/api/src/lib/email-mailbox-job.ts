import { z } from 'zod';
import { EmailMailboxError, type EmailScope, type EmailSyncResult } from './email-mailbox-service.js';
import type { JobHandler } from '../workers/types.js';

const identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const PayloadSchema = z.strictObject({ org_id: identifier, owner_user_id: identifier, account_id: identifier,
  authority_revision: z.number().int().positive().safe() });
const EMAIL_CODES = new Set(['EMAIL_ACCESS_DENIED', 'EMAIL_PAGE_INVALID', 'EMAIL_CURSOR_EXPIRED',
  'EMAIL_CHECKPOINT_CONFLICT', 'EMAIL_SYNC_REPLAY_CONFLICT']);

export type NativeEmailSyncJobScope = EmailScope & Readonly<{ authority_revision: number }>;
export type NativeEmailSyncRunLease = Readonly<{ job_id: string; lock_token: string }>;
export type EmailMailboxJobDependencies = Readonly<{
  enabled: () => boolean;
  runPage: (scope: NativeEmailSyncJobScope, lease: NativeEmailSyncRunLease, signal?: AbortSignal) => Promise<EmailSyncResult>;
  defer: (message: string, delayMs: number) => Error;
}>;

/** Runs no more than one durable provider page per queue delivery. The queue
 * contains only the native account scope and revision; credentials and bearer
 * tokens stay in the server-owned runtime. */
export function createEmailMailboxJobHandler(dependencies: EmailMailboxJobDependencies): JobHandler {
  return async job => {
    if (job.name !== 'native-email-sync' || typeof job.id !== 'string' || !job.id
      || typeof job.lockToken !== 'string' || !job.lockToken) throw new Error('EMAIL_SYNC_JOB_LEASE_REQUIRED');
    const parsed = PayloadSchema.safeParse(job.data);
    if (!parsed.success) throw new Error('EMAIL_SYNC_JOB_INVALID');
    if (!dependencies.enabled()) throw dependencies.defer('Native email sync is disabled', 60_000);
    if (job.signal?.aborted) throw new Error('EMAIL_SYNC_UNAVAILABLE');

    let result: EmailSyncResult;
    try {
      result = await dependencies.runPage(parsed.data, { job_id: job.id, lock_token: job.lockToken }, job.signal);
    } catch (error) {
      if (job.signal?.aborted) throw new Error('EMAIL_SYNC_UNAVAILABLE');
      // A concurrent confirmed human mutation can bump the checkpoint while
      // this read-only provider page is held. Its transaction correctly rolls
      // back; start from the fresh checkpoint on another leased delivery rather
      // than spending the terminal failure budget or reusing the held page.
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_CHECKPOINT_CONFLICT'){
        throw dependencies.defer('Native email sync checkpoint advanced',1_000);
      }
      const code = error instanceof EmailMailboxError && EMAIL_CODES.has(error.code) ? error.code : 'EMAIL_SYNC_UNAVAILABLE';
      throw new Error(code);
    }
    if (job.signal?.aborted) throw new Error('EMAIL_SYNC_UNAVAILABLE');
    if (!result || typeof result.has_more !== 'boolean') throw new Error('EMAIL_SYNC_UNAVAILABLE');
    if (result.has_more) throw dependencies.defer('Native email sync has another durable page', 1_000);
    throw dependencies.defer('Native email sync is idle', 10_000);
  };
}
