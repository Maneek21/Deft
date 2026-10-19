import {sql} from 'drizzle-orm';
import {agentActions} from '@deft/db/schema';
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
