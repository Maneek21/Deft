import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { jobQueue, messages } from '@deft/db/schema';
import { db } from './db.js';

type Executor = Pick<typeof db, 'select' | 'execute'>;

export type DeftyReplyTrigger = {
  orgId: string;
  spaceId: string;
  agentUserId: string;
  triggerMessageId: string;
  triggerCreatedAt: Date;
};

/** The queue delivery that is generating a reply; absent for direct calls. */
export type DeftyReplyDelivery = { jobId: string; lockToken: string; signal?: AbortSignal };

/** The delivery was cancelled or no longer owns its queue lease. */
export class DeftyDeliveryLostError extends Error {
  constructor(message = 'agent-reply: delivery was cancelled or lost its job lease before publishing') {
    super(message);
    this.name = 'DeftyDeliveryLostError';
  }
}

/**
 * The Defty reply already posted for a trigger message, if any. Identity is
 * `metadata.reply_to_message_id`, written with every handler reply. Deleted
 * replies count: the trigger was answered, a retry must not answer it again.
 */
export async function findExistingDeftyReply(executor: Executor, trigger: DeftyReplyTrigger) {
  const [existing] = await executor.select().from(messages).where(and(
    eq(messages.org_id, trigger.orgId),
    eq(messages.space_id, trigger.spaceId),
    eq(messages.user_id, trigger.agentUserId),
    gte(messages.created_at, trigger.triggerCreatedAt),
    sql`${messages.metadata}->>'reply_to_message_id' = ${trigger.triggerMessageId}`,
  )).orderBy(desc(messages.created_at)).limit(1);
  return existing ?? null;
}

export function throwIfDeliveryLost(delivery: { signal?: AbortSignal } | undefined): void {
  if (delivery?.signal?.aborted) throw new DeftyDeliveryLostError();
}

/**
 * Run inside the reply-insert transaction, before the insert.
 *
 * 1. Serialises every writer for this trigger on a transaction-scoped
 *    advisory lock keyed by (org, trigger message). A second writer blocks
 *    until the first commits, then sees its reply and returns it, so two
 *    concurrent deliveries cannot both insert (READ COMMITTED takes a fresh
 *    snapshot per statement, so the post-lock SELECT sees the committed row).
 * 2. When the reply comes from a queue delivery, requires that delivery to
 *    still own its lease and holds a share lock on the queue row until commit,
 *    so the stale-lease sweeper cannot hand the job to another worker between
 *    this check and the reply commit.
 *
 * Returns the existing reply when one is already present; the caller must then
 * not insert or broadcast.
 */
export async function claimDeftyReplySlot(
  tx: Executor,
  trigger: DeftyReplyTrigger,
  delivery?: DeftyReplyDelivery,
) {
  throwIfDeliveryLost(delivery);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`defty-reply:${trigger.orgId}:${trigger.triggerMessageId}`}, 0))`);
  if (delivery) {
    const owned = await tx.select({ id: jobQueue.id }).from(jobQueue).where(and(
      eq(jobQueue.id, delivery.jobId),
      eq(jobQueue.status, 'running'),
      eq(jobQueue.lock_token, delivery.lockToken),
      sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
    )).for('share');
    if (owned.length !== 1) throw new DeftyDeliveryLostError();
    throwIfDeliveryLost(delivery);
  }
  return findExistingDeftyReply(tx, trigger);
}
