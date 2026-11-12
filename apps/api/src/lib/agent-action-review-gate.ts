import { and, sql } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { visibleCaptureActionSql } from './agent-action-visibility.js';
import { actionReviewAssignmentSql } from './agent-action-requester.js';
import { visibleModuleActionSql } from './module-action-visibility.js';

/**
 * The actions a web user may open for review through the approve and reject
 * routes: actions of the user's workspace that the user reviews (see
 * `actionReviewAssignmentSql`: the requester when an active human member,
 * otherwise an owner/admin; an assignment counts when it names one of
 * them). For the actions it owns, the approval resolver adds its own
 * reviewer rule on top (see `viewerReviewAuthority`).
 */
export function reviewableActionSql(user: { id: string; org_id: string; role?: string }) {
  return and(
    sql`${agentActions.org_id} = ${user.org_id}`,
    visibleCaptureActionSql(user),
    visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
    actionReviewAssignmentSql(user.id),
  )!;
}
