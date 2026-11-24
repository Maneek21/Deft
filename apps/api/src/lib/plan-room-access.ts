import { sql, type SQL } from 'drizzle-orm';
import { agentPlans } from '@deft/db/schema';
import { readableSpaceSql } from './space-visibility.js';

/**
 * True while a plan's creator (`agent_plans.user_id`) can still read every
 * room the plan came from: its conversation (`conversation_id`, a space) and
 * the room of the chat message it was made for (`context.source_message_id`),
 * under the room's own read rule (`readableSpaceSql`: a member, archived or
 * not, or an unjoined public room for a non-guest member of the workspace),
 * and is an active member of the workspace (always, so nobody runs a
 * departed member's plan for them). A reference to no room of the workspace
 * adds no room; a message whose room is missing fails closed.
 *
 * Plan reads, edits, approvals, runs and resumes, and the executor before
 * every step, require it (check 13: nothing of a room a person lost stays
 * visible or runnable for them, and an owner/admin cannot run it for them).
 */
export function planCreatorKeepsRoomsSql(): SQL {
  const creator = sql`${agentPlans.user_id}`;
  const sourceMessageId = sql`(${agentPlans.context}->>'source_message_id')`;
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM spaces plan_room
      WHERE plan_room.id = ${agentPlans.conversation_id}
        AND plan_room.org_id = ${agentPlans.org_id}
        AND NOT ${readableSpaceSql(creator, sql.raw('plan_room.id'), sql.raw('plan_room.org_id'))}
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages plan_message
      LEFT JOIN spaces plan_message_room
        ON plan_message_room.id = plan_message.space_id AND plan_message_room.org_id = plan_message.org_id
      WHERE plan_message.id = ${sourceMessageId}
        AND plan_message.org_id = ${agentPlans.org_id}
        AND NOT COALESCE(${readableSpaceSql(creator, sql.raw('plan_message_room.id'), sql.raw('plan_message_room.org_id'))}, false)
    )
    -- The creator is an active member of the workspace, room or not: nobody
    -- runs a departed member's plan for them.
    AND EXISTS (SELECT 1 FROM org_members plan_creator_membership
      WHERE plan_creator_membership.org_id = ${agentPlans.org_id}
        AND plan_creator_membership.user_id = ${agentPlans.user_id}
        AND plan_creator_membership.is_active = true)
  )`;
}
