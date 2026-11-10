import {visibleCaptureActionSql} from '../lib/agent-action-visibility.js';
import type { AppRunTransaction } from '../lib/app-run-repository.js';
import { reconcileApprovalReplyText } from '../lib/agent-approval-copy.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppRunError } from '../lib/app-run-errors.js';
import { getModuleInstallation, getModuleRecord, humanModuleActor, listModuleRecordReferences } from '../lib/module-service.js';
import { parseModuleRecordResourceId } from '@deft/shared/modules';
import { appHttpFailure } from './app-http-errors.js';
import { randomUUID } from 'node:crypto';
import { eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentActions,
  appRuns,
  appNativeBindings,
  appRuntimeBindings,
  appRuntimeRegistrations,
  appVersions,
  agentActionApprovers,
  agentEmployees,
  actionReceipts,
  orgs,
  orgMembers,
  tasks,
  projects,
  messages,
  taskActivity,
  users,
  spaces,
  spaceMembers,
} from '@deft/db/schema';
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { DEFTY_EMAIL, DEFTY_SYSTEM_RUNTIME_KIND } from '../lib/defty-identity.js';
import { ensureAgentConversationSpace } from '../lib/ensure-agent-conversation-space.js';
import {
  executeAction,
  isModuleTaskLinkWriteAction,
  resolveTaskIdentifier,
  sanitizeModuleTaskLinkActionParamsForHistory,
} from '../lib/agent-actions.js';
import { logAuditEvent } from '../lib/audit.js';
import {
  approveAction as resolveApproveAction,
  isApprovalResolverAction,
  rejectAction as resolveRejectAction,
  sanitizeModuleActionParamsForReceipt,
  hasHumanMcpBulkProvenance,
} from '../lib/agent-approval-resolver.js';
import { generateReceipt } from '../lib/receipts.js';
import {
  markWorkIntentConvertedForAction,
  markWorkIntentDismissedForAction,
  markWorkIntentFailedForAction,
} from '../lib/work-intents.js';
import { getIO } from '../socket.js';
import { formatApprovalConfirmation } from '../lib/agent-action-confirmation.js';
import { recordActionApproverDecision, resolveAttentionBySource } from '../lib/attention.js';
import {
  isModuleWriteActionName,
  visibleModuleActionSql,
} from '../lib/module-action-visibility.js';
import { visibleTaskCondition } from '../lib/task-visibility.js';
import { sanitizeAgentMetadataForStorage } from '../lib/module-agent-history.js';
import {
  durableAgentActionResult,
  durableAgentActionResultHistoryText,
} from '../lib/agent-tool-result.js';
import {
  isModuleRecordBulkCreateAction,
  sanitizeModuleBulkCreateParamsForHistory,
} from '../lib/module-record-bulk-create.js';
import {
  sanitizeWorkspacePlanImportParams,
  WORKSPACE_PLAN_IMPORT_ACTION,
} from '../lib/workspace-plan-import.js';
import {
  DOCUMENT_SEND_ACTION,
  sanitizeDocumentSendParams,
} from '../lib/document-send.js';

export const agentRoutes = new Hono();

async function maybePostApprovalConfirmation(params: {
  orgId: string;
  actionMessageId: string | null;
  actorUserId: string;
}) {
  if (!params.actionMessageId) return;
  const actionMessageId = params.actionMessageId;
  const posted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`approval-confirmation:${params.orgId}:${actionMessageId}`}, 0
    ))`);
    const [approvalMessage] = await tx
      .select({
        id: messages.id,
        space_id: messages.space_id,
        parent_id: messages.parent_id,
        user_id: messages.user_id,
        content: messages.content,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(and(
        eq(messages.id, actionMessageId),
        eq(messages.org_id, params.orgId),
        eq(messages.is_deleted, false),
      ))
      .limit(1);
    if (!approvalMessage) return null;

    const [existingConfirmation] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.org_id, params.orgId),
        eq(messages.space_id, approvalMessage.space_id),
        sql`${messages.metadata}->>'approval_confirmation_for_message_id' = ${actionMessageId}`,
      ))
      .limit(1);
    if (existingConfirmation) return null;

    const siblingActions = await tx
      .select()
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, params.orgId),
        eq(agentActions.message_id, actionMessageId),
      ))
      .orderBy(asc(agentActions.created_at));
    if (siblingActions.length === 0) return null;
    if (siblingActions.some((row) => row.approval_status === 'pending')) return null;

    const approvedActions = siblingActions.filter((row) => row.approval_status === 'approved');
    const rejectedActions = siblingActions.filter((row) => row.approval_status === 'rejected');
    if (approvedActions.length === 0 && rejectedActions.length === 0) return null;

    // Most approved actions execute synchronously, so approval alone is not a
    // settled group outcome. App Runs are the deliberate exception: approval
    // durably releases an asynchronous run, and their safe result records that
    // release even though the provider attempt has not executed yet.
    const releasedAppActions = approvedActions.filter((row) => (
      row.action === 'app_run_invoke'
      && row.executed_at === null
      && row.result !== null
      && typeof row.result === 'object'
      && !Array.isArray(row.result)
      && (row.result as Record<string, unknown>).execution_released === true
    ));
    const releasedAppActionIds = new Set(releasedAppActions.map((row) => row.id));
    if (approvedActions.some((row) => (
      row.executed_at === null && !releasedAppActionIds.has(row.id)
    ))) return null;

    const rejectedCountSummary = `${rejectedActions.length} proposed action${rejectedActions.length === 1 ? '' : 's'}`;
    const rejectedDetails = rejectedActions.length === 0
      ? ''
      : `\n${rejectedActions.map((row) => `- ${rejectedActionLabel(row)}.`).join('\n')}`;
    const rejectedSummary = rejectedActions.length === 0
      ? ''
      : `Rejected ${rejectedCountSummary}.${rejectedDetails}`;
    const executedApprovedActions = approvedActions.filter((row) => row.executed_at !== null);
    const releasedAppSummary = releasedAppActions.length === 0
      ? ''
      : releasedAppActions.length === 1
        ? 'Approved the app action and queued it for execution.'
        : `Approved ${releasedAppActions.length} app actions and queued them for execution.`;
    const approvedSummary = [
      executedApprovedActions.length > 0 ? formatApprovalConfirmation(executedApprovedActions) : '',
      releasedAppSummary,
    ].filter(Boolean).join('\n');
    const content = approvedActions.length === 0
      ? `Done - rejected ${rejectedCountSummary}.${rejectedDetails}`
      : [approvedSummary, rejectedSummary].filter(Boolean).join('\n');
    const proposingEmployeeId = siblingActions.find((row) => row.agent_employee_id)?.agent_employee_id;
    const [proposingEmployee] = proposingEmployeeId
      ? await tx
          .select({ user_id: agentEmployees.user_id })
          .from(agentEmployees)
          .where(and(
            eq(agentEmployees.id, proposingEmployeeId),
            eq(agentEmployees.org_id, params.orgId),
          ))
          .limit(1)
      : [];
    const confirmationAuthorId = proposingEmployee?.user_id
      ?? approvalMessage.user_id
      ?? params.actorUserId;
    const [actor] = await tx
      .select({ name: users.name, avatar_url: users.avatar_url })
      .from(users)
      .where(eq(users.id, confirmationAuthorId))
      .limit(1);
    const [confirmation] = await tx
      .insert(messages)
      .values({
        org_id: params.orgId,
        space_id: approvalMessage.space_id,
        user_id: confirmationAuthorId,
        content,
        parent_id: approvalMessage.parent_id ?? null,
        metadata: {
          is_agent_reply: true,
          subtype: 'approval_confirmation',
          approval_confirmation_for_message_id: actionMessageId,
          confirmed_action_ids: approvedActions.map((row) => row.id),
          rejected_action_ids: rejectedActions.map((row) => row.id),
          requested_by_user_id: params.actorUserId,
        } as any,
      })
      .returning();
    const originalMetadata = (approvalMessage.metadata ?? {}) as Record<string, unknown>;
    const [canonicalDeftyAuthor] = !proposingEmployeeId
      ? await tx.select({ id: users.id }).from(users).where(and(
          eq(users.id, approvalMessage.user_id), eq(users.email, DEFTY_EMAIL),
          eq(users.kind, 'agent'), eq(users.is_agent, true),
        )).limit(1)
      : [];
    // Only reconcile an agent's own proposal. A human request can also be the
    // action source; its body and metadata belong to that human unchanged.
    const canReconcileSource = proposingEmployee?.user_id === approvalMessage.user_id
      || Boolean(canonicalDeftyAuthor);
    if (!canReconcileSource) return { confirmation, approvalMessage, actor, reconciledMessage: undefined };
    // Strip the now-stale approval-prompt prose from the proposal, but do not
    // append the outcome: the separate confirmation message below is the
    // canonical "Done" summary, and repeating it here rendered the summary
    // twice in the thread after the last card was approved.
    // A proposal made only of approval prose would be left empty; keep the
    // outcome there rather than an empty message.
    const reconciledContent = reconcileApprovalReplyText(approvalMessage.content, '') || content;
    const oldBlocks = Array.isArray(originalMetadata.agent_blocks) ? originalMetadata.agent_blocks : [];
    const [reconciledMessage] = await tx.update(messages).set({
      content: reconciledContent,
      metadata: {
        ...originalMetadata,
        approval_proposal_original_content: approvalMessage.content,
        approval_resolution_message_id: confirmation!.id,
        agent_blocks: [{ type: 'text', text: reconciledContent },
          ...oldBlocks.filter((block: any) => block?.type !== 'text')],
      } as any,
    }).where(and(eq(messages.id, actionMessageId), eq(messages.org_id, params.orgId),
      eq(messages.space_id, approvalMessage.space_id))).returning();
    return { confirmation, approvalMessage, actor, reconciledMessage };
  });

  const io = getIO();
  if (io && posted?.confirmation) {
    if (posted.reconciledMessage) io.to(`space:${posted.approvalMessage.space_id}`).emit('message:edited', posted.reconciledMessage);
    io.to(`space:${posted.approvalMessage.space_id}`).emit('message:new', {
      ...posted.confirmation,
      user_name: posted.actor?.name ?? 'Defty',
      user_avatar: posted.actor?.avatar_url ?? null,
    });
  }
}


function visibleActionSql(user: { id: string; org_id: string; role?: string }) {
  return and(
    visibleCaptureActionSql(user),
    visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
  );
}

function reviewableActionSql(user: { id: string; org_id: string; role?: string }) {
  const canReviewOrgActions = user.role === 'owner' || user.role === 'admin';
  return and(
    visibleCaptureActionSql(user),
    visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
    sql`(
      EXISTS (
        SELECT 1 FROM ${agentActionApprovers}
        WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
          AND ${agentActionApprovers.org_id} = ${user.org_id}
          AND ${agentActionApprovers.user_id} = ${user.id}
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM ${agentActionApprovers}
          WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
        )
        AND (
          COALESCE(
            ${agentActions.params}->>'source_user_id',
            ${agentActions.params}->>'origin_user_id',
            ${agentActions.user_id}
          ) = ${user.id}
          OR (
            ${canReviewOrgActions}
            AND NOT EXISTS (
              SELECT 1
              FROM ${users}
              INNER JOIN org_members review_om
                ON review_om.user_id = ${users.id}
                AND review_om.org_id = ${agentActions.org_id}
                AND review_om.is_active = true
              WHERE ${users.id} = COALESCE(
                ${agentActions.params}->>'source_user_id',
                ${agentActions.params}->>'origin_user_id',
                ${agentActions.user_id}
              )
                AND ${users.is_agent} = false
                AND ${users.kind} = 'human'
            )
          )
        )
      )
    )`,
  );
}

function actionParamString(params: unknown, key: string): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rejectedActionLabel(action: { action: string; params: unknown }): string {
  const actionLabel = action.action.replace(/_/g, ' ');
  const target = actionParamString(action.params, 'title')
    ?? actionParamString(action.params, 'task_identifier')
    ?? actionParamString(action.params, 'resource_id');
  return target ? `${actionLabel} "${target}"` : actionLabel;
}

async function recordRejectedActionDecisionContext(action: {
  id: string;
  org_id: string;
  conversation_id: string | null;
  tool_use_id: string | null;
  action: string;
  params: unknown;
}, actorUserId: string) {
  if (!action.conversation_id) return;
  const conversationId = action.conversation_id;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`approval-rejection-result:${action.org_id}:${action.id}`}, 0
    ))`);
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.org_id, action.org_id),
        eq(messages.space_id, conversationId),
        sql`${messages.metadata}->>'approval_rejection_result_for_action_id' = ${action.id}`,
      ))
      .limit(1);
    if (existing) return;
    const toolResultNames = action.tool_use_id
      ? new Map([[action.tool_use_id, action.action]])
      : new Map<string, string>();
    const agentBlocks: unknown[] = [];
    if (action.tool_use_id) {
      agentBlocks.push({
        type: 'tool_result',
        tool_use_id: action.tool_use_id,
        is_error: true,
        content: JSON.stringify({
          status: 'rejected',
          action: action.action,
          retry_requires_explicit_user_request: true,
        }),
      });
    }
    agentBlocks.push({
      type: 'text',
      text: `The user rejected the ${rejectedActionLabel(action)} action. It did not execute. Retry this rejected action only after a new explicit user request.`,
    });
    await tx.insert(messages).values({
      org_id: action.org_id,
      space_id: conversationId,
      user_id: actorUserId,
      content: '',
      metadata: {
        kind: 'tool_result',
        hidden: true,
        approval_rejection_result_for_action_id: action.id,
        agent_blocks: sanitizeAgentMetadataForStorage(
          { agent_blocks: agentBlocks },
          toolResultNames,
        ).agent_blocks,
      } as any,
    });
  });
}

async function recordApprovedActionExecutionContext(action: {
  id: string;
  org_id: string;
  conversation_id: string | null;
  message_id: string | null;
  tool_use_id: string | null;
  action: string;
}, actorUserId: string, executionResult: unknown) {
  if (!action.conversation_id || !action.message_id) return;
  const durableResult = durableAgentActionResult(action.action, executionResult);
  if (!durableResult) return;
  const conversationId = action.conversation_id;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`approval-execution-result:${action.org_id}:${action.id}`}, 0
    ))`);
    const [sourceMessage] = await tx
      .select({ parent_id: messages.parent_id })
      .from(messages)
      .where(and(
        eq(messages.id, action.message_id!),
        eq(messages.org_id, action.org_id),
        eq(messages.space_id, conversationId),
      ))
      .limit(1);
    if (!sourceMessage) return;
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.org_id, action.org_id),
        eq(messages.space_id, conversationId),
        sql`${messages.metadata}->>'approval_execution_result_for_action_id' = ${action.id}`,
      ))
      .limit(1);
    if (existing) return;

    const toolResultNames = action.tool_use_id
      ? new Map([[action.tool_use_id, action.action]])
      : new Map<string, string>();
    const agentBlocks = action.tool_use_id
      ? [{
        type: 'tool_result' as const,
        tool_use_id: action.tool_use_id,
        content: JSON.stringify(executionResult),
      }]
      : [{
        type: 'text' as const,
        text: durableAgentActionResultHistoryText(durableResult),
      }];
    await tx.insert(messages).values({
      org_id: action.org_id,
      space_id: conversationId,
      user_id: actorUserId,
      content: '',
      parent_id: sourceMessage.parent_id,
      metadata: {
        kind: 'tool_result',
        hidden: true,
        approval_execution_result_for_action_id: action.id,
        approval_execution_result: durableResult,
        agent_blocks: sanitizeAgentMetadataForStorage(
          { agent_blocks: agentBlocks },
          toolResultNames,
        ).agent_blocks,
      } as any,
    });
  });
}

async function attachSourceMessagePreviews<T extends { params: unknown }>(
  user: { id: string; org_id: string },
  rows: T[],
): Promise<Array<T & { source_message_content: string | null; source_message_space_id: string | null }>> {
  const sourceIds = Array.from(new Set(
    rows
      .map((row) => actionParamString(row.params, 'source_message_id'))
      .filter((id): id is string => Boolean(id)),
  ));
  if (sourceIds.length === 0) {
    return rows.map((row) => ({
      ...row,
      source_message_content: null,
      source_message_space_id: null,
    }));
  }

  const sourceRows = await db
    .select({
      id: messages.id,
      content: messages.content,
      space_id: messages.space_id,
    })
    .from(messages)
    .innerJoin(spaces, and(
      eq(spaces.id, messages.space_id),
      eq(spaces.org_id, user.org_id),
      eq(spaces.is_archived, false),
    ))
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, messages.space_id),
      eq(spaceMembers.user_id, user.id),
    ))
    .where(and(
      eq(messages.org_id, user.org_id),
      eq(messages.is_deleted, false),
      inArray(messages.id, sourceIds),
    ));
  const byId = new Map(sourceRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const sourceId = actionParamString(row.params, 'source_message_id');
    const source = sourceId ? byId.get(sourceId) : undefined;
    const enrichedParams = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
      ? {
          ...(row.params as Record<string, unknown>),
          source_message_content: source?.content ?? null,
          source_message_space_id: source?.space_id ?? null,
        }
      : row.params;

    return {
      ...row,
      params: enrichedParams,
      source_message_content: source?.content ?? null,
      source_message_space_id: source?.space_id ?? null,
    };
  });
}

// ── Legacy conversation API (retired 2026-11-10, W1-a) ──
//
// Chat (spaces/messages + the agent-reply worker) is the only agent
// conversation surface. The routes that ran an in-process streaming agent
// loop (POST /conversations/:id/messages, POST /conversations/:id/continue)
// and the generic rename/archive writes (PATCH/DELETE /conversations/:id)
// are retired: they resolved "the agent" as any other space member, ran
// writes under the org trust level during an interactive turn, and let any
// member rename or archive any space. They now answer 410 without touching
// the database. Post a message to POST /api/messages/:spaceId instead;
// rename/archive go through the spaces routes and their creator checks.
//
// Kept: read-only listing/detail/history/trace export, limited to
// agent_conversation spaces in the caller's org that the caller belongs to,
// and conversation creation (the only way to open a user-owned agent
// conversation, which the private-Defty review flow requires).

const RETIRED_CONVERSATION_ROUTE = {
  error: 'This endpoint has been retired. Post a message in the conversation with POST /api/messages/:spaceId instead.',
  code: 'ENDPOINT_RETIRED',
} as const;

const retiredConversationRoute = (c: Context) => c.json(RETIRED_CONVERSATION_ROUTE, 410);

agentRoutes.post('/conversations/:id/messages', retiredConversationRoute);
agentRoutes.post('/conversations/:id/continue', retiredConversationRoute);
agentRoutes.patch('/conversations/:id', retiredConversationRoute);
agentRoutes.delete('/conversations/:id', retiredConversationRoute);

type AgentConversation = {
  id: string;
  org_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  agentUserId: string | null;
  agentEmployeeId: string | null;
};

/**
 * Resolve an agent conversation the caller may read: a space of type
 * `agent_conversation` in the caller's org that the caller is a member of.
 * The assistant identity is the member that is an agent user (never "the
 * first other member"), and its employee row is looked up in the caller's
 * org only, so another org's per-org Defty system employee is never used.
 */
async function findReadableAgentConversation(
  user: { id: string; org_id: string },
  id: string,
  opts: { includeArchived: boolean },
): Promise<AgentConversation | null> {
  const [space] = await db
    .select({
      id: spaces.id,
      org_id: spaces.org_id,
      name: spaces.name,
      created_at: spaces.created_at,
      updated_at: spaces.updated_at,
    })
    .from(spaces)
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, spaces.id),
      eq(spaceMembers.user_id, user.id),
    ))
    .where(and(
      eq(spaces.id, id),
      eq(spaces.org_id, user.org_id),
      eq(spaces.type, 'agent_conversation'),
      ...(opts.includeArchived ? [] : [eq(spaces.is_archived, false)]),
    ))
    .limit(1);
  if (!space) return null;

  const [agentMember] = await db
    .select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.user_id))
    .where(and(
      eq(spaceMembers.space_id, space.id),
      sql`${spaceMembers.user_id} != ${user.id}`,
      sql`(${users.is_agent} = true OR ${users.kind} = 'agent')`,
    ))
    .orderBy(asc(spaceMembers.joined_at))
    .limit(1);
  const agentUserId = agentMember?.user_id ?? null;

  let agentEmployeeId: string | null = null;
  if (agentUserId) {
    const [emp] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.user_id, agentUserId),
        eq(agentEmployees.org_id, user.org_id),
        eq(agentEmployees.is_deleted, false),
        sql`${agentEmployees.runtime_kind} IS DISTINCT FROM ${DEFTY_SYSTEM_RUNTIME_KIND}`,
      ))
      .limit(1);
    agentEmployeeId = emp?.id ?? null;
  }

  return {
    id: space.id,
    org_id: space.org_id,
    title: space.name,
    created_at: space.created_at,
    updated_at: space.updated_at,
    agentUserId,
    agentEmployeeId,
  };
}

agentRoutes.get('/conversations', async (c) => {
  const user = c.get('user');
  const employeeIdFilter = c.req.query('employee') ?? c.req.query('agent_employee_id') ?? null;

  // Resolve the agent's user_id so we can filter by space membership. The
  // employee must belong to the caller's org.
  let agentFilterUserId: string | null = null;
  if (employeeIdFilter) {
    const [emp] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, employeeIdFilter),
        eq(agentEmployees.org_id, user.org_id),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    agentFilterUserId = emp?.user_id ?? null;
  } else {
    // No employee filter → Defty conversations.
    agentFilterUserId = await ensureDeftyMembership(user.org_id);
  }

  if (!agentFilterUserId) return c.json([], 200);

  // Find spaces of type agent_conversation where BOTH the current user
  // AND the target agent are members.
  const result = await db.execute(sql`
    SELECT s.id, s.name AS title, s.created_at, s.updated_at, s.org_id
    FROM spaces s
    WHERE s.org_id = ${user.org_id}
      AND s.type = 'agent_conversation'
      AND s.is_archived = false
      AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = ${user.id})
      AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = ${agentFilterUserId})
    ORDER BY s.updated_at DESC NULLS LAST
    LIMIT 100
  `);

  return c.json((result.rows as any[]).map((r) => ({
    id: r.id,
    user_id: user.id,
    org_id: r.org_id,
    agent_employee_id: employeeIdFilter ?? null,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
  })));
});

const createConversationSchema = z.object({
  agent_employee_id: z.string().min(1).max(200).optional(),
  title: z.string().max(500).optional(),
}).strict();

agentRoutes.post('/conversations', async (c) => {
  const user = c.get('user');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = createConversationSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid conversation request', code: 'VALIDATION_ERROR' }, 400);
  }
  const body = parsed.data;

  const conversationId = randomUUID();
  let agentUserId: string;
  if (body.agent_employee_id) {
    // Only an active employee of the caller's own org can join the new space.
    const [emp] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, body.agent_employee_id),
        eq(agentEmployees.org_id, user.org_id),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (!emp) {
      return c.json({ error: 'Unknown agent employee', code: 'NOT_FOUND' }, 404);
    }
    agentUserId = emp.user_id;
  } else {
    agentUserId = await ensureDeftyMembership(user.org_id);
  }

  const title = body.title?.trim() ? body.title : 'New conversation';
  await ensureAgentConversationSpace({
    orgId: user.org_id,
    userId: user.id,
    agentUserId,
    conversationId,
    title,
  });

  return c.json({
    id: conversationId,
    user_id: user.id,
    org_id: user.org_id,
    agent_employee_id: body.agent_employee_id ?? null,
    title,
    created_at: new Date(),
    updated_at: new Date(),
  }, 201);
});

agentRoutes.get('/conversations/:id', async (c) => {
  const user = c.get('user');
  const conv = await findReadableAgentConversation(user, c.req.param('id'), { includeArchived: false });
  if (!conv) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({
    id: conv.id,
    user_id: user.id,
    org_id: conv.org_id,
    agent_employee_id: conv.agentEmployeeId,
    title: conv.title,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
  });
});

agentRoutes.get('/conversations/:id/messages', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const conv = await findReadableAgentConversation(user, id, { includeArchived: false });
  if (!conv) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  // P2-7: Read from unified messages table (space_id = conversation id).
  const rows = await db
    .select()
    .from(messages)
    .where(and(
      eq(messages.space_id, id),
      eq(messages.org_id, user.org_id),
      eq(messages.is_deleted, false),
    ))
    .orderBy(asc(messages.created_at));

  const agentUserId = conv.agentUserId;

  // Filter out tool_result rows and explicitly hidden rows (user-visible list only).
  const visible = rows.filter((r) => {
    const m = (r.metadata as any) || {};
    return m.kind !== 'tool_result' && m.hidden !== true;
  });

  // Fetch all actions for this conversation
  const actionList = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.conversation_id, id),
      eq(agentActions.org_id, user.org_id),
      visibleActionSql(user),
    ));

  // Map to the shape AgentChat expects and attach pending_actions.
  const visibleToolNames = new Map<string, string>();
  const messagesWithActions = visible.map((r) => {
    const m = sanitizeAgentMetadataForStorage(r.metadata, visibleToolNames);
    const role = (agentUserId && r.user_id === agentUserId) ? 'assistant' : 'user';
    return {
      id: r.id,
      conversation_id: id,
      role,
      content: r.content,
      content_blocks: m.agent_blocks ?? [{ type: 'text', text: r.content }],
      citations: m.citations ?? null,
      tool_calls: m.tool_calls ?? null,
      hidden: m.hidden ?? false,
      model: m.model ?? null,
      tokens_in: m.tokens_in ?? null,
      tokens_out: m.tokens_out ?? null,
      created_at: r.created_at,
      pending_actions: actionList
        .filter((a) => a.message_id === r.id)
        .map((a) => ({
          id: a.id,
          action: a.action,
          params: a.params,
          approval_tier: a.approval_tier,
          status: a.approval_status,
          result: a.result,
          executed_at: a.executed_at,
          error: a.error,
        })),
    };
  });

  return c.json(messagesWithActions);
});

// ── Action approval / rejection / undo ──

// Phase 6.5 — Pending approvals list for the Settings → Agent pending
// approvals section. Returns the current user's org's pending MCP-sourced
// actions (the new employee-write kinds) plus the legacy Defty actions.
// The UI uses the `proposer` field + `employee_name` to show a source badge.
agentRoutes.get('/actions/pending', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      source: agentActions.source,
      approval_tier: agentActions.approval_tier,
      created_at: agentActions.created_at,
      agent_employee_id: agentActions.agent_employee_id,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
      employee_avatar: agentEmployees.avatar_url,
    })
    .from(agentActions)
    .leftJoin(
      agentEmployees,
      and(
        eq(agentActions.agent_employee_id, agentEmployees.id),
        eq(agentEmployees.org_id, user.org_id),
      ),
    )
    .where(
      and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
        // Auto-tier rows are routing/queue entries (chat_mention, heartbeat,
        // trigger, task assignment) that BYOA runtimes pull via MCP. Not
        // user-actionable — exclude from approvals view.
        inArray(agentActions.approval_tier, ['quick', 'full']),
        reviewableActionSql(user),
      ),
    )
    .orderBy(desc(agentActions.created_at))
    .limit(50);

  const rowsWithSources = await attachSourceMessagePreviews(user, rows);
  const actions = rowsWithSources.map((r) => ({
    ...r,
    proposer: hasHumanMcpBulkProvenance(r) ? 'user' : r.source === 'defty_capture' || !r.agent_employee_id ? 'defty' : 'employee',
  }));
  return c.json({ actions });
});

// P4-4 — Pending actions keyed by message, scoped to a space.
// The SpaceChat component polls this to render inline approval cards
// directly below the message that triggered the action.
// Space membership is checked before returning any rows.
agentRoutes.get('/actions/pending-by-space', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('space_id');
  if (!spaceId) {
    return c.json({ error: 'space_id required', code: 'VALIDATION_ERROR' }, 400);
  }

  // Membership check — callers outside the space get an empty list (not a 403)
  // so the polling loop doesn't error on transitions.
  const [membership] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(
      eq(spaceMembers.space_id, spaceId),
      eq(spaceMembers.user_id, user.id),
      eq(spaces.org_id, user.org_id),
    ))
    .limit(1);
  if (!membership) {
    return c.json([], 200);
  }

  const rows = await db.execute(sql`
    SELECT
      a.*,
      msg.content AS source_message_content,
      msg.space_id AS source_message_space_id
    FROM agent_actions a
    JOIN messages msg ON msg.id = a.message_id
    WHERE msg.space_id = ${spaceId}
      AND msg.org_id = ${user.org_id}
      AND a.org_id = ${user.org_id}
      AND a.approval_status = 'pending'
      AND a.approval_tier IN ('quick', 'full')
      AND a.source IS DISTINCT FROM 'defty_capture'
      AND (${user.role !== 'guest'} OR a.action NOT IN (
        'module_record_create',
        'module_record_bulk_create',
        'module_record_update',
        'module_record_archive',
        'module_record_task_link',
        'module_record_task_unlink'
      ))
      AND (
        EXISTS (
          SELECT 1 FROM agent_action_approvers action_approver
          WHERE action_approver.action_id = a.id
            AND action_approver.org_id = ${user.org_id}
            AND action_approver.user_id = ${user.id}
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM agent_action_approvers existing_approver
            WHERE existing_approver.action_id = a.id
          )
          AND (
            COALESCE(
              a.params->>'source_user_id',
              a.params->>'origin_user_id',
              a.user_id
            ) = ${user.id}
            OR (
              ${user.role === 'owner' || user.role === 'admin'}
              AND NOT EXISTS (
                SELECT 1
                FROM users requester
                INNER JOIN org_members requester_membership
                  ON requester_membership.user_id = requester.id
                  AND requester_membership.org_id = a.org_id
                  AND requester_membership.is_active = true
                WHERE requester.id = COALESCE(
                  a.params->>'source_user_id',
                  a.params->>'origin_user_id',
                  a.user_id
                )
                  AND requester.is_agent = false
                  AND requester.kind = 'human'
              )
            )
          )
        )
      )
    ORDER BY a.created_at DESC
    LIMIT 100
  `);

  const normalizedRows = rows.rows.map((row: any) => {
    const normalizeTimestamp = (value: unknown) => {
      if (value instanceof Date) return value.toISOString();
      if (typeof value !== 'string' || value.length === 0) return value;
      if (value.includes('T')) return value;
      return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
    };
    return {
      ...row,
      params: row.params && typeof row.params === 'object' && !Array.isArray(row.params)
        ? {
            ...row.params,
            source_message_content: row.source_message_content ?? null,
            source_message_space_id: row.source_message_space_id ?? null,
          }
        : row.params,
      proposer: hasHumanMcpBulkProvenance(row) ? 'user' : row.source === 'defty_capture' || !row.agent_employee_id ? 'defty' : 'employee',
      created_at: normalizeTimestamp(row.created_at),
      updated_at: normalizeTimestamp(row.updated_at),
      approved_at: normalizeTimestamp(row.approved_at),
      executed_at: normalizeTimestamp(row.executed_at),
      undone_at: normalizeTimestamp(row.undone_at),
    };
  });

  return c.json(normalizedRows);
});

// Block 3.8 — Agent trace export. Downloads the full tool-call tree
// for every assistant message in a conversation as a single JSON
// document: conversation metadata + each message's content_blocks +
// tool_calls + citations. Ownership: caller must be a member of the
// agent conversation in their own org; agent_actions attached to each message are
// also joined in so the downloaded trace matches what renders in
// the session inspector.
agentRoutes.get('/conversations/:id/trace.json', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');

  // Only an agent_conversation space in the caller's org that the caller is a
  // member of can be exported. Archived conversations stay exportable for audit.
  const convo = await findReadableAgentConversation(user, convoId, { includeArchived: true });
  if (!convo) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  // P2-7: Read from unified messages table. Trace export keeps full fidelity —
  // includes hidden + tool_result rows for audit purposes (no is_deleted filter either).
  const msgRows = await db
    .select()
    .from(messages)
    .where(and(
      eq(messages.space_id, convoId),
      eq(messages.org_id, user.org_id),
    ))
    .orderBy(asc(messages.created_at));

  const traceAgentUserId = convo.agentUserId;

  const traceToolNames = new Map<string, string>();
  const msgs = msgRows.map((r) => {
    const m = sanitizeAgentMetadataForStorage(r.metadata, traceToolNames);
    const role = (traceAgentUserId && r.user_id === traceAgentUserId) ? 'assistant' : 'user';
    return {
      id: r.id,
      role,
      content: r.content,
      content_blocks: m.agent_blocks ?? null,
      citations: m.citations ?? null,
      tool_calls: m.tool_calls ?? null,
      hidden: m.hidden ?? false,
      model: m.model ?? null,
      tokens_in: m.tokens_in ?? null,
      tokens_out: m.tokens_out ?? null,
      created_at: r.created_at,
    };
  });

  const actions = await db
    .select({
      id: agentActions.id,
      message_id: agentActions.message_id,
      action: agentActions.action,
      params: agentActions.params,
      result: agentActions.result,
      error: agentActions.error,
      approval_tier: agentActions.approval_tier,
      approval_status: agentActions.approval_status,
      executed_at: agentActions.executed_at,
      created_at: agentActions.created_at,
    })
    .from(agentActions)
    .where(and(
      eq(agentActions.conversation_id, convoId),
      eq(agentActions.org_id, user.org_id),
      visibleActionSql(user),
    ))
    .orderBy(agentActions.created_at);

  const trace = {
    format: 'deft.agent_trace.v1',
    exported_at: new Date().toISOString(),
    conversation: {
      id: convo.id,
      org_id: convo.org_id,
      created_at: convo.created_at,
      updated_at: convo.updated_at,
    },
    messages: msgs,
    actions,
  };

  const filename = `agent-trace-${convoId.slice(0, 8)}.json`;
  return new Response(JSON.stringify(trace, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
});

// Block 2.8 — dashboard "Agent Activity" widget. Returns the most recent
// actions across all employees in the org regardless of status, joined
// with the employee row so the UI can show name + avatar + kind.
agentRoutes.get('/actions/recent', async (c) => {
  const user = c.get('user');
  const limitParam = parseInt(c.req.query('limit') ?? '5', 10);
  const limit = Math.min(Math.max(isNaN(limitParam) ? 5 : limitParam, 1), 50);

  const visibilityConditions = [
    eq(agentActions.org_id, user.org_id),
    visibleActionSql(user),
  ];

  const rows = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      source: agentActions.source,
      approval_tier: agentActions.approval_tier,
      approval_status: agentActions.approval_status,
      error: agentActions.error,
      created_at: agentActions.created_at,
      executed_at: agentActions.executed_at,
      agent_employee_id: agentActions.agent_employee_id,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
      employee_avatar: agentEmployees.avatar_url,
    })
    .from(agentActions)
    .leftJoin(agentEmployees, and(
      eq(agentActions.agent_employee_id, agentEmployees.id),
      eq(agentEmployees.org_id, user.org_id),
    ))
    .where(and(...visibilityConditions))
    .orderBy(desc(agentActions.created_at))
    .limit(limit);

  return c.json({
    actions: rows.map((r) => ({
      ...r,
      proposer: hasHumanMcpBulkProvenance(r) ? 'user' : r.source === 'defty_capture' || !r.agent_employee_id ? 'defty' : 'employee',
    })),
  });
});

// Resolve task-link targets only for the current human reviewer. Target labels
// and URLs are intentionally absent from the shared action params/history.
agentRoutes.get('/actions/:id/task-link-review', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const user = c.get('user');
    const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers).where(and(
      eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true),
    )).limit(1);
    if (!membership || membership.role === 'guest') return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    const [action] = await db.select().from(agentActions).where(and(
      eq(agentActions.id, c.req.param('id')), eq(agentActions.org_id, user.org_id),
      inArray(agentActions.action, ['module_record_task_link', 'module_record_task_unlink']),
      eq(agentActions.approval_status, 'pending'), reviewableActionSql({ ...user, role: membership.role }),
    )).limit(1);
    if (!action) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params)
      ? action.params as Record<string, unknown>
      : {};
    const resourceId = typeof params.resource_id === 'string' ? params.resource_id : '';
    const taskIdentifier = typeof params.task_identifier === 'string' ? params.task_identifier : '';
    const record = await getModuleRecord(humanModuleActor({ orgId: user.org_id, userId: user.id, role: membership.role, source: 'ui' }), parseModuleRecordResourceId(resourceId));
    const installation = await getModuleInstallation(humanModuleActor({ orgId: user.org_id, userId: user.id, role: membership.role, source: 'ui' }), { moduleId: record.module_id });
    const [reference] = await listModuleRecordReferences(humanModuleActor({ orgId: user.org_id, userId: user.id, role: membership.role, source: 'ui' }), installation.slug, record.collection_key, [record.id]);
    const taskId = await resolveTaskIdentifier(taskIdentifier, user.org_id);
    if (!taskId) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    const [task] = await db.select({ id: tasks.id, title: tasks.title, number: tasks.number, prefix: projects.prefix, project_name: projects.name }).from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.project_id), eq(projects.org_id, tasks.org_id), eq(projects.is_deleted, false)))
      .where(and(eq(tasks.org_id, user.org_id), eq(tasks.id, taskId), eq(tasks.is_deleted, false), visibleTaskCondition(user.id)!)).limit(1);
    if (!reference || !task) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    return c.json({ record: { label: reference.label, href: `/modules/${encodeURIComponent(installation.slug)}/${encodeURIComponent(record.collection_key)}/${encodeURIComponent(record.id)}` }, task: { identifier: `${task.prefix}-${task.number}`, title: task.title, project_name: task.project_name, href: `/tasks?task=${encodeURIComponent(task.id)}` } });
  } catch {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
});

agentRoutes.post('/actions/:id/approve', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, user.org_id),
      reviewableActionSql(user),
    ))
    .limit(1);
  if (!action) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  // Resolver-owned MCP writes and App Run releases enter the shared approval
  // boundary. Legacy Defty actions (create_task/update_task_status/…) still
  // use the original executeAction path.
  if (isApprovalResolverAction(action.action)) {
    let nativeGuard: ((tx: AppRunTransaction) => Promise<void>) | undefined;
    if (action.app_run_id) {
      // Native proposal participant IDs are immutable. Approval authorization
      // locks and revalidates this exact set before the final SID fence; carry
      // its locator here so no membership lock is discovered after App.
      const [run] = await db.select({ provider_kind: appRuns.provider_kind,
        owner_user_id: appNativeBindings.owner_user_id, manager_user_id: appNativeBindings.stage_manager_user_id,
        input_expires_at: appRuns.input_expires_at, result_expires_at: appRuns.result_expires_at }).from(appRuns)
        .leftJoin(appNativeBindings, and(eq(appNativeBindings.org_id, appRuns.org_id),
          eq(appNativeBindings.id, appRuns.origin_native_binding_id)))
        .where(and(eq(appRuns.org_id, user.org_id), eq(appRuns.id, action.app_run_id))).limit(1);
      if (run?.provider_kind === 'native') {
        try {
          const { assertNativeCalendarEnabled } = await import('../lib/app-native-authority.js');
          const { nativeFinalAuthorityIsCurrent } = await import('../lib/app-native-final-authority.js');
          const { resourceSyncWebAuthority } = await import('../lib/app-resource-sync-web-authority.js');
          assertNativeCalendarEnabled();
          if (!user.sid || !run.owner_user_id || !run.manager_user_id) throw new AppRunError('APP_RUN_ACCESS_DENIED');
          const participantIds = [run.owner_user_id, run.manager_user_id];
          const { guard } = await resourceSyncWebAuthority(c.req.header('authorization'), { org_id: user.org_id, user_id: user.id, sid: user.sid });
          nativeGuard = async tx => {
            if (!await nativeFinalAuthorityIsCurrent(tx, participantIds, { guard,
              expires_at: [run.input_expires_at, run.result_expires_at] })) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
          };
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && 'code' in error
            && typeof error.status === 'number' && [400, 401, 403, 409, 503].includes(error.status)) {
            return c.json({ error: 'Native Calendar approval unavailable', code: String(error.code) }, error.status as 400 | 401 | 403 | 409 | 503);
          }
          return appHttpFailure(c, error, 'App Run', 'app-runs');
        }
      } else if (run?.provider_kind === 'app_runtime') {
        const [runtime] = await db.select({ protocol_version: appVersions.protocol_version,
          operator_user_id: appRuntimeRegistrations.operator_user_id,
          initiating_actor_type: appRuns.initiating_actor_type, initiating_actor_id: appRuns.initiating_actor_id })
          .from(appRuns).innerJoin(appVersions, and(eq(appVersions.org_id, appRuns.org_id),
            eq(appVersions.id, appRuns.origin_app_version_id)))
          .innerJoin(appRuntimeBindings, and(eq(appRuntimeBindings.org_id, appRuns.org_id),
            eq(appRuntimeBindings.id, appRuns.origin_runtime_binding_id)))
          .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appRuntimeBindings.org_id),
            eq(appRuntimeRegistrations.id, appRuntimeBindings.runtime_registration_id)))
          .where(and(eq(appRuns.org_id, user.org_id), eq(appRuns.id, action.app_run_id))).limit(1);
        if (runtime?.protocol_version === '7') {
          try {
            if (!user.sid || runtime.initiating_actor_type !== 'human' || runtime.initiating_actor_id !== user.id) {
              throw new AppRunError('APP_RUN_ACCESS_DENIED');
            }
            const { resourceSyncWebAuthority } = await import('../lib/app-resource-sync-web-authority.js');
            const { attachmentFinalAuthorityIsCurrent } = await import('../lib/app-attachment-authority.js');
            const { isAppV5RuntimeActionsEnabled } = await import('../lib/env.js');
            const { guard } = await resourceSyncWebAuthority(c.req.header('authorization'),
              { org_id: user.org_id, user_id: user.id, sid: user.sid });
            nativeGuard = async tx => {
              if (!await attachmentFinalAuthorityIsCurrent(tx, [user.id, runtime.operator_user_id],
                { guard, expires_at: [run.input_expires_at, run.result_expires_at] })
                || !isAppV5RuntimeActionsEnabled()) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
            };
          } catch (error) {
            if (error && typeof error === 'object' && 'status' in error && 'code' in error
              && typeof error.status === 'number' && [401, 403, 409, 503].includes(error.status)) {
              return c.json({ error: 'Attachment App approval unavailable', code: String(error.code) }, error.status as 401 | 403 | 409 | 503);
            }
            return appHttpFailure(c, error, 'App Run', 'app-runs');
          }
        }
      }
    }
    let result: Awaited<ReturnType<typeof resolveApproveAction>>;
    try {
      result = await resolveApproveAction(actionId, user.id, { appRunFinalGuard: nativeGuard, ...(user.sid ? { humanWebSessionId: user.sid } : {}) });
    }
    catch (error) { return appHttpFailure(c, error, 'App Run', 'app-runs'); }
    if (result.status === 'error') {
      const statusCode =
        result.code === 'NOT_FOUND' ? 404
        : result.code === 'FORBIDDEN' ? 403
        : result.code === 'EXECUTE_FAILED' ? 500
        : 400;
      return c.json(
        { error: result.message, code: result.code },
        statusCode,
      );
    }
    if (action.approval_status === 'pending') {
      await recordActionApproverDecision({
        orgId: user.org_id,
        actionId,
        userId: user.id,
        decision: 'approved',
      });
    }
    if (result.status === 'approved' && 'result' in result) {
      try {
        await recordApprovedActionExecutionContext(action, user.id, result.result);
      } catch (err) {
        console.warn('[agent-routes] Failed to record approved action result context', {
          actionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await maybePostApprovalConfirmation({
        orgId: user.org_id,
        actionMessageId: action.message_id,
        actorUserId: action.user_id,
      });
    } catch (err) {
      console.warn('[agent-routes] Failed to post approval confirmation', {
        actionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await resolveAttentionBySource({
      orgId: user.org_id,
      sourceType: 'agent_action',
      sourceId: actionId,
      resolution: 'approved',
      actorUserId: user.id,
    });
    return c.json({
      status: result.status,
      message: 'message' in result ? result.message : undefined,
      result: 'result' in result ? result.result : undefined,
    });
  }

  if (action.approval_status === 'approved') {
    if ((action.result as any)?.lifecycle_state === 'executing') {
      return c.json({ status: 'executing', message: 'execution is already in progress' }, 202);
    }
    return c.json({ status: 'approved', message: 'already approved', result: action.result ?? undefined });
  }
  if (action.approval_status === 'rejected') {
    return c.json({ status: 'rejected', message: 'already rejected' });
  }
  if (action.approval_status === 'expired') {
    return c.json({ error: 'Action has expired', code: 'NOT_FOUND' }, 404);
  }
  if (action.approval_status !== 'pending') {
    return c.json({ error: 'Action is not pending', code: 'INVALID_STATE' }, 409);
  }

  const [claimedAction] = await db
    .update(agentActions)
    .set({
      approval_status: 'approved',
      approved_at: new Date(),
      result: { lifecycle_state: 'executing', started_at: new Date().toISOString() } as any,
      error: null,
    })
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, user.org_id),
      eq(agentActions.approval_status, 'pending'),
    ))
    .returning({
      id: agentActions.id,
      approval_status: agentActions.approval_status,
      result: agentActions.result,
    });

  if (!claimedAction) {
    const [winner] = await db
      .select({
        approval_status: agentActions.approval_status,
        result: agentActions.result,
      })
      .from(agentActions)
      .where(and(
        eq(agentActions.id, actionId),
        eq(agentActions.org_id, user.org_id),
      ))
      .limit(1);
    if (winner?.approval_status === 'approved') {
      if ((winner.result as any)?.lifecycle_state === 'executing') {
        return c.json({ status: 'executing', message: 'execution is already in progress' }, 202);
      }
      return c.json({ status: 'approved', message: 'already approved', result: winner.result ?? undefined });
    }
    if (winner?.approval_status === 'rejected') {
      return c.json({ status: 'rejected', message: 'already rejected' });
    }
    if (winner?.approval_status === 'expired') {
      return c.json({ error: 'Action has expired', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ error: 'Action is no longer pending', code: 'INVALID_STATE' }, 409);
  }

  // Phase 6 invariant — the executor must receive the ORIGINAL proposer's
  // user_id (action.user_id), not the approver's. Otherwise:
  //   1. Inserted messages would be authored by the human approver,
  //      not by the proposing agent.
  //   2. The reply-storm guard would count the approver's replies
  //      instead of the agent's, defeating Phase 6 in the manual-
  //      approval path.
  const execResult = await executeAction(
    actionId,
    action.action,
    action.params as any,
    user.org_id,
    action.user_id,
    { agentEmployeeId: action.agent_employee_id ?? undefined },
  );

  // Only mark approved after execution succeeds. If the executor failed
  // (e.g. "Project not found" because the named project was deleted between
  // proposal and approval), leave the row pending and record the error so
  // the user can retry without losing the proposed params. Without this,
  // a failed exec left the row stuck in approved+null-result, invisible
  // to "/api/agent/actions/pending" but unactionable.
  if (execResult.success) {
    await db
      .update(agentActions)
      .set({
        approval_status: 'approved',
        approved_at: new Date(),
        result: execResult.result as any,
        error: null,
      })
      .where(eq(agentActions.id, actionId));
    await recordActionApproverDecision({
      orgId: user.org_id,
      actionId,
      userId: user.id,
      decision: 'approved',
    });
    if (
      action.action === 'create_task'
      || action.source === 'defty_capture'
      || isModuleTaskLinkWriteAction(action.action)
      || isModuleWriteActionName(action.action)
      || isModuleRecordBulkCreateAction(action.action)
      || action.action === WORKSPACE_PLAN_IMPORT_ACTION
      || action.action === DOCUMENT_SEND_ACTION
    ) {
      const [terminalReceiptAction] = await db
        .select({ params: agentActions.params })
        .from(agentActions)
        .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, action.org_id)))
        .limit(1);
      const terminalReceiptParams = terminalReceiptAction?.params ?? action.params;
      await generateReceipt({
        actionId,
        orgId: action.org_id,
        employeeId: action.agent_employee_id ?? null,
        proposer: action.agent_employee_id ? 'employee' : 'defty',
        proposerId: action.agent_employee_id ?? action.user_id,
        approverId: user.id,
        decision: 'approved',
        decisionReason: null,
        actionName: action.action,
        actionParams: isModuleTaskLinkWriteAction(action.action)
          ? sanitizeModuleTaskLinkActionParamsForHistory(terminalReceiptParams)
          : isModuleWriteActionName(action.action)
            ? sanitizeModuleActionParamsForReceipt(action.action, terminalReceiptParams)
            : isModuleRecordBulkCreateAction(action.action)
              ? sanitizeModuleBulkCreateParamsForHistory(terminalReceiptParams)
              : action.action === WORKSPACE_PLAN_IMPORT_ACTION
                ? sanitizeWorkspacePlanImportParams(terminalReceiptParams)
                : action.action === DOCUMENT_SEND_ACTION
                  ? sanitizeDocumentSendParams(terminalReceiptParams)
            : terminalReceiptParams,
        resultJson: execResult.result,
      });
    }
    if (action.source === 'defty_capture') {
      await markWorkIntentConvertedForAction({
        actionId,
        orgId: action.org_id,
        actionParams: action.params,
        result: execResult.result,
        convertedBy: user.id,
      });
    }
    try {
      await maybePostApprovalConfirmation({
        orgId: user.org_id,
        actionMessageId: action.message_id,
        actorUserId: action.user_id,
      });
    } catch (err) {
      console.warn('[agent-routes] Failed to post approval confirmation', {
        actionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await resolveAttentionBySource({
      orgId: user.org_id,
      sourceType: 'agent_action',
      sourceId: actionId,
      resolution: 'approved',
      actorUserId: user.id,
    });
  } else {
    if (isModuleTaskLinkWriteAction(action.action) || isModuleWriteActionName(action.action)) {
      // Idempotency keys are single-use terminal claims. A failed approved
      // edge mutation must not be reopened as pending after executeAction has
      // scrubbed its raw key, otherwise the next button click can neither
      // safely replay nor prove a single budget/receipt outcome.
      const [terminalAction] = await db
        .update(agentActions)
        .set({
          approval_status: 'approved',
          approved_at: new Date(),
          result: null,
          error: execResult.error ?? 'Action failed',
          executed_at: new Date(),
        })
        .where(eq(agentActions.id, actionId))
        .returning({ params: agentActions.params });
      await recordActionApproverDecision({
        orgId: user.org_id,
        actionId,
        userId: user.id,
        decision: 'approved',
      });
      await generateReceipt({
        actionId,
        orgId: action.org_id,
        employeeId: action.agent_employee_id ?? null,
        proposer: action.agent_employee_id ? 'employee' : 'defty',
        proposerId: action.agent_employee_id ?? action.user_id,
        approverId: user.id,
        decision: 'approved',
        decisionReason: `execution failed: ${execResult.error ?? 'unknown'}`.slice(0, 2_000),
        actionName: action.action,
        actionParams: isModuleTaskLinkWriteAction(action.action)
          ? sanitizeModuleTaskLinkActionParamsForHistory(terminalAction?.params ?? action.params)
          : sanitizeModuleActionParamsForReceipt(
              action.action,
              terminalAction?.params ?? action.params,
            ),
        resultJson: null,
      });
      if (action.source === 'defty_capture') {
        await markWorkIntentFailedForAction({
          actionId,
          orgId: action.org_id,
          actionParams: action.params,
          reason: execResult.error ?? 'Action failed',
        });
      }
    } else {
      const preservedFailureResult = execResult.result
        && typeof execResult.result === 'object'
        && !Array.isArray(execResult.result)
        ? execResult.result as Record<string, unknown>
        : { upstream_result: execResult.result ?? null };
      await db
        .update(agentActions)
        .set({
          approval_status: 'pending',
          approved_at: null,
          result: {
            ...preservedFailureResult,
            lifecycle_state: 'failed',
            failed_at: new Date().toISOString(),
            retryable: true,
          } as any,
          error: execResult.error ?? 'Action failed',
        })
        .where(eq(agentActions.id, actionId));
      await markWorkIntentFailedForAction({
        actionId,
        orgId: action.org_id,
        actionParams: action.params,
        reason: execResult.error ?? 'Action failed',
      });
    }
  }

  // Insert a hidden tool_result message into the unified messages table so
  // the next agent turn in this conversation sees a valid Anthropic tool_use →
  // tool_result pair. This eliminates the "messages repeated over and over"
  // disclaimers — the model can see its own prior call and its real result.
  const durableExecutionResult = execResult.success
    ? durableAgentActionResult(action.action, execResult.result)
    : null;
  if (durableExecutionResult) {
    try {
      await recordApprovedActionExecutionContext(action, user.id, execResult.result);
    } catch (err) {
      console.warn('[agent-routes] Failed to record approved action result context', {
        actionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (action.tool_use_id && action.conversation_id) {
    const preservedToolFailure = execResult.result
      && typeof execResult.result === 'object'
      && !Array.isArray(execResult.result)
      ? execResult.result as Record<string, unknown>
      : { upstream_result: execResult.result ?? null };
    const toolResultBlock = {
      type: 'tool_result' as const,
      tool_use_id: action.tool_use_id,
      content: JSON.stringify(
        execResult.success
          ? execResult.result
          : { ...preservedToolFailure, error: execResult.error || 'Action failed' }
      ),
      ...(execResult.success ? {} : { is_error: true }),
    };
    const toolResultNames = new Map([[action.tool_use_id, action.action]]);
    await db.insert(messages).values({
      org_id: action.org_id,
      space_id: action.conversation_id,
      user_id: action.user_id,
      content: '',
      metadata: {
        kind: 'tool_result',
        hidden: true,
        agent_blocks: sanitizeAgentMetadataForStorage(
          { agent_blocks: [toolResultBlock] },
          toolResultNames,
        ).agent_blocks,
      } as any,
    });
  }

  const legacyResultBody = {
    ...execResult,
    executed_at: new Date().toISOString(),
  };

  if (!execResult.success) {
    return c.json(
      {
        ...legacyResultBody,
        error: execResult.error ?? 'Action failed',
        code: 'EXECUTE_FAILED',
      },
      500,
    );
  }

  return c.json(legacyResultBody);
});

agentRoutes.post('/actions/:id/reject', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as { reason?: string }));
  const reason = typeof body?.reason === 'string' ? body.reason : undefined;

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, user.org_id),
      reviewableActionSql(user),
    ))
    .limit(1);

  if (!action) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  // Resolver-owned MCP writes and App Run releases use the same idempotent,
  // permission-checked rejection boundary.
  if (isApprovalResolverAction(action.action)) {
    const result = await resolveRejectAction(actionId, user.id, reason);
    if (result.status === 'error') {
      const statusCode =
        result.code === 'NOT_FOUND' ? 404
        : result.code === 'FORBIDDEN' ? 403
        : 400;
      return c.json({ error: result.message, code: result.code }, statusCode);
    }
    if (action.approval_status === 'pending') {
      await recordActionApproverDecision({
        orgId: user.org_id,
        actionId,
        userId: user.id,
        decision: 'rejected',
      });
    }
    if (result.status === 'rejected') {
      await recordRejectedActionDecisionContext(action, user.id);
    }
    try {
      await maybePostApprovalConfirmation({
        orgId: user.org_id,
        actionMessageId: action.message_id,
        actorUserId: action.user_id,
      });
    } catch (err) {
      console.warn('[agent-routes] Failed to post approval confirmation', {
        actionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await resolveAttentionBySource({
      orgId: user.org_id,
      sourceType: 'agent_action',
      sourceId: actionId,
      resolution: 'rejected',
      actorUserId: user.id,
    });
    return c.json({ status: result.status });
  }

  if (action.approval_status === 'rejected') {
    await recordRejectedActionDecisionContext(action, user.id);
    return c.json({ success: true, status: 'rejected', message: 'already rejected' });
  }
  if (action.approval_status === 'approved') {
    return c.json({ success: true, status: 'approved', message: 'already approved - cannot reject after approval' });
  }
  if (action.approval_status === 'expired') {
    return c.json({ error: 'Action has expired', code: 'NOT_FOUND' }, 404);
  }
  if (action.approval_status !== 'pending') {
    return c.json({ error: 'Action is not pending', code: 'INVALID_STATE' }, 409);
  }

  const rejectedParams = isModuleTaskLinkWriteAction(action.action)
    ? sanitizeModuleTaskLinkActionParamsForHistory(action.params)
    : isModuleWriteActionName(action.action)
      ? sanitizeModuleActionParamsForReceipt(action.action, action.params)
      : isModuleRecordBulkCreateAction(action.action)
        ? sanitizeModuleBulkCreateParamsForHistory(action.params)
        : action.action === WORKSPACE_PLAN_IMPORT_ACTION
          ? sanitizeWorkspacePlanImportParams(action.params)
          : action.action === DOCUMENT_SEND_ACTION
            ? sanitizeDocumentSendParams(action.params)
      : action.params;
  const [updatedAction] = await db
    .update(agentActions)
    .set({
      approval_status: 'rejected',
      error: reason ?? null,
      ...(isModuleTaskLinkWriteAction(action.action)
        || isModuleWriteActionName(action.action)
        || isModuleRecordBulkCreateAction(action.action)
        || action.action === WORKSPACE_PLAN_IMPORT_ACTION
        || action.action === DOCUMENT_SEND_ACTION
        ? { params: rejectedParams, executed_at: new Date() }
        : {}),
    })
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, user.org_id),
      eq(agentActions.approval_status, 'pending'),
    ))
    .returning({ id: agentActions.id });
  if (!updatedAction) {
    return c.json({ error: 'Action is no longer pending', code: 'INVALID_STATE' }, 409);
  }
  await recordActionApproverDecision({
    orgId: user.org_id,
    actionId,
    userId: user.id,
    decision: 'rejected',
  });
  await recordRejectedActionDecisionContext(action, user.id);
  await resolveAttentionBySource({
    orgId: user.org_id,
    sourceType: 'agent_action',
    sourceId: actionId,
    resolution: 'rejected',
    actorUserId: user.id,
  });

  if (
    action.source === 'defty_capture'
    || isModuleTaskLinkWriteAction(action.action)
    || isModuleWriteActionName(action.action)
    || isModuleRecordBulkCreateAction(action.action)
    || action.action === WORKSPACE_PLAN_IMPORT_ACTION
    || action.action === DOCUMENT_SEND_ACTION
  ) {
    await generateReceipt({
      actionId,
      orgId: action.org_id,
      employeeId: action.agent_employee_id ?? null,
      proposer: action.agent_employee_id ? 'employee' : 'defty',
      proposerId: action.agent_employee_id ?? action.user_id,
      approverId: user.id,
      decision: 'rejected',
      decisionReason: reason ?? null,
      actionName: action.action,
      actionParams: rejectedParams,
      resultJson: null,
    });
  }
  if (action.source === 'defty_capture') {
    await markWorkIntentDismissedForAction({
      actionId,
      orgId: action.org_id,
      actionParams: action.params,
      dismissedBy: user.id,
      reason: reason ?? null,
    });
  }
  try {
    await maybePostApprovalConfirmation({
      orgId: user.org_id,
      actionMessageId: action.message_id,
      actorUserId: action.user_id,
    });
  } catch (err) {
    console.warn('[agent-routes] Failed to post approval confirmation', {
      actionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return c.json({ success: true });
});

agentRoutes.post('/actions/:id/undo', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, user.org_id),
      visibleActionSql(user),
    ))
    .limit(1);
  if (!action) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (action.undone_at) {
    return c.json({ error: 'Already undone', code: 'ALREADY_UNDONE' }, 400);
  }

  const beforeState = action.before_state as Record<string, any> | null;
  const afterState = action.after_state as Record<string, any> | null;
  const result = action.result as Record<string, any> | null;

  try {
    switch (action.action) {
      case 'create_task': {
        const taskId = result?.task_id;
        if (taskId) {
          await db.update(tasks).set({ is_deleted: true }).where(eq(tasks.id, taskId));
          await db.insert(taskActivity).values({
            org_id: user.org_id,
            task_id: taskId,
            user_id: user.id,
            action: 'deleted',
          });
          await logAuditEvent({
            orgId: user.org_id,
            actorType: 'user',
            actorId: user.id,
            action: 'undo_create_task',
            entityType: 'task',
            entityId: taskId,
            beforeState: afterState,
            afterState: { is_deleted: true },
            metadata: { action_id: actionId },
          });
        }
        break;
      }

      case 'update_task_status': {
        const taskId = beforeState?.task_id || result?.task_id;
        const oldStatus = beforeState?.status;
        if (taskId && oldStatus) {
          await db.update(tasks).set({ status: oldStatus }).where(eq(tasks.id, taskId));
          await db.insert(taskActivity).values({
            org_id: user.org_id,
            task_id: taskId,
            user_id: user.id,
            action: 'status_changed',
            field: 'status',
            old_value: afterState?.status,
            new_value: oldStatus,
          });
          await logAuditEvent({
            orgId: user.org_id,
            actorType: 'user',
            actorId: user.id,
            action: 'undo_update_task_status',
            entityType: 'task',
            entityId: taskId,
            beforeState: afterState,
            afterState: beforeState,
            metadata: { action_id: actionId },
          });
        }
        break;
      }

      case 'assign_task': {
        const taskId = beforeState?.task_id || result?.task_id;
        const oldAssigneeId = beforeState?.assignee_id ?? null;
        if (taskId) {
          await db.update(tasks).set({ assignee_id: oldAssigneeId }).where(eq(tasks.id, taskId));
          await db.insert(taskActivity).values({
            org_id: user.org_id,
            task_id: taskId,
            user_id: user.id,
            action: 'field_changed',
            field: 'assignee',
            old_value: afterState?.assignee_id || null,
            new_value: oldAssigneeId,
          });
          await logAuditEvent({
            orgId: user.org_id,
            actorType: 'user',
            actorId: user.id,
            action: 'undo_assign_task',
            entityType: 'task',
            entityId: taskId,
            beforeState: afterState,
            afterState: beforeState,
            metadata: { action_id: actionId },
          });
        }
        break;
      }

      case 'post_message': {
        const messageId = result?.message_id;
        if (messageId) {
          await db.update(messages).set({ is_deleted: true }).where(eq(messages.id, messageId));
          await logAuditEvent({
            orgId: user.org_id,
            actorType: 'user',
            actorId: user.id,
            action: 'undo_post_message',
            entityType: 'message',
            entityId: messageId,
            beforeState: afterState,
            afterState: { is_deleted: true },
            metadata: { action_id: actionId },
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error('[undo] Failed to reverse action:', err);
    return c.json({
      error: 'Failed to undo action',
      code: 'UNDO_FAILED',
      detail: err instanceof Error ? err.message : 'Unknown error',
    }, 500);
  }

  await db
    .update(agentActions)
    .set({ undone_at: new Date() })
    .where(eq(agentActions.id, actionId));
  return c.json({ success: true });
});

agentRoutes.get('/actions', async (c) => {
  const user = c.get('user');

  // Phase 7 — LEFT JOIN action_receipts so the UI can show a "View receipt"
  // button only when there's something to show. We materialize has_receipt
  // via EXISTS rather than DISTINCT-on to keep one row per action regardless
  // of how many receipts are attached (future-proofing for re-execution).
  const rows = await db.execute(sql`
    SELECT agent_actions.*,
           EXISTS (SELECT 1 FROM action_receipts r WHERE r.action_id = agent_actions.id) AS has_receipt
    FROM agent_actions
    WHERE agent_actions.org_id = ${user.org_id}
      AND ${visibleActionSql(user)}
    ORDER BY agent_actions.created_at DESC
    LIMIT 100
  `);
  const rawRows = (rows as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  return c.json(rawRows);
});

// Phase 7 — fetch the most-recent receipt for an action and report whether
// the HMAC still verifies. The action log UI hits this on "View receipt".
//
// 404 semantics: if the action exists but has no receipt, we return 404 —
// this is how a compliance officer expects a missing record to surface.
// 403 semantics: if the action belongs to another org, also 404-like but
// we use 403 so the UI can distinguish "hidden by ACL" from "missing".
agentRoutes.get('/actions/:id/receipt', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select({ id: agentActions.id, org_id: agentActions.org_id })
    .from(agentActions)
    .where(eq(agentActions.id, actionId))
    .limit(1);

  if (!action) {
    return c.json({ error: 'action not found', code: 'NOT_FOUND' }, 404);
  }
  if (action.org_id !== user.org_id) {
    return c.json({ error: 'forbidden', code: 'FORBIDDEN' }, 403);
  }

  const [visibleAction] = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), visibleActionSql(user)))
    .limit(1);
  if (!visibleAction) {
    return c.json({ error: 'action not found', code: 'NOT_FOUND' }, 404);
  }
  const [receipt] = await db
    .select()
    .from(actionReceipts)
    .where(eq(actionReceipts.action_id, actionId))
    .orderBy(desc(actionReceipts.created_at))
    .limit(1);

  if (!receipt) {
    return c.json({ error: 'no receipt for action', code: 'NOT_FOUND' }, 404);
  }

  // Resolve approver + proposer display names so the viewer doesn't have
  // to probe /api/members separately.
  let approver_name: string | null = null;
  if (receipt.approver_id) {
    const [u] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, receipt.approver_id))
      .limit(1);
    approver_name = u?.name ?? null;
  }
  let proposer_name: string | null = null;
  if (receipt.employee_id) {
    const [e] = await db
      .select({ name: agentEmployees.name })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, receipt.employee_id))
      .limit(1);
    proposer_name = e?.name ?? null;
  }

  const { verifyReceipt } = await import('../lib/receipts.js');
  const verified = await verifyReceipt(receipt);

  return c.json({
    receipt: {
      ...receipt,
      approver_name,
      proposer_name,
    },
    verified,
  });
});

// ── Trust level settings ──

agentRoutes.get('/settings', async (c) => {
  const user = c.get('user');
  const [org] = await db
    .select({ trust_level: orgs.trust_level })
    .from(orgs)
    .where(eq(orgs.id, user.org_id))
    .limit(1);
  return c.json({ trust_level: org?.trust_level || 'conservative' });
});

const trustSettingsSchema = z.object({
  trust_level: z.enum(['conservative', 'standard', 'autonomous']),
}).strict();

// The org trust level governs background and automation runs (heartbeat,
// triggers, BYOA employee writes). Interactive chat turns are always
// approval-only regardless of it. Changing it is an org-admin decision.
agentRoutes.patch('/settings', async (c) => {
  const user = c.get('user');

  // Authorize from current active membership, not the session's role claim.
  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(
      eq(orgMembers.org_id, user.org_id),
      eq(orgMembers.user_id, user.id),
      eq(orgMembers.is_active, true),
    ))
    .limit(1);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return c.json({ error: 'Only workspace owners and admins can change the trust level', code: 'FORBIDDEN' }, 403);
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = trustSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid trust level', code: 'VALIDATION_ERROR' }, 400);
  }
  const { trust_level } = parsed.data;

  await db
    .update(orgs)
    .set({ trust_level })
    .where(eq(orgs.id, user.org_id));

  return c.json({ success: true, trust_level });
});
