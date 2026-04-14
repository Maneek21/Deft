// Handler: standup-generate — checks which orgs are at 9 AM and generates standups
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import {
  agentEmployees,
  orgs,
  tasks,
  taskActivity,
  messages,
  spaces,
  standups,
} from '@deft/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { getIO } from '../../socket.js';
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

      console.log(`[standup-generate] Generating standup for org "${org.name}" (${org.id})`);

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // 3. Gather yesterday's activity

      // Task status changes from taskActivity (last 24h)
      const statusChanges = await db
        .select({
          action: taskActivity.action,
          field: taskActivity.field,
          old_value: taskActivity.old_value,
          new_value: taskActivity.new_value,
          task_title: tasks.title,
          task_number: tasks.number,
        })
        .from(taskActivity)
        .innerJoin(tasks, eq(taskActivity.task_id, tasks.id))
        .where(
          and(
            eq(tasks.org_id, org.id),
            gte(taskActivity.created_at, yesterday),
          ),
        );

      // New tasks created (last 24h)
      const newTasks = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          number: tasks.number,
          status: tasks.status,
          priority: tasks.priority,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.org_id, org.id),
            eq(tasks.is_deleted, false),
            gte(tasks.created_at, yesterday),
          ),
        );

      // Message count per space (last 24h)
      const messagesBySpace = await db
        .select({
          space_name: spaces.name,
          msg_count: sql<number>`count(*)`,
        })
        .from(messages)
        .innerJoin(spaces, eq(messages.space_id, spaces.id))
        .where(
          and(
            eq(messages.org_id, org.id),
            eq(messages.is_deleted, false),
            gte(messages.created_at, yesterday),
          ),
        )
        .groupBy(spaces.name);

      // Count active users (last 24h)
      const [activeUsersRow] = await db
        .select({
          count: sql<number>`count(distinct ${messages.user_id})`,
        })
        .from(messages)
        .where(
          and(
            eq(messages.org_id, org.id),
            eq(messages.is_deleted, false),
            gte(messages.created_at, yesterday),
          ),
        );
      const activeUsers = Number(activeUsersRow?.count ?? 0);

      // Count tasks completed (status changed to done in last 24h)
      const completedCount = statusChanges.filter(
        (sc) => sc.field === 'status' && sc.new_value === 'done',
      ).length;

      // Count overdue tasks
      const [overdueRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.org_id, org.id),
            eq(tasks.is_deleted, false),
            sql`${tasks.due_date} < now()`,
            sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          ),
        );
      const overdueCount = Number(overdueRow?.count ?? 0);

      const rawData = {
        status_changes: statusChanges,
        new_tasks: newTasks,
        messages_by_space: messagesBySpace,
        active_users: activeUsers,
        completed_count: completedCount,
        overdue_count: overdueCount,
      };

      // 4. Generate summary
      let summary: string;

      if (env.ANTHROPIC_API_KEY) {
        try {
          const { llm } = await import('../../lib/llm.js');

          const dataForPrompt = JSON.stringify(rawData, null, 2);
          const response = await llm({
            task: 'summarize',
            messages: [
              {
                role: 'user',
                content: `Generate a concise daily standup summary for the team. Include: what was accomplished, what's in progress, any blockers or overdue items. Keep it under 200 words.\n\nHere is the raw activity data from the last 24 hours:\n${dataForPrompt}`,
              },
            ],
            maxTokens: 400,
          });

          summary = response.text || generateFallbackSummary(rawData);
        } catch (err) {
          console.error(`[standup-generate] LLM API error for org ${org.id}:`, err);
          summary = generateFallbackSummary(rawData);
        }
      } else {
        summary = generateFallbackSummary(rawData);
      }

      // 5. Insert into standups table
      await db.insert(standups).values({
        org_id: org.id,
        date: now,
        generated_by: 'system',
        summary,
        raw_data: rawData,
      });

      // 6. Post message in default space
      const [defaultSpace] = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(
          and(
            eq(spaces.org_id, org.id),
            eq(spaces.is_default, true),
          ),
        )
        .limit(1);

      if (defaultSpace) {
        const [msg] = await db
          .insert(messages)
          .values({
            org_id: org.id,
            space_id: defaultSpace.id,
            user_id: 'system',
            content: `**Daily Standup Summary**\n\n${summary}`,
          })
          .returning();

        // 7. Emit via Socket.io
        if (msg) {
          const io = getIO();
          if (io) {
            io.to(`org:${org.id}`).emit('message:new', {
              ...msg,
              user_name: 'Deft',
              user_avatar: null,
            });
          }
        }
      }

      console.log(`[standup-generate] Standup generated for org "${org.name}"`);
    } catch (err) {
      console.error(`[standup-generate] Error generating standup for org ${org.id}:`, err);
      // Continue to next org — don't let one failure block all others
    }
  }
}

/**
 * Generate a simple text summary from raw activity data when no AI is available.
 */
function generateFallbackSummary(rawData: {
  status_changes: any[];
  new_tasks: any[];
  messages_by_space: any[];
  active_users: number;
  completed_count: number;
  overdue_count: number;
}): string {
  const lines: string[] = [];

  lines.push(`**Activity in the last 24 hours:**`);
  lines.push('');

  if (rawData.completed_count > 0) {
    lines.push(`- ${rawData.completed_count} task(s) completed`);
  }

  if (rawData.new_tasks.length > 0) {
    lines.push(`- ${rawData.new_tasks.length} new task(s) created`);
  }

  if (rawData.status_changes.length > 0) {
    lines.push(`- ${rawData.status_changes.length} task update(s)`);
  }

  const totalMessages = rawData.messages_by_space.reduce(
    (sum: number, s: any) => sum + Number(s.msg_count),
    0,
  );
  if (totalMessages > 0) {
    lines.push(`- ${totalMessages} message(s) across ${rawData.messages_by_space.length} space(s)`);
  }

  lines.push(`- ${rawData.active_users} active contributor(s)`);

  if (rawData.overdue_count > 0) {
    lines.push('');
    lines.push(`**Attention:** ${rawData.overdue_count} task(s) are overdue.`);
  }

  if (lines.length <= 2) {
    lines.push('- No significant activity recorded.');
  }

  return lines.join('\n');
}
