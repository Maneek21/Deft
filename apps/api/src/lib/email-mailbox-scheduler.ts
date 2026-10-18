import { createHash } from 'node:crypto';

export const EMAIL_MAILBOX_QUEUE = 'scheduled-jobs' as const;
export const EMAIL_MAILBOX_SYNC_JOB = 'native-email-sync' as const;
/** Existing terminal read-only failures may be rearmed under fresh account
 * authority. Page corruption, replay conflicts and access denial require review. */
export const EMAIL_MAILBOX_REARMABLE_FAILURES:readonly string[]=Object.freeze([
  'EMAIL_SYNC_UNAVAILABLE','EMAIL_CHECKPOINT_CONFLICT','stale: worker lease expired before settlement',
]);
export const EMAIL_MAILBOX_WORKER_SHUTDOWN_PATTERN = '^Worker shutdown exceeded [1-9][0-9]{0,8}ms$';
const workerShutdown = new RegExp(EMAIL_MAILBOX_WORKER_SHUTDOWN_PATTERN, 'u');
/** Controlled read-only interruption is eligible under fresh account authority.
 * Match the whole reason: JavaScript's dollar anchor also matches before a final
 * newline, which must not widen the production scheduler's canonical format. */
export function emailMailboxFailureCanRearm(reason: string | null): boolean {
  return reason !== null && (EMAIL_MAILBOX_REARMABLE_FAILURES.includes(reason)
    || workerShutdown.exec(reason)?.[0] === reason);
}

const MAX_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;

export type EmailMailboxScheduleScope = Readonly<{
  org_id: string;
  owner_user_id: string;
  account_id: string;
  authority_revision: number;
}>;

export type EmailMailboxScheduleCursor = Readonly<{
  org_id: string;
  owner_user_id: string;
  account_id: string;
}>;

export type EmailMailboxSchedulerDependencies = Readonly<{
  enqueue: (queue: typeof EMAIL_MAILBOX_QUEUE, name: typeof EMAIL_MAILBOX_SYNC_JOB,
    payload: EmailMailboxScheduleScope, options: { orgId: string; dedupeKey: string; maxAttempts: number }) => Promise<void>;
  rearmFailed: (queue: typeof EMAIL_MAILBOX_QUEUE, name: typeof EMAIL_MAILBOX_SYNC_JOB,
    payload: EmailMailboxScheduleScope, options: { orgId: string; dedupeKey: string; maxAttempts: number }) => Promise<'active' | 'rearmed'>;
  scanActive: (after: EmailMailboxScheduleCursor | null, limit: number) => Promise<readonly EmailMailboxScheduleScope[]>;
}>;

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validateScope(value: unknown): EmailMailboxScheduleScope {
  if (!value || typeof value !== 'object') throw new Error('EMAIL_SYNC_SCOPE_INVALID');
  const scope = value as Record<string, unknown>;
  if (!validIdentifier(scope.org_id) || !validIdentifier(scope.owner_user_id) || !validIdentifier(scope.account_id)
    || !Number.isSafeInteger(scope.authority_revision) || (scope.authority_revision as number) < 1) {
    throw new Error('EMAIL_SYNC_SCOPE_INVALID');
  }
  return { org_id: scope.org_id, owner_user_id: scope.owner_user_id, account_id: scope.account_id,
    authority_revision: scope.authority_revision as number };
}

export function emailMailboxSyncDedupeKey(scope: EmailMailboxScheduleScope): string {
  return createHash('sha256').update(JSON.stringify([
    scope.org_id, scope.owner_user_id, scope.account_id, scope.authority_revision,
  ])).digest('hex');
}

function cursorFor(scope: EmailMailboxScheduleScope): EmailMailboxScheduleCursor {
  return { org_id: scope.org_id, owner_user_id: scope.owner_user_id, account_id: scope.account_id };
}

function compareCursor(left: EmailMailboxScheduleCursor, right: EmailMailboxScheduleCursor): number {
  for (const key of ['org_id', 'owner_user_id', 'account_id'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

/**
 * Enqueues token-free, revision-deduplicated native account work. Ordinary
 * adoption only enqueues. Restart repair re-arms terminal failures only after
 * its injected active-account scan has selected the current authority revision.
 */
export function createEmailMailboxScheduler(dependencies: EmailMailboxSchedulerDependencies) {
  async function queue(scopeValue: unknown, repair: boolean): Promise<'active' | 'rearmed'> {
    const scope = validateScope(scopeValue);
    const options = { orgId: scope.org_id, dedupeKey: emailMailboxSyncDedupeKey(scope), maxAttempts: MAX_ATTEMPTS };
    if (repair) return dependencies.rearmFailed(EMAIL_MAILBOX_QUEUE, EMAIL_MAILBOX_SYNC_JOB, scope, options);
    await dependencies.enqueue(EMAIL_MAILBOX_QUEUE, EMAIL_MAILBOX_SYNC_JOB, scope, options);
    return 'active';
  }

  return {
    scheduleActiveAccount(scope: EmailMailboxScheduleScope) {
      return queue(scope, false);
    },

    async repairBatch(after: EmailMailboxScheduleCursor | null = null, requestedLimit = MAX_BATCH_SIZE) {
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_BATCH_SIZE) {
        throw new Error('EMAIL_SYNC_REPAIR_LIMIT_INVALID');
      }
      if (after && (!validIdentifier(after.org_id) || !validIdentifier(after.owner_user_id) || !validIdentifier(after.account_id))) {
        throw new Error('EMAIL_SYNC_CURSOR_INVALID');
      }
      const rows = await dependencies.scanActive(after, requestedLimit);
      if (!Array.isArray(rows) || rows.length > requestedLimit) throw new Error('EMAIL_SYNC_SCAN_INVALID');
      let previous = after;
      const scopes: EmailMailboxScheduleScope[] = [];
      for (const raw of rows) {
        const scope = validateScope(raw);
        const current = cursorFor(scope);
        if (previous && compareCursor(previous, current) >= 0) throw new Error('EMAIL_SYNC_SCAN_INVALID');
        previous = current;
        scopes.push(scope);
      }
      let rearmed = 0;
      for (const scope of scopes) {
        if (await queue(scope, true) === 'rearmed') rearmed += 1;
      }
      return { scanned: rows.length, rearmed, next: rows.length === requestedLimit ? previous : null,
        done: rows.length < requestedLimit } as const;
    },
  };
}
