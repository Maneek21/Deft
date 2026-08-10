/**
 * Shared streaming agent loop used by POST /messages (initial send) and
 * POST /continue (resume after action approval).
 *
 * Responsibilities:
 *  - Run the Anthropic tool-use loop to completion or budget exhaustion
 *  - Persist each iteration's assistant content_blocks and any tool_result
 *    user message so future turns have faithful structured history
 *  - Stream SSE events to the client via the provided `write` function
 *  - Create agent_actions rows for tools that require approval and stop
 *    the loop if any are pending (waiting for user approval)
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { agentActions, messages, spaces } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { executeToolCall } from './agent-context.js';
import { executeActionDirect } from './agent-actions.js';
import { getApprovalTier, shouldAutoExecute, type ApprovalTier, type TrustLevel } from './agent-approval.js';
import { createAgentMessage } from './agent-llm.js';
import type { ResolvedReasonProvider } from './org-ai-config.js';

export interface StreamLoopParams {
  convoId: string;
  userId: string;
  orgId: string;
  agentUserId: string;  // Defty or BYOA — the message author for assistant turns
  agentEmployeeId: string | undefined;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  allActionTools: Set<string>;
  actionApprovalTiers: Map<string, ApprovalTier>;
  trustLevel: TrustLevel;
  apiMessages: Anthropic.MessageParam[];
  write: (data: any) => Promise<void>;
  abortSignal: AbortSignal;
  /** Resolved provider context (provider | model | apiKey | baseUrl) for the reason task. */
  resolved: ResolvedReasonProvider;
}

export interface StreamLoopResult {
  finalText: string;
  citations: any[];
  pendingActions: { id: string; action: string; params: any }[];
  totalTokensIn: number;
  totalTokensOut: number;
}

const MAX_INPUT_TOKENS = 200_000;
const MAX_ITERATIONS = 50;

export async function runAgentStreamingLoop(p: StreamLoopParams): Promise<StreamLoopResult> {
  let apiMessages = [...p.apiMessages];
  let finalText = '';
  const allCitations: any[] = [];
  const pendingActions: { id: string; action: string; params: any }[] = [];
  // Accumulated across iterations; written to the terminal assistant row's
  // tool_calls column so history reload can render badges on the one visible
  // bubble (all intermediate tool-calling iterations are hidden).
  const cumulativeToolCalls: { tool: string; params: any }[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS && totalTokensIn < MAX_INPUT_TOKENS) {
    iterations++;
    console.log(`[agent-loop] iter=${iterations} tokens=${totalTokensIn}/${MAX_INPUT_TOKENS} msgs=${apiMessages.length}`);

    // Provider-agnostic reasoning call. For Anthropic the adapter applies the
    // two prompt-cache breakpoints (system + tools) internally; for OpenAI /
    // OpenRouter / Ollama it translates the request and normalizes the response
    // back to Anthropic-shaped content blocks.
    const response = await createAgentMessage({
      resolved: p.resolved,
      system: p.systemPrompt,
      messages: apiMessages,
      tools: p.tools,
      maxTokens: 4096,
      abortSignal: p.abortSignal,
    });

    if (response.usage) {
      totalTokensIn += response.usage.input_tokens || 0;
      totalTokensOut += response.usage.output_tokens || 0;
      const cacheRead = response.usage.cache_read ?? 0;
      const cacheWrite = response.usage.cache_write ?? 0;
      if (cacheRead > 0 || cacheWrite > 0) {
        console.log(
          `[agent-loop] cache: read=${cacheRead} write=${cacheWrite} fresh=${response.usage.input_tokens}`,
        );
      }
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );

    const iterText = textBlocks.map((b) => b.text).join('\n\n').trim();

    // Collect tool_use blocks from this iteration into the cumulative list.
    for (const tu of toolUseBlocks) {
      cumulativeToolCalls.push({ tool: tu.name, params: tu.input });
    }

    // Persist this assistant iteration with structured content_blocks.
    //
    // Hide rule: an iteration is hidden from reload UI only when EVERY tool
    // call in it is a read-only lookup (search/time/fetch/etc). If any
    // tool_use is an action (create_task, post_message, MCP write), the
    // iteration stays visible so the approval card — linked by
    // agent_actions.message_id — has a parent row the GET endpoint returns.
    // Hiding action-bearing iterations previously orphaned their approval
    // cards and broke post-approval confidence inference.
    const hasAnyActionToolUse = toolUseBlocks.some((tu) => p.allActionTools.has(tu.name));
    const isTerminalIteration = toolUseBlocks.length === 0;
    // totalTokensIn / totalTokensOut already include this iteration's usage
    // (accumulated at line 74 above after response.usage is read). The terminal
    // row gets the cumulative running sum so history reload can show the full
    // cost of a multi-iter response, not just the final API call's tokens.
    const [assistantRow] = await db.insert(messages).values({
      org_id: p.orgId,
      space_id: p.convoId,
      user_id: p.agentUserId,
      content: iterText,
      metadata: {
        is_agent_reply: true,
        agent_blocks: response.content as any,
        hidden: toolUseBlocks.length > 0 && !hasAnyActionToolUse,
        tool_calls: (isTerminalIteration && cumulativeToolCalls.length > 0)
          ? (cumulativeToolCalls as any)
          : null,
        model: p.resolved.model ?? null,
        tokens_in: isTerminalIteration ? totalTokensIn : (response.usage?.input_tokens ?? null),
        tokens_out: isTerminalIteration ? totalTokensOut : (response.usage?.output_tokens ?? null),
      },
    }).returning();

    // Stream this iteration's text word-by-word for typing effect.
    if (iterText) {
      for (const word of iterText.split(/(\s+)/)) {
        if (p.abortSignal.aborted) break;
        await p.write({ type: 'text', text: word });
      }
    }

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      finalText = iterText;
      break;
    }

    // Execute / enqueue tools, building the tool_result user turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let haltAfterThisIteration = false;
    const pendingActionsBeforeIter = pendingActions.length;

    for (const tool of toolUseBlocks) {
      const isAction = p.allActionTools.has(tool.name);

      if (isAction) {
        const approvalTier = getApprovalTier(tool.name, p.actionApprovalTiers.get(tool.name));
        if (shouldAutoExecute(tool.name, p.trustLevel, tool.input, approvalTier)) {
          const { actionId, success, result, error, requiresApproval } = await executeActionDirect(
            tool.name,
            tool.input as any,
            p.orgId,
            p.userId,
            p.convoId,
            approvalTier,
            {
              agentEmployeeId: p.agentEmployeeId,
              source: 'auto_execute',
              messageId: assistantRow!.id,
              toolUseId: tool.id,
            },
          );
          if (success) {
            await p.write({ type: 'tool_result', tool: tool.name, count: Array.isArray(result) ? result.length : 1 });
            toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
          } else if (requiresApproval) {
            pendingActions.push({ id: actionId, action: tool.name, params: tool.input });
            await p.write({ type: 'pending_action', id: actionId, action: tool.name, params: tool.input });
            haltAfterThisIteration = true;
          } else {
            const errorMsg = error ?? 'Tool execution failed';
            const errorPayload = result !== null && typeof result === 'object' && !Array.isArray(result)
              ? { ...result, error: errorMsg }
              : { result: result ?? null, error: errorMsg };
            await p.write({ type: 'tool_result', tool: tool.name, error: errorMsg });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tool.id,
              content: JSON.stringify(errorPayload),
              is_error: true,
            });
          }
          continue;
        }

        // Needs approval — create the action row and halt.
        const [actionRecord] = await db
          .insert(agentActions)
          .values({
            org_id: p.orgId,
            user_id: p.userId,
            conversation_id: p.convoId,
            agent_employee_id: p.agentEmployeeId ?? null,
            action: tool.name,
            params: tool.input as any,
            approval_tier: approvalTier,
            approval_status: 'pending',
            message_id: assistantRow!.id,
            tool_use_id: tool.id,
          })
          .returning();

        pendingActions.push({ id: actionRecord!.id, action: tool.name, params: tool.input });
        await p.write({ type: 'pending_action', id: actionRecord!.id, action: tool.name, params: tool.input });
        haltAfterThisIteration = true;
      } else {
        // Read-only tool — execute now.
        try {
          await p.write({ type: 'tool_start', tool: tool.name });
          const { result, citations } = await executeToolCall(
            tool.name, tool.input as any, p.orgId, p.userId, p.convoId, p.agentEmployeeId,
          );
          allCitations.push(...citations);
          await p.write({ type: 'tool_result', tool: tool.name, count: Array.isArray(result) ? result.length : 1 });
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Tool execution failed';
          await p.write({ type: 'tool_result', tool: tool.name, error: errorMsg });
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: errorMsg }), is_error: true });
        }
      }
    }

    // Persist the tool_result user turn (only if we produced results this iteration).
    if (toolResults.length > 0) {
      await db.insert(messages).values({
        org_id: p.orgId,
        space_id: p.convoId,
        user_id: p.userId,
        content: '',
        metadata: {
          kind: 'tool_result',
          agent_blocks: toolResults as any,
          hidden: true,
        },
      });

      apiMessages = [
        ...apiMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    if (haltAfterThisIteration) {
      // The pre-tool prose Claude streams in the same turn as a pending-approval
      // tool_use is sometimes contradictory ("I don't have access to set a
      // reminder" while emitting a create_reminder call). The model never gets
      // a follow-up turn to correct itself because we halt here. Replace the
      // streamed text with a deterministic summary that points the user at the
      // approval card, so the persisted message + the live UI agree with the
      // actual outcome.
      const newPendings = pendingActions.slice(pendingActionsBeforeIter);
      if (newPendings.length > 0) {
        const labels = newPendings.map((a) => a.action.replace(/_/g, ' '));
        const replacement =
          newPendings.length === 1
            ? `Queued the **${labels[0]}** action for your approval — confirm the card above to proceed.`
            : `Queued ${newPendings.length} actions for your approval (${labels.join(', ')}) — confirm the cards above to proceed.`;

        await db
          .update(messages)
          .set({ content: replacement })
          .where(eq(messages.id, assistantRow!.id));

        await p.write({ type: 'text_replace', text: replacement });
        finalText = replacement;
      } else {
        finalText = iterText;
      }
      break;
    }
  }

  // Touch the space's updated_at so the conversation list sorts correctly.
  await db
    .update(spaces)
    .set({ updated_at: new Date() })
    .where(eq(spaces.id, p.convoId));

  return { finalText, citations: allCitations, pendingActions, totalTokensIn, totalTokensOut };
}
