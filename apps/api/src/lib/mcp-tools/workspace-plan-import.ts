import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentActions, agentEmployees } from '@deft/db/schema';
import { db } from '../db.js';
import {
  compileMessageWorkspacePlanImport,
  sanitizeWorkspacePlanImportParams,
  WORKSPACE_PLAN_IMPORT_ACTION,
} from '../workspace-plan-import.js';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

export type WorkspacePlanImportArgs = {
  caller_employee_slug: string;
  message_id: string;
  attachment_id?: string;
};

export async function workspacePlanImport(
  args: WorkspacePlanImportArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.message_id?.trim()) return errorResult('workspace_plan_import requires message_id');
  const [employee] = await db.select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.id, ctx.employee_id),
      eq(agentEmployees.org_id, ctx.org_id),
      eq(agentEmployees.is_active, true),
      eq(agentEmployees.is_deleted, false),
    ))
    .limit(1);
  if (!employee) return errorResult('workspace_plan_import: employee is inactive or unavailable');

  const draft = await compileMessageWorkspacePlanImport({
    orgId: ctx.org_id,
    actorUserId: employee.user_id,
    messageId: args.message_id.trim(),
    promptContent: 'Import this attached workspace plan into projects and tasks.',
    attachmentId: args.attachment_id?.trim() || undefined,
    employeeId: ctx.employee_id,
    force: true,
  });
  if (!draft || draft.clarification || draft.actions.length !== 1) {
    return errorResult(`workspace_plan_import: ${draft?.clarification ?? 'could not prepare a reviewed plan'}`);
  }
  const proposal = draft.actions[0]!;
  const idempotencyKey = String(proposal.params.idempotency_key ?? '');
  if (!idempotencyKey) return errorResult('workspace_plan_import: preview idempotency key is unavailable');

  const queued = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.org_id}:${ctx.employee_id}:${idempotencyKey}`}, 0))`);
    const [existing] = await tx.select({
      id: agentActions.id,
      approval_status: agentActions.approval_status,
    }).from(agentActions).where(and(
      eq(agentActions.org_id, ctx.org_id),
      eq(agentActions.agent_employee_id, ctx.employee_id),
      eq(agentActions.action, WORKSPACE_PLAN_IMPORT_ACTION),
      inArray(agentActions.approval_status, ['pending', 'approved']),
      sql`${agentActions.params}->>'idempotency_key' = ${idempotencyKey}`,
    )).limit(1);
    if (existing) return { ...existing, idempotent: true };

    const [created] = await tx.insert(agentActions).values({
      org_id: ctx.org_id,
      user_id: employee.user_id,
      agent_employee_id: ctx.employee_id,
      channel_event_id: ctx.channel_event_id,
      runtime_request_key: ctx.runtime_request_key,
      source: 'mcp',
      action: WORKSPACE_PLAN_IMPORT_ACTION,
      params: proposal.params,
      approval_tier: 'full',
      approval_status: 'pending',
    }).returning({ id: agentActions.id, approval_status: agentActions.approval_status });
    if (!created) throw new Error('pending action insert returned no row');
    return { ...created, idempotent: false };
  });

  return textResult({
    status: queued.approval_status,
    action_id: queued.id,
    idempotent: queued.idempotent,
    message: queued.approval_status === 'approved'
      ? 'This exact workspace plan was already approved.'
      : 'Workspace plan preview is pending full human review. No project or task has been created yet.',
    summary: draft.summary,
    preview: sanitizeWorkspacePlanImportParams(proposal.params),
  });
}
