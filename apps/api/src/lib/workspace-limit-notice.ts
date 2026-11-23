/**
 * The notice a hosted workspace's owners and admins get when it reaches a
 * limit (workspace-limits.ts decides when: at most one an hour per limit).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { orgMembers, users } from '@deft/db/schema';
import { db } from './db.js';
import { createNotificationIfAllowed } from './notification-policy.js';

export async function noticeWorkspaceAdmins(kind: string, notice: { title: string; body: string }): Promise<void> {
  const admins = await db
    .select({ org_id: orgMembers.org_id, user_id: orgMembers.user_id })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(inArray(orgMembers.role, ['owner', 'admin']), eq(orgMembers.is_active, true), eq(users.kind, 'human')));
  for (const admin of admins) {
    await createNotificationIfAllowed({
      org_id: admin.org_id,
      user_id: admin.user_id,
      type: 'system',
      title: notice.title,
      body: notice.body,
      metadata: { kind: 'workspace_limit', limit: kind },
    }).catch(() => console.warn('[workspace-limit] admin notice failed'));
  }
}
