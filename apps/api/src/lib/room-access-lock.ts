/**
 * DFX2: one lock per (workspace, person) for their room access, held to the
 * end of the transaction (a PostgreSQL advisory lock; no table).
 *
 * Every change that can take a room away from the person (leaving or being
 * removed from a space, removal from the workspace, a guest demotion) holds
 * it exclusively, as its first lock. Every approval claim of an action the
 * person requested holds it shared, before its claiming statement. So:
 * - a claim never runs on a snapshot taken before a loss that commits while
 *   it waits: it commits before the loss can start, or starts after the loss
 *   committed and sees it (READ COMMITTED takes a new snapshot per statement);
 * - two access changes for the same person run one after the other, each
 *   seeing the other's result.
 * Taking it first also keeps a single lock order with the membership row
 * locks the access changes take next.
 */
import { sql } from 'drizzle-orm';
import type { db } from './db.js';

type Executor = Pick<typeof db, 'execute'>;

function roomAccessLockKey(orgId: string, userId: string) {
  return sql`hashtextextended(${`deft-room-access:${orgId}:${userId}`}, 0)`;
}

/** Exclusive: the first lock of a transaction that may end a room for `userId`. */
export async function lockRoomAccessChange(tx: Executor, orgId: string, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${roomAccessLockKey(orgId, userId)})`);
}

/** Shared: an approval claim, before its claiming statement, for the action's requester. */
export async function lockRoomAccessForClaim(tx: Executor, orgId: string, requesterId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${roomAccessLockKey(orgId, requesterId)})`);
}
