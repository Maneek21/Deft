// Reusable agent reasoning engine — used by @agent mentions in chat and other background jobs.
// Supports two modes:
//   'chat_mention' (default): write actions are skipped (safety for @mentions)
//   'background': write actions auto-execute based on org trust level

import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { connectedAccounts, wikiPages, orgs, agentMemory } from '@deft/db/schema';
import { eq, and, desc, or, ilike, sql } from 'drizzle-orm';
import { resolveReasonProvider, getOrgAIConfig } from './org-ai-config.js';
import { createAgentMessage } from './agent-llm.js';
import { llm } from './llm.js';
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS } from './agent-tools.js';
import { executeToolCall } from './agent-context.js';
import { executeActionDirect } from './agent-actions.js';
import { shouldAutoExecute, getApprovalTier, type TrustLevel } from './agent-approval.js';
import { getMCPToolsForAgent, mcpToolToAnthropicFormat } from './mcp-tools.js';
import { getIO } from '../socket.js';

const SYSTEM_PROMPT = `You are Deft, the AI assistant for this workspace. You have direct SQL access to the organization's data through tools.

Rules:
- ALWAYS use the search/list tools to ground your answer before responding. Even for simple questions about workspace data (members, tasks, projects, recent messages), call the relevant tool — never answer from conversation context alone. Use the tools silently (see narration rule below); just don't skip them.
- Cite your sources (the tools return source IDs)
- Be concise and direct
- Before proposing a write action that names a person (assignee, mentioned user) or project, verify they exist using the appropriate search tool. If the named entity doesn't exist in this workspace, ASK the user to clarify rather than confidently proposing a write against a fabricated name. Never invent a project name to attach a task to — if the user hasn't named a project, OR explicitly says "no project", set project_name to "" (empty string). NEVER default to "General", "Inbox", "Default", or any other invented project name; there is no implicit default project. Same rule for assignee_name when unassigned.
- For write actions (create_task, update_task_status, post_message), clearly explain what you'll do. When invoked from a chat mention, write actions are not executed immediately — they're queued for the user's approval, which appears as an Approve/Reject card on your reply and in the user's Inbox under the Approvals tab. Do NOT refer to an "Agent panel" or "Agent dashboard" — neither exists.
- You are responding in a chat thread. Keep your reply as a single cohesive message.
- Use markdown formatting (bold, lists, headers) for structure but keep it compact.
- Do NOT narrate your tool usage. Do NOT say "I'll search for..." or "Let me look up..." — just use the tools silently and present your findings directly.
- Separate paragraphs with blank lines. Use proper line breaks between sections.
- For "why" questions (why is X behind, why is X blocked), do a multi-step investigation:
  1. First check the task details and status
  2. Then check the assignee's workload and recent activity
  3. Search for blocker mentions in chat
  4. Check task dependencies
  5. Synthesize your findings into a clear explanation
- Don't just return raw data — analyze patterns and suggest actions
- Current date: {{DATE}}
- Organization: {{ORG}}`;

type ConversationMessage = {
  role: string;
  content: string;
};

async function verifyResponse(
  originalQuery: string,
  response: string,
  citations: any[],
  orgName: string,
  orgId: string,
): Promise<string> {
  try {
    // Route through the provider-agnostic llm() router (classify task) so the
    // verify pass honors whichever provider the org configured — not Anthropic
    // only. Returns the original response unchanged if no provider is set up.
    const orgConfig = await getOrgAIConfig(orgId).catch(() => undefined);
    const hasOrgProvider = orgConfig?.api_keys && Object.values(orgConfig.api_keys).some(Boolean);
    if (!hasOrgProvider && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
      return response;
    }
    const verificationResult = await llm({
      task: 'classify',
      maxTokens: 1024,
      system: `You are a quality reviewer for an AI assistant at ${orgName}. Review the response briefly.`,
      messages: [{
        role: 'user',
        content: `Original question: "${originalQuery.slice(0, 300)}"

Response to review:
${response.slice(0, 2000)}

Citations: ${citations.length > 0 ? citations.slice(0, 5).map((c: any) => c.title || c.id).join(', ') : 'none'}

Check: Does it answer the question? Any fabricated claims? Anything important missing?

If good, reply exactly: VERIFIED
If issues, provide a corrected version (same style/length).`,
      }],
      orgConfig: orgConfig as any,
    });

    const text = verificationResult.text?.trim() || 'VERIFIED';
    // Pass if the first word is VERIFIED — Haiku often appends meta-commentary
    // like "VERIFIED\n\nThe response accurately..." which would otherwise
    // replace the real answer with a self-review.
    const firstWord = text.toUpperCase().match(/^[A-Z]+/)?.[0];
    return firstWord === 'VERIFIED' ? response : text;
  } catch (err) {
    console.warn('[agent-runner] Verification failed:', err);
    return response;
  }
}

export async function runAgentQuery(params: {
  content: string;
  orgId: string;
  userId: string;
  orgName: string;
  conversationHistory?: ConversationMessage[];
  /** 'chat_mention' (default): write actions skipped. 'background': auto-execute per trust level. */
  mode?: 'chat_mention' | 'background';
  /** Override system prompt (for agent employees in future). */
  systemPromptOverride?: string;
  /** Override trust level (for agent employees with per-employee trust). */
  trustLevelOverride?: 'conservative' | 'standard' | 'autonomous';
  /** Agent employee ID for limit enforcement. */
  agentEmployeeId?: string;
  /** Skip the self-verification pass. Defaults to true for chat_mention, false for background. */
  skipVerification?: boolean;
  /**
   * Triggering message id. When set, write actions that accept source_message_id
   * (e.g. create_task) inherit it automatically — the LLM does not need to
   * know about or pass it. See Task 3.2 of the task-management overhaul plan.
   */
  sourceMessageId?: string;
  /**
   * Task 3.10 — if the agent is working on a specific task, emit
   * task:agent_progress to `org:${orgId}` on each reasoning iteration so the
   * task-detail UI can render a live status strip. No-op when unset.
   */
  taskId?: string;
  /**
   * Surface context — what kind of space the agent is replying in. Drives
   * tone (DM = 1:1 conversation, channel = many viewers) and is appended
   * to the system prompt. Optional; agent works without it.
   */
  spaceContext?: {
    type: 'dm' | 'group_dm' | 'agent_conversation' | 'public' | 'private';
    name: string;
    otherMemberName?: string;
  };
}): Promise<{
  text: string;
  citations: any[];
  pendingActions: any[];
  executedActions: any[];
  // Phase 2 — last assistant API response, exposed so agent-reply can
  // populate metadata.agent_blocks / model / tokens_* on the inserted
  // message (parity with agent-stream-loop).
  model: string;
  tokensIn: number;
  tokensOut: number;
  assistantBlocks: Anthropic.ContentBlock[] | null;
}> {
  const { content, orgId, userId, orgName, conversationHistory, mode = 'chat_mention', systemPromptOverride, agentEmployeeId } = params;

  // BYOK — resolve the org's chosen reasoning provider (anthropic | openai |
  // openrouter | ollama) with env fallback. Ollama needs no key.
  const reasonProvider = await resolveReasonProvider(orgId);
  if (!reasonProvider.apiKey && reasonProvider.provider !== 'ollama') {
    throw new Error(`${reasonProvider.provider} API key not configured (org or env)`);
  }

  // Check connected accounts for dynamic tool availability
  const connections = await db.select({ provider: connectedAccounts.provider })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.user_id, userId), eq(connectedAccounts.org_id, orgId)));
  const connectedProviders = connections.map(conn => conn.provider);

  // Build dynamic tool list (read-only tools only — no write actions in chat mentions)
  let tools: Anthropic.Tool[] = [...AGENT_TOOLS];
  const allActionTools = new Set([...ACTION_TOOLS]);
  if (connectedProviders.includes('google_calendar')) {
    tools = [...tools, ...CALENDAR_TOOLS];
    CALENDAR_ACTION_TOOLS.forEach(t => allActionTools.add(t));
  }
  if (connectedProviders.includes('github')) {
    tools = [...tools, ...GITHUB_TOOLS];
    GITHUB_ACTION_TOOLS.forEach(t => allActionTools.add(t));
  }

  // MCP tools
  try {
    const mcpTools = await getMCPToolsForAgent(orgId);
    const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropicFormat);
    tools = [...tools, ...mcpAnthropicTools];
    mcpTools.forEach(t => {
      if (t.approvalTierMapped !== 'auto') {
        allActionTools.add(t.name);
      }
    });
  } catch (err) {
    console.warn('[agent-runner] Failed to load MCP tools:', err instanceof Error ? err.message : err);
  }

  let connectionInfo = '';
  if (connectedProviders.includes('google_calendar')) {
    connectionInfo += '\nThe user has Google Calendar connected. You can check their schedule and create events.';
  }
  if (connectedProviders.includes('github')) {
    connectionInfo += '\nThe user has GitHub connected. You can check PRs, issues, and create issues.';
  }
  if (!connectionInfo) {
    connectionInfo = '\nNo external services are connected. If the user asks about calendar or GitHub, suggest they connect in Settings → Integrations.';
  }

  // Load trust level for background mode
  let trustLevel: TrustLevel = 'conservative';
  if (mode === 'background') {
    const [org] = await db
      .select({ trust_level: orgs.trust_level })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    trustLevel = (params.trustLevelOverride || org?.trust_level || 'conservative') as TrustLevel;
  }

  let systemPrompt = SYSTEM_PROMPT
    .replace('{{DATE}}', new Date().toISOString().split('T')[0]!)
    .replace('{{ORG}}', orgName || 'Unknown') + connectionInfo;

  // Surface context — let the agent adapt to DM vs channel.
  if (params.spaceContext) {
    const sc = params.spaceContext;
    if (sc.type === 'dm' || sc.type === 'agent_conversation') {
      systemPrompt += `\n\nYou are in a private 1:1 direct message${sc.otherMemberName ? ` with ${sc.otherMemberName}` : ''}. This is a personal conversation — reply directly and conversationally. No one else sees this thread.`;
    } else if (sc.type === 'group_dm') {
      systemPrompt += `\n\nYou are in a small private group DM. Other members can see your replies — keep them concise and inclusive of the group.`;
    } else {
      systemPrompt += `\n\nYou are in #${sc.name} (a ${sc.type} channel). Multiple people may see your reply — keep it useful for the broader audience and avoid leaking 1:1 context.`;
    }
  }

  // Auto-load relevant wiki context using full-text search (two-tier: employee-specific then org-wide)
  try {
    const searchQuery = content.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (searchQuery.length > 2) {
      const allRelevantPages: { title: string; slug: string; summary: string | null; type: string; confidence: number }[] = [];

      // Tier 1: Employee-tagged pages (if agent employee)
      if (agentEmployeeId) {
        const employeePages = await db.select({
          title: wikiPages.title,
          slug: wikiPages.slug,
          summary: wikiPages.summary,
          type: wikiPages.type,
          confidence: wikiPages.confidence,
        })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.org_id, orgId),
            eq(wikiPages.is_deleted, false),
            eq(wikiPages.agent_employee_id, agentEmployeeId),
            sql`search_vector @@ plainto_tsquery('english', ${searchQuery})`,
          ))
          .orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${searchQuery})) * ${wikiPages.confidence} DESC`)
          .limit(2);
        allRelevantPages.push(...employeePages);
      }

      // Tier 2: Org-wide pages (no employee tag)
      const orgWidePages = await db.select({
        title: wikiPages.title,
        slug: wikiPages.slug,
        summary: wikiPages.summary,
        type: wikiPages.type,
        confidence: wikiPages.confidence,
      })
        .from(wikiPages)
        .where(and(
          eq(wikiPages.org_id, orgId),
          eq(wikiPages.is_deleted, false),
          sql`${wikiPages.agent_employee_id} IS NULL`,
          sql`search_vector @@ plainto_tsquery('english', ${searchQuery})`,
        ))
        .orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${searchQuery})) * ${wikiPages.confidence} DESC`)
        .limit(3);
      allRelevantPages.push(...orgWidePages);

      if (allRelevantPages.length > 0) {
        const wikiContext = allRelevantPages.map(p =>
          `- **${p.title}** (${p.type}, confidence: ${p.confidence}): ${p.summary || 'No summary'}`
        ).join('\n');
        systemPrompt += `\n\nRelevant knowledge from the team wiki:\n${wikiContext}\nUse wiki_search and wiki_read tools for more details.`;
      }
    }
  } catch (err) {
    // Non-critical: don't fail the agent reply if wiki auto-load errors
    console.warn('[agent-runner] Wiki auto-load failed:', (err as Error).message);
  }

  // Apply system prompt override if provided (for agent employees)
  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride
      .replace('{{DATE}}', new Date().toISOString().split('T')[0]!)
      .replace('{{ORG}}', orgName || 'Unknown') + connectionInfo;
  }

  const reasonModel = reasonProvider.model;

  // Build messages array
  let apiMessages: Anthropic.MessageParam[] = [];

  // Add conversation history if provided (thread context)
  if (conversationHistory && conversationHistory.length > 0) {
    for (const msg of conversationHistory) {
      apiMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
  }

  // Add the current message
  apiMessages.push({ role: 'user', content });

  let allCitations: any[] = [];
  let pendingActions: any[] = [];
  let executedActions: any[] = [];
  let finalText = '';
  let intermediateText = ''; // Text from iterations with tool calls (preamble — usually discarded)
  // Phase 2 — capture metadata from the final API response so agent-reply
  // can populate metadata.agent_blocks / model / tokens_* parity with
  // agent-stream-loop. Without these the rendered chat falls back to
  // plain-text and Phase 4's <AgentMessageBlocks/> can't show tool chips
  // or the model+tokens footer.
  let lastResponseContent: Anthropic.ContentBlock[] | null = null;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  let iterations = 0;
  const maxIterations = params.mode === 'background' ? 25 : 8;

  // Task 3.10 — emit live step progress to the org room so the task-detail
  // UI can render a strip while the agent works. We don't know the true
  // total step count in advance (it depends on how many tool-use rounds the
  // LLM takes), so we use maxIterations as the ceiling.
  const emitTaskProgress = (
    stepIndex: number,
    stepDescription: string,
    status: 'started' | 'completed' | 'failed',
    error?: string,
  ): void => {
    if (!params.taskId) return;
    const io = getIO();
    if (!io) return;
    io.to(`org:${orgId}`).emit('task:agent_progress', {
      task_id: params.taskId,
      agent_employee_id: agentEmployeeId ?? null,
      step_index: stepIndex,
      step_description: stepDescription,
      status,
      total_steps: maxIterations,
      ...(error ? { error } : {}),
    });
  };

  while (iterations < maxIterations) {
    iterations++;
    emitTaskProgress(
      iterations - 1,
      iterations === 1 ? 'Reading the task and gathering context' : 'Thinking and using tools',
      'started',
    );

    // Provider-agnostic reasoning call. The adapter applies Anthropic prompt
    // caching internally (no-op for other providers) and normalizes the
    // response back to Anthropic-shaped content blocks.
    const response = await createAgentMessage({
      resolved: reasonProvider,
      system: systemPrompt,
      messages: apiMessages,
      tools,
      maxTokens: 4096,
    });

    if (response.usage) {
      const cacheRead = response.usage.cache_read ?? 0;
      const cacheWrite = response.usage.cache_write ?? 0;
      if (cacheRead > 0 || cacheWrite > 0) {
        console.log(
          `[agent-runner] cache: read=${cacheRead} write=${cacheWrite} fresh=${response.usage.input_tokens}`,
        );
      }
      totalTokensIn += response.usage.input_tokens ?? 0;
      totalTokensOut += response.usage.output_tokens ?? 0;
    }
    lastResponseContent = response.content;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );

    const newText = textBlocks.map((b) => b.text).join('\n\n').trim();

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // This is the final response — use this text
      finalText = newText;
      emitTaskProgress(iterations - 1, 'Wrapping up and posting results', 'completed');
      break;
    }

    // This iteration has tool calls — text here is just preamble ("I'll search...")
    // Save it in case the final response is empty
    if (newText) {
      intermediateText += (intermediateText ? '\n\n' : '') + newText;
    }

    // Emit a "completed" event for this reasoning iteration with a
    // human-readable summary of the tools the agent is running.
    const toolsLabel = toolUseBlocks.map((b) => b.name).slice(0, 3).join(', ');
    emitTaskProgress(
      iterations - 1,
      toolUseBlocks.length === 1
        ? `Using ${toolsLabel}`
        : `Using ${toolUseBlocks.length} tools (${toolsLabel}${toolUseBlocks.length > 3 ? '…' : ''})`,
      'completed',
    );

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUseBlocks) {
      const isAction = allActionTools.has(tool.name);

      if (isAction) {
        const approvalTier = getApprovalTier(tool.name);
        if (mode === 'background' && shouldAutoExecute(tool.name, trustLevel, tool.input)) {
          // Background mode: auto-execute if trust level permits
          // Thread the triggering message id into write actions that understand
          // source_message_id. The LLM never has to know about it — we inject
          // it here for create_task and similar tools.
          const toolInput = { ...(tool.input as Record<string, any>) };
          if (params.sourceMessageId && !toolInput.source_message_id) {
            toolInput.source_message_id = params.sourceMessageId;
          }
          const { actionId, success, result, error } = await executeActionDirect(
            tool.name,
            toolInput,
            orgId,
            userId,
            null, // no conversation_id for background actions
            approvalTier,
          );
          executedActions.push({ actionId, action: tool.name, params: tool.input, success, result, error });
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: JSON.stringify(
              success
                ? { status: 'auto_executed', ...result }
                : { status: 'auto_execute_failed', error },
            ),
          });
        } else {
          // Chat mention mode or trust level requires approval: skip write actions.
          // Thread the source message id through so the approval UI can persist
          // it when the action is executed later.
          const pendingParams = { ...(tool.input as Record<string, any>) };
          if (params.sourceMessageId && !pendingParams.source_message_id) {
            pendingParams.source_message_id = params.sourceMessageId;
          }
          pendingActions.push({
            action: tool.name,
            params: pendingParams,
            tool_use_id: tool.id,
            approval_tier: approvalTier,
          });
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: JSON.stringify({
              status: 'skipped',
              message: mode === 'background'
                ? 'Action requires approval. Trust level does not permit auto-execution.'
                : 'Write actions from chat mentions require user approval. The action has been queued — an Approve/Reject card will appear inline on this message, and it is also listed in the user\'s Inbox under the Approvals tab.',
            }),
          });
        }
      } else {
        // Read-only tools — execute immediately
        const { result, citations } = await executeToolCall(
          tool.name,
          tool.input as any,
          orgId,
          userId,
          undefined,
          agentEmployeeId,
        );
        allCitations.push(...citations);

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Continue conversation with tool results
    apiMessages = [
      ...apiMessages,
      { role: 'assistant' as const, content: response.content },
      { role: 'user' as const, content: toolResults },
    ];
  }

  // Use final text if available, fall back to intermediate text from tool-call iterations
  const responseText = finalText || intermediateText;

  // Persist durable notes for agent employees
  if (agentEmployeeId && responseText && responseText.length > 100) {
    try {
      const noteKey = `findings:${new Date().toISOString().slice(0, 10)}`;
      await db.insert(agentMemory).values({
        id: crypto.randomUUID(),
        org_id: orgId,
        user_id: userId,
        scope: 'user',
        key: noteKey,
        value: responseText.slice(0, 500),
      }).onConflictDoNothing();
    } catch (err) {
      console.warn('[agent-runner] Durable notes failed:', err);
    }
  }

  // Self-verification for background mode. Skipped for chat mentions where
  // the user is in the loop. Callers can force-skip with skipVerification=true
  // even in background mode (useful for agent-employee chat replies, which
  // use background mode for auto-exec but don't want verifier mangling).
  let verifiedText = responseText;
  const shouldVerify = params.skipVerification === undefined
    ? params.mode === 'background'
    : !params.skipVerification;
  if (shouldVerify && responseText && responseText.length > 50) {
    verifiedText = await verifyResponse(content, responseText, allCitations, orgName, orgId);
  }

  return {
    text: verifiedText,
    citations: allCitations,
    pendingActions,
    executedActions,
    model: reasonModel,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    assistantBlocks: lastResponseContent,
  };
}
