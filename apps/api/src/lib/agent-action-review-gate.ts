import { and, sql } from 'drizzle-orm';
import { agentActionApprovers, agentActions, users } from '@deft/db/schema';
import { visibleCaptureActionSql } from './agent-action-visibility.js';
import { visibleModuleActionSql } from './module-action-visibility.js';

/**
 * The actions a web user may open for review through the approve and reject
 * routes. When reviewers are assigned, only they qualify; otherwise the
 * requester does, and so does an owner/admin when the requester is not an
 * active human member. For the actions it owns, the approval resolver adds
 * its own reviewer rule on top (see `viewerReviewAuthority`).
 */
export function reviewableActionSql(user: { id: string; org_id: string; role?: string }) {
  const canReviewOrgActions = user.role === 'owner' || user.role === 'admin';
  return and(
    visibleCaptureActionSql(user),
    visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
    sql`(
      EXISTS (
        SELECT 1 FROM ${agentActionApprovers}
        WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
          AND ${agentActionApprovers.org_id} = ${user.org_id}
          AND ${agentActionApprovers.user_id} = ${user.id}
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM ${agentActionApprovers}
          WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
        )
        AND (
          COALESCE(
            ${agentActions.params}->>'source_user_id',
            ${agentActions.params}->>'origin_user_id',
            ${agentActions.user_id}
          ) = ${user.id}
          OR (
            ${canReviewOrgActions}
            AND NOT EXISTS (
              SELECT 1
              FROM ${users}
              INNER JOIN org_members review_om
                ON review_om.user_id = ${users.id}
                AND review_om.org_id = ${agentActions.org_id}
                AND review_om.is_active = true
              WHERE ${users.id} = COALESCE(
                ${agentActions.params}->>'source_user_id',
                ${agentActions.params}->>'origin_user_id',
                ${agentActions.user_id}
              )
                AND ${users.is_agent} = false
                AND ${users.kind} = 'human'
            )
          )
        )
      )
    )`,
  )!;
}
