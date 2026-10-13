export const EMAIL_NOTIFICATION_REPAIR_MAX_BATCH = 100;

export type EmailNotificationRepairCursor = Readonly<{
  org_id: string;
  owner_user_id: string;
  account_id: string;
  notification_id: string;
}>;

export type EmailNotificationRepairCandidate = EmailNotificationRepairCursor & Readonly<{
  revision: number;
  authority_revision: number;
}>;

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validCursor(value: unknown): value is EmailNotificationRepairCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Record<string, unknown>;
  return validText(cursor.org_id) && validText(cursor.owner_user_id) && validText(cursor.account_id)
    && typeof cursor.notification_id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(cursor.notification_id);
}

function compare(left: EmailNotificationRepairCursor, right: EmailNotificationRepairCursor): number {
  for (const field of ['org_id', 'owner_user_id', 'account_id'] as const) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return left.notification_id.localeCompare(right.notification_id);
}

/** Repairs only an event whose queue row is missing. Existing failed or active
 * deliveries remain owned by queue retry/retention policy; this scan cannot
 * revive old alerts or create a second dedupe identity. */
export function createEmailNotificationRepairScheduler(dependencies: Readonly<{
  scan: (after: EmailNotificationRepairCursor | null, limit: number) => Promise<readonly EmailNotificationRepairCandidate[]>;
  repair: (candidate: EmailNotificationRepairCandidate) => Promise<'queued' | 'suppressed' | 'skipped'>;
}>) {
  return {
    async repairBatch(after: EmailNotificationRepairCursor | null = null, requestedLimit = EMAIL_NOTIFICATION_REPAIR_MAX_BATCH) {
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > EMAIL_NOTIFICATION_REPAIR_MAX_BATCH)
        throw new Error('EMAIL_NOTIFICATION_REPAIR_LIMIT_INVALID');
      if (after && !validCursor(after)) throw new Error('EMAIL_NOTIFICATION_CURSOR_INVALID');
      const rows = await dependencies.scan(after, requestedLimit);
      if (!Array.isArray(rows) || rows.length > requestedLimit) throw new Error('EMAIL_NOTIFICATION_SCAN_INVALID');
      let previous = after;
      const candidates: EmailNotificationRepairCandidate[] = [];
      for (const raw of rows) {
        const row = raw as EmailNotificationRepairCandidate;
        if (!validCursor(row) || !Number.isSafeInteger(row.revision) || row.revision < 1
          || !Number.isSafeInteger(row.authority_revision) || row.authority_revision < 1
          || previous && compare(previous, row) >= 0) throw new Error('EMAIL_NOTIFICATION_SCAN_INVALID');
        candidates.push(row);
        previous = row;
      }
      let queued = 0, suppressed = 0;
      for (const candidate of candidates) {
        const result = await dependencies.repair(candidate);
        if (result === 'queued') queued += 1;
        else if (result === 'suppressed') suppressed += 1;
        else if (result !== 'skipped') throw new Error('EMAIL_NOTIFICATION_SCAN_INVALID');
      }
      return { scanned: candidates.length, queued, suppressed,
        next: candidates.length === requestedLimit ? previous : null, done: candidates.length < requestedLimit } as const;
    },
  };
}
