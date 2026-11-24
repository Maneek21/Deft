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
 *
 * A change to a room itself (archiving it ends unjoined reading of a public
 * room) does not take this lock: it updates the room's row, which every claim
 * locks FOR SHARE before its claiming statement (see below), and closes the
 * actions it orphans in its own transaction. Deleting an agent employee
 * deactivates an agent's membership; agent employees' actions follow their
 * own source rule, not this one.
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

/**
 * Shared: an approval claim, before its claiming statement, for the action's
 * requester. Also locks the rows of the rooms the action came from (FOR
 * SHARE, in id order), so a change to a room itself (archiving it, making it
 * private) cannot commit between this and the claiming statement: it waits
 * for the claim, or the claim waits for it and then reads it.
 */
export async function lockRoomAccessForClaim(tx: Executor, orgId: string, requesterId: string, actionId?: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${roomAccessLockKey(orgId, requesterId)})`);
  if (!actionId) return;
  await tx.execute(sql`SELECT source_room.id FROM spaces source_room
    WHERE source_room.org_id = ${orgId}
      AND source_room.id IN (
        SELECT claimed.conversation_id FROM agent_actions claimed WHERE claimed.id = ${actionId} AND claimed.org_id = ${orgId}
        UNION
        SELECT COALESCE(claimed.params->>'source_space_id', claimed.params->>'origin_space_id', claimed.params->>'space_id')
          FROM agent_actions claimed WHERE claimed.id = ${actionId} AND claimed.org_id = ${orgId} AND claimed.source = 'defty_capture'
        UNION
        SELECT source_message.space_id FROM messages source_message
          JOIN agent_actions claimed ON claimed.id = ${actionId} AND claimed.org_id = ${orgId}
          WHERE source_message.org_id = ${orgId}
            AND source_message.id IN (claimed.message_id, claimed.params->>'source_message_id')
        UNION
        ${planRoomIdsSql(sql`(SELECT claimed.plan_id FROM agent_actions claimed WHERE claimed.id = ${actionId} AND claimed.org_id = ${orgId})`, orgId)}
      )
    ORDER BY source_room.id
    FOR SHARE OF source_room`);
}

/** The room ids of a plan: its conversation and its source message's room. */
function planRoomIdsSql(planId: ReturnType<typeof sql>, orgId: string) {
  return sql`SELECT locked_plan.conversation_id FROM agent_plans locked_plan
          WHERE locked_plan.id = ${planId} AND locked_plan.org_id = ${orgId}
        UNION
        SELECT plan_source.space_id FROM messages plan_source
          JOIN agent_plans locked_plan ON locked_plan.id = ${planId} AND locked_plan.org_id = ${orgId}
          WHERE plan_source.org_id = ${orgId} AND plan_source.id = locked_plan.context->>'source_message_id'`;
}

/**
 * DFX3: a plan's step claim or a guarded plan update, for the plan's
 * creator: the creator's room-access lock (shared), then the plan's room rows
 * FOR SHARE in id order. Losses and room changes wait for it, or it waits for
 * them and the next statement reads them.
 */
export async function lockPlanRoomAccess(tx: Executor, orgId: string, creatorId: string, planId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${roomAccessLockKey(orgId, creatorId)})`);
  await tx.execute(sql`SELECT plan_room.id FROM spaces plan_room
    WHERE plan_room.org_id = ${orgId} AND plan_room.id IN (${planRoomIdsSql(sql`${planId}`, orgId)})
    ORDER BY plan_room.id
    FOR SHARE OF plan_room`);
}
