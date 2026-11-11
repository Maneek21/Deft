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
export type DeftyReplyDelivery = { signal?: AbortSignal; lease?: { jobId: string; lockToken: string } };

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
 * Remaining lease in ms by the database clock, or null when this delivery no
 * longer owns its queue row (reclaimed, settled or expired). Takes no row lock:
 * a lock on the queue row would block the worker's own lease renewal, and
 * under READ COMMITTED each statement sees the latest committed renewal.
 */
async function remainingLeaseMs(tx: Executor, lease: NonNullable<DeftyReplyDelivery['lease']>): Promise<number | null> {
  const [row] = await tx.select({
    remaining: sql<number>`floor(extract(epoch from (${jobQueue.lock_expires_at} - clock_timestamp())) * 1000)::int`,
  }).from(jobQueue).where(and(
    eq(jobQueue.id, lease.jobId),
    eq(jobQueue.status, 'running'),
    eq(jobQueue.lock_token, lease.lockToken),
    sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
  )).limit(1);
  return row ? Number(row.remaining) : null;
}

/** Below this much remaining lease a delivery does not start persisting. */
const MIN_LEASE_TO_PERSIST_MS = 2_000;
/** Margin kept between the database wait bound and the lease expiry. */
const LEASE_SAFETY_MARGIN_MS = 1_000;

/**
 * Run inside the reply-insert transaction, before the insert.
 *
 * 1. Serialises every writer for this trigger on a transaction-scoped
 *    advisory lock keyed by (org, trigger message). A second writer blocks
 *    until the first commits, then sees its reply and returns it, so two
 *    concurrent deliveries cannot both insert (READ COMMITTED takes a fresh
 *    snapshot per statement, so the post-lock SELECT sees the committed row).
 * 2. For a queue delivery, requires a live lease by the database clock and
 *    bounds every later wait in this transaction (SET LOCAL lock_timeout and
 *    statement_timeout) below the lease remaining now, so a blocked statement
 *    errors and rolls the reply back instead of committing long after the
 *    lease. assertDeliveryOwnedBeforeCommit re-checks immediately before
 *    COMMIT.
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
  if (delivery?.lease) {
    const remaining = await remainingLeaseMs(tx, delivery.lease);
    if (remaining === null || remaining < MIN_LEASE_TO_PERSIST_MS) throw new DeftyDeliveryLostError();
    const boundMs = Math.max(1, Math.floor(remaining - LEASE_SAFETY_MARGIN_MS));
    // SET takes no bind parameters; boundMs is a computed positive integer.
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${boundMs}`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${boundMs}`));
  }
  throwIfDeliveryLost(delivery);
  return findExistingDeftyReply(tx, trigger);
}

/**
 * Run as the last statement of the reply transaction, immediately before
 * COMMIT; throwing rolls the reply back. A delivery whose signal aborted
 * (worker timeout or lease loss) or whose lease is no longer current by the
 * database clock must not publish, however long the transaction waited.
 */
export async function assertDeliveryOwnedBeforeCommit(tx: Executor, delivery?: DeftyReplyDelivery): Promise<void> {
  throwIfDeliveryLost(delivery);
  if (delivery?.lease && await remainingLeaseMs(tx, delivery.lease) === null) throw new DeftyDeliveryLostError();
  throwIfDeliveryLost(delivery);
}

/**
 * True when an error (or anything in its cause chain) is a PostgreSQL lock or
 * statement timeout. The reply transaction bounds its waits to the remaining
 * lease, so these mean "try the delivery again", never "publish a fallback".
 */
export function isDatabaseWaitTimeout(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 8; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (code === '55P03' || code === '57014') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when an error (or anything in its cause chain) carries a PostgreSQL
 * SQLSTATE. A database error inside a transaction aborts it, so it must be
 * rethrown, never treated as a rejected proposal.
 */
export function isDatabaseError(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 8; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
