import {collectCompilerReadFacts,validateCompilerGrounding} from './agent-compiler-read-facts.js';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { agentActions, messages, orgs, projects, tasks } from '@deft/db/schema';
import { getApprovalTier } from './agent-approval.js';
import { db } from './db.js';
import { getOrgAIConfig } from './org-ai-config.js';
import { resolveProjectTarget } from './resolve-project-target.js';
import { buildUntrustedWorkspaceContext } from './agent-untrusted-context.js';
import { visibleTaskCondition } from './task-visibility.js';
import { llm } from './llm.js';
import { truncatePlainText } from './plain-text.js';
import { ACTION_TOOLS, AGENT_TOOLS } from './agent-tools.js';
import { buildActionGraph, type ActionGraph } from './agent-action-graph.js';
import { syncApprovalToAttention } from './attention.js';
import {
  parseProjectTaskIdentifier,
  agentModuleActionClaimKey,
  agentModuleActionIdempotencyDigest,
  isModuleTaskLinkWriteAction,
  isModuleWriteAction,
  preflightAgentModuleAction,
  preflightAgentModuleBulkCreateAction,
  preflightAgentModuleActionWithExecutor,
  sameModuleActionInput,
  sanitizeModuleTaskLinkActionParamsForHistory,
} from './agent-actions.js';
import {
  isModuleRecordBulkCreateAction,
  sanitizeModuleBulkCreateParamsForHistory,
} from './module-record-bulk-create.js';
import {
  moduleMutationInputDigest,
  sanitizeModuleActionParamsForHistory,
} from './module-service.js';
import { sanitizeAgentMetadataForStorage } from './module-agent-history.js';
import {
  sanitizeWorkspacePlanImportParams,
  WORKSPACE_PLAN_IMPORT_ACTION,
} from './workspace-plan-import.js';
import {
  DOCUMENT_SEND_ACTION,
  sanitizeDocumentSendParams,
  validateDocumentSendDraft,
} from './document-send.js';

type ApprovalTier = 'auto' | 'quick' | 'full';

export type ProposedAgentAction = {
  action: string;
  params: Record<string, any>;
  approval_tier?: ApprovalTier;
  tool_use_id?: string | null;
  source?: string | null;
  agent_employee_id?: string | null;
  mcp_connection_id?: string | null;
  existing_action_id?: string;
  node_id?: string;
  depends_on?: string[];
  idempotency_key?: string;
};

type PersistReplyWithActionsParams = {
  orgId: string;
  spaceId: string;
  userId: string;
  agentUserId: string;
  content: string;
  parentId?: string | null;
  resolvePendingMessageId?: string;
  metadata: Record<string, any>;
  pendingActions: ProposedAgentAction[];
};

function safeActionParamsForMessage(action: string, actionParams: unknown): unknown {
  if (!isRecord(actionParams)) return actionParams;
  if (isModuleWriteAction(action)) {
    return sanitizeModuleActionParamsForHistory(action, actionParams);
  }
  if (isModuleRecordBulkCreateAction(action)) {
    return sanitizeModuleBulkCreateParamsForHistory(actionParams);
  }
  if (isModuleTaskLinkWriteAction(action)) {
    return sanitizeModuleTaskLinkActionParamsForHistory(actionParams);
  }
  if (action === WORKSPACE_PLAN_IMPORT_ACTION) {
    return sanitizeWorkspacePlanImportParams(actionParams);
  }
  if (action === DOCUMENT_SEND_ACTION) {
    return sanitizeDocumentSendParams(actionParams);
  }
  if(action==='email_send')return {account_id:actionParams.account_id,draft_id:actionParams.draft_id,draft_revision:actionParams.draft_revision,content_digest:actionParams.content_digest,review_url:actionParams.review_url};
  return actionParams;
}

function safePendingDraftForMessage(pending: unknown): unknown {
  if (!isRecord(pending)) return pending;
  const safeActions = (actions: unknown[]) => actions.map((action: unknown) => {
    if (!isRecord(action) || typeof action.action !== 'string') return action;
    return { ...action, params: safeActionParamsForMessage(action.action, action.params) };
  });
  if (Array.isArray(pending.draft)) return { ...pending, draft: safeActions(pending.draft) };
  if (!isRecord(pending.draft)) return pending;
  const draft = { ...pending.draft };
  for (const key of ['actions', 'pendingActions']) {
    if (Array.isArray(draft[key])) draft[key] = safeActions(draft[key]);
  }
  return { ...pending, draft };
}

export function sanitizeAgentReplyActionMetadata(metadata: Record<string, any>): Record<string, any> {
  const { pending_actions: _pendingActions, action_graph: graph, ...safe } = metadata;
  const safeMetadata = sanitizeAgentMetadataForStorage(safe);
  if (Object.hasOwn(safeMetadata, 'defty_pending')) {
    safeMetadata.defty_pending = safePendingDraftForMessage(safeMetadata.defty_pending);
  }
  if (!isRecord(graph) || !Array.isArray(graph.actions)) {
    return { ...safeMetadata, ...(graph === undefined ? {} : { action_graph: graph }) };
  }
  return {
    ...safeMetadata,
    action_graph: {
      ...graph,
      actions: graph.actions.map((node: unknown) => {
        if (!isRecord(node) || typeof node.tool !== 'string') return node;
        return {
          ...node,
          params: safeActionParamsForMessage(node.tool, node.params),
        };
      }),
    },
  };
}

/** Generated draft artifacts are not a substitute for the user's requested text. */
export function hasUnrequestedWikiPlaceholder(content: unknown, userRequest: string): boolean {
  const sentinel = '[existing content retained]';
  return typeof content === 'string' && content.toLowerCase().includes(sentinel)
    && !userRequest.toLowerCase().includes(sentinel);
}

/** The planned graph is evidence of intent; only actual rows describe proposals. */
export function reconcilePersistedProposalContent(content: string, actionNames: string[], rejected: string[], metadata: Record<string, any>, existingActionNames: string[] = []): string {
  const graph = isRecord(metadata.action_graph) && Array.isArray(metadata.action_graph.actions) ? metadata.action_graph.actions : null;
  const remaining = [...actionNames, ...existingActionNames];
  const omitted: string[] = [...rejected];
  for (const node of graph ?? []) {
    if (!isRecord(node) || typeof node.tool !== 'string') continue;
    const index = remaining.indexOf(node.tool);
    if (index >= 0) remaining.splice(index, 1);
    else if (!omitted.includes(node.tool)) omitted.push(node.tool);
  }
  const warnings = Array.isArray(metadata.proposal_preparation_warnings)
    ? metadata.proposal_preparation_warnings.filter((value: unknown): value is string => typeof value === 'string') : [];
  if (omitted.length === 0 && warnings.length === 0 && existingActionNames.length === 0 && (!graph || (remaining.length === 0 && graph.length === actionNames.length && graph.every((node: unknown) => isRecord(node) && typeof node.tool === 'string')))) return content;
  return [
    actionNames.length ? `I prepared ${actionNames.length} proposal${actionNames.length === 1 ? '' : 's'} for review.` : 'I could not prepare any approval proposals.',
    omitted.length ? `Not prepared: ${omitted.map(humanizeAction).join(', ')}. Verify the exact targets, current record revision, manifest digest, field changes and access before preparing these changes.` : '',
    existingActionNames.length ? `An existing request already represents: ${existingActionNames.map(humanizeAction).join(', ')}.` : '',
    ...warnings,
  ].filter(Boolean).join('\n\n');
}

/** Keep the generated message's rendered text surfaces in agreement. */
export function reconcileProposalTextBlocks(metadata: Record<string, any>, content: string, previousContent: string): Record<string, any> {
  if (content === previousContent || !Array.isArray(metadata.agent_blocks)) return metadata;
  let replaced = false;
  return { ...metadata, agent_blocks: metadata.agent_blocks.map((block: unknown) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
    const text = replaced ? '' : content; replaced = true;
    return { ...block, text };
  }) };
}

export async function persistAgentReplyWithActions(params: PersistReplyWithActionsParams) {
  const preparedPendingActions: ProposedAgentAction[] = [];
  const rejectedModuleActions: string[] = [];
  const rejectedOtherActions: string[] = [];
  for (const proposal of params.pendingActions) {
    if(proposal.source==='native_email'||proposal.action==='email_send')throw Error('RETIRED_NATIVE_ACTION');
    if ((proposal.action === 'add_dependency' || proposal.action === 'remove_dependency') && !validateRegisteredProposalAction(proposal).ok) {
      rejectedOtherActions.push(proposal.action); continue;
    }
    if (proposal.existing_action_id) {
      preparedPendingActions.push(proposal);
      continue;
    }
    try {
      const canonicalParams = await preflightAgentModuleAction(
        proposal.action,
        proposal.params,
        params.orgId,
        params.userId,
        proposal.agent_employee_id ?? undefined,
      );
      const bulkCanonicalParams = await preflightAgentModuleBulkCreateAction(
        proposal.action,
        canonicalParams,
        params.orgId,
        params.userId,
        proposal.agent_employee_id ?? undefined,
      );
      preparedPendingActions.push({ ...proposal, params: bulkCanonicalParams });
    } catch (error) {
      if (!isModuleWriteAction(proposal.action) && !isModuleRecordBulkCreateAction(proposal.action)) throw error;
      rejectedModuleActions.push(proposal.action);
      console.warn('[agent-action-proposals] Rejected module proposal before persistence', {
        action: proposal.action,
        orgId: params.orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const moduleIdempotencyDigests = new Map<ProposedAgentAction, string>();
  for (const proposal of preparedPendingActions) {
    const digest = await agentModuleActionIdempotencyDigest(
      proposal.action,
      proposal.params,
      params.orgId,
      params.userId,
      proposal.agent_employee_id ?? undefined,
    );
    if (digest) moduleIdempotencyDigests.set(proposal, digest);
  }

  const persisted = await db.transaction(async (tx) => {
    const resolvePendingClarifications = async (currentMessageId: string) => {
      if (!params.resolvePendingMessageId) return;
      const pendingScope = and(
        eq(messages.id, params.resolvePendingMessageId),
        eq(messages.org_id, params.orgId),
        eq(messages.space_id, params.spaceId),
        eq(messages.user_id, params.agentUserId),
      );
      const [pending] = await tx.select({ metadata: messages.metadata }).from(messages)
        .where(pendingScope).limit(1);
      if (!pending || !isRecord(pending.metadata) || pending.metadata.defty_pending?.kind !== 'action_draft'
        || typeof pending.metadata.defty_pending.request_message_id !== 'string') return;
      const requestScope = and(
        eq(messages.org_id, params.orgId),
        eq(messages.space_id, params.spaceId),
        eq(messages.user_id, params.agentUserId),
        sql`${messages.id} <> ${currentMessageId}`,
        sql`${messages.metadata}->'defty_pending'->>'kind' = 'action_draft'`,
        sql`${messages.metadata}->'defty_pending'->>'request_message_id' = ${pending.metadata.defty_pending.request_message_id}`,
        sql`${messages.metadata}->>'defty_pending_resolved_at' IS NULL`,
      );
      // A request may have accumulated several clarification questions. Every
      // answer consumes all of them, whether it produced a proposal, a new
      // question or no action at all. Lock them in a stable order and retire
      // them atomically with the reply so an older draft cannot be revived.
      const clarifications = await tx.select({ id: messages.id }).from(messages)
        .where(requestScope).orderBy(messages.id).for('update');
      if (!clarifications.length) return;
      await tx.update(messages).set({
        metadata: sql`${messages.metadata} || ${JSON.stringify({ defty_pending_resolved_at: new Date().toISOString() })}::jsonb`,
      }).where(and(requestScope, inArray(messages.id, clarifications.map(row => row.id))));
    };
    const moduleClaimKeys = preparedPendingActions
      .flatMap((proposal) => {
        const digest = moduleIdempotencyDigests.get(proposal);
        return digest ? [agentModuleActionClaimKey(params.orgId, proposal.action, digest)] : [];
      });
    for (const lockKey of [...new Set(moduleClaimKeys)].sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    }

    // Repeat module authorization inside the action-insert transaction while
    // holding the installation row lock. A concurrent disable/write-revoke
    // must therefore either see and expire this proposal, or commit first and
    // make this preflight reject before raw review values are persisted.
    const rejectedAtBoundary = new Set<ProposedAgentAction>();
    const modulePreflightOrder = preparedPendingActions
      .filter((proposal) => !proposal.existing_action_id && isModuleWriteAction(proposal.action))
      .sort((left, right) => {
        const leftIdentity = String(left.params.module_id ?? left.params.record_id ?? '');
        const rightIdentity = String(right.params.module_id ?? right.params.record_id ?? '');
        return `${left.action}:${leftIdentity}`.localeCompare(`${right.action}:${rightIdentity}`);
      });
    for (const proposal of modulePreflightOrder) {
      try {
        const canonicalParams = await preflightAgentModuleActionWithExecutor(
          tx,
          proposal.action,
          proposal.params,
          params.orgId,
          params.userId,
          proposal.agent_employee_id ?? undefined,
        );
        proposal.params = canonicalParams as Record<string, any>;
      } catch (error) {
        rejectedAtBoundary.add(proposal);
        rejectedModuleActions.push(proposal.action);
        console.warn('[agent-action-proposals] Rejected module proposal at transaction boundary', {
          action: proposal.action,
          orgId: params.orgId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const readyActions = preparedPendingActions.filter(
      (proposal) => !rejectedAtBoundary.has(proposal),
    );

    const novelActions: ProposedAgentAction[] = [];
    const duplicateActions: Array<typeof agentActions.$inferSelect> = [];
    const seenKeys = new Set<string>();
    const seenModuleClaims = new Map<string, ProposedAgentAction>();
    for (const action of readyActions) {
      if (action.existing_action_id) continue;
      const key = typeof action.params.idempotency_key === 'string' ? action.params.idempotency_key : '';
      if (!key) {
        novelActions.push(action);
        continue;
      }
      const digest = moduleIdempotencyDigests.get(action);
      if (digest) {
        const claimKey = agentModuleActionClaimKey(params.orgId, action.action, digest);
        const inBatch = seenModuleClaims.get(claimKey);
        if (inBatch) {
          if (!sameModuleActionInput(inBatch.params, action.params)) {
            throw new Error('Idempotency key was already used for a different module mutation');
          }
          continue;
        }
        seenModuleClaims.set(claimKey, action);
      } else {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      const actorScope = action.agent_employee_id
        ? eq(agentActions.agent_employee_id, action.agent_employee_id)
        : and(
          eq(agentActions.user_id, params.userId),
          sql`${agentActions.agent_employee_id} IS NULL`,
        );
      const [existing] = await tx
        .select()
        .from(agentActions)
        .where(and(
          eq(agentActions.org_id, params.orgId),
          digest ? eq(agentActions.action, action.action) : sql`true`,
          digest ? actorScope : eq(agentActions.user_id, params.userId),
          inArray(agentActions.approval_status, ['pending', 'approved']),
          digest
            ? or(
              sql`${agentActions.params}->>'idempotency_key' = ${key}`,
              sql`${agentActions.params}->>'idempotency_digest' = ${digest}`,
            )
            : sql`${agentActions.params}->>'idempotency_key' = ${key}`,
        ))
        .limit(1);
      if (existing) {
        if (digest) {
          const existingParams = isRecord(existing.params) ? existing.params : {};
          if (
            existingParams.idempotency_key === key
            && !sameModuleActionInput(existingParams, action.params)
          ) {
            throw new Error('Idempotency key was already used for a different module mutation');
          }
          const inputDigest = moduleMutationInputDigest(
            action.action === 'module_record_create' ? 'create'
              : action.action === 'module_record_update' ? 'update'
                : 'archive',
            action.params,
          );
          if (
            existingParams.idempotency_digest === digest
            && typeof existingParams.input_digest === 'string'
            && existingParams.input_digest !== inputDigest
          ) {
            throw new Error('Idempotency key was already used for a different module mutation');
          }
        }
        duplicateActions.push(existing);
      } else novelActions.push(action);
    }

    const duplicateOnly = readyActions.length > 0 && novelActions.length === 0 && duplicateActions.length > 0;
    const messageContent = rejectedModuleActions.length > 0 && readyActions.length === 0
      ? 'I could not safely prepare that module change. Refresh the module schema or permissions, then try again.'
      : duplicateOnly
      ? duplicateActions.every((action) => action.approval_status === 'approved')
        ? 'This request was already approved and completed.'
        : 'I already drafted this request. Use the existing approval card to review it.'
      : params.content;
    const messageMetadata = {
      ...sanitizeAgentReplyActionMetadata(params.metadata),
      duplicate_action_ids: duplicateActions.length > 0 ? duplicateActions.map((action) => action.id) : undefined,
      rejected_module_actions: rejectedModuleActions.length > 0 ? rejectedModuleActions : undefined,
      rejected_action_proposals: rejectedOtherActions.length > 0 ? rejectedOtherActions : undefined,
    };
    const [agentMessage] = await tx
      .insert(messages)
      .values({
        org_id: params.orgId,
        space_id: params.spaceId,
        user_id: params.agentUserId,
        content: messageContent,
        parent_id: params.parentId ?? null,
        metadata: messageMetadata as never,
      })
      .returning();

    if (!agentMessage) throw new Error('Failed to create agent reply message');

    const linkedActions: Array<typeof agentActions.$inferSelect> = [];
    for (const proposal of readyActions) {
      if (!proposal.existing_action_id) continue;
      const [linked] = await tx
        .update(agentActions)
        .set({
          conversation_id: params.spaceId,
          message_id: agentMessage.id,
          tool_use_id: proposal.tool_use_id ?? null,
        })
        .where(and(
          eq(agentActions.id, proposal.existing_action_id),
          eq(agentActions.org_id, params.orgId),
          eq(agentActions.user_id, params.userId),
          eq(agentActions.approval_status, 'pending'),
        ))
        .returning();
      if (linked) linkedActions.push(linked);
    }

    if (novelActions.length === 0) {
      const inlineActions = linkedActions.map((action) => ({
        id: action.id,
        action: action.action,
        params: safeActionParamsForMessage(action.action, action.params),
        approval_tier: action.approval_tier,
        status: action.approval_status,
      }));
      const finalMetadata = {
        ...messageMetadata,
        pending_actions: inlineActions.length > 0 ? inlineActions : undefined,
      };
      const finalContent = duplicateOnly ? messageContent : reconcilePersistedProposalContent(messageContent, linkedActions.map(action => action.action), [...rejectedModuleActions, ...rejectedOtherActions], messageMetadata, duplicateActions.map(action => action.action));
      const coherentMetadata = reconcileProposalTextBlocks(finalMetadata, finalContent, params.content);
      await tx.update(messages).set({ content: finalContent, metadata: coherentMetadata as never }).where(eq(messages.id, agentMessage.id));
      await resolvePendingClarifications(agentMessage.id);
      return {
        message: { ...agentMessage, content: finalContent, metadata: coherentMetadata as never },
        actions: linkedActions,
        duplicates: duplicateActions,
      };
    }

    const actions = await tx
      .insert(agentActions)
      .values(
        novelActions.map((p) => ({
          org_id: params.orgId,
          user_id: params.userId,
          conversation_id: params.spaceId,
          message_id: agentMessage.id,
          action: p.action,
          params: p.params,
          approval_tier: normalizeApprovalTier(p),
          approval_status: 'pending' as const,
          source: p.source ?? 'mention',
          tool_use_id: p.tool_use_id ?? null,
          agent_employee_id: p.agent_employee_id ?? null,
          mcp_connection_id: p.mcp_connection_id ?? null,
        })),
      )
      .returning();

    const persistedActions = [...linkedActions, ...actions];
    const inlineActions = persistedActions.map((action) => ({
      id: action.id,
      action: action.action,
      params: safeActionParamsForMessage(action.action, action.params),
      approval_tier: action.approval_tier,
      status: action.approval_status,
    }));
    const finalMetadata = {
      ...messageMetadata,
      pending_actions: inlineActions,
    };
    const finalContent = reconcilePersistedProposalContent(messageContent, persistedActions.map(action => action.action), [...rejectedModuleActions, ...rejectedOtherActions], messageMetadata, duplicateActions.map(action => action.action));
    const coherentMetadata = reconcileProposalTextBlocks(finalMetadata, finalContent, params.content);
    await tx.update(messages).set({ content: finalContent, metadata: coherentMetadata as never }).where(eq(messages.id, agentMessage.id));

    await resolvePendingClarifications(agentMessage.id);
    return {
      message: { ...agentMessage, content: finalContent, metadata: coherentMetadata as never },
      actions: persistedActions,
      duplicates: duplicateActions,
    };
  });
  await Promise.all(persisted.actions.map((action) =>
    syncApprovalToAttention(action).catch((error) => {
      console.warn('[agent-action-proposals] Approval attention dual-write failed', {
        actionId: action.id,
        error: error instanceof Error ? error.message : String(error),
      });
    })
  ));
  return persisted;
}

function normalizeApprovalTier(action: ProposedAgentAction): ApprovalTier {
  const tier = action.approval_tier ?? getApprovalTier(action.action);
  return tier === 'auto' ? 'quick' : tier;
}

export type CompiledActionDraft = {
  actions: ProposedAgentAction[];
  graph: ActionGraph;
  warnings?: string[];
  clarification?: string;
  pendingActions?: ProposedAgentAction[];
  summary?: string;
  metrics: {
    duration_ms: number;
    tokens_in: number;
    tokens_out: number;
    model: string;
  };
};

export type PendingDeftyActionDraft = {
  request_message_id: string;
  request_text: string;
  draft: unknown;
  question?: string;
  answer: string;
};

export type DeftyTaskReference = { id?: string; identifier: string; title: string };

export type CompileDeftyActionDraftParams = {
  successfulReadActions?: Parameters<typeof collectCompilerReadFacts>[0];
  orgId: string;
  requesterId?: string;
  sourceSpaceId?: string;
  promptContent: string;
  pendingDraft?: PendingDeftyActionDraft;
  projectCandidates?: string[];
  priorTaskCandidates?: DeftyTaskReference[];
  agentReplyText?: string;
  sourceMessageId: string;
  projectNameHint?: string | null;
  priorTaskReferences?: string[];
  spaceName?: string | null;
  callerName?: string | null;
  allowedActionNames?: string[];
};

const CLARIFICATION_TOOL = {
  name: 'request_action_clarification',
  description: 'Ask one concise question only when a required write target cannot be inferred safely.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The single clarification question to ask.' },
      summary: { type: 'string', description: 'What is already understood about the requested action.' },
      draft_actions: {
        type: 'array',
        description: 'Already understood action drafts, including known owner, date and source. Missing required fields are allowed here; these are not approval actions.',
        items: { type: 'object', properties: { action: { type: 'string' }, params: { type: 'object' } }, required: ['action', 'params'] },
      },
    },
    required: ['question'],
  },
};

/** The compiler and executor share one action vocabulary. */
export function getActionCompilerTools() {
  return [
    ...AGENT_TOOLS.filter((tool) => ACTION_TOOLS.has(tool.name)),
    CLARIFICATION_TOOL,
  ];
}

export function getActionCompilerToolsForPrompt(promptContent: string, allowedActionNames?: string[]) {
  const allowlist = allowedActionNames?.length ? new Set(allowedActionNames) : null;
  const tools = allowlist
    ? getActionCompilerTools().filter((tool) => allowlist.has(tool.name) || tool.name === CLARIFICATION_TOOL.name)
    : getActionCompilerTools();
  if (/\b(?:remind\s+me|create\s+(?:a\s+)?reminder|set\s+(?:a\s+)?reminder)\b/i.test(promptContent)) {
    return tools.filter((tool) => tool.name === 'create_reminder');
  }
  return tools;
}

function hasExplicitOutcomeLabelForEveryTask(plain: string, taskCount: number): boolean {
  const ordinalLabels = new Set<string>();
  const ordinalAliases: Record<string, string> = {
    first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
    sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  };
  const labelPattern = /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\s+(?:task|todo|ticket)\s+(?:title\s*:|outcome\s+is\s*:)\s*(?=(?:["'‘“]\s*)?[\p{L}\p{N}])/giu;
  for (const match of plain.matchAll(labelPattern)) {
    const ordinal = match[1]!.toLowerCase();
    ordinalLabels.add(ordinalAliases[ordinal] ?? ordinal.replace(/(?:st|nd|rd|th)$/i, ''));
  }
  return ordinalLabels.size >= taskCount;
}

export function validateCompiledIntentAlignment(
  promptContent: string,
  actions: ProposedAgentAction[],
  params: Pick<CompileDeftyActionDraftParams, 'projectNameHint' | 'projectCandidates'>,
): { blocked: boolean; clarification?: string } {
  const plain = promptContent.replace(/\s+/g, ' ').trim();
  const explicitNoWrite = /\b(?:do\s+not|don't|dont|never)\s+(?:create|queue|post|send|write|save|record|update|edit|change|mark|move|close|assign)(?:\s+or\s+(?:create|queue|post|send|write|update))?\s+(?:any\s+)?(?:tasks?|actions?|changes?|messages?|posts?|pages?|notes?|documents?|files?|reports?|spreadsheets?|reminders?)\b/i.test(plain);
  if (explicitNoWrite) {
    return {
      blocked: true,
      clarification: 'Understood. I will not queue or execute that change.',
    };
  }

  const readOnlyLead = /^(?:please\s+)?(?:read|show|list|search|find|explain|summarize|summarise|what|which|who|when|where|how)\b/i.test(plain);
  const explicitWriteVerb = /\b(?:create|queue|post|send|write|save|record|update|edit|change|set|mark|move|close|reopen|assign|comment|link|unlink|remove|convert|remind)\b/i.test(plain);
  if (readOnlyLead && !explicitWriteVerb && actions.length > 0) {
    return { blocked: true };
  }

  const requestsReminder = /\b(?:remind\s+me|create\s+(?:a\s+)?reminder|set\s+(?:a\s+)?reminder)\b/i.test(plain);
  if (requestsReminder && actions.length > 0 && !actions.some((action) => action.action === 'create_reminder')) {
    return {
      blocked: true,
      clarification: 'I could not safely draft that as a reminder. Please include when you want to be reminded.',
    };
  }

  const taskActions = actions.filter((action) => action.action === 'create_task');
  if (taskActions.length > 0) {
    const suppliedOutcome = /\b(?:titled|called|named|name\s+(?:it|this))\b/i.test(plain)
      || /\b(?:task|todo|ticket)\s+(?:to|for|about)\s+\S/i.test(plain)
      || /\b(?:need|needs|should|must)\s+to\s+\S/i.test(plain)
      || hasExplicitOutcomeLabelForEveryTask(plain, taskActions.length);
    if (!suppliedOutcome) {
      return {
        blocked: true,
        clarification: 'What should this task accomplish? Give me a title or a concrete outcome.',
      };
    }

    const hasProjectHint = Boolean(params.projectNameHint?.trim());
    const suppliedProject = taskActions.some((action) => {
      const projectName = typeof action.params.project_name === 'string' ? action.params.project_name.trim() : '';
      return projectName.length > 0 && plain.toLowerCase().includes(projectName.toLowerCase());
    }) || /\bproject\b/i.test(plain);
    if (!hasProjectHint && !suppliedProject) {
      return {
        blocked: true,
        clarification: params.projectCandidates?.length
          ? `Which project should this task belong to: ${params.projectCandidates.slice(0, 5).join(', ')}?`
          : 'Which project should this task belong to?',
      };
    }
  }

  return { blocked: false };
}

export function resolveCompiledIntentOutcome(
  prompt: string,
  actions: ProposedAgentAction[],
  params: Pick<CompileDeftyActionDraftParams, 'projectNameHint' | 'projectCandidates'>,
  targetedQuestion?: string,
): { actions: ProposedAgentAction[]; clarification?: string; substitutionRejected: boolean; blocked: boolean } {
  // Quoted source content and references to existing tasks are not task requests.
  const request = prompt.replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  const nonTaskMutation = /\b(?:update|edit|change|set|append)\b/i.test(request)
    && /\b(?:CRM\s+contact|module\s+record|wiki(?:\s+page)?)\b/i.test(request);
  const requestedTask = /\b(?:create|add|queue|draft|prepare|make)\s+(?:(?:a|an|the|new|another|one|two|three|project|urgent|follow-up|high-priority|low-priority|small|separate)\s+){0,6}(?:tasks?|todos?|tickets?)\b/i.test(request)
    || /\b(?:need|want|request)\s+(?:a\s+)?(?:tasks?|todos?|tickets?)\s+(?:to|for|about|titled|called|named)\b/i.test(request);
  const filtered = nonTaskMutation && !requestedTask ? actions.filter((action) => action.action !== 'create_task') : actions;
  const alignment = validateCompiledIntentAlignment(prompt, filtered, params);
  const accepted = alignment.blocked ? [] : filtered;
  return {
    actions: accepted,
    clarification: alignment.clarification ?? (accepted.length === 0 ? targetedQuestion : undefined),
    substitutionRejected: filtered.length !== actions.length,
    blocked: alignment.blocked,
  };
}

export async function compileDeftyActionDraft(params: CompileDeftyActionDraftParams): Promise<CompiledActionDraft> {
  const startedAt = Date.now();
  if (params.pendingDraft) {
    params = { ...params, sourceMessageId: params.pendingDraft.request_message_id,
      promptContent: `${params.pendingDraft.request_text}\n\nClarification answer: ${params.pendingDraft.answer}` };
  }
  const orgConfig = await getOrgAIConfig(params.orgId).catch(() => undefined);
  const knownProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      is_archived: projects.is_archived,
      is_deleted: projects.is_deleted,
    })
    .from(projects)
    .where(and(eq(projects.org_id, params.orgId), eq(projects.is_archived, false), eq(projects.is_deleted, false)))
    .limit(50)
    .catch(() => []);
  const defaultProject = !params.projectNameHint
    ? await resolveProjectTarget(params.orgId, { sourceSpaceId: params.sourceSpaceId, requesterId: params.requesterId }).catch(() => null)
    : null;
  params = {
    ...params,
    projectNameHint: params.projectNameHint || (defaultProject?.status === 'resolved' ? defaultProject.project.name : null),
    projectCandidates: knownProjects.map((project) => project.name).slice(0, 5),
  };
  const [orgClock] = await db
    .select({ timezone: orgs.timezone })
    .from(orgs)
    .where(eq(orgs.id, params.orgId))
    .limit(1)
    .catch(() => []);
  const groundedReadFacts=collectCompilerReadFacts(params.successfulReadActions??[]);
  const result = await llm({
    task: 'extract',
    maxTokens: 1200,
    orgConfig: orgConfig as any,
    system: [
      'You convert a Defty chat request into one or more registered Deft write tool calls.',
      'Call the exact matching write tool. Never substitute a task for a wiki, note, message, canvas, decision, or other requested object.',
      'A reminder request must use create_reminder, never create_task.',
      'Resolve relative reminder times using current_time_iso and org_timezone from the request context.',
      'Reminder content is the reminder title/body; never ask for a separate reminder title.',
      'When org_timezone is provided, treat it as the user local timezone and do not ask for another timezone.',
      'If the user explicitly says not to create, queue, post, or change something, return no write tool calls.',
      'Read-only requests such as read, show, list, search, or explain must return no write tool calls.',
      'Do not execute anything. These actions will become approval cards.',
      'grounded_read_facts contains successful same-turn authorized reads. For module updates use its exact record ID, revision, manifest digest and explicit requested patch; never invent these fields.',
      'For an existing wiki use the exact read slug and current full body. An append must include the real current body followed by the requested literal addition, never preservation instructions or placeholders. If facts are unavailable ask for a grounded lookup instead of inventing a target.',
      'Use request_action_clarification only when a required target cannot be inferred safely. Include draft_actions containing everything already understood, especially the original assignee, due date and source message.',
      'When asking which task, name every candidate as KEY "exact title" using prior_task_candidates. Never paraphrase a task title.',
      'If a pending clarification is supplied, complete its original draft using the clarification answer. Preserve its owner, due date and original source unless the user explicitly corrects them.',
      'Required for create_task: title and project_name. Use an exact project name from known_projects whenever possible.',
      'The task title or concrete outcome must come from the user request. Never invent the work itself.',
      'If a project hint is supplied, use it. If the user gives an informal project phrase, choose the closest exact known project name.',
      'When no project is named, use the project hint. With exactly one known active project use it. With several and no hint, ask which project and name up to five candidates; never choose arbitrarily.',
      'Optional for create_task: assignee_name, priority, due_date, description, subtasks.',
      'Missing priority should default to p2. Missing due date is allowed and means no due date.',
      'For create_task descriptions, write concise markdown: short summary plus bullets when useful. Do not create an unformatted text wall.',
      'If subtasks are requested, put them in subtasks and keep the parent task description brief.',
      'Preserve subtask ordering as dependencies: when a later subtask says "after that", "after the previous step", or "after the draft", set depends_on to the matching earlier subtask using 1-based indexes.',
      'If the user says "me" or "myself", use caller_name as assignee_name when caller_name is provided.',
      'If the request refers to "all three", "both", or "those tasks", use the supplied prior task references.',
      'For ambiguous channel names, ask a clarification instead of guessing.',
      'Return no actions for read-only questions.',
    ].join('\n'),
    tools: getActionCompilerToolsForPrompt(params.promptContent, params.allowedActionNames),
    messages: [{
      role: 'user',
      content: buildUntrustedWorkspaceContext([JSON.stringify({
        grounded_read_facts: groundedReadFacts,
        user_request: params.promptContent,
        pending_clarification: params.pendingDraft ?? null,
        prior_task_candidates: params.priorTaskCandidates ?? [],
        prior_defty_reply: params.agentReplyText ?? '',
        project_name_hint: params.projectNameHint ?? null,
        source_message_id: params.sourceMessageId,
        prior_task_references: params.priorTaskReferences ?? [],
        known_projects: knownProjects,
        current_space_name: params.spaceName ?? null,
        caller_name: params.callerName ?? null,
        current_time_iso: new Date().toISOString(),
        org_timezone: orgClock?.timezone ?? 'UTC',
      })])!,
    }],
  });

  const parsedText = parseFirstJsonObject(result.text);
  const clarificationCall = result.toolCalls?.find((call) => call.name === CLARIFICATION_TOOL.name)?.input;
  const clarificationInput = isRecord(clarificationCall) ? clarificationCall : isRecord(parsedText) ? parsedText : null;
  const targetedQuestion = clarificationInput && typeof clarificationInput.question === 'string'
    ? truncatePlainText(clarificationInput.question.trim(), 400) : undefined;
  const clarificationDrafts = Array.isArray(clarificationInput?.draft_actions)
    ? normalizeCompiledToolCalls(clarificationInput.draft_actions.filter(isRecord).map((action: Record<string, any>) => ({ name: action.action, input: action.params })), params)
    : null;
  let rawNormalized = normalizeCompiledToolCalls(result.toolCalls ?? [], params);
  // Required project fields can be supplied by the safe singleton resolution,
  // even when the model unnecessarily returned a project question.
  const answeredProjectQuestion = Boolean(params.projectNameHint && targetedQuestion && /\b(?:which|what)\b.*\bproject\b|\bproject\b.*\b(?:which|what)\b/i.test(targetedQuestion));
  if (rawNormalized.actions.length === 0 && answeredProjectQuestion && clarificationDrafts?.actions.length) {
    rawNormalized = clarificationDrafts;
  }
  const grounded = validateCompilerGrounding(rawNormalized.actions, groundedReadFacts, params.promptContent);
  const initiallyNormalized = { ...rawNormalized, actions: grounded.actions, warnings: [...(rawNormalized.warnings ?? []), ...groundedReadFacts.limitations, ...grounded.warnings] };
  const intentOutcome = resolveCompiledIntentOutcome(params.promptContent, initiallyNormalized.actions, params, answeredProjectQuestion ? undefined : targetedQuestion);
  const normalized = { ...initiallyNormalized, actions: intentOutcome.actions, summary: intentOutcome.blocked || (intentOutcome.substitutionRejected && intentOutcome.actions.length === 0) ? undefined : initiallyNormalized.summary };
  if (intentOutcome.substitutionRejected) normalized.warnings = [...normalized.warnings, 'Task substitution was not prepared: this request targets a CRM record or wiki page, not a new task.'];
  let clarification = intentOutcome.clarification;
  const clarificationKeys = [...new Set([...((clarification ?? '').matchAll(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/gi))]
    .map((match) => match[0].toUpperCase()))].slice(0, 5);
  if (params.requesterId && clarificationKeys.length > 0 && !params.priorTaskCandidates?.length) {
    const candidates = await db.select({ id: tasks.id,
      identifier: sql<string>`${projects.prefix} || '-' || ${tasks.number}`, title: tasks.title })
      .from(tasks).innerJoin(projects, and(eq(projects.id, tasks.project_id), eq(projects.org_id, params.orgId)))
      .where(and(eq(tasks.org_id, params.orgId), eq(tasks.is_deleted, false),
        eq(projects.is_deleted, false), eq(projects.is_archived, false), visibleTaskCondition(params.requesterId),
        inArray(sql`${projects.prefix} || '-' || ${tasks.number}`, clarificationKeys))).limit(5).catch(() => []);
    params = { ...params, priorTaskCandidates: candidates };
  }
  if (clarification && !/\bproject\b/i.test(clarification) && (/which.*(?:task|review)|(?:task|review).*which/i.test(clarification) || clarificationKeys.length > 1) && params.priorTaskCandidates?.length) {
    clarification = `Which task do you mean: ${formatDeftyTaskCandidates(params.priorTaskCandidates)}?`;
  }
  const pendingActions = rawNormalized.pendingActions?.length ? rawNormalized.pendingActions
    : rawNormalized.actions.length ? rawNormalized.actions
    : clarificationDrafts?.pendingActions?.length ? clarificationDrafts.pendingActions : clarificationDrafts?.actions;
  console.info('[agent-action-compiler] outcome', {
    reason: intentOutcome.substitutionRejected ? 'unrequested_task_substitution' : clarification ? 'clarification' : 'actions',
    raw_action_count: rawNormalized.actions.length, accepted_action_count: normalized.actions.length,
    tool_names: [...new Set((result.toolCalls ?? []).map((call) => call.name).filter((name) => typeof name === 'string' && (ACTION_TOOLS.has(name) || name === CLARIFICATION_TOOL.name)))].slice(0, 12),
    grounded_read_counts: { module_record_query: groundedReadFacts.facts.filter((fact) => fact.tool === 'module_record_query').length, module_record_get: groundedReadFacts.facts.filter((fact) => fact.tool === 'module_record_get').length, wiki_read: groundedReadFacts.facts.filter((fact) => fact.tool === 'wiki_read').length },
  });
  const concreteSummary = formatDeftyApprovalReply(normalized.actions, params.priorTaskCandidates);
  const summary = concreteSummary ?? (clarificationInput && typeof clarificationInput.summary === 'string'
    ? truncatePlainText(clarificationInput.summary.trim(), 300)
    : normalized.summary);

  const graph = buildActionGraph(normalized.actions, params.sourceMessageId, summary ?? '');
  const actions = normalized.actions.map((action, index) => {
    const node = graph.actions[index]!;
    return {
      ...action,
      node_id: node.id,
      depends_on: node.depends_on,
      idempotency_key: node.idempotency_key,
      params: {
        ...action.params,
        proposal_node_id: node.id,
        proposal_depends_on: node.depends_on,
        idempotency_key: node.idempotency_key,
      },
    };
  });
  const draft: CompiledActionDraft = {
    actions,
    graph,
    metrics: {
      duration_ms: Date.now() - startedAt,
      tokens_in: result.usage?.input ?? 0,
      tokens_out: result.usage?.output ?? 0,
      model: result.model,
    },
  };
  if (normalized.warnings?.length) draft.warnings = normalized.warnings;
  if (clarification) {
    draft.clarification = clarification;
    if (pendingActions?.length) draft.pendingActions = pendingActions;
  }
  if (summary) draft.summary = summary;
  return draft;
}

/** Exact database titles are data, never a paraphrasing opportunity. */
export function formatDeftyTaskCandidates(tasks: DeftyTaskReference[]): string {
  return tasks.slice(0, 5).map((task) => `${task.identifier} "${task.title}"`).join(' or ');
}

/** Format only changes for which concrete task identities are available. */
export function formatDeftyApprovalReply(actions: ProposedAgentAction[], tasks: DeftyTaskReference[] = []): string | null {
  if (!actions.length) return null;
  const changes = new Map<string, { target: string; details: string[] }>();
  const statuses: Record<string, string> = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done', cancelled: 'Cancelled' };
  for (const action of actions) {
    const p = action.params;
    if (action.action === 'create_task') {
      if (typeof p.title !== 'string') return null;
      const details = [typeof p.project_name === 'string' ? `in ${p.project_name}` : '', typeof p.assignee_name === 'string' ? `assigned to ${p.assignee_name}` : '', typeof p.due_date === 'string' ? `due ${p.due_date}` : ''].filter(Boolean);
      changes.set(`create:${changes.size}`, { target: `create "${p.title}"`, details });
      continue;
    }
    if (action.action !== 'update_task_status' && action.action !== 'assign_task') return null;
    const requestedIdentifier = stringValue(p.task_identifier) || stringValue(p.resolved_task_identifier);
    const task = tasks.find((candidate) => candidate.identifier.toUpperCase() === requestedIdentifier.toUpperCase()
      || Boolean(candidate.id && (candidate.id === requestedIdentifier || candidate.id === p.resolved_task_id)));
    const identifier = task?.identifier ?? requestedIdentifier;
    const title = task?.title ?? (typeof p.resolved_task_title === 'string' ? p.resolved_task_title : typeof p.task_title === 'string' ? p.task_title : null);
    if (!identifier || title === null) return null;
    const change = changes.get(identifier.toUpperCase()) ?? { target: `${identifier} "${title}"`, details: [] };
    if (action.action === 'update_task_status') {
      const status = statuses[stringValue(p.new_status)];
      if (!status) return null;
      change.details.push(`→ ${status}`);
    } else {
      const assignee = stringValue(p.assignee_name) || stringValue(p.resolved_assignee_name);
      if (!assignee) return null;
      change.details.push(`assigned to ${assignee}`);
    }
    changes.set(identifier.toUpperCase(), change);
  }
  const summaries = [...changes.values()].map(({ target, details }) => `${target}${details.length ? ` ${details.join(', ')}` : ''}`);
  return `Drafted for approval: ${summaries.join('; ')}.`;
}

function pendingDraftActions(params: CompileDeftyActionDraftParams): ProposedAgentAction[] {
  const draft = params.pendingDraft?.draft;
  const actions = Array.isArray(draft) ? draft : isRecord(draft) && Array.isArray(draft.actions) ? draft.actions : [];
  return actions.filter((action): action is ProposedAgentAction => isRecord(action) && typeof action.action === 'string' && isRecord(action.params));
}

const DATE_EXPRESSION = /\b(?:due|by|today|tomorrow|tonight|next\s+week|next\s+month|end\s+of\s+(?:the\s+)?(?:week|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b|\bmay\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)\b|\d{4}-\d{2}-\d{2}/i;

function draftValueWords(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function mentionsValue(text: string, value: string): boolean {
  const words = new Set(draftValueWords(text));
  return draftValueWords(value).some(word => word.length > 1 && words.has(word));
}

/** The new value must add a word the old value did not have. */
function mentionsDistinctValue(text: string, value: string, previous: string): boolean {
  const words = new Set(draftValueWords(text));
  const previousWords = new Set(draftValueWords(previous));
  return draftValueWords(value).some(word => word.length > 1 && !previousWords.has(word) && words.has(word));
}

function draftReplacementPairs(answer: string): Array<{ previous: string; next: string }> {
  const pairs: Array<{ previous: string; next: string }> = [];
  const patterns: Array<[RegExp, number, number]> = [
    [/([^,;\n]+?)\s+(?:instead of|rather than|in place of)\s+([^,;\n]+)/gi, 2, 1],
    [/\bnot\s+([^,;\n]+?)\s*(?:[,;]\s*|\s+but\s+)([^,;\n]+)/gi, 1, 2],
    [/\bchange(?:d|s|ing)?\s+(?:from\s+)?([^,;\n]+?)\s+to\s+([^,;\n]+)/gi, 1, 2],
    [/\breplace(?:d|s|ing)?\s+([^,;\n]+?)\s+(?:with|by)\s+([^,;\n]+)/gi, 1, 2],
    [/([^,;\n]+?)\s*(?:->|→)\s*([^,;\n]+)/gi, 1, 2],
  ];
  for (const [pattern, previousIndex, nextIndex] of patterns) {
    for (const match of answer.matchAll(pattern)) {
      const previous = match[previousIndex]?.trim();
      const next = match[nextIndex]?.trim();
      if (previous && next) pairs.push({ previous, next });
    }
  }
  return pairs;
}

function draftReplacementValues(answer: string): string[] {
  const values: string[] = [];
  const patterns = [
    /\b(?:make|set|use|switch|move)\s+(?:it|that|this|the\s+\w+)\s*(?:to|as|for)?\s*([^,;\n]+)/gi,
    /\bchange(?:d|s|ing)?\s+[^,;\n]*?\bto\s+([^,;\n]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of answer.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

/** A replacement can name people, dates or projects without repeating the field name. */
function explicitlyReplacesDraftValue(answer: string, previous: unknown, next: unknown): boolean {
  if (typeof previous !== 'string' || typeof next !== 'string' || previous === next) return false;
  const nextValue = next.trim();
  if (!nextValue) return false;
  if (draftReplacementPairs(answer).some(pair =>
    mentionsValue(pair.previous, previous) && mentionsDistinctValue(pair.next, nextValue, previous))) return true;
  return draftReplacementValues(answer).some(value => mentionsDistinctValue(value, nextValue, previous));
}

function continueDraftCall(call: { name?: string; input?: unknown }, params: CompileDeftyActionDraftParams) {
  if (!isRecord(call.input)) return call;
  const callInput = call.input;
  const candidates = pendingDraftActions(params).filter((action) => action.action === call.name);
  const previous = candidates.find((action) => action.params.title === callInput.title) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!previous) return call;
  const input: Record<string, any> = { ...previous.params, ...call.input };
  const answer = params.pendingDraft?.answer ?? '';
  const question = params.pendingDraft?.question ?? '';
  for (const key of ['assignee_name', 'due_date', 'project_name', 'title', 'source_message_id']) {
    if (previous.params[key] === undefined) continue;
    const nextValue = callInput[key];
    const hasNextValue = typeof nextValue === 'string' ? nextValue.trim().length > 0 : nextValue !== undefined && nextValue !== null;
    const replacement = hasNextValue && explicitlyReplacesDraftValue(answer, previous.params[key], nextValue);
    const explicitlyRevised = hasNextValue && (
      key === 'assignee_name' ? replacement || /\b(?:assign|owner|give)\b/i.test(answer) || /\b(?:who|assignee|owner)\b/i.test(question)
        : key === 'due_date' ? replacement || DATE_EXPRESSION.test(answer) || /\b(?:when|due|date|deadline)\b/i.test(question)
        : key === 'project_name' ? replacement || (typeof nextValue === 'string' && typeof previous.params[key] === 'string'
          && mentionsDistinctValue(answer, nextValue, previous.params[key])) || /\b(?:which|what)\b.*\bproject\b/i.test(question)
        : key === 'title' ? replacement || /\b(?:title|called|name|rename)\b/i.test(answer) || /\b(?:title|accomplish)\b/i.test(question) : false);
    if (!explicitlyRevised) input[key] = previous.params[key];
  }
  return { ...call, input };
}

export function normalizeCompiledToolCalls(
  calls: Array<{ name?: string; input?: unknown }>,
  params: CompileDeftyActionDraftParams,
): { actions: ProposedAgentAction[]; pendingActions?: ProposedAgentAction[]; summary?: string; warnings?: string[] } {
  const continuedCalls = calls.map((call) => continueDraftCall(call, params));
  const warnings = continuedCalls.flatMap(call => {
    if (call.name !== 'add_dependency' && call.name !== 'remove_dependency') return [];
    const result = validateRegisteredProposalAction({ action: call.name, params: call.input });
    return result.ok ? [] : [`The task dependency proposal was not prepared. ${result.message}`];
  });
  const normalized = continuedCalls.flatMap((call) => normalizeRegisteredToolCall(call, params));
  const actions = normalized.filter((action) => action.action !== 'create_task' || stringValue(action.params.project_name));
  const pendingActions = normalized.length > actions.length ? normalized : undefined;
  if (actions.length === 0) return { actions, ...(pendingActions ? { pendingActions } : {}), ...(warnings.length ? { warnings } : {}) };
  return {
    actions,
    ...(pendingActions ? { pendingActions } : {}),
    ...(warnings.length ? { warnings } : {}),
    summary: formatDeftyApprovalReply(actions) ?? (actions.length === 1
      ? `I drafted a ${humanizeAction(actions[0]!.action)} for approval.`
      : `I drafted ${actions.length} related changes for approval.`),
  };
}

function normalizeRegisteredToolCall(
  call: { name?: string; input?: unknown },
  params: CompileDeftyActionDraftParams,
): ProposedAgentAction[] {
  const action = typeof call.name === 'string' ? call.name : '';
  if (!ACTION_TOOLS.has(action) || !isRecord(call.input)) return [];

  if (action === 'create_task') {
    return normalizeCompiledAction({ action, ...call.input }, params);
  }
  if (action === 'update_task_status') {
    return normalizeCompiledAction({ action, ...call.input }, params);
  }
  if (action === 'post_message') {
    return normalizeCompiledAction({ action, ...call.input }, params);
  }

  const validation = validateRegisteredProposalAction({ action, params: call.input });
  if (!validation.ok) return [];
  const requestedWikiWriteMode = action === 'wiki_write'
    ? inferRequestedWikiWriteMode(params.promptContent)
    : undefined;
  const requestedWikiUpdateOperation = requestedWikiWriteMode === 'update'
    ? inferRequestedWikiUpdateOperation(params.promptContent)
    : undefined;
  const requestedWikiTypeChange = requestedWikiWriteMode === 'update'
    ? /\b(?:change|set|make)\b.{0,50}\btype\b/i.test(params.promptContent)
    : false;
  return [{
    action,
    params: {
      ...call.input,
      ...(requestedWikiWriteMode ? { requested_wiki_write_mode: requestedWikiWriteMode } : {}),
      ...(requestedWikiUpdateOperation ? { requested_wiki_update_operation: requestedWikiUpdateOperation } : {}),
      ...(requestedWikiTypeChange ? { requested_wiki_type_change: true } : {}),
      source_message_id: params.sourceMessageId,
    },
    approval_tier: getApprovalTier(action),
    tool_use_id: null,
    source: 'action_compiler',
  }];
}

function inferRequestedWikiUpdateOperation(promptContent: string): 'append' | 'replace' {
  return /\b(?:add|append|include|insert)\b/i.test(promptContent) ? 'append' : 'replace';
}

function inferRequestedWikiWriteMode(promptContent: string): 'create' | 'update' | undefined {
  const plain = promptContent.replace(/\s+/g, ' ').trim();
  if (/\b(?:update|edit|revise|correct|append|add\s+.+?\s+to)\b/i.test(plain)) return 'update';
  if (/\b(?:create|make|start|write|save|record|capture)\b.{0,100}\b(?:wiki|knowledge)(?:\s+page)?\b/i.test(plain)) {
    return 'create';
  }
  return undefined;
}

export function validateRegisteredProposalAction(action: {
  action?: unknown;
  params?: unknown;
  existing_action_id?:unknown;
  source?:unknown;
}): { ok: true } | { ok: false; message: string } {
  const name = typeof action.action === 'string' ? action.action : '';
  if(name==='email_send')return {ok:false,message:'The built-in mailbox action is retired. Use the installed App review.'};
  if (name.startsWith('mcp__')) {
    return isRecord(action.params)
      ? { ok: true }
      : { ok: false, message: `The ${humanizeAction(name)} draft is missing its parameters.` };
  }
  if (name === WORKSPACE_PLAN_IMPORT_ACTION) {
    if (!isRecord(action.params)) {
      return { ok: false, message: 'The workspace plan import draft is missing its parameters.' };
    }
    try {
      sanitizeWorkspacePlanImportParams(action.params);
      return { ok: true };
    } catch {
      return { ok: false, message: 'The workspace plan import preview is invalid or exceeds its safety limits.' };
    }
  }
  if (name === DOCUMENT_SEND_ACTION) {
    if (!isRecord(action.params)) {
      return { ok: false, message: 'The document send draft is missing its parameters.' };
    }
    try {
      validateDocumentSendDraft(action.params);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'The document send draft is invalid.',
      };
    }
  }
  if (!ACTION_TOOLS.has(name)) {
    return { ok: false, message: `The requested action "${name || 'unknown'}" is not a registered approval action.` };
  }
  if (!isRecord(action.params)) {
    return { ok: false, message: `The ${humanizeAction(name)} draft is missing its parameters.` };
  }

  const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return { ok: false, message: `The ${humanizeAction(name)} action has no registered tool contract.` };
  }

  const schema: Record<string, any> = isRecord(tool.input_schema) ? tool.input_schema : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string') continue;
    const value = action.params[key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      return { ok: false, message: `The ${humanizeAction(name)} draft needs ${humanizeAction(key)}.` };
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, definition] of Object.entries(properties)) {
    const value = action.params[key];
    if (value === undefined || !isRecord(definition)) continue;
    if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
      return { ok: false, message: `The ${humanizeAction(name)} draft has an invalid ${humanizeAction(key)}.` };
    }
    if (definition.type === 'array' && !Array.isArray(value)) {
      return { ok: false, message: `The ${humanizeAction(name)} draft needs ${humanizeAction(key)} as a list.` };
    }
    if (definition.type === 'array' && typeof definition.minItems === 'number' && value.length < definition.minItems) {
      return { ok: false, message: `The ${humanizeAction(name)} draft needs at least ${definition.minItems} ${humanizeAction(key)} item.` };
    }
  }

  if (name === 'add_dependency' || name === 'remove_dependency') {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    for (const field of ['source_task_identifier', 'target_task_identifier']) {
      const value = action.params[field];
      if (typeof value !== 'string' || (!uuid.test(value) && !parseProjectTaskIdentifier(value))) return { ok: false,
        message: 'A task dependency needs exact task UUIDs or project task identifiers such as DEFT-5. Look up both existing tasks first; a task title is not an identifier.' };
    }
  }

  if (name === 'wiki_write' && !action.params.slug) {
    for (const key of ['title', 'type']) {
      if (!action.params[key]) {
        return { ok: false, message: `A new wiki page needs ${humanizeAction(key)}.` };
      }
    }
  }
  if (name === 'create_note' && action.params.visibility === 'space' && !action.params.visibility_space_id) {
    return { ok: false, message: 'A space-visible note needs the exact target space.' };
  }

  return { ok: true };
}

function humanizeAction(action: string) {
  return action.replace(/_/g, ' ');
}

function normalizeCompiledAction(raw: unknown, params: CompileDeftyActionDraftParams): ProposedAgentAction[] {
  if (!isRecord(raw) || typeof raw.action !== 'string') return [];

  if (raw.action === 'create_task') {
    const title = stringValue(raw.title);
    const projectName = stringValue(raw.project_name) || params.projectNameHint || '';
    if (!title) return [];
    const subtasks = normalizeCompiledSubtasks(raw.subtasks, params);
    return [{
      action: 'create_task',
      params: removeUndefined({
        title: truncatePlainText(title, 120),
        project_name: truncatePlainText(projectName, 160),
        priority: normalizePriority(raw.priority) ?? 'p2',
        assignee_name: normalizeCompiledAssignee(raw.assignee_name, params) || undefined,
        due_date: normalizeDueDate(raw.due_date),
        description: normalizeCompiledTaskDescription(raw.description, params.promptContent, title, subtasks),
        subtasks,
        source_message_id: stringValue(raw.source_message_id) || params.pendingDraft?.request_message_id || params.sourceMessageId,
      }),
      approval_tier: getApprovalTier('create_task'),
      tool_use_id: null,
      source: 'action_compiler',
    }];
  }

  if (raw.action === 'update_task_status') {
    const requestedStatus = normalizeStatus(raw.new_status);
    const directTarget = stringValue(raw.task_identifier);
    const taskTargets = looksLikeTaskIdentifier(directTarget)
      ? [directTarget]
      : selectPriorTaskReferences(params.priorTaskReferences ?? [], params.promptContent);
    if (!requestedStatus || taskTargets.length === 0 || taskTargets.length > 3) return [];
    return taskTargets.map((taskIdentifier) => ({
      action: 'update_task_status',
      params: {
        task_identifier: taskIdentifier.toUpperCase(),
        new_status: requestedStatus,
        source_message_id: params.sourceMessageId,
      },
      approval_tier: 'quick',
      tool_use_id: null,
      source: 'action_compiler',
    }));
  }

  if (raw.action === 'post_message') {
    const spaceName = stringValue(raw.space_name);
    const content = stringValue(raw.content);
    if (!spaceName || !content) return [];
    return [{
      action: 'post_message',
      params: {
        space_name: spaceName.replace(/^#/, ''),
        content: truncatePlainText(content, 4000),
        source_message_id: params.sourceMessageId,
      },
      approval_tier: getApprovalTier('post_message'),
      tool_use_id: null,
      source: 'action_compiler',
    }];
  }

  return [];
}

function normalizeCompiledTaskDescription(
  value: unknown,
  promptContent: string,
  title: string,
  subtasks: ReturnType<typeof normalizeCompiledSubtasks>,
) {
  const raw = stringValue(value);
  const prompt = promptContent.trim();
  const normalizedRaw = normalizeDescriptionFingerprint(raw);
  const normalizedPrompt = normalizeDescriptionFingerprint(prompt);
  const containsSubtaskDump = Boolean(subtasks?.length) && (
    /\*{0,2}subtasks?\*{0,2}\s*:/i.test(raw) ||
    subtasks!.filter((subtask) => raw.toLowerCase().includes(subtask.title.toLowerCase())).length >= 2
  );
  const looksLikePromptEcho =
    !raw ||
    raw.length > 700 ||
    containsSubtaskDump ||
    (normalizedPrompt.length > 60 && normalizedRaw.includes(normalizedPrompt.slice(0, 80))) ||
    /\bcreate\s+a\s+task\b/i.test(raw) ||
    /\bwith\s+(?:three|two|\d+)\s+subtasks\b/i.test(raw);

  if (!looksLikePromptEcho) return truncatePlainText(raw, 1200);

  const lead = raw
    .split(/(?:\r?\n|[-*]\s*)?\*{0,2}subtasks?\*{0,2}\s*:/i)[0]
    ?.replace(/[-*\s]+$/g, '')
    .trim();
  return truncatePlainText(lead && lead.length >= 20 ? lead : `Coordinate ${title}.`, 1200);
}

function normalizeDescriptionFingerprint(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeTaskIdentifier(value: string) {
  return /\b(?:[A-Z]{2,12}-\d+|[0-9a-f]{8}-[0-9a-f-]{27})\b/i.test(value);
}

function normalizeCompiledSubtasks(value: unknown, params: CompileDeftyActionDraftParams) {
  if (!Array.isArray(value)) return undefined;
  const subtasks = value
    .map((raw) => {
      if (!isRecord(raw)) return null;
      const title = stringValue(raw.title);
      if (!title) return null;
      return removeUndefined({
        title: truncatePlainText(title, 120),
        description: stringValue(raw.description) || undefined,
        assignee_name: normalizeCompiledAssignee(raw.assignee_name, params) || undefined,
        priority: normalizePriority(raw.priority) ?? undefined,
        due_date: normalizeDueDate(raw.due_date),
        depends_on: Array.isArray(raw.depends_on)
          ? raw.depends_on.filter((value: unknown) => Number.isInteger(value))
          : undefined,
      });
    })
    .filter((subtask): subtask is NonNullable<typeof subtask> => Boolean(subtask));
  if (subtasks.length === 0) return undefined;

  return subtasks.map((subtask, index) => {
    if (subtask.depends_on?.length || index === 0) return subtask;
    const inferred = inferSubtaskDependencies(
      [subtask.title, subtask.description].filter(Boolean).join(' '),
      subtasks,
      index,
    );
    if (inferred.length === 0) return subtask;
    return { ...subtask, depends_on: inferred };
  });
}

function inferSubtaskDependencies(
  meaning: string,
  subtasks: Array<{ title: string; description?: string; depends_on?: number[] }>,
  index: number,
): number[] {
  const normalized = meaning.toLowerCase();
  if (/\bafter\s+(?:that|this|the previous (?:step|task)|the prior (?:step|task))\b/.test(normalized)) {
    return [index];
  }

  const namedDependency = normalized.match(/\bafter\s+(?:the\s+)?([a-z][a-z0-9-]*)\b/)?.[1];
  if (!namedDependency) return [];
  const candidates = subtasks
    .slice(0, index)
    .map((candidate, candidateIndex) => ({
      index: candidateIndex + 1,
      matches: [candidate.title, candidate.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(namedDependency),
    }))
    .filter((candidate) => candidate.matches);
  return candidates.length === 1 ? [candidates[0]!.index] : [];
}

function normalizeCompiledAssignee(value: unknown, params: CompileDeftyActionDraftParams) {
  const name = stringValue(value);
  if (!name) return '';
  const normalized = name.replace(/[?!.,;:]+$/g, '').trim();
  if (/^(?:me|myself)$/i.test(normalized)) return params.callerName ?? '';
  return name;
}

function selectPriorTaskReferences(references: string[], prompt: string): string[] {
  const unique = [...new Set(references.map((ref) => ref.toUpperCase()))];
  if (unique.length === 0) return [];
  const lower = prompt.toLowerCase();
  if (/\bfirst\s+(?:two|2)\b/.test(lower)) return unique.slice(0, 2);
  if (/\blast\s+(?:two|2)\b/.test(lower)) return unique.slice(-2);
  if (/\bboth\b/.test(lower)) return unique.slice(0, 2);
  const allCount = lower.match(/\ball\s+(\d+|one|two|three)\b/)?.[1];
  const count = allCount ? ({ one: 1, two: 2, three: 3 } as Record<string, number>)[allCount] ?? Number(allCount) : undefined;
  if (count) return unique.slice(0, count);
  if (/\b(?:all|these|those|them|above)\b/.test(lower)) return unique;
  return [];
}

function normalizeStatus(value: unknown) {
  const normalized = stringValue(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'complete' || normalized === 'completed' || normalized === 'closed') return 'done';
  if (normalized === 'to_do') return 'todo';
  return ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'].includes(normalized)
    ? normalized
    : null;
}

function normalizePriority(value: unknown) {
  const normalized = stringValue(value).toLowerCase();
  return ['p0', 'p1', 'p2', 'p3'].includes(normalized) ? normalized : null;
}

function normalizeDueDate(value: unknown) {
  const text = stringValue(value);
  if (!text || /^none|null|no due date$/i.test(text)) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function removeUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseFirstJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue below.
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
