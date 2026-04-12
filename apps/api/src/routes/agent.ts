import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and, desc, lt, sql, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentConversations,
  agentMessages,
  agentActions,
  agentMemory,
  agentEmployees,
  connectedAccounts,
  orgs,
  tasks,
  messages,
  taskActivity,
  wikiPages,
} from '@deft/db/schema';
import { env } from '../lib/env.js';
import { getModelConfig } from '../lib/llm.js';
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS, MANAGER_TOOLS, SUPERINTENDENT_TOOLS, SUPERINTENDENT_ACTION_TOOLS } from '../lib/agent-tools.js';
import { executeToolCall } from '../lib/agent-context.js';
import { executeAction, executeActionDirect } from '../lib/agent-actions.js';
import { logAuditEvent } from '../lib/audit.js';
import { shouldAutoExecute, getApprovalTier, type TrustLevel } from '../lib/agent-approval.js';
import { getMCPToolsForAgent, mcpToolToAnthropicFormat } from '../lib/mcp-tools.js';

export const agentRoutes = new Hono();

const SYSTEM_PROMPT = `You are Deft, the AI assistant for this workspace. You have direct SQL access to the organization's data through tools.

Rules:
- Use search tools to find data before answering — don't guess
- Cite your sources (the tools return source IDs)
- Be concise and direct
- For write actions (create_task, update_task_status, assign_task, post_message), clearly explain what you'll do
- Use the remember tool to store important facts about users and conversations for future reference
- Use the recall tool to retrieve previously stored context when relevant
- For "why" questions (why is X behind, why is X blocked), do a multi-step investigation:
  1. First check the task details and status
  2. Then check the assignee's workload and recent activity
  3. Search for blocker mentions in chat
  4. Check task dependencies
  5. Synthesize your findings into a clear explanation
- Don't just return raw data — analyze patterns and suggest actions
- Current date: {{DATE}}
- Organization: {{ORG}}`;

// ── CRUD routes ──

agentRoutes.get('/conversations', async (c) => {
  const user = c.get('user');
  const employeeFilter = c.req.query('employee');

  const conditions = [
    eq(agentConversations.user_id, user.id),
    eq(agentConversations.org_id, user.org_id),
  ];
  if (employeeFilter) {
    conditions.push(eq(agentConversations.agent_employee_id, employeeFilter));
  } else {
    conditions.push(isNull(agentConversations.agent_employee_id));
  }

  const convos = await db
    .select()
    .from(agentConversations)
    .where(and(...conditions))
    .orderBy(desc(agentConversations.updated_at))
    .limit(50);
  return c.json(convos);
});

agentRoutes.post('/conversations', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const [convo] = await db
    .insert(agentConversations)
    .values({
      org_id: user.org_id,
      user_id: user.id,
      title: body.title || 'New conversation',
      agent_employee_id: body.agent_employee_id || null,
    })
    .returning();
  return c.json(convo, 201);
});

agentRoutes.patch('/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const { title } = body;
  if (title) {
    await db
      .update(agentConversations)
      .set({ title })
      .where(and(eq(agentConversations.id, id), eq(agentConversations.user_id, user.id)));
  }
  return c.json({ success: true });
});

agentRoutes.delete('/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await db.delete(agentMessages).where(eq(agentMessages.conversation_id, id));
  await db
    .delete(agentConversations)
    .where(
      and(eq(agentConversations.id, id), eq(agentConversations.user_id, user.id)),
    );
  return c.json({ success: true });
});

agentRoutes.get('/conversations/:id/messages', async (c) => {
  const id = c.req.param('id');

  // Expire stale pending actions (older than 1 hour)
  await db.update(agentActions)
    .set({ approval_status: 'expired' })
    .where(and(
      eq(agentActions.conversation_id, id),
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, new Date(Date.now() - 60 * 60 * 1000)),
    ));

  const messageList = await db
    .select()
    .from(agentMessages)
    .where(and(
      eq(agentMessages.conversation_id, id),
      eq(agentMessages.hidden, false),
    ))
    .orderBy(agentMessages.created_at);

  // Fetch all actions for this conversation
  const actionList = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.conversation_id, id));

  // Attach actions to their messages
  const messagesWithActions = messageList.map((m) => ({
    ...m,
    pending_actions: actionList
      .filter((a) => a.message_id === m.id)
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
  }));

  return c.json(messagesWithActions);
});

// ── Main chat endpoint — non-streaming tool loop, then stream final text ──

agentRoutes.post('/conversations/:id/messages', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');
  const body = await c.req.json();
  const { content, agent_employee_id, hidden } = body;
  const agentEmployeeId = agent_employee_id || undefined;

  if (!env.ANTHROPIC_API_KEY) {
    return c.json(
      { error: 'Anthropic API key not configured', code: 'NO_API_KEY' },
      503,
    );
  }

  // Save user message
  await db.insert(agentMessages).values({
    conversation_id: convoId,
    role: 'user',
    content,
    hidden: hidden || false,
  });

  // If agent_employee_id provided and conversation doesn't have one yet, set it
  if (agentEmployeeId) {
    const [existingConv] = await db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, convoId))
      .limit(1);
    if (existingConv && !existingConv.agent_employee_id) {
      await db
        .update(agentConversations)
        .set({ agent_employee_id: agentEmployeeId })
        .where(eq(agentConversations.id, convoId));
    }
  }

  // Auto-title on first message
  const [convo] = await db
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.id, convoId))
    .limit(1);
  if (convo && (!convo.title || convo.title === 'New conversation')) {
    await db
      .update(agentConversations)
      .set({ title: content.slice(0, 60) + (content.length > 60 ? '...' : '') })
      .where(eq(agentConversations.id, convoId));
  }

  // Load conversation history
  const history = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversation_id, convoId))
    .orderBy(agentMessages.created_at);

  const [org] = await db
    .select()
    .from(orgs)
    .where(eq(orgs.id, user.org_id))
    .limit(1);

  const trustLevel = (org?.trust_level || 'conservative') as TrustLevel;

  // Check connected accounts for dynamic tool availability
  const connections = await db.select({ provider: connectedAccounts.provider })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.user_id, user.id), eq(connectedAccounts.org_id, user.org_id)));
  const connectedProviders = connections.map(conn => conn.provider);

  // Build dynamic tool list — always include manager tools (privacy enforced at execution time)
  let tools = [...AGENT_TOOLS, ...MANAGER_TOOLS];
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
    const mcpTools = await getMCPToolsForAgent(org?.id ?? user.org_id, agentEmployeeId);
    const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropicFormat);
    tools = [...tools, ...mcpAnthropicTools];
    mcpTools.forEach(t => {
      if (t.approvalTierMapped !== 'auto') {
        allActionTools.add(t.name);
      }
    });
  } catch (err) {
    console.warn('[agent] Failed to load MCP tools:', err instanceof Error ? err.message : err);
  }

  // Load employee context if this is an employee conversation
  let employeePrompt: string | undefined;
  let employeeTrustLevel: string | undefined;
  let employeeNativeTools: string[] | null = null;

  if (agentEmployeeId) {
    const [emp] = await db.select().from(agentEmployees)
      .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.is_active, true)))
      .limit(1);
    if (emp) {
      employeeTrustLevel = emp.trust_level;
      employeeNativeTools = emp.native_tools;

      // Build augmented system prompt
      employeePrompt = `${emp.system_prompt}

## Your Identity
You are ${emp.name}, a ${emp.role.replace(/_/g, ' ')} at ${org?.name || 'this organization'}.
${emp.expertise_description ? `Your expertise: ${emp.expertise_description}` : ''}

## Permissions
Trust level: ${emp.trust_level}
Daily action budget: ${emp.max_daily_actions - emp.daily_action_count}/${emp.max_daily_actions} remaining

## Communication Guidelines
- In DMs: be thorough, provide detailed analysis.
- When assigned tasks: act autonomously within your scope.
- Always identify yourself. Never impersonate humans.`;
    }
  }

  // Superintendent tools — only for Defty, not employee conversations
  if (!agentEmployeeId) {
    tools = [...tools, ...SUPERINTENDENT_TOOLS];
    SUPERINTENDENT_ACTION_TOOLS.forEach(t => allActionTools.add(t));
  }

  // Filter tools by employee's allowed native tools
  if (agentEmployeeId && employeeNativeTools) {
    const allowed = new Set(employeeNativeTools);
    // Keep system tools (create_plan) + employee's allowed tools + MCP tools
    tools = tools.filter(t =>
      t.name === 'create_plan' ||
      t.name.startsWith('mcp__') ||
      allowed.has(t.name)
    );
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

  // Load agent memories for this user, conversation, and org
  let memoryContext = '';
  try {
    const userMemories = await db
      .select({ key: agentMemory.key, value: agentMemory.value })
      .from(agentMemory)
      .where(and(eq(agentMemory.user_id, user.id), eq(agentMemory.scope, 'user')));

    const convoMemories = await db
      .select({ key: agentMemory.key, value: agentMemory.value })
      .from(agentMemory)
      .where(and(eq(agentMemory.conversation_id, convoId), eq(agentMemory.scope, 'conversation')));

    const orgMemories = await db
      .select({ key: agentMemory.key, value: agentMemory.value })
      .from(agentMemory)
      .where(and(eq(agentMemory.org_id, user.org_id), eq(agentMemory.scope, 'org')));

    const allMemories = [
      ...userMemories.map(m => ({ ...m, scope: 'user' })),
      ...convoMemories.map(m => ({ ...m, scope: 'conversation' })),
      ...orgMemories.map(m => ({ ...m, scope: 'org' })),
    ];

    if (allMemories.length > 0) {
      memoryContext = '\n\nKnown context about this user/conversation/org:\n' +
        allMemories.map(m => `- [${m.scope}] ${m.key}: ${m.value}`).join('\n');
    }
  } catch (err) {
    console.error('[agent] Failed to load memories:', err);
  }

  let systemPrompt = SYSTEM_PROMPT.replace(
    '{{DATE}}',
    new Date().toISOString().split('T')[0]!,
  ).replace('{{ORG}}', org?.name || 'Unknown') + connectionInfo + memoryContext;

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
            eq(wikiPages.org_id, user.org_id),
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
          eq(wikiPages.org_id, user.org_id),
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
    console.warn('[agent] Wiki auto-load failed:', (err as Error).message);
  }

  if (employeePrompt) {
    systemPrompt = employeePrompt;
  }

  const reasonConfig = getModelConfig('reason');
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Create an AbortController for cancellation
  const abortController = new AbortController();

  // Create assistant message row early so actions can link to it
  const assistantMsgId = crypto.randomUUID();
  await db.insert(agentMessages).values({
    id: assistantMsgId,
    conversation_id: convoId,
    role: 'assistant',
    content: '',
    hidden: false,
  });

  return streamSSE(c, async (sseStream) => {
    console.log(`[agent] SSE stream started for conversation ${convoId}`);
    sseStream.onAbort(() => { console.log(`[agent] Stream aborted for ${convoId}`); abortController.abort(); });

    const write = async (data: any) => {
      await sseStream.writeSSE({ data: JSON.stringify(data) });
    };

    // Keepalive every 10s — streamSSE flushes each writeSSE call properly
    const keepalive = setInterval(async () => {
      try { await sseStream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) }); } catch { /* stream closed */ }
    }, 10000);

    let allCitations: any[] = [];
    let toolCalls: any[] = [];
    let pendingActions: any[] = [];
    let finalText = '';
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    try {
      // Build messages for Anthropic API
      let apiMessages: any[] = history.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Token budget instead of hard iteration cap — agent runs until done or budget exhausted
      const MAX_INPUT_TOKENS = 200_000; // ~$0.60 at Sonnet pricing — generous but bounded
      const MAX_ITERATIONS = 50; // absolute safety net (should never hit this)
      let iterations = 0;
      while (iterations < MAX_ITERATIONS && totalTokensIn < MAX_INPUT_TOKENS) {
        iterations++;

        console.log(`[agent] Iteration ${iterations}, tokens: ${totalTokensIn}/${MAX_INPUT_TOKENS}, messages: ${apiMessages.length}`);

        const response = await anthropic.messages.create({
          model: reasonConfig.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: apiMessages,
          tools,
        }, { signal: abortController.signal }).catch((err) => {
          console.error(`[agent] Anthropic API error:`, err.message, err.status, err.error);
          throw err;
        });

        // Accumulate token usage
        if (response.usage) {
          totalTokensIn += response.usage.input_tokens || 0;
          totalTokensOut += response.usage.output_tokens || 0;
        }

        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === 'text',
        );

        const newText = textBlocks.map((b: any) => b.text).join('\n\n').trim();

        if (toolUseBlocks.length === 0) {
          // No tool calls — this is the final response
          finalText = newText;
          break;
        }

        if (response.stop_reason === 'end_turn' && toolUseBlocks.length === 0) {
          finalText = newText;
          break;
        }

        // This iteration has tool calls — text is preamble ("I'll search...")
        // Don't add it to finalText — the final iteration's text is the real response

        // Execute tool calls
        const toolResults: any[] = [];
        for (const tool of toolUseBlocks) {
          const isAction = allActionTools.has(tool.name);

          if (isAction) {
            const approvalTier = getApprovalTier(tool.name);

            const effectiveTrustLevel = (employeeTrustLevel || trustLevel) as TrustLevel;
            if (shouldAutoExecute(tool.name, effectiveTrustLevel)) {
              // Trust level permits auto-execution
              await write({ type: 'tool_start', tool: tool.name });
              const { actionId, success, result, error } = await executeActionDirect(
                tool.name,
                tool.input as Record<string, any>,
                user.org_id,
                user.id,
                convoId,
                approvalTier,
              );

              await write({
                type: 'action_auto_executed',
                id: actionId,
                action: tool.name,
                params: tool.input,
                success,
                result,
                error,
              });

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
              // Needs user approval
              const [actionRecord] = await db
                .insert(agentActions)
                .values({
                  org_id: user.org_id,
                  user_id: user.id,
                  conversation_id: convoId,
                  action: tool.name,
                  params: tool.input as any,
                  approval_tier: approvalTier,
                  approval_status: 'pending',
                  message_id: assistantMsgId,
                })
                .returning();

              pendingActions.push({
                id: actionRecord!.id,
                action: tool.name,
                params: tool.input,
              });
              await write({
                type: 'pending_action',
                id: actionRecord!.id,
                action: tool.name,
                params: tool.input,
              });

              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: tool.id,
                content: JSON.stringify({
                  status: 'pending_approval',
                  action_id: actionRecord!.id,
                }),
              });
            }
          } else {
            // Read-only tools (including remember/recall) — execute immediately
            await write({ type: 'tool_start', tool: tool.name });
            try {
              const { result, citations } = await executeToolCall(
                tool.name,
                tool.input as any,
                user.org_id,
                user.id,
                convoId,
                agentEmployeeId,
              );
              allCitations.push(...citations);
              toolCalls.push({ tool: tool.name, params: tool.input, result });
              await write({
                type: 'tool_result',
                tool: tool.name,
                count: Array.isArray(result) ? result.length : 1,
              });

              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: tool.id,
                content: JSON.stringify(result),
              });
            } catch (toolErr) {
              console.error(`[agent] Tool ${tool.name} failed:`, toolErr);
              const errorMsg = toolErr instanceof Error ? toolErr.message : 'Tool execution failed';
              await write({ type: 'tool_result', tool: tool.name, error: errorMsg });
              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: tool.id,
                content: JSON.stringify({ error: errorMsg }),
                is_error: true,
              });
            }
          }
        }

        // Continue conversation with tool results
        apiMessages = [
          ...apiMessages,
          { role: 'assistant' as const, content: response.content },
          { role: 'user' as const, content: toolResults },
        ];

      }

      // If loop exited without a final response (budget/iteration limit), force one
      if (!finalText && totalTokensIn > 0) {
        console.log(`[agent] Budget/iteration limit reached (${iterations} iters, ${totalTokensIn} tokens). Forcing final response.`);
        try {
          const finalResponse = await anthropic.messages.create({
            model: reasonConfig.model,
            max_tokens: 4096,
            system: systemPrompt + '\n\nIMPORTANT: You have used all available research steps. Provide your best answer NOW based on everything gathered. Do NOT call any tools.',
            messages: apiMessages,
          }, { signal: abortController.signal });

          if (finalResponse.usage) {
            totalTokensIn += finalResponse.usage.input_tokens || 0;
            totalTokensOut += finalResponse.usage.output_tokens || 0;
          }
          const finalTextBlocks = finalResponse.content.filter(
            (b): b is Anthropic.TextBlock => b.type === 'text',
          );
          finalText = finalTextBlocks.map((b: any) => b.text).join('\n\n').trim();
        } catch (err) {
          console.error(`[agent] Forced final response failed:`, err);
          finalText = '*I gathered extensive information but encountered an issue generating the final summary. Please try asking again.*';
        }
      }

      // Stream final text word by word for a typing effect
      if (finalText) {
        const words = finalText.split(/(\s+)/);
        for (const word of words) {
          if (abortController.signal.aborted) break;
          await write({ type: 'text', text: word });
          await new Promise((r) => setTimeout(r, 12));
        }
      }

      // Send citations and pending actions
      if (allCitations.length > 0) {
        await write({ type: 'citations', citations: allCitations });
      }
      if (pendingActions.length > 0) {
        await write({ type: 'actions', actions: pendingActions });
      }
      clearInterval(keepalive);
      await write({ type: 'done', model: reasonConfig.model, tokens_in: totalTokensIn, tokens_out: totalTokensOut });

      // Update the pre-created assistant message row with final content
      await db
        .update(agentMessages)
        .set({
          content: finalText || '',
          citations: allCitations.length > 0 ? (allCitations as any) : null,
          tool_calls: toolCalls.length > 0 ? (toolCalls as any) : null,
          model: reasonConfig.model,
          tokens_in: totalTokensIn,
          tokens_out: totalTokensOut,
        })
        .where(eq(agentMessages.id, assistantMsgId));
      await db
        .update(agentConversations)
        .set({ updated_at: new Date() })
        .where(eq(agentConversations.id, convoId));
    } catch (err) {
      clearInterval(keepalive);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[agent] Stream error:', errMsg);
      try {
        await write({
          type: 'error',
          error: errMsg,
        });
        await write({ type: 'done' });
      } catch {
        // Stream may already be closed
      }

      // Save error into the pre-created assistant message so user sees something on refresh
      try {
        const errorContent = finalText
          ? finalText + '\n\n*[An error occurred while processing: ' + errMsg + ']*'
          : '*I encountered an error processing your request: ' + errMsg + '. Please try again.*';
        await db
          .update(agentMessages)
          .set({
            content: errorContent,
            model: reasonConfig.model,
          })
          .where(eq(agentMessages.id, assistantMsgId));
      } catch {
        // DB save failed too — nothing we can do
      }
    }
  });
});

// ── Action approval / rejection / undo ──

agentRoutes.post('/actions/:id/approve', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, user.org_id)))
    .limit(1);
  if (!action) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (action.approval_status !== 'pending') {
    return c.json({ error: 'Already processed', code: 'ALREADY_PROCESSED' }, 400);
  }

  await db
    .update(agentActions)
    .set({ approval_status: 'approved', approved_at: new Date() })
    .where(eq(agentActions.id, actionId));

  const result = await executeAction(
    actionId,
    action.action,
    action.params as any,
    user.org_id,
    user.id,
  );
  return c.json({ ...result, executed_at: new Date().toISOString() });
});

agentRoutes.post('/actions/:id/reject', async (c) => {
  const actionId = c.req.param('id');
  await db
    .update(agentActions)
    .set({ approval_status: 'rejected' })
    .where(eq(agentActions.id, actionId));
  return c.json({ success: true });
});

agentRoutes.post('/actions/:id/undo', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, user.org_id)))
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

  // Auto-expire stale pending actions (older than 1 hour)
  await db.update(agentActions)
    .set({ approval_status: 'expired' })
    .where(and(
      eq(agentActions.org_id, user.org_id),
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, new Date(Date.now() - 60 * 60 * 1000)),
    ));

  const actions = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.org_id, user.org_id))
    .orderBy(desc(agentActions.created_at))
    .limit(100);
  return c.json(actions);
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

agentRoutes.patch('/settings', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { trust_level } = body;

  const validLevels = ['conservative', 'standard', 'autonomous'];
  if (!trust_level || !validLevels.includes(trust_level)) {
    return c.json({ error: 'Invalid trust level', code: 'VALIDATION_ERROR' }, 400);
  }

  await db
    .update(orgs)
    .set({ trust_level })
    .where(eq(orgs.id, user.org_id));

  return c.json({ success: true, trust_level });
});
