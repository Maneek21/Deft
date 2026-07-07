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
  taskComments,
} from '@deft/db/schema';
import { eq, and, lt, sql, gte, inArray, isNotNull } from 'drizzle-orm';
import { emitToUser } from '../../socket.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { TriggerInvocation } from './employee-trigger.js';
import { getOrgTimezone, isOverdue, isDueWithinDays } from '../../lib/task-dates.js';
import { createNotificationIfAllowed } from '../../lib/notification-policy.js';

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

// Task 3.11 — proactive agent comment on a task, authored by the given
// employee's shadow user. Dedups within 7d: we only post one agent comment
// per task per week across any proactive-comment source. Silently no-ops on
// DB errors so a failed comment never blocks the rest of the nudge pass.
const PROACTIVE_COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function buildProactiveCommentBody(
  nudgeType: 'stalled' | 'overdue' | 'workload_imbalance',
  taskIdentifier: string,
): string {
  switch (nudgeType) {
    case 'stalled':
      return `Noticed ${taskIdentifier} has been In Progress for 48h without updates — is there a blocker?`;
    case 'overdue':
      return `Heads up: ${taskIdentifier} is past its due date. Can we push it forward or replan?`;
    case 'workload_imbalance':
      return `Flagging ${taskIdentifier} — the assignee's queue looks heavy this week. Consider reassigning or deferring.`;
  }
}

export async function postProactiveAgentComment(params: {
  orgId: string;
  taskId: string;
  agentUserId: string;
  body: string;
}): Promise<void> {
  const { orgId, taskId, agentUserId, body } = params;
  try {
    const since = new Date(Date.now() - PROACTIVE_COMMENT_WINDOW_MS);
    const existing = await db
      .select({ id: taskComments.id })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.task_id, taskId),
          eq(taskComments.user_id, agentUserId),
          eq(taskComments.is_deleted, false),
          gte(taskComments.created_at, since),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    await db.insert(taskComments).values({
      org_id: orgId,
      task_id: taskId,
      user_id: agentUserId,
      content: body,
    });
  } catch (err) {
    console.error(
      `[nudge-check] Failed to post proactive comment on task ${taskId}:`,
      (err as Error).message,
    );
  }
}

export async function handleNudgeCheck(_job: JobData): Promise<void> {
  console.log('[nudge-check] Checking for overdue and stalled tasks');

  const now = new Date();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  // Widened SQL windows for tz-aware filtering: the most extreme real tz
  // offsets are ±14h, so ±1 day safely contains every task that might be
  // "overdue" or "due today" in any org's local timezone. We then filter
  // precisely in JS using isOverdue / isDueWithinDays with the org's tz.
  const fortyEightHoursFromNow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  // Memoize tz lookups per org so we don't re-query orgs.timezone for every
  // candidate task.
  const tzByOrg = new Map<string, string>();
  const getTz = async (orgId: string): Promise<string> => {
    let tz = tzByOrg.get(orgId);
    if (tz === undefined) {
      tz = await getOrgTimezone(orgId);
      tzByOrg.set(orgId, tz);
    }
    return tz;
  };

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

    // 2. Query overdue tasks: due_date < start-of-today in org-local tz. We
    //    broaden the SQL bound to (now + 24h) to cover any tz offset, then
    //    filter in JS against each org's actual timezone via isOverdue().
    const overdueCandidates = await db
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
          lt(tasks.due_date, twentyFourHoursFromNow),
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
        ),
      );
    const overdueTasks: typeof overdueCandidates = [];
    for (const t of overdueCandidates) {
      const tz = await getTz(t.org_id);
      if (isOverdue(t.due_date, tz, now)) overdueTasks.push(t);
    }

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
        // Task 3.11 — drop a proactive, agent-authored comment on the task
        // so the assignee sees the nudge in-context (not just via DM). The
        // helper dedups within 7d so repeated cron passes do not spam.
        await postProactiveAgentComment({
          orgId: task.org_id,
          taskId: task.id,
          agentUserId: subscribed.user_id,
          body: buildProactiveCommentBody(
            'stalled',
            `${task.project_prefix}-${task.number}`,
          ),
        });
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
        // Task 3.11 — proactive, in-task comment on the overdue card so
        // the assignee gets context where they work. 7d dedup via helper.
        await postProactiveAgentComment({
          orgId: task.org_id,
          taskId: task.id,
          agentUserId: subscribed.user_id,
          body: buildProactiveCommentBody(
            'overdue',
            `${task.project_prefix}-${task.number}`,
          ),
        });
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
    const notification = await createNotificationIfAllowed({
      org_id: orgId,
      user_id: targetUserId,
      type: 'agent_suggestion',
      title: nudgeType === 'stalled' ? 'Stalled Task' : nudgeType === 'overdue' ? 'Overdue Task' : nudgeType === 'upcoming_due' ? 'Due Soon' : 'Overdue Task',
      body: message,
      link: `/tasks?task=${taskIdentifier}`,
      metadata: { task_id: taskId, nudge_type: nudgeType },
    }, { channel: 'tasks' });

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

export async function checkWorkloadImbalance(): Promise<void> {
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

      if (overloaded.length === 0) continue;

      // Find ALL org owners/admins to notify (per-admin dedup below)
      const orgAdmins = await db
        .select({ user_id: orgMembers.user_id })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.org_id, orgId),
            eq(orgMembers.is_active, true),
            sql`${orgMembers.role} IN ('owner', 'admin')`,
          ),
        );

      if (orgAdmins.length === 0) continue;

      for (const person of overloaded) {
        for (const admin of orgAdmins) {
          // Dedup per (admin, overloaded_user) pair: skip if this admin has
          // already been notified about THIS overloaded user in the last 7d.
          // Key: notifications.user_id = admin, metadata.overloaded_user_id =
          // overloaded user, metadata.nudge_type = 'workload_imbalance',
          // metadata.admin_user_id = admin.
          const existingNotification = await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.org_id, orgId),
                eq(notifications.user_id, admin.user_id),
                gte(notifications.created_at, sevenDaysAgo),
                sql`${notifications.metadata}->>'nudge_type' = 'workload_imbalance'`,
                sql`${notifications.metadata}->>'overloaded_user_id' = ${person.assignee_id}`,
                sql`${notifications.metadata}->>'admin_user_id' = ${admin.user_id}`,
              ),
            )
            .limit(1);

          if (existingNotification.length > 0) continue;

          const message = `Workload imbalance: ${person.assignee_name} has ${person.count} open tasks while the team average is ${Math.round(avg)}. Consider redistributing.`;

          // Create notification — one per (admin, overloaded user) pair.
          const notification = await createNotificationIfAllowed({
            org_id: orgId,
            user_id: admin.user_id,
            type: 'agent_suggestion',
            title: 'Workload Imbalance',
            body: message,
            link: '/tasks',
            metadata: {
              nudge_type: 'workload_imbalance',
              overloaded_user_id: person.assignee_id,
              admin_user_id: admin.user_id,
              task_count: person.count,
              team_average: Math.round(avg),
            },
          }, { channel: 'tasks' });

          if (notification) {
            emitToUser(admin.user_id, 'notification:new', notification);
          }

          console.log(
            `[nudge-check] Sent workload imbalance alert for ${person.assignee_name} to admin ${admin.user_id} in org ${orgId}`,
          );
        }

        // Separately keep an agent_nudges row per overloaded user (org-wide
        // audit trail). Dedup on (org_id, user_id=overloaded, nudge_type,
        // 7d window) so we don't spam this side-channel — the admin-facing
        // notification dedup above is the load-bearing one.
        const existingNudgeRow = await db
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

        if (existingNudgeRow.length === 0) {
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
              message: `Workload imbalance: ${person.assignee_name} has ${person.count} open tasks while the team average is ${Math.round(avg)}. Consider redistributing.`,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[nudge-check] Error during workload imbalance check:', err);
    // Don't throw — this is a supplementary check
  }
}
