// Handler: find overdue/stalled tasks and send nudges
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentEmployees,
  tasks,
  projects,
  notifications,
  agentNudges,
  users,
  orgMembers,
} from '@deft/db/schema';
import { eq, and, lt, sql, gte, inArray, isNotNull } from 'drizzle-orm';
import { emitToUser } from '../../socket.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { TriggerInvocation } from './employee-trigger.js';

// Phase 6 — per-kind trigger routing. Stalled tasks and overdue tasks are
// separate kinds so an employee can subscribe to just one. If the org has
// a subscribed employee for a given kind, we hand the nudge off to the
// `employee-trigger` dispatcher and skip the built-in notification path
// for that (kind, task) pair.
const NUDGE_STALLED_KIND = 'event:task-stalled';
const NUDGE_OVERDUE_KIND = 'event:task-overdue';

async function findNudgeEmployee(orgId: string, triggerKind: string) {
  const [row] = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        sql`${triggerKind} = ANY(${agentEmployees.trigger_subscriptions})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function handleNudgeCheck(_job: JobData): Promise<void> {
  console.log('[nudge-check] Checking for overdue and stalled tasks');

  const now = new Date();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  try {
    // 1. Query stalled tasks: in_progress and not updated in 48h
    const stalledTasks = await db
      .select({
        id: tasks.id,
        org_id: tasks.org_id,
        title: tasks.title,
        number: tasks.number,
        status: tasks.status,
        assignee_id: tasks.assignee_id,
        created_by: tasks.created_by,
        updated_at: tasks.updated_at,
        project_prefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.is_deleted, false),
          eq(tasks.status, 'in_progress'),
          lt(tasks.updated_at, fortyEightHoursAgo),
        ),
      );

    // 2. Query overdue tasks: due_date < now and not done/cancelled
    const overdueTasks = await db
      .select({
        id: tasks.id,
        org_id: tasks.org_id,
        title: tasks.title,
        number: tasks.number,
        status: tasks.status,
        assignee_id: tasks.assignee_id,
        created_by: tasks.created_by,
        due_date: tasks.due_date,
        project_prefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.is_deleted, false),
          lt(tasks.due_date, now),
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
        ),
      );

    // Phase 6 — per-org memoized subscription lookups. We resolve each
    // (org_id, trigger_kind) pair at most once per nudge pass so we don't
    // spam the DB with the same query for every task in a large org.
    const stalledEmpByOrg = new Map<string, Awaited<ReturnType<typeof findNudgeEmployee>>>();
    const overdueEmpByOrg = new Map<string, Awaited<ReturnType<typeof findNudgeEmployee>>>();

    // Process stalled tasks
    for (const task of stalledTasks) {
      if (!stalledEmpByOrg.has(task.org_id)) {
        stalledEmpByOrg.set(task.org_id, await findNudgeEmployee(task.org_id, NUDGE_STALLED_KIND));
      }
      const subscribed = stalledEmpByOrg.get(task.org_id);
      if (subscribed) {
        const invocation: TriggerInvocation = {
          employee_id: subscribed.id,
          trigger_kind: NUDGE_STALLED_KIND,
          context: {
            task_id: task.id,
            task_identifier: `${task.project_prefix}-${task.number}`,
            title: task.title,
            assignee_id: task.assignee_id,
            updated_at: task.updated_at,
          },
          goal:
            `Task ${task.project_prefix}-${task.number} ("${task.title}") has been stalled since ${task.updated_at.toISOString()}. ` +
            'Ask the assignee for a status update or suggest an unblock path.',
        };
        await enqueue(
          QUEUE_NAMES.AGENT_JOBS,
          'employee-trigger',
          invocation as unknown as Record<string, unknown>,
        );
        continue;
      }
      await processNudge({
        taskId: task.id,
        orgId: task.org_id,
        targetUserId: task.assignee_id || task.created_by,
        nudgeType: 'stalled',
        taskIdentifier: `${task.project_prefix}-${task.number}`,
        message: buildStalledMessage(task.project_prefix, task.number, task.updated_at),
        since: twentyFourHoursAgo,
      });
    }

    // Process overdue tasks
    for (const task of overdueTasks) {
      if (!overdueEmpByOrg.has(task.org_id)) {
        overdueEmpByOrg.set(task.org_id, await findNudgeEmployee(task.org_id, NUDGE_OVERDUE_KIND));
      }
      const subscribed = overdueEmpByOrg.get(task.org_id);
      if (subscribed) {
        const invocation: TriggerInvocation = {
          employee_id: subscribed.id,
          trigger_kind: NUDGE_OVERDUE_KIND,
          context: {
            task_id: task.id,
            task_identifier: `${task.project_prefix}-${task.number}`,
            title: task.title,
            assignee_id: task.assignee_id,
            due_date: task.due_date,
          },
          goal:
            `Task ${task.project_prefix}-${task.number} ("${task.title}") is overdue (due ${task.due_date?.toISOString() ?? 'unset'}). ` +
            'DM the assignee and alert the project lead.',
        };
        await enqueue(
          QUEUE_NAMES.AGENT_JOBS,
          'employee-trigger',
          invocation as unknown as Record<string, unknown>,
        );
        continue;
      }
      await processNudge({
        taskId: task.id,
        orgId: task.org_id,
        targetUserId: task.assignee_id || task.created_by,
        nudgeType: 'overdue',
        taskIdentifier: `${task.project_prefix}-${task.number}`,
        message: buildOverdueMessage(task.project_prefix, task.number, task.due_date),
        since: twentyFourHoursAgo,
      });
    }

    // 3. Upcoming due date reminders — tasks due within 24 hours that haven't been nudged
    const upcomingTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        number: tasks.number,
        due_date: tasks.due_date,
        assignee_id: tasks.assignee_id,
        created_by: tasks.created_by,
        project_prefix: projects.prefix,
        org_id: tasks.org_id,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          gte(tasks.due_date, now),
          lt(tasks.due_date, twentyFourHoursFromNow),
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          eq(tasks.is_deleted, false),
          isNotNull(tasks.assignee_id),
        ),
      );

    // Process upcoming due date tasks
    for (const task of upcomingTasks) {
      await processNudge({
        taskId: task.id,
        orgId: task.org_id,
        targetUserId: task.assignee_id || task.created_by,
        nudgeType: 'upcoming_due',
        taskIdentifier: `${task.project_prefix}-${task.number}`,
        message: buildUpcomingDueMessage(task.project_prefix, task.number, task.due_date),
        since: twentyFourHoursAgo,
      });
    }

    // 4. Workload imbalance detection
    await checkWorkloadImbalance();

    console.log(
      `[nudge-check] Processed ${stalledTasks.length} stalled, ${overdueTasks.length} overdue, and ${upcomingTasks.length} upcoming due tasks`,
    );
  } catch (err) {
    console.error('[nudge-check] Error during nudge check:', err);
    throw err;
  }
}

interface NudgeParams {
  taskId: string;
  orgId: string;
  targetUserId: string;
  nudgeType: 'stalled' | 'overdue' | 'workload_imbalance' | 'upcoming_due';
  taskIdentifier: string;
  message: string;
  since: Date;
}

async function processNudge(params: NudgeParams): Promise<void> {
  const { taskId, orgId, targetUserId, nudgeType, taskIdentifier, message, since } = params;

  try {
    // Check if a nudge was already sent for this task in the last 24h
    const existingNudge = await db
      .select({ id: agentNudges.id })
      .from(agentNudges)
      .where(
        and(
          eq(agentNudges.task_id, taskId),
          eq(agentNudges.nudge_type, nudgeType),
          gte(agentNudges.created_at, since),
        ),
      )
      .limit(1);

    if (existingNudge.length > 0) {
      return; // Already nudged recently
    }

    // Create notification
    const [notification] = await db
      .insert(notifications)
      .values({
        org_id: orgId,
        user_id: targetUserId,
        type: 'agent_suggestion',
        title: nudgeType === 'stalled' ? 'Stalled Task' : nudgeType === 'overdue' ? 'Overdue Task' : nudgeType === 'upcoming_due' ? 'Due Soon' : 'Overdue Task',
        body: message,
        link: `/tasks?task=${taskIdentifier}`,
        metadata: { task_id: taskId, nudge_type: nudgeType },
      })
      .returning();

    // Insert nudge record
    await db.insert(agentNudges).values({
      org_id: orgId,
      user_id: targetUserId,
      task_id: taskId,
      nudge_type: nudgeType,
      message,
    });

    // Emit notification to user via Socket.io
    if (notification) {
      emitToUser(targetUserId, 'notification:new', notification);
    }

    console.log(`[nudge-check] Sent ${nudgeType} nudge for ${taskIdentifier} to user ${targetUserId}`);
  } catch (err) {
    console.error(`[nudge-check] Error processing nudge for task ${taskId}:`, err);
    // Don't throw — continue processing other tasks
  }
}

function buildStalledMessage(prefix: string, number: number, updatedAt: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - updatedAt.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return `${prefix}-${number} has been in progress for ${diffDays} day${diffDays !== 1 ? 's' : ''} with no updates`;
}

function buildUpcomingDueMessage(prefix: string, number: number, dueDate: Date | null): string {
  if (!dueDate) {
    return `${prefix}-${number} is due soon`;
  }
  const now = new Date();
  const diffMs = dueDate.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours <= 1) {
    return `${prefix}-${number} is due in less than an hour`;
  }
  if (diffHours < 24) {
    return `${prefix}-${number} is due in ${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
  }
  return `${prefix}-${number} is due tomorrow`;
}

function buildOverdueMessage(prefix: string, number: number, dueDate: Date | null): string {
  if (!dueDate) {
    return `${prefix}-${number} is overdue`;
  }
  const now = new Date();
  const diffMs = now.getTime() - dueDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return `${prefix}-${number} is overdue by ${diffDays} day${diffDays !== 1 ? 's' : ''}`;
}

async function checkWorkloadImbalance(): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    // Query open tasks grouped by assignee and org
    const workloadRows = await db
      .select({
        org_id: tasks.org_id,
        assignee_id: tasks.assignee_id,
        assignee_name: users.name,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .innerJoin(users, eq(tasks.assignee_id, users.id))
      .where(
        and(
          eq(tasks.is_deleted, false),
          sql`${tasks.assignee_id} IS NOT NULL`,
          sql`${tasks.status} IN ('todo', 'in_progress', 'in_review')`,
        ),
      )
      .groupBy(tasks.org_id, tasks.assignee_id, users.name);

    // Group by org
    const orgWorkloads = new Map<
      string,
      { assignee_id: string; assignee_name: string; count: number }[]
    >();
    for (const row of workloadRows) {
      if (!orgWorkloads.has(row.org_id)) {
        orgWorkloads.set(row.org_id, []);
      }
      orgWorkloads.get(row.org_id)!.push({
        assignee_id: row.assignee_id!,
        assignee_name: row.assignee_name,
        count: Number(row.count),
      });
    }

    for (const [orgId, members] of orgWorkloads) {
      if (members.length < 2) continue; // Need at least 2 people to compare

      const totalTasks = members.reduce((sum, m) => sum + m.count, 0);
      const avg = totalTasks / members.length;

      // Find anyone with 3x or more than average
      const overloaded = members.filter((m) => m.count >= avg * 3 && m.count >= 3);

      for (const person of overloaded) {
        // Deduplicate: check if we already sent a workload imbalance nudge for this org in the last 7 days
        const existingNudge = await db
          .select({ id: agentNudges.id })
          .from(agentNudges)
          .where(
            and(
              eq(agentNudges.org_id, orgId),
              eq(agentNudges.nudge_type, 'workload_imbalance'),
              eq(agentNudges.user_id, person.assignee_id),
              gte(agentNudges.created_at, sevenDaysAgo),
            ),
          )
          .limit(1);

        if (existingNudge.length > 0) continue;

        // Find an org owner or admin to notify
        const [orgAdmin] = await db
          .select({ user_id: orgMembers.user_id })
          .from(orgMembers)
          .where(
            and(
              eq(orgMembers.org_id, orgId),
              eq(orgMembers.is_active, true),
              sql`${orgMembers.role} IN ('owner', 'admin')`,
            ),
          )
          .limit(1);

        if (!orgAdmin) continue;

        const message = `Workload imbalance: ${person.assignee_name} has ${person.count} open tasks while the team average is ${Math.round(avg)}. Consider redistributing.`;

        // Create notification
        const [notification] = await db
          .insert(notifications)
          .values({
            org_id: orgId,
            user_id: orgAdmin.user_id,
            type: 'agent_suggestion',
            title: 'Workload Imbalance',
            body: message,
            link: '/tasks',
            metadata: {
              nudge_type: 'workload_imbalance',
              overloaded_user_id: person.assignee_id,
              task_count: person.count,
              team_average: Math.round(avg),
            },
          })
          .returning();

        // Use a dummy task_id — pick the first task of the overloaded person
        const [firstTask] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.org_id, orgId),
              eq(tasks.assignee_id, person.assignee_id),
              eq(tasks.is_deleted, false),
              sql`${tasks.status} IN ('todo', 'in_progress', 'in_review')`,
            ),
          )
          .limit(1);

        if (firstTask) {
          await db.insert(agentNudges).values({
            org_id: orgId,
            user_id: person.assignee_id,
            task_id: firstTask.id,
            nudge_type: 'workload_imbalance',
            message,
          });
        }

        if (notification) {
          emitToUser(orgAdmin.user_id, 'notification:new', notification);
        }

        console.log(
          `[nudge-check] Sent workload imbalance alert for ${person.assignee_name} in org ${orgId}`,
        );
      }
    }
  } catch (err) {
    console.error('[nudge-check] Error during workload imbalance check:', err);
    // Don't throw — this is a supplementary check
  }
}
