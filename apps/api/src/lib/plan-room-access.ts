import { sql, type SQL } from 'drizzle-orm';
import { readableSpaceSql } from './space-visibility.js';

/**
 * The rooms of the plan row `alias` (an `agent_plans` row in scope) are all
 * readable by `reader`: its conversation (`conversation_id`, a space) and the
 * room of the chat message it was made for (`context.source_message_id`),
 * under the room's own read rule (`readableSpaceSql`: a member, archived or
 * not, or an unjoined public room for a non-guest member of the workspace),
 * and `reader` is an active member of the workspace. A reference to no room
 * of the workspace adds no room; a message whose room is missing fails
 * closed, and so does a source reference that is not a string.
 *
 * A plan made by another plan's step (its result names the new plan) also
 * needs the rooms of that parent plan (one level; the parent's own rule).
 */
function planRoomsReadableSql(alias: string, reader: SQL, withParents: boolean): SQL {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  const sourceMessageId = sql`(${col('context')}->>'source_message_id')`;
  const parents = withParents ? sql`
    AND NOT EXISTS (
      SELECT 1 FROM agent_plans parent_plan
      WHERE parent_plan.org_id = ${col('org_id')}
        AND parent_plan.id <> ${col('id')}
        AND jsonb_path_exists(parent_plan.context, '$.**.plan_id ? (@ == $id)', jsonb_build_object('id', ${col('id')}))
        AND NOT ${planRoomsReadableSql('parent_plan', reader, false)}
    )` : sql``;
  return sql`(
    COALESCE(jsonb_typeof(${col('context')}->'source_message_id'), 'string') = 'string'
    AND NOT EXISTS (
      SELECT 1 FROM spaces plan_room
      WHERE plan_room.id = ${col('conversation_id')}
        AND plan_room.org_id = ${col('org_id')}
        AND NOT ${readableSpaceSql(reader, sql.raw('plan_room.id'), sql.raw('plan_room.org_id'))}
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages plan_message
      LEFT JOIN spaces plan_message_room
        ON plan_message_room.id = plan_message.space_id AND plan_message_room.org_id = plan_message.org_id
      WHERE plan_message.id = ${sourceMessageId}
        AND plan_message.org_id = ${col('org_id')}
        AND NOT COALESCE(${readableSpaceSql(reader, sql.raw('plan_message_room.id'), sql.raw('plan_message_room.org_id'))}, false)
    )
    -- An active member of the workspace, room or not: nobody runs a departed
    -- member's plan for them.
    AND EXISTS (SELECT 1 FROM org_members plan_reader_membership
      WHERE plan_reader_membership.org_id = ${col('org_id')}
        AND plan_reader_membership.user_id = ${reader}
        AND plan_reader_membership.is_active = true)
    ${parents}
  )`;
}

/**
 * True while a plan's creator (`agent_plans.user_id`) can still read every
 * room the plan came from and is an active workspace member (see
 * `planRoomsReadableSql`). For a query whose `agent_plans` row is unaliased.
 *
 * Plan reads, edits, approvals, runs and resumes, and the executor before
 * every step, require it (check 13: nothing of a room a person lost stays
 * visible or runnable for them, and an owner/admin cannot run it for them).
 */
export function planCreatorKeepsRoomsSql(): SQL {
  return planRoomsReadableSql('agent_plans', sql.raw('agent_plans.user_id'), true);
}

/**
 * For a query over `agent_actions`: the action is not a plan step, or `reader`
 * (default: the plan's creator) can read every room of its plan. A plan step's
 * own row may name fewer rooms than its plan.
 */
export function actionPlanRoomsReadableSql(reader?: SQL): SQL {
  return sql`(agent_actions.plan_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM agent_plans step_plan
    WHERE step_plan.id = agent_actions.plan_id
      AND step_plan.org_id = agent_actions.org_id
      AND NOT ${planRoomsReadableSql('step_plan', reader ?? sql.raw('step_plan.user_id'), true)}
  ))`;
}
