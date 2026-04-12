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
import { agentActions, agentConversations, agentMessages } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { env } from './env.js';
import { executeToolCall } from './agent-context.js';
import { getApprovalTier, shouldAutoExecute, type TrustLevel } from './agent-approval.js';

export interface StreamLoopParams {
  convoId: string;
  userId: string;
  orgId: string;
  agentEmployeeId: string | undefined;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  allActionTools: Set<string>;
  trustLevel: TrustLevel;
  apiMessages: Anthropic.MessageParam[];
  write: (data: any) => Promise<void>;
  abortSignal: AbortSignal;
  model: string;
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
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

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

    const response = await anthropic.messages.create({
      model: p.model,
      max_tokens: 4096,
      system: p.systemPrompt,
      messages: apiMessages,
      tools: p.tools,
    }, { signal: p.abortSignal });

    if (response.usage) {
      totalTokensIn += response.usage.input_tokens || 0;
      totalTokensOut += response.usage.output_tokens || 0;
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
    // Any iteration that made tool calls is hidden from reload UI — only the
    // terminal iteration (no tool_use, stop_reason=end_turn) stays visible.
    // This ensures reload shows exactly one bubble per user question, matching
    // the live streaming UX where all iteration text flows into one placeholder.
    //
    // The terminal (visible) row gets the accumulated tool_calls in its
    // legacy tool_calls column so history reload can render tool badges —
    // by definition the terminal row's content_blocks has only text blocks.
    const isTerminalIteration = toolUseBlocks.length === 0;
    const [assistantRow] = await db.insert(agentMessages).values({
      conversation_id: p.convoId,
      role: 'assistant',
      content: iterText,
      content_blocks: response.content as any,
      hidden: toolUseBlocks.length > 0,
      tool_calls: (isTerminalIteration && cumulativeToolCalls.length > 0)
        ? (cumulativeToolCalls as any)
        : null,
      model: p.model,
      tokens_in: response.usage?.input_tokens ?? null,
      tokens_out: response.usage?.output_tokens ?? null,
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

    for (const tool of toolUseBlocks) {
      const isAction = p.allActionTools.has(tool.name);

      if (isAction) {
        if (shouldAutoExecute(tool.name, p.trustLevel)) {
          try {
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
          continue;
        }

        // Needs approval — create the action row and halt.
        const approvalTier = getApprovalTier(tool.name);
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
      await db.insert(agentMessages).values({
        conversation_id: p.convoId,
        role: 'user',
        content: '',
        content_blocks: toolResults as any,
        hidden: true,
      });

      apiMessages = [
        ...apiMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    if (haltAfterThisIteration) {
      finalText = iterText;
      break;
    }
  }

  await db
    .update(agentConversations)
    .set({ updated_at: new Date() })
    .where(eq(agentConversations.id, p.convoId));

  return { finalText, citations: allCitations, pendingActions, totalTokensIn, totalTokensOut };
}
