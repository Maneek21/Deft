import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import Anthropic from '@anthropic-ai/sdk';
import type { TrustLevel } from '../lib/agent-approval.js';
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
import { shouldAutoExecute, getApprovalTier } from '../lib/agent-approval.js';
import { getMCPToolsForAgent, mcpToolToAnthropicFormat } from '../lib/mcp-tools.js';
import { runAgentStreamingLoop } from '../lib/agent-stream-loop.js';

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

// ── Stream context types ──

type StreamContextError = { _kind: 'error'; error: string; code: string; status: 400 | 403 | 404 | 503 };
type StreamContextOk = {
  _kind: 'ok';
  apiMessages: Anthropic.MessageParam[];
  systemPrompt: string;
  tools: Anthropic.Tool[];
  allActionTools: Set<string>;
  trustLevel: TrustLevel;
  model: string;
  agentEmployeeId: string | undefined;
};
type StreamContext = StreamContextOk | StreamContextError;

async function buildStreamContext(
  user: { id: string; org_id: string },
  convoId: string,
): Promise<StreamContext> {
  if (!env.ANTHROPIC_API_KEY) {
    return { _kind: 'error', error: 'Anthropic API key not configured', code: 'NO_API_KEY', status: 503 };
  }

  // Load the conversation to get agent_employee_id
  const [convo] = await db
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.id, convoId))
    .limit(1);
  const agentEmployeeId = convo?.agent_employee_id ?? undefined;

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
  let tools: Anthropic.Tool[] = [...AGENT_TOOLS, ...MANAGER_TOOLS];
  const allActionTools = new Set([...ACTION_TOOLS]);
  if (connectedProviders.includes('google_calendar')) {
    tools = [...tools, ...CALENDAR_TOOLS];
    CALENDAR_ACTION_TOOLS.forEach(t => allActionTools.add(t));
  }
  if (connectedProviders.includes('github')) {
    tools = [...tools, ...GITHUB_TOOLS];
    GITHUB_ACTION_TOOLS.forEach(t => allActionTools.add(t));
  }

  // MCP tools — discover from active connections and auto-classify tiers.
  const mcpToolsBySlug = new Map<string, { originalName: string; tier: string }[]>();
  try {
    const mcpTools = await getMCPToolsForAgent(org?.id ?? user.org_id, agentEmployeeId);
    const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropicFormat);
    tools = [...tools, ...mcpAnthropicTools];
    mcpTools.forEach(t => {
      if (t.approvalTierMapped !== 'auto') {
        allActionTools.add(t.name);
      }
      const slug = t.connectionSlug;
      const existing = mcpToolsBySlug.get(slug) || [];
      existing.push({ originalName: t.originalName, tier: t.approvalTierMapped });
      mcpToolsBySlug.set(slug, existing);
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
  ).replace('{{ORG}}', org?.name || 'Unknown');
  let wikiSection = '';

  // Auto-load relevant wiki context using the last user message as the search query
  try {
    // Derive search query from the most recent user message in history
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    const rawQuery = lastUserMsg?.content || '';
    const searchQuery = rawQuery.replace(/[^a-zA-Z0-9\s]/g, '').trim();
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
        wikiSection = `\n\nRelevant knowledge from the team wiki:\n${wikiContext}\nUse wiki_search and wiki_read tools for more details.`;
      }
    }
  } catch (err) {
    console.warn('[agent] Wiki auto-load failed:', (err as Error).message);
  }

  // Build the MCP capabilities section so the agent knows what external tools
  // it has. Without this, employees with a narrow stored system prompt
  // (e.g. "project manager") will refuse to use browser tools as "outside scope".
  let mcpCapabilitiesSection = '';
  if (mcpToolsBySlug.size > 0) {
    const lines: string[] = ['\n\n## Your Connected MCP Capabilities'];
    for (const [slug, toolList] of mcpToolsBySlug.entries()) {
      lines.push(`\n**${slug}** — ${toolList.length} tools available:`);
      const byTier: Record<string, string[]> = { auto: [], quick: [], full: [] };
      for (const t of toolList) byTier[t.tier]?.push(t.originalName);
      if (byTier.auto!.length) lines.push(`  - instant (no approval needed): ${byTier.auto!.join(', ')}`);
      if (byTier.quick!.length) lines.push(`  - quick-approve: ${byTier.quick!.join(', ')}`);
      if (byTier.full!.length)  lines.push(`  - full-review (ask first): ${byTier.full!.join(', ')}`);
    }
    lines.push(
      '\nUse these tools whenever the user asks for something that matches their purpose.',
      'Do NOT disclaim that the task is "outside your scope" — if the tool is listed here, it IS in scope.',
      'Do NOT narrate approval flow to the user — the UI already shows an approve/reject card.',
      'When a tool requires approval, call it once and stop; wait for the result to come back.',
    );
    mcpCapabilitiesSection = lines.join('\n');
  }

  if (employeePrompt) {
    systemPrompt = employeePrompt + connectionInfo + memoryContext + wikiSection + mcpCapabilitiesSection;
  } else {
    systemPrompt = systemPrompt + connectionInfo + memoryContext + wikiSection + mcpCapabilitiesSection;
  }

  const reasonConfig = getModelConfig('reason');

  // Rehydrate history into Anthropic message format. Rows with content_blocks
  // use the structured form; legacy rows fall back to plain text. Skip empty rows.
  const apiMessages: Anthropic.MessageParam[] = [];
  for (const m of history) {
    const blocks = (m as any).content_blocks;
    if (blocks && Array.isArray(blocks) && blocks.length > 0) {
      apiMessages.push({ role: m.role as 'user' | 'assistant', content: blocks as any });
    } else if (m.content && m.content.trim().length > 0) {
      apiMessages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }
  }

  return {
    _kind: 'ok',
    apiMessages,
    systemPrompt,
    tools,
    allActionTools,
    trustLevel: (employeeTrustLevel ?? trustLevel) as TrustLevel,
    model: reasonConfig.model,
    agentEmployeeId,
  };
}

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

agentRoutes.get('/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [conv] = await db
    .select()
    .from(agentConversations)
    .where(and(eq(agentConversations.id, id), eq(agentConversations.user_id, user.id)))
    .limit(1);
  if (!conv) return c.json({ error: 'Not found' }, 404);
  return c.json(conv);
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

// ── Main chat endpoint ──

agentRoutes.post('/conversations/:id/messages', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');
  const body = await c.req.json();
  const { content, agent_employee_id, hidden } = body;

  // Insert the user message first so buildStreamContext picks it up.
  await db.insert(agentMessages).values({
    conversation_id: convoId,
    role: 'user',
    content,
    hidden: hidden || false,
  });

  // Auto-set agent_employee_id on conversation if provided and not yet set.
  if (agent_employee_id) {
    const [existingConv] = await db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, convoId))
      .limit(1);
    if (existingConv && !existingConv.agent_employee_id) {
      await db
        .update(agentConversations)
        .set({ agent_employee_id })
        .where(eq(agentConversations.id, convoId));
    }
  }

  // Auto-title on first message.
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

  const ctx = await buildStreamContext(user, convoId);
  if (ctx._kind === 'error') {
    return c.json({ error: ctx.error, code: ctx.code }, ctx.status);
  }

  return streamSSE(c, async (sseStream) => {
    const abortController = new AbortController();
    sseStream.onAbort(() => abortController.abort());
    const write = async (data: any) => {
      await sseStream.writeSSE({ data: JSON.stringify(data) });
    };
    const keepalive = setInterval(async () => {
      try { await sseStream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) }); } catch { /* closed */ }
    }, 10000);

    try {
      const result = await runAgentStreamingLoop({
        convoId,
        userId: user.id,
        orgId: user.org_id,
        agentEmployeeId: ctx.agentEmployeeId,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        allActionTools: ctx.allActionTools,
        trustLevel: ctx.trustLevel,
        apiMessages: ctx.apiMessages,
        write,
        abortSignal: abortController.signal,
        model: ctx.model,
      });
      if (result.citations.length > 0) await write({ type: 'citations', citations: result.citations });
      if (result.pendingActions.length > 0) await write({ type: 'actions', actions: result.pendingActions });
      clearInterval(keepalive);
      await write({ type: 'done', model: ctx.model, tokens_in: result.totalTokensIn, tokens_out: result.totalTokensOut });
    } catch (err) {
      clearInterval(keepalive);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[agent] Stream error:', errMsg);
      try { await write({ type: 'error', error: errMsg }); } catch { /* closed */ }
    }
  });
});

// ── Continue endpoint — resumes the agent after an approval ──

agentRoutes.post('/conversations/:id/continue', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');

  // Verify conversation ownership.
  const [convo] = await db
    .select()
    .from(agentConversations)
    .where(and(eq(agentConversations.id, convoId), eq(agentConversations.user_id, user.id)))
    .limit(1);
  if (!convo) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  const ctx = await buildStreamContext(user, convoId);
  if (ctx._kind === 'error') {
    return c.json({ error: ctx.error, code: ctx.code }, ctx.status);
  }

  return streamSSE(c, async (sseStream) => {
    const abortController = new AbortController();
    sseStream.onAbort(() => abortController.abort());
    const write = async (data: any) => { await sseStream.writeSSE({ data: JSON.stringify(data) }); };
    const keepalive = setInterval(async () => {
      try { await sseStream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) }); } catch { /* closed */ }
    }, 10000);

    try {
      const result = await runAgentStreamingLoop({
        convoId,
        userId: user.id,
        orgId: user.org_id,
        agentEmployeeId: ctx.agentEmployeeId,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        allActionTools: ctx.allActionTools,
        trustLevel: ctx.trustLevel,
        apiMessages: ctx.apiMessages,
        write,
        abortSignal: abortController.signal,
        model: ctx.model,
      });
      if (result.citations.length > 0) await write({ type: 'citations', citations: result.citations });
      if (result.pendingActions.length > 0) await write({ type: 'actions', actions: result.pendingActions });
      clearInterval(keepalive);
      await write({ type: 'done', model: ctx.model, tokens_in: result.totalTokensIn, tokens_out: result.totalTokensOut });
    } catch (err) {
      clearInterval(keepalive);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      try { await write({ type: 'error', error: errMsg }); } catch { /* closed */ }
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

  const execResult = await executeAction(
    actionId,
    action.action,
    action.params as any,
    user.org_id,
    user.id,
  );

  // Insert a hidden user agent_messages row with a proper tool_result block so
  // the next streaming turn (via /continue) sees a valid Anthropic tool_use →
  // tool_result pair. This is what eliminates the "messages repeated over and
  // over" disclaimers — the model can see its own prior call and its real result.
  if (action.tool_use_id && action.conversation_id) {
    const toolResultBlock = {
      type: 'tool_result' as const,
      tool_use_id: action.tool_use_id,
      content: JSON.stringify(
        execResult.success
          ? execResult.result
          : { error: execResult.error || 'Action failed' }
      ),
      ...(execResult.success ? {} : { is_error: true }),
    };
    await db.insert(agentMessages).values({
      conversation_id: action.conversation_id,
      role: 'user',
      content: '',
      content_blocks: [toolResultBlock] as any,
      hidden: true,
    });
  }

  return c.json({ ...execResult, executed_at: new Date().toISOString() });
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
