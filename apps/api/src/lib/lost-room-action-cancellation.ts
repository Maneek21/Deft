/**
 * DFX2: when a person loses a room (removed from a space or DM, left it, the
 * space made private without them, or removed from the workspace or made a
 * guest of it), their pending assistant actions that came from that room
 * are closed with a recorded reason. Owners and admins keep the rows in the
 * action history; DFX1 (lib/module-action-visibility.ts) already hides them
 * from the person.
 *
 * Who runs it, and why both:
 * - At the moment of loss, after the change commits (routes/spaces.ts and
 *   routes/members.ts), so the Inbox and approval lists settle at once.
 * - A sweep in the attention maintenance job (every 15 minutes), which
 *   catches every other way a room can be lost, including any added later,
 *   and any run that failed after the change committed.
 *
 * Neither is what stops an approval. Every approval claim carries
 * `requesterKeepsSourceRoomsSql` in its claiming UPDATE, and so does each
 * close below. A claim and a loss that happen together therefore resolve in
 * one order: if the loss committed before the claim's statement ran, the
 * claim matches no row; if the claim's statement ran first, the approval was
 * made while the person still had the room, and the close below finds the
 * row no longer pending and leaves it. Both statements lock the action row,
 * so they never both succeed.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { db } from './db.js';
import { actionRequesterIdSql } from './agent-action-requester.js';
import { resolveAttentionBySource } from './attention.js';
import { MODULE_WRITE_ACTION_NAMES, canonicalDeftyActionSql, requesterKeepsSourceRoomsSql } from './module-action-visibility.js';
import { terminalizePendingModuleActions } from './module-action-terminalization.js';
import { markWorkIntentsExpiredForActions } from './work-intents.js';

/** Recorded on the action (`error`) and on its receipt. Names no room. */
export const LOST_ROOM_CANCEL_REASON = 'Cancelled: the person who asked no longer has access to the conversation this came from';
/** Attention items of a closed action resolve with this. */
export const LOST_ROOM_ATTENTION_RESOLUTION = 'source_room_access_lost';

/**
 * Governed App Run releases and record-mirror nominations keep their own
 * lifecycle and authority checks (lib/app-run-approval-adapter.ts); closing
 * only their action row would leave the run out of step. Their approval
 * claims still refuse a requester who lost the room.
 */
const OWN_LIFECYCLE_ACTIONS = ['app_run_invoke', 'app_record_mirror_nominate'];

const lostRoomPendingSql = () => and(
  eq(agentActions.approval_status, 'pending'),
  sql`(${agentActions.agent_employee_id} IS NULL OR ${canonicalDeftyActionSql()})`,
  notInArray(agentActions.action, OWN_LIFECYCLE_ACTIONS),
  sql`NOT ${requesterKeepsSourceRoomsSql()}`,
)!;

/**
 * Close the pending Defty actions whose requester can no longer read a room
 * they came from. `orgId` and `requesterId` narrow the search (the sweep
 * passes neither). Returns the ids closed by this call.
 */
export async function cancelLostRoomActions(scope: { orgId?: string; requesterId?: string } = {}): Promise<string[]> {
  const candidates = await db
    .select({ id: agentActions.id, org_id: agentActions.org_id, action: agentActions.action })
    .from(agentActions)
    .where(and(
      lostRoomPendingSql(),
      scope.orgId ? eq(agentActions.org_id, scope.orgId) : undefined,
      scope.requesterId ? sql`${actionRequesterIdSql()} = ${scope.requesterId}` : undefined,
    ));
  if (candidates.length === 0) return [];

  const closed: string[] = [];
  const byOrg = new Map<string, typeof candidates>();
  for (const row of candidates) byOrg.set(row.org_id, [...(byOrg.get(row.org_id) ?? []), row]);
  for (const [orgId, rows] of byOrg) {
    // Module writes carry record values: the shared terminal path scrubs them,
    // issues the expired receipt and closes their attention items.
    const moduleIds = rows.filter((row) => (MODULE_WRITE_ACTION_NAMES as readonly string[]).includes(row.action)).map((row) => row.id);
    if (moduleIds.length) {
      const done = await terminalizePendingModuleActions({
        orgId,
        actionIds: moduleIds,
        reason: LOST_ROOM_CANCEL_REASON,
        attentionResolution: LOST_ROOM_ATTENTION_RESOLUTION,
        claimGuard: lostRoomPendingSql(),
      });
      closed.push(...done.map((row) => row.id));
    }

    const otherIds = rows.filter((row) => !moduleIds.includes(row.id)).map((row) => row.id);
    if (otherIds.length === 0) continue;
    // The same compare-and-set as the TTL expiry (lib/attention-maintenance.ts),
    // with the room rule re-checked in the statement.
    const expired = await db
      .update(agentActions)
      .set({ approval_status: 'expired', error: LOST_ROOM_CANCEL_REASON, updated_at: new Date() })
      .where(and(eq(agentActions.org_id, orgId), inArray(agentActions.id, otherIds), lostRoomPendingSql()))
      .returning({ id: agentActions.id, params: agentActions.params });
    if (expired.length === 0) continue;
    await markWorkIntentsExpiredForActions({ orgId, actions: expired, reason: LOST_ROOM_CANCEL_REASON });
    for (const row of expired) {
      await resolveAttentionBySource({
        orgId,
        sourceType: 'agent_action',
        sourceId: row.id,
        resolution: LOST_ROOM_ATTENTION_RESOLUTION,
      });
      closed.push(row.id);
    }
  }
  return closed;
}

/**
 * The moment-of-loss call: best effort after the change committed. A
 * failure is logged without content and left to the sweep; the approval
 * claims refuse the action meanwhile.
 */
export async function cancelLostRoomActionsAfterLoss(orgId: string, userId: string): Promise<void> {
  try {
    await cancelLostRoomActions({ orgId, requesterId: userId });
  } catch {
    console.error('[lost-room-actions] cancellation after a room loss failed; the maintenance sweep will retry');
  }
}
