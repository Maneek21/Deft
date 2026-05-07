/**
 * Block 2.7 — member.joined trigger fan-out.
 *
 * Called from the POST /api/members route after a new member is added
 * to the org. Finds every active agent-employee whose
 * `trigger_subscriptions` contains `member.joined` and enqueues one
 * `employee-trigger` job per match. The trigger handler then runs the
 * agent's onboarding playbook (typically: create task list, DM
 * welcome message, schedule 1:1).
 *
 * Org must explicitly opt in by installing an HR-style skill that
 * declares `member.joined` in its trigger manifest. No agent fires
 * automatically — that's why the sql filter is a strict array
 * containment check rather than a broad default.
 */
import { db } from './db.js';
import { agentEmployees, users } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { enqueue, QUEUE_NAMES } from './queues.js';

export type MemberJoinedEvent = {
  org_id: string;
  new_user_id: string;
  inviter_user_id: string;
  role: string;
};

export async function emitMemberJoinedTrigger(event: MemberJoinedEvent): Promise<number> {
  const subscribers = await db
    .select({
      id: agentEmployees.id,
      slug: agentEmployees.slug,
      name: agentEmployees.name,
    })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.org_id, event.org_id),
      eq(agentEmployees.is_active, true),
      sql`${agentEmployees.trigger_subscriptions} @> ARRAY['member.joined']::text[]`,
    ));

  if (subscribers.length === 0) return 0;

  const [newUser] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, event.new_user_id))
    .limit(1);

  for (const emp of subscribers) {
    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'employee-trigger', {
        employee_id: emp.id,
        trigger_kind: 'member.joined',
        context: {
          new_user_id: event.new_user_id,
          new_user_name: newUser?.name ?? 'New member',
          new_user_email: newUser?.email ?? '',
          inviter_user_id: event.inviter_user_id,
          role: event.role,
        },
        goal: `A new ${event.role} "${newUser?.name ?? 'New member'}" just joined the org. Run your onboarding playbook: create their welcome task list, add them to the right spaces, and post a welcome message.`,
      });
    } catch (err) {
      console.warn(`[member-joined-trigger] failed to enqueue for employee ${emp.id}: ${(err as Error).message}`);
    }
  }
  return subscribers.length;
}
