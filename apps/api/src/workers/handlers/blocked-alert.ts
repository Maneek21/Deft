// Handler: detect blocked users and alert project leads
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  tasks,
  projects,
  users,
  spaces,
  notifications,
  agentNudges,
  taskRelationships,
  agentActions,
} from '@deft/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { emitToUser } from '../../socket.js';

export async function handleBlockedAlert(job: JobData): Promise<void> {
  const { messageId, spaceId, content, orgId, userId } = job.data;
  console.log('[blocked-alert] Processing blocked signal from user', userId);

  const now = new Date();
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

  try {
    // Deduplicate: don't alert for the same user+space within 4 hours
    const existingNudge = await db
      .select({ id: agentNudges.id })
      .from(agentNudges)
      .where(
        and(
          eq(agentNudges.user_id, userId),
          eq(agentNudges.nudge_type, 'blocked'),
          gte(agentNudges.created_at, fourHoursAgo),
        ),
      )
      .limit(1);

    if (existingNudge.length > 0) {
      console.log('[blocked-alert] Skipped — already alerted for this user within 4h');
      return;
    }

    // Get the user's name
    const [blockedUser] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const userName = blockedUser?.name || 'Someone';

    // Get the space name for context
    const [space] = await db
      .select({ name: spaces.name })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);

    const spaceName = space?.name || 'unknown';

    // Find tasks assigned to this user that are in_progress
    const userTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        number: tasks.number,
        project_id: tasks.project_id,
        project_prefix: projects.prefix,
        project_lead_id: projects.lead_id,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.assignee_id, userId),
          eq(tasks.status, 'in_progress'),
          eq(tasks.is_deleted, false),
        ),
      );

    // Block 2.4 — queue a draft task_create proposal so the user can
    // one-click approve "Yes, track this as a task" from the approval
    // inbox. Independent of the lead-notification path below so it
    // still fires for users with no in-progress tasks.
    try {
      const draftSnippet = content.length > 80 ? content.slice(0, 80) + '…' : content;
      await db.insert(agentActions).values({
        org_id: orgId,
        user_id: userId,
        action: 'create_task',
        message_id: messageId,
        params: {
          title: `Blocker: ${draftSnippet}`,
          description: content,
          source_message_id: messageId,
          source_space_id: spaceId,
        } as any,
        approval_tier: 'quick',
        approval_status: 'pending',
        source: 'blocked_classifier',
      });
      console.log(`[blocked-alert] Queued create_task proposal for ${userId}`);
    } catch (err) {
      console.warn('[blocked-alert] failed to queue task-create proposal:', err);
    }

    if (userTasks.length === 0) {
      console.log('[blocked-alert] No in-progress tasks for blocked user, skipping');
      return;
    }

    // Truncate content for notification body
    const contentSnippet =
      content.length > 120 ? content.slice(0, 120) + '...' : content;

    for (const task of userTasks) {
      const taskIdentifier = `${task.project_prefix}-${task.number}`;

      // Find blocking dependencies (tasks that block this one)
      const blockingDeps = await db
        .select({
          id: taskRelationships.id,
          source_task_id: taskRelationships.source_task_id,
        })
        .from(taskRelationships)
        .where(
          and(
            eq(taskRelationships.target_task_id, task.id),
            eq(taskRelationships.type, 'blocks'),
          ),
        );

      // Determine who to notify: the project lead
      const targetUserId = task.project_lead_id;
      if (!targetUserId || targetUserId === userId) {
        continue; // Don't notify the blocked person themselves
      }

      const message = `${userName} may be blocked — '${contentSnippet}' (in #${spaceName})`;

      // Create notification
      const [notification] = await db
        .insert(notifications)
        .values({
          org_id: orgId,
          user_id: targetUserId,
          type: 'agent_suggestion',
          title: 'Blocked Team Member',
          body: message,
          link: `/spaces/${spaceId}?message=${messageId}`,
          metadata: {
            task_id: task.id,
            nudge_type: 'blocked',
            blocking_deps: blockingDeps.map((d) => d.source_task_id),
          },
        })
        .returning();

      // Insert nudge record for deduplication
      await db.insert(agentNudges).values({
        org_id: orgId,
        user_id: userId,
        task_id: task.id,
        nudge_type: 'blocked',
        message,
      });

      // Emit notification in real time
      if (notification) {
        emitToUser(targetUserId, 'notification:new', notification);
      }

      console.log(
        `[blocked-alert] Sent blocked alert for ${taskIdentifier} to lead ${targetUserId}`,
      );

      // Only send one notification per blocked signal (avoid spam)
      break;
    }
  } catch (err) {
    console.error('[blocked-alert] Error processing blocked alert:', err);
    throw err;
  }
}
