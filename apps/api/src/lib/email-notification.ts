import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { db } from './db.js';
import { emailMessages, emailMemberships } from '@deft/db/schema';
import { emailNotificationEvents } from '../../../../packages/db/src/email-notification-schema.js';
import { upsertAttentionItem } from './attention.js';
import type { EmailServiceLease } from './email-mailbox-authority.js';
import type { EmailCapability, EmailScope } from './email-mailbox-service.js';
import { EmailMailboxError } from './email-mailbox-service.js';
import type { JobHandler } from '../workers/types.js';
import { z } from 'zod';

export const EMAIL_NOTIFICATION_JOB = 'native-email-notification-dispatch' as const;
export const EmailNotificationJobSchema = z.strictObject({
  org_id: z.string().min(1).max(256), owner_user_id: z.string().min(1).max(256), account_id: z.string().min(1).max(256),
  notification_id: z.string().uuid(), revision: z.number().int().min(1).max(2147483647),
  authority_revision: z.number().int().min(1).max(2147483647),
});
export type EmailNotificationJob = Readonly<z.infer<typeof EmailNotificationJobSchema>>;

type CurrentService = (scope: EmailScope, lease: EmailServiceLease, tx?: unknown, signal?: AbortSignal) => Promise<EmailCapability>;
export type EmailNotificationDatabase = Pick<NodePgDatabase<any>, 'transaction'>;
export type EmailNotificationLease = Readonly<{ job_id: string; lock_token: string; job_name: typeof EMAIL_NOTIFICATION_JOB;
  notification_id: string; revision: number; authority_revision: number }>;

export function emailNotificationAttentionDraft(scope: EmailScope, event: Pick<typeof emailNotificationEvents.$inferSelect,
  'notification_id' | 'logical_message_id' | 'revision' | 'authority_revision' | 'created_at'>) {
  return {
    orgId: scope.org_id, userId: scope.owner_user_id, kind: 'email_new_message', lane: 'updates' as const, priority: 'normal' as const,
    dedupeKey: `email:${scope.account_id}:${event.logical_message_id}`, sourceType: 'email', sourceId: event.logical_message_id,
    sourceEventId: `email-new:${event.notification_id}:${event.revision}`, title: 'New email', body: null,
    link: `/email?account=${encodeURIComponent(scope.account_id)}&message=${encodeURIComponent(event.logical_message_id)}`,
    metadata: { account_id: scope.account_id, notification_id: event.notification_id,
      notification_revision: event.revision, authority_revision: event.authority_revision }, occurredAt: event.created_at,
  };
}

/** Projects one contentless event into the existing attention inbox. The event
 * and attention receipt commit together; replay therefore cannot increment a
 * notification twice. Push is separately gated by the user's default-off
 * Email category and current account revision at delivery time. */
export class EmailNotificationDispatcher {
  constructor(private readonly database: EmailNotificationDatabase, private readonly currentService: CurrentService,
    private readonly now = Date.now) {}

  async dispatch(scopeRaw: EmailScope, jobRaw: EmailNotificationJob, lease: EmailNotificationLease, signal?: AbortSignal) {
    const scope = z.strictObject({ org_id: z.string().min(1).max(256), owner_user_id: z.string().min(1).max(256), account_id: z.string().min(1).max(256) }).parse(scopeRaw);
    const job = EmailNotificationJobSchema.parse(jobRaw);
    if (job.org_id !== scope.org_id || job.owner_user_id !== scope.owner_user_id || job.account_id !== scope.account_id
      || lease.job_name !== EMAIL_NOTIFICATION_JOB || lease.notification_id !== job.notification_id || lease.revision !== job.revision
      || !lease.job_id || !lease.lock_token) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const authorityLease: EmailServiceLease = { ...lease };
    const initial = await this.currentService(scope, authorityLease, undefined, signal);
    const verify = async (tx?: unknown) => {
      signal?.throwIfAborted();
      const current = await this.currentService(scope, authorityLease, tx, signal);
      if (current.scope.org_id !== scope.org_id || current.scope.owner_user_id !== scope.owner_user_id || current.scope.account_id !== scope.account_id
        || current.authority_version !== initial.authority_version || current.resource_binding_id !== initial.resource_binding_id
        || !Number.isFinite(current.expires_at) || current.expires_at <= this.now()) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    };
    let afterCommit: (() => Promise<void>) | undefined;
    const result = await this.database.transaction(async tx => {
      await verify(tx); signal?.throwIfAborted();
      const [event] = await tx.select().from(emailNotificationEvents).where(and(
        eq(emailNotificationEvents.org_id, scope.org_id), eq(emailNotificationEvents.owner_user_id, scope.owner_user_id),
        eq(emailNotificationEvents.account_id, scope.account_id), eq(emailNotificationEvents.notification_id, job.notification_id)))
        .limit(1).for('update');
      if (!event || event.revision !== job.revision) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      if (event.state !== 'pending') { await verify(tx); return { state: event.state === 'projected' ? 'duplicate' as const : 'suppressed' as const }; }
      const [message] = await tx.select({ id: emailMessages.logical_message_id, seen: emailMessages.seen }).from(emailMessages).where(and(
        eq(emailMessages.org_id, scope.org_id), eq(emailMessages.owner_user_id, scope.owner_user_id), eq(emailMessages.account_id, scope.account_id),
        eq(emailMessages.logical_message_id, event.logical_message_id), isNull(emailMessages.deleted_at))).limit(1);
      const [inbox] = message ? await tx.select({ id: emailMemberships.logical_message_id }).from(emailMemberships).where(and(
        eq(emailMemberships.org_id, scope.org_id), eq(emailMemberships.owner_user_id, scope.owner_user_id), eq(emailMemberships.account_id, scope.account_id),
        eq(emailMemberships.logical_message_id, event.logical_message_id), inArray(emailMemberships.folder, ['inbox', 'INBOX']))).limit(1) : [];
      // The notification itself is contentless; read/deleted/moved mail is suppressed.
      if (!message || message.seen || !inbox) {
        await tx.update(emailNotificationEvents).set({ state: 'suppressed' }).where(and(
          eq(emailNotificationEvents.org_id, scope.org_id), eq(emailNotificationEvents.owner_user_id, scope.owner_user_id),
          eq(emailNotificationEvents.account_id, scope.account_id), eq(emailNotificationEvents.notification_id, job.notification_id),
          eq(emailNotificationEvents.revision, job.revision), eq(emailNotificationEvents.state, 'pending')));
        await verify(tx); return { state: 'suppressed' as const };
      }
      await upsertAttentionItem(emailNotificationAttentionDraft(scope, event), {
        executor: tx as unknown as Pick<typeof db, 'select'|'insert'>,
        afterCommit: effect => { afterCommit = effect; },
      });
      await tx.update(emailNotificationEvents).set({ state: 'projected', projected_at: new Date(this.now()) }).where(and(
        eq(emailNotificationEvents.org_id, scope.org_id), eq(emailNotificationEvents.owner_user_id, scope.owner_user_id),
        eq(emailNotificationEvents.account_id, scope.account_id), eq(emailNotificationEvents.notification_id, job.notification_id),
        eq(emailNotificationEvents.revision, job.revision), eq(emailNotificationEvents.state, 'pending')));
      await verify(tx); signal?.throwIfAborted(); return { state: 'projected' as const };
    });
    await afterCommit?.();
    return result;
  }
}

export type EmailNotificationJobPorts = Readonly<{ enabled: () => boolean;
  run: (scope: EmailScope, payload: EmailNotificationJob, lease: EmailNotificationLease, signal?: AbortSignal) => Promise<unknown>;
  defer: (message: string, delayMs: number) => Error }>;

export function createEmailNotificationJobHandler(ports: EmailNotificationJobPorts): JobHandler {
  return async job => {
    if (job.name !== EMAIL_NOTIFICATION_JOB || !job.id || !job.lockToken || !job.leaseExpiresAt
      || !Number.isFinite(job.leaseExpiresAt.getTime()) || job.leaseExpiresAt <= new Date()) throw new Error('EMAIL_NOTIFICATION_JOB_LEASE_REQUIRED');
    const parsed = EmailNotificationJobSchema.safeParse(job.data);
    if (!parsed.success) throw new Error('EMAIL_NOTIFICATION_JOB_INVALID');
    if (!ports.enabled()) throw ports.defer('Native email notifications are disabled', 60_000);
    job.signal?.throwIfAborted();
    const payload = parsed.data, scope = { org_id: payload.org_id, owner_user_id: payload.owner_user_id, account_id: payload.account_id };
    const lease: EmailNotificationLease = { job_id: job.id, lock_token: job.lockToken, job_name: EMAIL_NOTIFICATION_JOB,
      notification_id: payload.notification_id, revision: payload.revision, authority_revision: payload.authority_revision };
    try { await ports.run(scope, payload, lease, job.signal); }
    catch (error) {
      if (job.signal?.aborted) throw new Error('EMAIL_NOTIFICATION_UNAVAILABLE');
      const code = error instanceof Error && error.message === 'EMAIL_ACCESS_DENIED' ? error.message : 'EMAIL_NOTIFICATION_UNAVAILABLE';
      throw new Error(code);
    }
    job.signal?.throwIfAborted();
  };
}
