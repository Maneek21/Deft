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
  messages,
  agentActions,
  agentEmployees,
  projects,
  spaces,
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

/** Resolves a space_id only if it belongs to the caller's org. */
async function verifySpaceInOrg(
  spaceId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId)))
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

// ─── task_create ──────────────────────────────────────────────────────────

const VALID_PRIORITY = new Set(['p0', 'p1', 'p2', 'p3']);

export type TaskCreateArgs = {
  caller_employee_slug: string;
  title: string;
  description?: string;
  project_id?: string;
  space_id?: string;
  assignee_id?: string;
  priority?: string;
  size?: string;
};

/**
 * Inner executor for task_create. No trust-gating check — the caller is
 * expected to have already decided whether the action should run (either
 * via shouldAutoExecute at handler time or via user approval).
 */
export async function executeTaskCreate(
  args: TaskCreateArgs,
  ctx: ToolContext,
  opts?: { skipReceipt?: boolean },
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

    // Atomically bump the project's task_counter and use it as the task
    // number. Counter UPDATE is also org-scoped as defence-in-depth.
    const counterRow = await db.execute(
      sql`UPDATE projects SET task_counter = task_counter + 1
          WHERE id = ${projectId} AND org_id = ${ctx.org_id} RETURNING task_counter`,
    );
    const rawRows = (counterRow as { rows?: unknown[] }).rows ?? (counterRow as unknown as unknown[]);
    const first = (rawRows as Array<Record<string, unknown>>)[0];
    if (!first) return errorResult('task_create: project counter update failed');
    const taskNumber = Number(first.task_counter);

    const [task] = await db
      .insert(tasks)
      .values({
        org_id: ctx.org_id,
        project_id: projectId,
        number: taskNumber,
        title: args.title.trim(),
        description: args.description ?? null,
        priority,
        assignee_id: args.assignee_id ?? null,
        created_by: shadowUserId,
      })
      .returning();

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      id: task!.id,
      project_id: task!.project_id,
      number: task!.number,
      title: task!.title,
      status: task!.status,
      priority: task!.priority,
      assignee_id: task!.assignee_id,
      created_at: task!.created_at,
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
  };
};

/** Inner executor for task_update. No trust-gating. */
export async function executeTaskUpdate(
  args: TaskUpdateArgs,
  ctx: ToolContext,
  opts?: { skipReceipt?: boolean },
): Promise<ToolResult> {
  if (!args.task_id) return errorResult('task_update requires task_id');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('task_update requires a non-empty patch');
  }

  try {
    const patch = args.patch;
    const update: Record<string, unknown> = {};
    if (typeof patch.title === 'string') update.title = patch.title;
    if (typeof patch.description === 'string') update.description = patch.description;
    if (patch.status && VALID_STATUS.has(patch.status)) update.status = patch.status;
    if (patch.priority && VALID_PRIORITY.has(patch.priority)) update.priority = patch.priority;
    if (patch.assignee_id !== undefined) update.assignee_id = patch.assignee_id;

    if (Object.keys(update).length === 0) {
      return errorResult('task_update: no valid fields in patch');
    }

    const [row] = await db
      .update(tasks)
      .set(update)
      .where(and(eq(tasks.id, args.task_id), eq(tasks.org_id, ctx.org_id)))
      .returning();

    if (!row) return errorResult(`task_update: task ${args.task_id} not found`);

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assignee_id: row.assignee_id,
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

    if (!(await verifySpaceInOrg(args.space_id, ctx.org_id))) {
      return errorResult(
        `message_post: space ${args.space_id} not found in caller's org`,
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
  if (!args.space_id) return errorResult('message_post requires space_id');
  if (!args.content?.trim()) return errorResult('message_post requires content');

  if (!shouldAutoExecute('message_post', ctx.trust_level)) {
    return queueAction('message_post', args as Record<string, unknown>, ctx);
  }

  return executeMessagePost(args, ctx);
}
