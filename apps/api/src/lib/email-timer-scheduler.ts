import { createHash } from 'node:crypto';
import type { EmailScope } from './email-mailbox-service.js';
import type { EmailTimerJob } from './email-timer-types.js';

export const EMAIL_TIMER_QUEUE = 'scheduled-jobs' as const;
export const EMAIL_TIMER_MAX_BATCH = 100;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export type EmailTimerCandidate = EmailTimerJob & Readonly<{ scheduled_at: string }>;
export type EmailTimerCursor = EmailScope & Readonly<{ timer_id: string }>;
export type EmailTimerSchedule = (scope: EmailScope, timerId: string, revision: number, authorityRevision: number,
  scheduledAt: Date) => Promise<'active' | 'rearmed'>;

function validate(candidate: EmailTimerCandidate): EmailTimerCandidate {
  if (!identifier(candidate.org_id) || !identifier(candidate.owner_user_id) || !identifier(candidate.account_id)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(candidate.timer_id)
    || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 || candidate.revision > 2147483646
    || !Number.isSafeInteger(candidate.authority_revision) || candidate.authority_revision < 1
    || !Number.isFinite(Date.parse(candidate.scheduled_at))) throw new Error('EMAIL_TIMER_SCAN_INVALID');
  return candidate;
}
export function emailTimerDedupeKey(job: EmailTimerJob): string {
  return 'native-email-timer:' + createHash('sha256').update(JSON.stringify([
    job.org_id, job.owner_user_id, job.account_id, job.timer_id, job.revision, job.authority_revision,
  ])).digest('hex');
}
function cursorOf(value: EmailTimerCandidate): EmailTimerCursor {
  return { org_id: value.org_id, owner_user_id: value.owner_user_id, account_id: value.account_id, timer_id: value.timer_id };
}
function compare(left: EmailTimerCursor, right: EmailTimerCursor): number {
  for (const key of ['org_id', 'owner_user_id', 'account_id', 'timer_id'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

/** Bounded repair for due timers that were saved but not successfully enqueued.
 * Queue payloads contain only scope and revisions, never message content. */
export function createEmailTimerScheduler(dependencies: Readonly<{
  scanDue: (after: EmailTimerCursor | null, limit: number) => Promise<readonly EmailTimerCandidate[]>;
  schedule: EmailTimerSchedule;
}>) {
  return {
    async repairBatch(after: EmailTimerCursor | null = null, requestedLimit = EMAIL_TIMER_MAX_BATCH) {
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > EMAIL_TIMER_MAX_BATCH) throw new Error('EMAIL_TIMER_SCAN_LIMIT_INVALID');
      if (after && (![after.org_id, after.owner_user_id, after.account_id].every(identifier)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(after.timer_id))) throw new Error('EMAIL_TIMER_CURSOR_INVALID');
      const rows = await dependencies.scanDue(after, requestedLimit);
      if (!Array.isArray(rows) || rows.length > requestedLimit) throw new Error('EMAIL_TIMER_SCAN_INVALID');
      let previous = after, scheduled = 0;
      for (const raw of rows) {
        const candidate = validate(raw), cursor = cursorOf(candidate);
        if (previous && compare(previous, cursor) >= 0) throw new Error('EMAIL_TIMER_SCAN_INVALID');
        previous = cursor;
        await dependencies.schedule({ org_id: candidate.org_id, owner_user_id: candidate.owner_user_id, account_id: candidate.account_id },
          candidate.timer_id, candidate.revision, candidate.authority_revision, new Date(candidate.scheduled_at));
        scheduled += 1;
      }
      return { scanned: rows.length, scheduled, next: rows.length === requestedLimit ? previous : null, done: rows.length < requestedLimit } as const;
    },
  };
}
