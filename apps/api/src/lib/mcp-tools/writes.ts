/**
 * Phase 4 — task_create, task_update, message_post MCP tools.
 *
 * All three share the same trust-gating pattern:
 *   1. getApprovalTier(toolName) → static tier
 *   2. shouldAutoExecute(toolName, ctx.trust_level) → bool
 *   3. if auto-exec: call the matching `execute*` inner function which does
 *      the actual write + cache invalidation + returns a ToolResult.
 *   4. if queued: INSERT into agent_actions with approval_status='pending' and
 *      return asPseudoResult(actionId, "...pending human review...").
 *
 * Phase 6.5 refactor: the execute* inner functions are exported so that the
 * agent-approval-resolver can re-use them when a user approves a queued
 * action. They deliberately DO NOT re-check shouldAutoExecute — that's the
 * caller's job. They also DO NOT queue on failure; any error bubbles up as
 * an error ToolResult for the resolver to stash in agent_actions.error.
 *
 * Phase 7 will wrap the write handlers with receipt generation — the hook
 * point is the end of each execute* function.
 */
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../db.js';
import {
  tasks,
  taskComments,
  messages,
  agentActions,
  agentEmployees,
  projects,
  spaces,
  spaceMembers,
  taskActivity,
  workflowRules,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import {
  shouldAutoExecute,
  getApprovalTier,
  asPseudoResult,
} from '../agent-approval.js';
import { invalidatePlatformContextCacheFor } from './context.js';
import { generateReceipt } from '../receipts.js';
import { checkReplyStorm, STORM_THRESHOLD } from '../storm-detector.js';
import { getProjectResolvedConfig } from '../project-resolved-config.js';
import { isValidTransition } from '../task-status-machine.js';
import { enqueue, QUEUE_NAMES } from '../queues.js';
import { resolveAssigneeWithMatches } from '../resolve-assignee.js';
import { createTaskBundle, type TaskBundleSubtaskInput } from '../task-bundle.js';
import { employeeCanAccessSpace } from './employee-space-access.js';

/**
 * Phase 7 — Insert an "auto-executed" agent_actions row up front so that
 * the inner execute* functions have a real action_id to attach their
 * receipt to. The row is approved+executed in the same write so the
 * action log UI sees a completed row whether or not receipt generation
 * succeeds downstream. Returns the action id or null on failure.
 */
async function insertAutoExecActionRow(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string | null> {
  try {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) return null;
    const now = new Date();
    const [row] = await db
      .insert(agentActions)
      .values({
        org_id: ctx.org_id,
        user_id: shadowUserId,
        agent_employee_id: ctx.employee_id,
        source: 'mcp',
        action: toolName,
        params: args,
        approval_tier: getApprovalTier(toolName),
        approval_status: 'approved',
        approved_at: now,
        executed_at: now,
      })
      .returning({ id: agentActions.id });
    return row?.id ?? null;
  } catch (err) {
    console.error('[writes] insertAutoExecActionRow failed:', err);
    return null;
  }
}

/**
 * Phase 7 — best-effort: stash the tool result on the agent_actions row so
 * the action log UI can surface what the auto-exec produced. Swallows errors.
 */
async function patchActionResult(
  actionId: string | null,
  result: unknown,
): Promise<void> {
  if (!actionId) return;
  try {
    await db
      .update(agentActions)
      .set({ result: result as any })
      .where(eq(agentActions.id, actionId));
  } catch (err) {
    console.error('[writes] patchActionResult failed:', err);
  }
}

const QUEUE_MESSAGE =
  'Action requires human approval. Tell the user the action is pending review and will execute asynchronously if approved.';

// ─── shared helper: insert a pending agent_actions row for a queued write ──

async function queueAction(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const shadowUserId = await getShadowUserId(ctx.employee_id);
  if (!shadowUserId) {
    return errorResult(`queueAction: no shadow user for employee ${ctx.employee_id}`);
  }
  const [row] = await db
    .insert(agentActions)
    .values({
      org_id: ctx.org_id,
      user_id: shadowUserId,
      agent_employee_id: ctx.employee_id,
      source: 'mcp',
      action: toolName,
      params: args,
      approval_tier: getApprovalTier(toolName),
      approval_status: 'pending',
    })
    .returning({ id: agentActions.id });
  if (!row?.id) return errorResult(`queueAction: insert returned no row`);
  return asPseudoResult(row.id, QUEUE_MESSAGE);
}

/** Look up agent_employees.user_id for FK-satisfying inserts. */
async function getShadowUserId(employeeId: string): Promise<string | null> {
  const [row] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  return row?.user_id ?? null;
}

// ─── cross-tenant scope guards (Phase 12 code-review fix) ─────────────────

/** Resolves a project_id only if it belongs to the caller's org. */
async function verifyProjectInOrg(
  projectId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId)))
    .limit(1);
  return !!row;
}

/** Verifies a parent message exists, is in the caller's org, and is in
 * the same space as the proposed reply (prevents cross-space thread hijack). */
async function verifyParentMessageMatches(
  parentId: string,
  spaceId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, parentId),
        eq(messages.org_id, orgId),
        eq(messages.space_id, spaceId),
      ),
    )
    .limit(1);
  return !!row;
}

/** Verifies a source message belongs to this org and is readable by the actor. */
async function verifyMessageVisibleToUser(
  messageId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, messages.space_id),
      eq(spaceMembers.user_id, userId),
    ))
    .innerJoin(spaces, and(
      eq(spaces.id, messages.space_id),
      eq(spaces.org_id, orgId),
      eq(spaces.is_archived, false),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);
  return !!row;
}

// ─── task_create ──────────────────────────────────────────────────────────

const VALID_PRIORITY = new Set(['p0', 'p1', 'p2', 'p3']);

export type TaskCreateArgs = {
  caller_employee_slug: string;
  title: string;
  description?: string;
  project_id?: string;
  space_id?: string;
  assignee_id?: string;
  assignee_name?: string;
  priority?: string;
  size?: string;
  due_date?: string;
  start_date?: string;
  estimation?: string;
  source_message_id?: string;
  subtasks?: TaskBundleSubtaskInput[];
};

/**
 * Inner executor for task_create. No trust-gating check — the caller is
 * expected to have already decided whether the action should run (either
 * via shouldAutoExecute at handler time or via user approval).
 */
export async function executeTaskCreate(
  args: TaskCreateArgs,
  ctx: ToolContext,
  opts?: {
    skipReceipt?: boolean;
    actionId?: string | null;
    sourceReaderUserId?: string | null;
  },
): Promise<ToolResult> {
  if (!args.title?.trim()) return errorResult('task_create requires title');

  try {
    // Resolve project — use provided project_id (scoped to caller org) or
    // fall back to the first project in the org.
    let projectId = args.project_id ?? null;
    if (projectId) {
      if (!(await verifyProjectInOrg(projectId, ctx.org_id))) {
        return errorResult(
          `task_create: project ${projectId} not found in caller's org`,
        );
      }
    } else {
      const [p] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.org_id, ctx.org_id), eq(projects.is_archived, false)))
        .limit(1);
      if (!p) return errorResult('task_create: no project available in org');
      projectId = p.id;
    }

    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(
        `task_create: no shadow user for employee ${ctx.employee_id}`,
      );
    }

    const priority =
      args.priority && VALID_PRIORITY.has(args.priority)
        ? (args.priority as 'p2')
        : ('p2' as const);

    if (args.source_message_id?.trim()) {
      const sourceReaderIds = [
        shadowUserId,
        opts?.sourceReaderUserId ?? null,
      ].filter((value, index, values): value is string =>
        typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
      );
      let canReadSource = false;
      for (const readerUserId of sourceReaderIds) {
        canReadSource = await verifyMessageVisibleToUser(
          args.source_message_id,
          readerUserId,
          ctx.org_id,
        );
        if (canReadSource) break;
      }
      if (!canReadSource) {
        return errorResult(
          `task_create: source_message_id ${args.source_message_id} is not readable in caller's org`,
        );
      }
    }

    let assigneeId: string | null = null;
    if (args.assignee_id?.trim()) {
      const resolved = await resolveAssigneeWithMatches(args.assignee_id, ctx.org_id);
      if (!resolved.ok) {
        return errorResult(
          `task_create: assignee_id ${args.assignee_id} not found in caller's org`,
        );
      }
      assigneeId = resolved.value.id;
    } else if (args.assignee_name?.trim()) {
      const resolved = await resolveAssigneeWithMatches(args.assignee_name, ctx.org_id);
      if (!resolved.ok) {
        if (resolved.ambiguous) {
          return errorResult(
            `task_create: ambiguous assignee "${args.assignee_name}". Matches: ${resolved.matches
              .map((m) => m.name)
              .join(', ')}`,
          );
        }
        return errorResult(
          `task_create: assignee "${args.assignee_name}" not found in caller's org`,
        );
      }
      assigneeId = resolved.value.id;
    }

    const [project] = await db
      .select({ prefix: projects.prefix, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.org_id, ctx.org_id)))
      .limit(1);
    if (!project) return errorResult('task_create: project not found');

    const bundle = await createTaskBundle({
      orgId: ctx.org_id,
      projectId,
      projectPrefix: project.prefix,
      projectName: project.name,
      createdBy: shadowUserId,
      title: args.title.trim(),
      description: args.description,
      priority,
      assigneeId,
      dueDate: args.due_date ?? null,
      startDate: args.start_date ?? null,
      estimation: args.estimation ?? args.size ?? null,
      sourceMessageId: args.source_message_id ?? null,
      actionId: opts?.actionId ?? null,
      actingAgentEmployeeId: ctx.employee_id,
      subtasks: Array.isArray(args.subtasks) ? args.subtasks : null,
    });
    const task = bundle.parent;

    try {
      const { getIO } = await import('../../socket.js');
      const io = getIO();
      if (io) {
        for (const createdTask of bundle.allTasks) {
          io.to(`org:${ctx.org_id}`).emit('task:created', {
            ...createdTask,
            project_prefix: project.prefix,
            project_name: project.name,
          });
        }
      }
    } catch {
      // Socket broadcast is best-effort in tests and headless workers.
    }

    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'duplicate-detect', {
        taskId: task.id,
        title: task.title,
        projectId,
        orgId: ctx.org_id,
      });
    } catch (err) {
      console.error('[mcp task_create] Failed to enqueue duplicate-detect:', err);
    }

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      id: task.id,
      task_id: task.id,
      project_id: task.project_id,
      number: task.number,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assignee_id: task.assignee_id,
      source_message_id: task.source_message_id,
      created_at: task.created_at,
      subtasks: bundle.subtasks,
    };

    if (!opts?.skipReceipt) {
      const actionId = await insertAutoExecActionRow(
        'task_create',
        args as Record<string, unknown>,
        ctx,
      );
      await patchActionResult(actionId, resultPayload);
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId: ctx.org_id,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'task_create',
          actionParams: args as unknown,
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`task_create failed: ${msg}`);
  }
}

/**
 * Public MCP tool handler — does the trust-gating check, then either
 * dispatches to the inner executor or queues an approval.
 */
export async function taskCreate(
  args: TaskCreateArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.title?.trim()) return errorResult('task_create requires title');

  if (!shouldAutoExecute('task_create', ctx.trust_level)) {
    return queueAction('task_create', args as Record<string, unknown>, ctx);
  }

  return executeTaskCreate(args, ctx);
}

// ─── task_update ──────────────────────────────────────────────────────────

const VALID_STATUS = new Set([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]);

export type TaskUpdateArgs = {
  caller_employee_slug: string;
  task_id: string;
  patch: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    assignee_id?: string | null;
    due_date?: string | null;
    comment?: string;
  };
};

function parseDueDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

/** Inner executor for task_update. No trust-gating. */
export async function executeTaskUpdate(
  args: TaskUpdateArgs,
  ctx: ToolContext,
  opts?: { skipReceipt?: boolean; actionId?: string | null },
): Promise<ToolResult> {
  if (!args.task_id) return errorResult('task_update requires task_id');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('task_update requires a non-empty patch');
  }

  try {
    const patch = args.patch;
    const update: Record<string, unknown> = {};
    let createdCommentId: string | null = null;
    const activityEntries: {
      action: string;
      field: string;
      old_value: string | null;
      new_value: string | null;
    }[] = [];

    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(
        `task_update: no shadow user for employee ${ctx.employee_id}`,
      );
    }

    const [existingTask] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, args.task_id), eq(tasks.org_id, ctx.org_id)))
      .limit(1);

    if (!existingTask) {
      return errorResult(`task_update: task ${args.task_id} not found`);
    }

    if (typeof patch.title === 'string') update.title = patch.title;
    if (typeof patch.description === 'string') update.description = patch.description;
    if (patch.status && VALID_STATUS.has(patch.status)) {
      if (patch.status !== existingTask.status) {
        const resolvedConfig = await getProjectResolvedConfig(existingTask.project_id);
        if (!isValidTransition(existingTask.status, patch.status, resolvedConfig)) {
          return errorResult('task_update: invalid status transition');
        }
        update.status = patch.status;
        activityEntries.push({
          action: 'status_changed',
          field: 'status',
          old_value: existingTask.status,
          new_value: patch.status,
        });
      }
    }
    if (patch.priority && VALID_PRIORITY.has(patch.priority)) {
      if (patch.priority !== existingTask.priority) {
        update.priority = patch.priority;
        activityEntries.push({
          action: 'priority_changed',
          field: 'priority',
          old_value: existingTask.priority,
          new_value: patch.priority,
        });
      }
    }
    if (patch.assignee_id !== undefined) {
      const assigneeId = patch.assignee_id || null;
      if (assigneeId) {
        const resolved = await resolveAssigneeWithMatches(assigneeId, ctx.org_id);
        if (!resolved.ok) {
          return errorResult(
            `task_update: assignee_id ${assigneeId} not found in caller's org`,
          );
        }
      }
      if (assigneeId !== existingTask.assignee_id) {
        update.assignee_id = assigneeId;
        activityEntries.push({
          action: 'assigned',
          field: 'assignee_id',
          old_value: existingTask.assignee_id ?? null,
          new_value: assigneeId,
        });
      }
    }
    if (patch.due_date !== undefined) {
      const dueDate = parseDueDate(patch.due_date);
      if (dueDate === undefined) {
        return errorResult(`task_update: invalid due_date ${patch.due_date}`);
      }
      const oldDue = existingTask.due_date?.toISOString() ?? null;
      const newDue = dueDate?.toISOString() ?? null;
      if (oldDue !== newDue) {
        update.due_date = dueDate;
        activityEntries.push({
          action: 'due_date_changed',
          field: 'due_date',
          old_value: oldDue,
          new_value: newDue,
        });
      }
    }
    if (typeof patch.title === 'string' && patch.title !== existingTask.title) {
      activityEntries.push({
        action: 'title_changed',
        field: 'title',
        old_value: existingTask.title,
        new_value: patch.title,
      });
    }
    if (
      typeof patch.description === 'string' &&
      patch.description !== (existingTask.description ?? '')
    ) {
      activityEntries.push({
        action: 'description_changed',
        field: 'description',
        old_value: existingTask.description ?? null,
        new_value: patch.description,
      });
    }

    if (Object.keys(update).length === 0) {
      const comment = typeof patch.comment === 'string' ? patch.comment.trim() : '';
      if (!comment) {
        return errorResult('task_update: no valid fields in patch');
      }
    }

    const [row] = Object.keys(update).length > 0
      ? await db
        .update(tasks)
        .set(update)
        .where(and(eq(tasks.id, args.task_id), eq(tasks.org_id, ctx.org_id)))
        .returning()
      : [existingTask];

    if (!row) return errorResult(`task_update: task ${args.task_id} not found`);

    const comment = typeof patch.comment === 'string' ? patch.comment.trim() : '';
    if (comment) {
      const [commentRow] = await db
        .insert(taskComments)
        .values({
          org_id: ctx.org_id,
          task_id: args.task_id,
          user_id: shadowUserId,
          content: comment,
        })
        .returning({ id: taskComments.id });
      createdCommentId = commentRow?.id ?? null;
      activityEntries.push({
        action: 'commented',
        field: 'comment',
        old_value: null,
        new_value: createdCommentId,
      });
    }

    if (activityEntries.length > 0) {
      await db.insert(taskActivity).values(
        activityEntries.map((entry) => ({
          org_id: ctx.org_id,
          task_id: args.task_id,
          user_id: shadowUserId,
          action: entry.action,
          field: entry.field,
          old_value: entry.old_value,
          new_value: entry.new_value,
          agent_action_id: opts?.actionId ?? null,
          acting_agent_employee_id: ctx.employee_id,
        })),
      );
    }

    if (update.status && update.status !== existingTask.status) {
      try {
        const matchingRules = await db
          .select({ id: workflowRules.id, trigger_config: workflowRules.trigger_config })
          .from(workflowRules)
          .where(and(
            eq(workflowRules.org_id, ctx.org_id),
            eq(workflowRules.trigger_type, 'task.status_changed'),
            eq(workflowRules.is_active, true),
          ));

        for (const rule of matchingRules) {
          const cfg = (rule.trigger_config ?? {}) as Record<string, unknown>;
          const toStatus = (cfg as any).to_status;
          if (toStatus && toStatus !== update.status) continue;
          await enqueue(QUEUE_NAMES.AGENT_JOBS, 'workflow-execute', {
            workflow_id: rule.id,
            task_id: args.task_id,
            actor_user_id: shadowUserId,
          });
        }
      } catch (err) {
        console.error('[mcp task_update] Failed to enqueue workflow-execute:', (err as Error).message);
      }

      try {
        const { getIO } = await import('../../socket.js');
        const [project] = await db
          .select({ prefix: projects.prefix, name: projects.name })
          .from(projects)
          .where(eq(projects.id, row.project_id))
          .limit(1);
        const io = getIO();
        if (io) {
          io.to(`org:${ctx.org_id}`).emit('task:updated', {
            ...row,
            project_prefix: project?.prefix,
            project_name: project?.name,
          });
        }
      } catch {
        // Socket broadcast is best-effort in tests and headless workers.
      }
    }

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assignee_id: row.assignee_id,
      due_date: row.due_date,
      comment_id: createdCommentId,
      updated_at: row.updated_at,
    };

    if (!opts?.skipReceipt) {
      const actionId = await insertAutoExecActionRow(
        'task_update',
        args as Record<string, unknown>,
        ctx,
      );
      await patchActionResult(actionId, resultPayload);
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId: ctx.org_id,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'task_update',
          actionParams: args as unknown,
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`task_update failed: ${msg}`);
  }
}

// Trust-gating verified by apps/api/test/task-update-trust.test.ts
export async function taskUpdate(
  args: TaskUpdateArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.task_id) return errorResult('task_update requires task_id');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('task_update requires a non-empty patch');
  }

  if (!shouldAutoExecute('task_update', ctx.trust_level)) {
    return queueAction('task_update', args as Record<string, unknown>, ctx);
  }

  return executeTaskUpdate(args, ctx);
}

// ─── message_post ─────────────────────────────────────────────────────────

export type MessagePostArgs = {
  caller_employee_slug: string;
  space_id: string;
  content: string;
  parent_id?: string;
};

/** Inner executor for message_post. No trust-gating. */
export async function executeMessagePost(
  args: MessagePostArgs,
  ctx: ToolContext,
  opts?: { skipReceipt?: boolean },
): Promise<ToolResult> {
  if (!args.space_id) return errorResult('message_post requires space_id');
  if (!args.content?.trim()) return errorResult('message_post requires content');

  try {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(
        `message_post: no shadow user for employee ${ctx.employee_id}`,
      );
    }

    if (!(await employeeCanAccessSpace(ctx.employee_id, ctx.org_id, args.space_id))) {
      return errorResult(
        `message_post: space ${args.space_id} is not accessible to this employee`,
      );
    }
    if (args.parent_id) {
      if (
        !(await verifyParentMessageMatches(
          args.parent_id,
          args.space_id,
          ctx.org_id,
        ))
      ) {
        return errorResult(
          `message_post: parent ${args.parent_id} is not in space ${args.space_id}`,
        );
      }
    }

    const [row] = await db
      .insert(messages)
      .values({
        org_id: ctx.org_id,
        space_id: args.space_id,
        user_id: shadowUserId,
        content: args.content,
        parent_id: args.parent_id ?? null,
      })
      .returning();

    // Best-effort broadcast. Socket.io might not be initialized in tests.
    try {
      const { getIO } = await import('../../socket.js');
      const io = getIO();
      if (io) {
        io.to(`space:${args.space_id}`).emit('message:new', row);
      }
    } catch {
      // swallow — broadcast must not roll back the write.
    }

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      id: row!.id,
      space_id: row!.space_id,
      user_id: row!.user_id,
      content: row!.content,
      parent_id: row!.parent_id,
      created_at: row!.created_at,
    };

    if (!opts?.skipReceipt) {
      const actionId = await insertAutoExecActionRow(
        'message_post',
        args as Record<string, unknown>,
        ctx,
      );
      await patchActionResult(actionId, resultPayload);
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId: ctx.org_id,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'message_post',
          actionParams: args as unknown,
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`message_post failed: ${msg}`);
  }
}

export async function messagePost(
  args: MessagePostArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  console.warn('[mcp] message_post is deprecated; use send_message');
  if (!args.space_id) return errorResult('message_post requires space_id');
  if (!args.content?.trim()) return errorResult('message_post requires content');

  if (!shouldAutoExecute('message_post', ctx.trust_level)) {
    return queueAction('message_post', args as Record<string, unknown>, ctx);
  }

  return executeMessagePost(args, ctx);
}

// ─── send_message (Phase 3 unified tool) ─────────────────────────────────

export type SendMessageTarget =
  | { space_id: string }
  | { thread_id: string }
  | { user_id: string };

export type SendMessageArgs = {
  caller_employee_slug: string;
  target?: SendMessageTarget;
  space_id?: string;
  thread_id?: string;
  user_id?: string;
  content: string;
};

/**
 * Phase 3 of agent-chat unification — unified message-send tool.
 * Target is one of:
 *   - { space_id }   — post in an existing space
 *   - { thread_id }  — reply in a thread (parent message id)
 *   - { user_id }    — DM target user; creates DM space if missing
 *
 * Tier 'full': queued for approval unless caller's trust is autonomous.
 */
export async function sendMessage(
  args: SendMessageArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.content?.trim()) return errorResult('send_message requires content');

  const { content } = args;
  const target = args.target
    ?? (args.space_id ? { space_id: args.space_id } : null)
    ?? (args.thread_id ? { thread_id: args.thread_id } : null)
    ?? (args.user_id ? { user_id: args.user_id } : null);
  if (!target) {
    return errorResult('send_message: target must include space_id, thread_id, or user_id');
  }

  // Resolve target → { spaceId, parentId? } so the rest is uniform.
  let spaceId: string;
  let parentId: string | null = null;

  if ('space_id' in target) {
    spaceId = target.space_id;
  } else if ('thread_id' in target) {
    const [parent] = await db
      .select({ id: messages.id, space_id: messages.space_id })
      .from(messages)
      .where(and(eq(messages.id, target.thread_id), eq(messages.org_id, ctx.org_id)))
      .limit(1);
    if (!parent) {
      return errorResult('send_message: thread_id not found');
    }
    spaceId = parent.space_id;
    parentId = parent.id;

    // Phase 6 — reply-storm guard.
    const callerShadowId = await getShadowUserId(ctx.employee_id);
    if (callerShadowId) {
      const storm = await checkReplyStorm(callerShadowId, parent.id);
      if (storm.tripped) {
        return errorResult(
          `STORM_DETECTED: agent exceeded ${STORM_THRESHOLD} replies in this thread within the rate-limit window; backing off`,
        );
      }
    }
  } else if ('user_id' in target) {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(`send_message: no shadow user for employee ${ctx.employee_id}`);
    }
    spaceId = await findOrCreateDmSpace(ctx.org_id, shadowUserId, target.user_id);
  } else {
    return errorResult('send_message: target must include space_id, thread_id, or user_id');
  }

  // Org-scope guard
  if (!(await employeeCanAccessSpace(ctx.employee_id, ctx.org_id, spaceId))) {
    return errorResult(`send_message: space ${spaceId} is not accessible to this employee`);
  }

  if (!shouldAutoExecute('send_message', ctx.trust_level)) {
    return queueAction(
      'send_message',
      { ...args, resolved_space_id: spaceId, parent_id: parentId } as Record<string, unknown>,
      ctx,
    );
  }

  return executeSendMessage({ orgId: ctx.org_id, spaceId, content, parentId, ctx });
}

export async function executeSendMessage(opts: {
  orgId: string;
  spaceId: string;
  content: string;
  parentId: string | null;
  ctx: ToolContext;
}, execOpts?: { skipReceipt?: boolean }): Promise<ToolResult> {
  const { orgId, spaceId, content, parentId, ctx } = opts;
  try {
    if (!(await employeeCanAccessSpace(ctx.employee_id, orgId, spaceId))) {
      return errorResult(`send_message: space ${spaceId} is not accessible to this employee`);
    }

    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(`send_message: no shadow user for employee ${ctx.employee_id}`);
    }

    const [row] = await db
      .insert(messages)
      .values({
        org_id: orgId,
        space_id: spaceId,
        user_id: shadowUserId,
        content,
        parent_id: parentId,
      })
      .returning();

    // Best-effort broadcast. Socket.io might not be initialized in tests.
    try {
      const { getIO } = await import('../../socket.js');
      const io = getIO();
      if (io && row) {
        io.to(`space:${spaceId}`).emit('message:new', row);
      }
    } catch {
      // swallow — broadcast must not roll back the write.
    }

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      message_id: row!.id,
      space_id: row!.space_id,
      user_id: row!.user_id,
      content: row!.content,
      parent_id: row!.parent_id,
      created_at: row!.created_at,
    };

    if (!execOpts?.skipReceipt) {
      const actionId = await insertAutoExecActionRow(
        'send_message',
        { space_id: spaceId, content, parent_id: parentId } as Record<string, unknown>,
        ctx,
      );
      await patchActionResult(actionId, resultPayload);
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'send_message',
          actionParams: { space_id: spaceId, content, parent_id: parentId },
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`send_message failed: ${msg}`);
  }
}

/**
 * Find an existing 1:1 DM space between two users in the same org,
 * or create one if it doesn't exist.
 */
async function findOrCreateDmSpace(
  orgId: string,
  userIdA: string,
  userIdB: string,
): Promise<string> {
  const existing = await db.execute(sql`
    SELECT s.id FROM spaces s
    WHERE s.org_id = ${orgId}
      AND s.type = 'dm'
      AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${userIdA})
      AND EXISTS (SELECT 1 FROM space_members WHERE space_id = s.id AND user_id = ${userIdB})
      AND (SELECT COUNT(*) FROM space_members WHERE space_id = s.id) = 2
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    return (existing.rows[0] as { id: string }).id;
  }

  const [space] = await db
    .insert(spaces)
    .values({
      org_id: orgId,
      name: 'DM',
      type: 'dm',
      created_by: userIdA,
    })
    .returning();
  await db
    .insert(spaceMembers)
    .values([
      { space_id: space!.id, user_id: userIdA },
      { space_id: space!.id, user_id: userIdB },
    ])
    .onConflictDoNothing();
  return space!.id;
}
