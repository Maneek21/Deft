import {and, eq, sql} from 'drizzle-orm';
import {agentActions, messages, projects, tasks} from '@deft/db/schema';
import {db} from './db.js';
import {requireSpaceMembership} from './space-membership.js';
import {visibleTaskCondition} from './task-visibility.js';
export function visibleCaptureActionSql(user: { id: string; org_id: string }) {
  return sql`(
    ${agentActions.source} IS DISTINCT FROM 'defty_capture'
    OR (
      (
        COALESCE(
          ${agentActions.params}->>'source_space_id',
          ${agentActions.params}->>'origin_space_id',
          ${agentActions.params}->>'space_id'
        ) IS NULL
        OR EXISTS (
          SELECT 1
          FROM space_members agent_capture_sm
          INNER JOIN spaces agent_capture_s
            ON agent_capture_s.id = agent_capture_sm.space_id
          WHERE agent_capture_sm.space_id = COALESCE(
              ${agentActions.params}->>'source_space_id',
              ${agentActions.params}->>'origin_space_id',
              ${agentActions.params}->>'space_id'
            )
            AND agent_capture_sm.user_id = ${user.id}
            AND agent_capture_s.org_id = ${user.org_id}
            AND agent_capture_s.is_archived = false
        )
      )
      AND (
        ${agentActions.params}->>'source_message_id' IS NULL
        OR EXISTS (
          SELECT 1
          FROM messages agent_capture_m
          INNER JOIN space_members agent_capture_msg_sm
            ON agent_capture_msg_sm.space_id = agent_capture_m.space_id
          INNER JOIN spaces agent_capture_msg_s
            ON agent_capture_msg_s.id = agent_capture_m.space_id
          WHERE agent_capture_m.id = ${agentActions.params}->>'source_message_id'
            AND agent_capture_m.org_id = ${user.org_id}
            AND agent_capture_m.is_deleted = false
            AND agent_capture_msg_sm.user_id = ${user.id}
            AND agent_capture_msg_s.org_id = ${user.org_id}
            AND agent_capture_msg_s.is_archived = false
            AND (
              COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              ) IS NULL
              OR agent_capture_m.space_id = COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              )
            )
        )
      )
    )
  )`;
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : null;
}

/**
 * Undo authority (C01). The caller must be the action's requester or an org
 * owner/admin, AND must still be able to see the object the undo would change
 * (task visibility for task actions, space membership for posted messages).
 * Callers answer `false` exactly like a missing action.
 */
export async function canUndoAgentAction(
  user: { id: string; org_id: string; role?: string },
  action: { user_id: string; action: string; params: unknown; result: unknown; before_state: unknown },
): Promise<boolean> {
  const requester = action.user_id === user.id
    || stringField(action.params, 'source_user_id') === user.id
    || stringField(action.params, 'origin_user_id') === user.id;
  if (!requester && user.role !== 'owner' && user.role !== 'admin') return false;

  switch (action.action) {
    case 'create_task':
    case 'update_task_status':
    case 'assign_task': {
      const taskId = stringField(action.before_state, 'task_id') ?? stringField(action.result, 'task_id');
      if (!taskId) return true;
      const [task] = await db.select({ id: tasks.id }).from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.project_id))
        .where(and(eq(tasks.id, taskId), eq(tasks.org_id, user.org_id), visibleTaskCondition(user.id)))
        .limit(1);
      return Boolean(task);
    }
    case 'post_message': {
      const messageId = stringField(action.result, 'message_id');
      if (!messageId) return true;
      const [message] = await db.select({ space_id: messages.space_id }).from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.org_id, user.org_id)))
        .limit(1);
      return Boolean(message && await requireSpaceMembership(message.space_id, user.id, user.org_id));
    }
    default:
      return true;
  }
}
