import { sql } from 'drizzle-orm';
import { agentEmployees, users } from '@deft/db/schema';
import { DEFTY_EMAIL } from './ensure-defty-membership.js';

/** Keep member list and resource projections aligned on live agent visibility. */
export function visibleLiveMemberForOrg(orgIdRef: unknown) {
  return sql`
    (
      ${users.kind} <> 'agent'
      OR ${users.email} = ${DEFTY_EMAIL}
      OR EXISTS (
        SELECT 1
        FROM ${agentEmployees}
        WHERE ${agentEmployees.user_id} = ${users.id}
          AND ${agentEmployees.org_id} = ${orgIdRef}
          AND ${agentEmployees.is_active} = true
          AND ${agentEmployees.is_deleted} = false
      )
    )
  `;
}
