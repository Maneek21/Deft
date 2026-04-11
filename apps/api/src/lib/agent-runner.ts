// Reusable agent reasoning engine — used by @agent mentions in chat and other background jobs.
// Does NOT stream; returns the final response synchronously.

import Anthropic from '@anthropic-ai/sdk';
import { getModelConfig } from './llm.js';
import { db } from './db.js';
import { connectedAccounts } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { env } from './env.js';
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS } from './agent-tools.js';
import { executeToolCall } from './agent-context.js';

const SYSTEM_PROMPT = `You are Deft, the AI assistant for this workspace. You have direct SQL access to the organization's data through tools.

Rules:
- Use search tools to find data before answering — don't guess
- Cite your sources (the tools return source IDs)
- Be concise and direct
- For write actions (create_task, update_task_status, post_message), clearly explain what you'll do
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

export async function runAgentQuery(params: {
  content: string;
  orgId: string;
  userId: string;
  orgName: string;
  conversationHistory?: ConversationMessage[];
}): Promise<{
  text: string;
  citations: any[];
  pendingActions: any[];
}> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured');
  }

  const { content, orgId, userId, orgName, conversationHistory } = params;

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

  const systemPrompt = SYSTEM_PROMPT
    .replace('{{DATE}}', new Date().toISOString().split('T')[0]!)
    .replace('{{ORG}}', orgName || 'Unknown') + connectionInfo;

  const reasonConfig = getModelConfig('reason');
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

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
  let finalText = '';
  let intermediateText = ''; // Text from iterations with tool calls (preamble — usually discarded)

  let iterations = 0;
  while (iterations < 8) {
    iterations++;

    const response = await anthropic.messages.create({
      model: reasonConfig.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: apiMessages,
      tools,
    });

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
      break;
    }

    // This iteration has tool calls — text here is just preamble ("I'll search...")
    // Save it in case the final response is empty
    if (newText) {
      intermediateText += (intermediateText ? '\n\n' : '') + newText;
    }

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUseBlocks) {
      const isAction = allActionTools.has(tool.name);

      if (isAction) {
        // Write actions: skip in chat mention context, tell the agent it needs approval
        pendingActions.push({
          action: tool.name,
          params: tool.input,
        });
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: tool.id,
          content: JSON.stringify({
            status: 'skipped_in_chat_mention',
            message: 'Write actions are not auto-executed from chat mentions. Suggest the user use the Agent panel for this action.',
          }),
        });
      } else {
        // Read-only tools — execute immediately
        const { result, citations } = await executeToolCall(
          tool.name,
          tool.input as any,
          orgId,
          userId,
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

  return {
    text: responseText,
    citations: allCitations,
    pendingActions,
  };
}
