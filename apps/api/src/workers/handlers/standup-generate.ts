// Handler: standup-generate — checks which orgs are at 9 AM and routes standups
// to a subscribed agent employee. If no employee is subscribed, emits a one-time
// CTA notification to org admins pointing at /library to attach a standup skill.
// The native-llm fallback path was retired 2026-04-19 in Block 0 of OpenClaw
// Unlock — see docs/superpowers/plans/2026-04-19-openclaw-unlock.md.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentEmployees,
  notifications,
  orgs,
  orgMembers,
  spaces,
} from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { TriggerInvocation } from './employee-trigger.js';

const TRIGGER_KIND = 'cron:standup';

/**
 * Phase 6 — check whether any employee in this org has subscribed to the
 * `cron:standup` trigger. If yes, route the standup through the employee
 * trigger dispatcher (the employee will author the standup itself via its
 * own chat envelope) and skip the built-in native standup for this org.
 */
async function findSubscribedEmployee(orgId: string) {
  const [row] = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        sql`${TRIGGER_KIND} = ANY(${agentEmployees.trigger_subscriptions})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Get the current hour (0-23) in a given IANA timezone.
 * Returns null if the timezone string is invalid.
 */
function currentHourInTimezone(timezone: string): number | null {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(new Date());
    return parseInt(formatted, 10);
  } catch {
    return null;
  }
}

export async function handleStandupGenerate(job: JobData): Promise<void> {
  console.log(`[standup-generate] Running standup generation check (job ${job.id})`);

  // 1. Query all orgs
  const allOrgs = await db.select().from(orgs);

  for (const org of allOrgs) {
    try {
      // 2. Check if current UTC hour matches their 9am
      const localHour = currentHourInTimezone(org.timezone);
      if (localHour !== 9) {
        continue;
      }

      // Phase 6 branch: if an employee subscribes to `cron:standup` for this
      // org, hand the work off to the employee-trigger dispatcher and skip
      // the built-in native standup path. The fallback below stays unchanged
      // for orgs that have NOT deployed a subscribed employee, so existing
      // demos keep working.
      const subscribed = await findSubscribedEmployee(org.id);
      if (subscribed) {
        const [defaultSpace] = await db
          .select({ id: spaces.id })
          .from(spaces)
          .where(and(eq(spaces.org_id, org.id), eq(spaces.is_default, true)))
          .limit(1);
        const invocation: TriggerInvocation = {
          employee_id: subscribed.id,
          trigger_kind: TRIGGER_KIND,
          context: { org_id: org.id, org_name: org.name },
          goal:
            'Generate a concise daily standup summary for the team. ' +
            'Pull task activity + messages from the last 24h via your MCP ' +
            'tools, post the summary in #general.',
          target_space_id: defaultSpace?.id,
        };
        await enqueue(QUEUE_NAMES.AGENT_JOBS, 'employee-trigger', invocation as unknown as Record<string, unknown>);
        console.log(
          `[standup-generate] Routed cron:standup to employee ${subscribed.slug} in org "${org.name}"`,
        );
        continue;
      }

      // No subscribed employee — the native llm() fallback was retired
      // 2026-04-19. Standups must now be produced by an agent employee with
      // a standup-capable skill attached. Emit a CTA to org admins/owners
      // once per 7 days so existing orgs find their way to /library.
      const admins = await db
        .select({ user_id: orgMembers.user_id })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.org_id, org.id),
            eq(orgMembers.is_active, true),
            sql`${orgMembers.role} IN ('owner', 'admin')`,
          ),
        );

      for (const admin of admins) {
        // Dedupe: skip if this admin already has an unread
        // standup_unconfigured notification from the last 7 days.
        const [recent] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.org_id, org.id),
              eq(notifications.user_id, admin.user_id),
              eq(notifications.type, 'system'),
              sql`${notifications.metadata}->>'subtype' = 'standup_unconfigured'`,
              sql`${notifications.created_at} > now() - interval '7 days'`,
            ),
          )
          .limit(1);
        if (recent) continue;

        await db.insert(notifications).values({
          org_id: org.id,
          user_id: admin.user_id,
          type: 'system',
          title: 'Configure your standup agent',
          body:
            'No agent is subscribed to the daily standup yet. Attach a ' +
            'standup-capable skill to an agent employee to get the morning ' +
            'summary.',
          link: '/library',
          metadata: { subtype: 'standup_unconfigured' },
        });
      }

      console.log(
        `[standup-generate] No subscribed employee for org "${org.name}" — emitted configure-standup CTA to ${admins.length} admin(s)`,
      );
    } catch (err) {
      console.error(`[standup-generate] Error generating standup for org ${org.id}:`, err);
      // Continue to next org — don't let one failure block all others
    }
  }
}
