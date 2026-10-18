import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailTimers, notifications } from '@deft/db/schema';
import { canonicalCapabilityJson } from '@deft/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppRunSecretEnvelopeSchema } from './app-run-secrets.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import type { EmailScope } from './email-mailbox-service.js';
import { EmailTimerContentSchema, EmailTimerError, type EmailTimerContent, type EmailTimerKind, type EmailTimerPage,
  type EmailTimerState, type EmailTimerView } from './email-timer-types.js';

const schema = { emailAccounts, emailTimers, notifications };
export type EmailTimerDatabase = Pick<NodePgDatabase<typeof schema>, 'transaction'>;
export type EmailTimerGuard = (tx: unknown) => Promise<void>;
export type EmailTimerNotification = Readonly<{ org_id: string; user_id: string; title: string; body: string | null;
  delivery_policy: Readonly<{ reason: string; channel: string | null; evaluated_at: string }> }>;
const Cursor = z.strictObject({ schema_version: z.literal('deft.email_timer_cursor.v1'), org_id: z.string().min(1).max(256),
  owner_user_id: z.string().min(1).max(256), account_id: z.string().min(1).max(256), kind: z.enum(['snooze', 'follow_up']).nullable(),
  state: z.enum(['scheduled', 'firing', 'completed', 'cancelled', 'blocked']).nullable(), scheduled_at: z.iso.datetime(), timer_id: z.string().uuid(), expires_at: z.number().finite() });
const whereScope = (scope: EmailScope) => and(eq(emailTimers.org_id, scope.org_id), eq(emailTimers.owner_user_id, scope.owner_user_id), eq(emailTimers.account_id, scope.account_id));
const timerContext = (scope: EmailScope, timerId: string, revision: number) => ({ ...scope, kind: 'timer' as const, record_id: `timer:${timerId}`, revision });
const cursorContext = (scope: EmailScope) => ({ ...scope, kind: 'timer' as const, record_id: 'timer-list-cursor', revision: 0 });
const digestTarget = (scope: EmailScope, logicalId: string) => {
  return createHash('sha256').update(canonicalCapabilityJson(['deft.email.timer.target.v1', scope.org_id, scope.owner_user_id, scope.account_id, logicalId])).digest('hex');
};
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

function materialize(crypto: EmailMailboxCrypto, scope: EmailScope, row: typeof emailTimers.$inferSelect): EmailTimerView {
  const parsed = EmailTimerContentSchema.parse(crypto.open(row.timer_envelope, timerContext(scope, row.timer_id, row.revision)));
  if (digestTarget(scope, parsed.logical_message_id) !== row.logical_message_digest || parsed.kind !== row.kind) throw new Error('timer envelope mismatch');
  return Object.freeze({ timer_id: row.timer_id, account_id: row.account_id, logical_message_id: parsed.logical_message_id,
    kind: row.kind, scheduled_at: row.scheduled_at.toISOString(), display_timezone: row.display_timezone,
    revision: row.revision, state: row.state, ...(parsed.reminder_text === undefined ? {} : { reminder_text: parsed.reminder_text }),
    updated_at: row.updated_at.toISOString() });
}
function seal(crypto: EmailMailboxCrypto, scope: EmailScope, timerId: string, revision: number, content: EmailTimerContent) {
  return crypto.seal(EmailTimerContentSchema.parse(content), timerContext(scope, timerId, revision));
}
function cursorSeal(crypto: EmailMailboxCrypto, scope: EmailScope, value: z.infer<typeof Cursor>) {
  return crypto.seal(value, cursorContext(scope));
}
function cursorOpen(crypto: EmailMailboxCrypto, scope: EmailScope, encoded: string | null, kind: EmailTimerKind | null,
  state: EmailTimerState | null, now: number) {
  if (encoded === null) return null;
  try {
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.byteLength < 16 || raw.byteLength > 6144 || raw.toString('base64url') !== encoded) throw new Error();
    const envelope = AppRunSecretEnvelopeSchema.parse(JSON.parse(raw.toString('utf8')));
    const value = Cursor.parse(crypto.open(envelope, cursorContext(scope)));
    if (value.org_id !== scope.org_id || value.owner_user_id !== scope.owner_user_id || value.account_id !== scope.account_id
      || value.kind !== kind || value.state !== state || value.expires_at <= now) throw new Error();
    return value;
  } catch { throw new EmailTimerError('EMAIL_TIMER_INVALID'); }
}
const toCursor = (crypto: EmailMailboxCrypto, scope: EmailScope, kind: EmailTimerKind | null,
  state: EmailTimerState | null, row: typeof emailTimers.$inferSelect, now: number) => Buffer.from(JSON.stringify(cursorSeal(crypto, scope,
  { schema_version: 'deft.email_timer_cursor.v1', org_id: scope.org_id, owner_user_id: scope.owner_user_id, account_id: scope.account_id,
    kind, state, scheduled_at: row.scheduled_at.toISOString(), timer_id: row.timer_id, expires_at: now + 15 * 60_000 }))).toString('base64url');

/** Encrypted timer persistence. All mutation authority is a same-transaction
 * SQL-only human/account lease guard supplied by the service/runtime. */
export class EmailTimerStore {
  constructor(private readonly database: EmailTimerDatabase, private readonly crypto: EmailMailboxCrypto,
    private readonly now = () => new Date()) {}

  async read(scope: EmailScope, timerId: string, guard: EmailTimerGuard, signal?: AbortSignal): Promise<EmailTimerView | null> {
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const [row] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1);
      await guard(tx); signal?.throwIfAborted(); return row ? materialize(this.crypto, scope, row) : null;
    });
  }

  async create(scope: EmailScope, timerId: string, content: EmailTimerContent, scheduledAt: Date, zone: string,
    guard: EmailTimerGuard, signal?: AbortSignal): Promise<EmailTimerView> {
    const clean = EmailTimerContentSchema.parse(content), time = scheduledAt.getTime();
    if (!Number.isFinite(time) || !Number.isFinite(this.now().getTime()) || time > this.now().getTime() + 10 * 366 * 86400_000) throw new EmailTimerError('EMAIL_TIMER_INVALID');
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const [existing] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1).for('update');
      if (existing) {
        const prior = materialize(this.crypto, scope, existing);
        if (existing.revision === 1 && existing.state === 'scheduled' && existing.scheduled_at.getTime() === time
          && existing.display_timezone === zone && canonicalCapabilityJson({ logical_message_id: prior.logical_message_id, kind: prior.kind,
            ...(prior.reminder_text === undefined ? {} : { reminder_text: prior.reminder_text }) }) === canonicalCapabilityJson(clean)) {
          await guard(tx); return prior;
        }
        throw new EmailTimerError('EMAIL_TIMER_CONFLICT');
      }
      const revision = 1;
      const values = { ...scope, timer_id: timerId, logical_message_digest: digestTarget(scope, clean.logical_message_id), kind: clean.kind,
        revision, state: 'scheduled' as const, scheduled_at: scheduledAt, display_timezone: zone,
        timer_envelope: seal(this.crypto, scope, timerId, revision, clean), created_at: this.now(), updated_at: this.now() };
      try { await tx.insert(emailTimers).values(values); }
      catch (error) { if (isUniqueViolation(error)) throw new EmailTimerError('EMAIL_TIMER_CONFLICT'); throw error; }
      const [row] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1);
      await guard(tx); signal?.throwIfAborted(); if (!row) throw new EmailTimerError('EMAIL_TIMER_UNAVAILABLE'); return materialize(this.crypto, scope, row);
    });
  }

  async reschedule(scope: EmailScope, timerId: string, expectedRevision: number, scheduledAt: Date, zone: string,
    reminderText: string | undefined, hasReminderText: boolean, guard: EmailTimerGuard, signal?: AbortSignal): Promise<EmailTimerView> {
    if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() > this.now().getTime() + 10 * 366 * 86400_000) throw new EmailTimerError('EMAIL_TIMER_INVALID');
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const [row] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1).for('update');
      if (!row) throw new EmailTimerError('EMAIL_TIMER_NOT_FOUND');
      if (row.revision !== expectedRevision || row.state !== 'scheduled' || row.revision >= 2147483647) throw new EmailTimerError('EMAIL_TIMER_CONFLICT');
      const current = materialize(this.crypto, scope, row), revision = row.revision + 1;
      const content = EmailTimerContentSchema.parse({ logical_message_id: current.logical_message_id, kind: current.kind,
        ...(hasReminderText ? { reminder_text: reminderText } : current.reminder_text === undefined ? {} : { reminder_text: current.reminder_text }) });
      await tx.update(emailTimers).set({ scheduled_at: scheduledAt, display_timezone: zone, revision, timer_envelope: seal(this.crypto, scope, timerId, revision, content), updated_at: this.now() })
        .where(and(whereScope(scope), eq(emailTimers.timer_id, timerId), eq(emailTimers.revision, expectedRevision), eq(emailTimers.state, 'scheduled')));
      const [updated] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1);
      await guard(tx); signal?.throwIfAborted(); if (!updated) throw new EmailTimerError('EMAIL_TIMER_CONFLICT'); return materialize(this.crypto, scope, updated);
    });
  }

  async cancel(scope: EmailScope, timerId: string, expectedRevision: number, guard: EmailTimerGuard, signal?: AbortSignal): Promise<EmailTimerView> {
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const [row] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1).for('update');
      if (!row) throw new EmailTimerError('EMAIL_TIMER_NOT_FOUND');
      if (row.revision !== expectedRevision || row.state !== 'scheduled' || row.revision >= 2147483647) throw new EmailTimerError('EMAIL_TIMER_CONFLICT');
      const current = EmailTimerContentSchema.parse(this.crypto.open(row.timer_envelope, timerContext(scope, timerId, row.revision)));
      const revision = row.revision + 1;
      await tx.update(emailTimers).set({ state: 'cancelled', revision,
        timer_envelope: seal(this.crypto, scope, timerId, revision, current), updated_at: this.now() })
        .where(and(whereScope(scope), eq(emailTimers.timer_id, timerId), eq(emailTimers.revision, expectedRevision), eq(emailTimers.state, 'scheduled')));
      const [updated] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1);
      await guard(tx); signal?.throwIfAborted(); if (!updated) throw new EmailTimerError('EMAIL_TIMER_CONFLICT'); return materialize(this.crypto, scope, updated);
    });
  }

  async list(scope: EmailScope, kind: EmailTimerKind | null, state: EmailTimerState | null, cursor: string | null, limit: number,
    guard: EmailTimerGuard, signal?: AbortSignal): Promise<EmailTimerPage> {
    const now = this.now().getTime(), after = cursorOpen(this.crypto, scope, cursor, kind, state, now);
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const filters = [whereScope(scope), ...(kind ? [eq(emailTimers.kind, kind)] : []), ...(state ? [eq(emailTimers.state, state)] : []),
        ...(after ? [or(gt(emailTimers.scheduled_at, new Date(after.scheduled_at)), and(eq(emailTimers.scheduled_at, new Date(after.scheduled_at)), gt(emailTimers.timer_id, after.timer_id)))] : [])];
      const rows = await tx.select().from(emailTimers).where(and(...filters)).orderBy(asc(emailTimers.scheduled_at), asc(emailTimers.timer_id)).limit(limit + 1);
      await guard(tx); signal?.throwIfAborted();
      const has_more = rows.length > limit, selected = rows.slice(0, limit), items = selected.map(row => materialize(this.crypto, scope, row));
      return Object.freeze({ items, has_more, next_cursor: has_more && selected.length ? toCursor(this.crypto, scope, kind, state, selected.at(-1)!, now) : null });
    });
  }

  /** Query seam for Inbox list assembly. Only future local snoozes suppress an
   * Inbox row; once UTC due, it is eligible even if the timer worker is late. */
  async futureInboxMessageIds(scope: EmailScope, guard: EmailTimerGuard, signal?: AbortSignal): Promise<ReadonlySet<string>> {
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const rows = await tx.select({ timer_id: emailTimers.timer_id, revision: emailTimers.revision,
        timer_envelope: emailTimers.timer_envelope, logical_message_digest: emailTimers.logical_message_digest })
        .from(emailTimers).where(and(whereScope(scope), eq(emailTimers.kind, 'snooze'),
          inArray(emailTimers.state, ['scheduled', 'firing']), gt(emailTimers.scheduled_at, this.now())));
      const ids = new Set<string>();
      for (const row of rows) {
        signal?.throwIfAborted();
        const content = EmailTimerContentSchema.parse(this.crypto.open(row.timer_envelope, timerContext(scope, row.timer_id, row.revision)));
        // A corrupted or rebound envelope must fail the count, never silently
        // publish an exact result with an untrusted visibility exclusion.
        if (content.kind !== 'snooze' || digestTarget(scope, content.logical_message_id) !== row.logical_message_digest)
          throw new Error('timer envelope mismatch');
        ids.add(content.logical_message_id);
      }
      await guard(tx); signal?.throwIfAborted(); return ids;
    });
  }

  async hiddenInboxMessageIds(scope: EmailScope, logicalMessageIds: readonly string[], guard: EmailTimerGuard,
    signal?: AbortSignal): Promise<ReadonlySet<string>> {
    if (!logicalMessageIds.length) return new Set();
    const digests = [...new Set(logicalMessageIds.map(id => digestTarget(scope, id)))];
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const rows = await tx.select({ logical_message_digest: emailTimers.logical_message_digest }).from(emailTimers).where(and(whereScope(scope),
        // Unread projection may contain 100,001 identifiers. One typed array
        // bind avoids PostgreSQL's 65,535-parameter limit while preserving the
        // account scope and both authority guards in this same transaction.
        sql`${emailTimers.logical_message_digest} = ANY(${sql.param(digests)}::text[])`, eq(emailTimers.kind, 'snooze'), inArray(emailTimers.state, ['scheduled', 'firing']),
        gt(emailTimers.scheduled_at, this.now())));
      await guard(tx); signal?.throwIfAborted();
      const hidden = new Set(rows.map(row => row.logical_message_digest));
      return new Set(logicalMessageIds.filter(id => hidden.has(digestTarget(scope, id))));
    });
  }

  async claimDue(scope: EmailScope, timerId: string, expectedRevision: number, jobId: string, lockToken: string,
    leaseExpiresAt: Date, guard: EmailTimerGuard, signal?: AbortSignal): Promise<EmailTimerView> {
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const [row] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1).for('update');
      if (!row) throw new EmailTimerError('EMAIL_TIMER_NOT_FOUND');
      const now = this.now();
      if (row.state === 'firing' && row.firing_job_id === jobId && row.revision === expectedRevision + 1
        && row.firing_lease_expires_at && row.firing_lease_expires_at <= now) {
        await tx.update(emailTimers).set({ firing_lock_token: lockToken, firing_lease_expires_at: leaseExpiresAt, updated_at: now })
          .where(and(whereScope(scope), eq(emailTimers.timer_id, timerId), eq(emailTimers.revision, row.revision), eq(emailTimers.state, 'firing')));
      } else {
        if (row.state === 'firing' && row.firing_job_id === jobId && row.firing_lock_token === lockToken) { await guard(tx); return materialize(this.crypto, scope, row); }
        if (row.state !== 'scheduled' || row.revision !== expectedRevision || row.scheduled_at > now || row.revision >= 2147483647)
          throw new EmailTimerError('EMAIL_TIMER_CONFLICT');
        const content = EmailTimerContentSchema.parse(this.crypto.open(row.timer_envelope, timerContext(scope, timerId, row.revision)));
        const revision = row.revision + 1;
        await tx.update(emailTimers).set({ state: 'firing', revision,
          timer_envelope: seal(this.crypto, scope, timerId, revision, content), firing_job_id: jobId,
          firing_lock_token: lockToken, firing_lease_expires_at: leaseExpiresAt, updated_at: now })
          .where(and(whereScope(scope), eq(emailTimers.timer_id, timerId), eq(emailTimers.revision, expectedRevision), eq(emailTimers.state, 'scheduled')));
      }
      const [updated] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1);
      await guard(tx); signal?.throwIfAborted(); if (!updated) throw new EmailTimerError('EMAIL_TIMER_CONFLICT'); return materialize(this.crypto, scope, updated);
    });
  }

  async completeFiring(scope: EmailScope, timerId: string, revision: number, jobId: string, lockToken: string,
    guard: EmailTimerGuard, signal?: AbortSignal, notification?: EmailTimerNotification): Promise<Readonly<{ timer: EmailTimerView; notification: typeof notifications.$inferSelect | null }>> {
    return this.database.transaction(async tx => {
      signal?.throwIfAborted(); await guard(tx);
      const [row] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1).for('update');
      if (!row) throw new EmailTimerError('EMAIL_TIMER_NOT_FOUND');
      if (row.state === 'completed') { await guard(tx); return { timer: materialize(this.crypto, scope, row), notification: null }; }
      if (row.state !== 'firing' || row.revision !== revision || row.firing_job_id !== jobId || row.firing_lock_token !== lockToken
        || row.revision >= 2147483647) throw new EmailTimerError('EMAIL_TIMER_CONFLICT');
      const now = this.now();
      const content = EmailTimerContentSchema.parse(this.crypto.open(row.timer_envelope, timerContext(scope, timerId, row.revision)));
      let createdNotification: typeof notifications.$inferSelect | null = null;
      if (notification) {
        if (content.kind !== 'follow_up' || notification.org_id !== scope.org_id || notification.user_id !== scope.owner_user_id
          || notification.title.length > 200 || notification.body !== null && notification.body.length > 2048) throw new EmailTimerError('EMAIL_TIMER_INVALID');
        const [inserted] = await tx.insert(notifications).values({ org_id: notification.org_id, user_id: notification.user_id,
          type: 'reminder', title: notification.title, body: notification.body,
          link: `/email?account=${encodeURIComponent(scope.account_id)}&message=${encodeURIComponent(content.logical_message_id)}`,
          metadata: { reminder_id: `native-email-timer:${timerId}`, delivery_policy: notification.delivery_policy } })
          .onConflictDoNothing().returning();
        createdNotification = inserted ?? null;
      }
      const nextRevision = row.revision + 1;
      await tx.update(emailTimers).set({ state: 'completed', revision: nextRevision,
        timer_envelope: seal(this.crypto, scope, timerId, nextRevision, content), firing_job_id: null, firing_lock_token: null,
        firing_lease_expires_at: null, completed_at: now, updated_at: now })
        .where(and(whereScope(scope), eq(emailTimers.timer_id, timerId), eq(emailTimers.revision, revision), eq(emailTimers.state, 'firing')));
      const [updated] = await tx.select().from(emailTimers).where(and(whereScope(scope), eq(emailTimers.timer_id, timerId))).limit(1);
      await guard(tx); signal?.throwIfAborted(); if (!updated) throw new EmailTimerError('EMAIL_TIMER_CONFLICT');
      return { timer: materialize(this.crypto, scope, updated), notification: createdNotification };
    });
  }
}
