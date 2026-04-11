// Privacy middleware — enforce manager-only access and data filtering
import { db } from '../lib/db.js';
import { orgMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Check if a user is a manager (owner or admin) in the org.
 */
export async function isManager(userId: string, orgId: string): Promise<boolean> {
  const [member] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.user_id, userId),
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.is_active, true),
      ),
    )
    .limit(1);

  if (!member) return false;
  return member.role === 'owner' || member.role === 'admin';
}

/**
 * Strip sensitive fields from API responses for non-managers.
 * Removes burnout signals, individual health statuses, and private patterns.
 */
export function filterForPrivacy(
  data: any,
  requestingUserId: string,
  orgId: string,
): any {
  if (!data || typeof data !== 'object') return data;

  // If data is an array, filter each item
  if (Array.isArray(data)) {
    return data
      .map((item) => filterForPrivacy(item, requestingUserId, orgId))
      .filter((item) => item !== null);
  }

  const filtered = { ...data };

  // Strip burnout signals — these should never leak to non-managers
  if ('signals' in filtered) {
    delete filtered.signals;
  }

  // Strip raw pattern_data for other users
  if ('pattern_data' in filtered && filtered.user_id && filtered.user_id !== requestingUserId) {
    delete filtered.pattern_data;
    delete filtered.baseline_data;
  }

  // Strip health status details for non-self users
  if ('health_cards' in filtered) {
    filtered.health_cards = filtered.health_cards
      .filter((card: any) => card.userId === requestingUserId)
      .map((card: any) => ({
        userId: card.userId,
        name: card.name,
        status: card.status,
        insight: 'Your personal health summary',
        activeTasks: card.activeTasks,
      }));
  }

  // Remove action items directed at other people
  if ('action_items' in filtered) {
    filtered.action_items = [];
  }

  return filtered;
}
