import type Anthropic from '@anthropic-ai/sdk';
import type { ModuleActor } from '@deft/shared/modules';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { db } from './db.js';
import { getModuleRecord } from './module-service.js';
import {
  durableAgentActionResult,
  durableAgentActionResultFromMetadata,
  durableAgentActionResultHistoryText,
  type DurableAgentActionResult,
} from './agent-tool-result.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function durableAgentResultInMessageMetadata(metadata: unknown): DurableAgentActionResult | null {
  if (!isRecord(metadata)) return null;
  return durableAgentActionResultFromMetadata(metadata.approval_execution_result);
}

function durableAgentResultActionId(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const actionId = metadata.approval_execution_result_for_action_id;
  return typeof actionId === 'string' && actionId.length > 0 && actionId.length <= 255
    ? actionId
    : null;
}

/**
 * Anchor the metadata to its terminal action row, then recheck current Module
 * authority before a durable result identifier enters model context.
 */
export async function authorizedDurableAgentResult(params: {
  actor: ModuleActor;
  orgId: string;
  conversationId: string;
  metadata: unknown;
}): Promise<DurableAgentActionResult | null> {
  const actionId = durableAgentResultActionId(params.metadata);
  const claimedResult = durableAgentResultInMessageMetadata(params.metadata);
  if (!actionId || !claimedResult) return null;
  try {
    const [action] = await db
      .select({ action: agentActions.action, result: agentActions.result })
      .from(agentActions)
      .where(and(
        eq(agentActions.id, actionId),
        eq(agentActions.org_id, params.orgId),
        eq(agentActions.conversation_id, params.conversationId),
        eq(agentActions.approval_status, 'approved'),
        isNotNull(agentActions.executed_at),
        isNull(agentActions.error),
      ))
      .limit(1);
    if (!action || action.action !== claimedResult.operation) return null;
    const committedResult = durableAgentActionResult(action.action, action.result);
    if (!committedResult || JSON.stringify(committedResult) !== JSON.stringify(claimedResult)) return null;

    const record = await getModuleRecord(params.actor, committedResult.record_id);
    return record.id === committedResult.record_id
      && record.installation_id === committedResult.installation_id
      && record.module_id === committedResult.module_id
      && record.collection_key === committedResult.collection_key
      ? committedResult
      : null;
  } catch {
    return null;
  }
}

export function durableAgentResultWorkerHistory(metadata: unknown): string | null {
  const result = durableAgentResultInMessageMetadata(metadata);
  return result ? durableAgentActionResultHistoryText(result) : null;
}

/** Repair provider protocol ordering in sanitized history, never persisted records.
 * Reviews can finish after visible assistant messages, and rejected/pending calls
 * may have no stored result. Missing results must never imply successful execution.
 */
export function normalizeAgentToolHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const results = new Map<string, Anthropic.ToolResultBlockParam>();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') results.set(block.tool_use_id, block);
    }
  }
  const output: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { output.push(message); continue; }
    const content = message.content.filter(block => block.type !== 'tool_result');
    if (!content.length) continue;
    output.push({ ...message, content });
    if (message.role !== 'assistant') continue;
    const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (!calls.length) continue;
    output.push({ role: 'user', content: calls.map(call => results.get(call.id) ?? {
      type: 'tool_result', tool_use_id: call.id, is_error: true,
      content: 'A tool result was not recorded. The action may be pending or rejected; do not assume it executed. Check its current status before proposing a retry.',
    }) });
  }
  return output;
}
