import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { TrustLevel } from '../lib/agent-approval.js';
import { eq, and, asc, desc, lt, sql, isNull, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentActions,
  agentMemory,
  agentEmployees,
  actionReceipts,
  orgs,
  tasks,
  messages,
  taskActivity,
  users,
  spaces,
  spaceMembers,
} from '@deft/db/schema';
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';
import { ensureAgentConversationSpace } from '../lib/ensure-agent-conversation-space.js';
import { env } from '../lib/env.js';
import { resolveReasonProvider, type ResolvedReasonProvider } from '../lib/org-ai-config.js';
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_READ_TOOLS, MANAGER_TOOLS, SUPERINTENDENT_TOOLS, SUPERINTENDENT_ACTION_TOOLS } from '../lib/agent-tools.js';
import { executeToolCall } from '../lib/agent-context.js';
import { executeAction, executeActionDirect } from '../lib/agent-actions.js';
import { logAuditEvent } from '../lib/audit.js';
import { shouldAutoExecute, getApprovalTier } from '../lib/agent-approval.js';
import { getMCPToolsForAgent, mcpToolToAnthropicFormat } from '../lib/mcp-tools.js';
import { runAgentStreamingLoop } from '../lib/agent-stream-loop.js';
import { retrieveContext } from '../lib/retrieve-context.js';
import {
  approveAction as resolveApproveAction,
  rejectAction as resolveRejectAction,
  MCP_ACTION_KINDS,
} from '../lib/agent-approval-resolver.js';

export const agentRoutes = new Hono();

const SYSTEM_PROMPT = `You are Deft, the AI assistant for this workspace. You have direct SQL access to the organization's data through tools.

Rules:
- ALWAYS use the search/list tools to ground your answer before responding. Even for simple questions about workspace data (members, tasks, projects, recent messages), call the relevant tool — never answer from conversation context alone. Use the tools silently (see narration rule below); just don't skip them.
- Cite your sources (the tools return source IDs)
- Be concise and direct
- Before proposing a write action that names a person (assignee, mentioned user) or project, verify they exist using the appropriate search tool. If the named entity doesn't exist in this workspace, ASK the user to clarify rather than confidently proposing a write against a fabricated name. Never invent a project name to attach a task to — if the user hasn't named a project, OR explicitly says "no project", set project_name to "" (empty string). NEVER default to "General", "Inbox", "Default", or any other invented project name; there is no implicit default project. Same rule for assignee_name when unassigned.
- For write actions (create_task, update_task_status, assign_task, post_message), clearly explain what you'll do. Write actions that require approval are queued for the user — an Approve/Reject card appears inline on your reply, and pending actions are also listed in the user's Inbox under the Approvals tab. Do NOT refer to an "Agent panel" or "Agent dashboard" — neither exists.
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
  resolved: ResolvedReasonProvider;
  agentEmployeeId: string | undefined;
  agentUserId: string;
};
type StreamContext = StreamContextOk | StreamContextError;

async function buildStreamContext(
  user: { id: string; org_id: string },
  convoId: string,
): Promise<StreamContext> {
  // BYOK — resolve the org's chosen reasoning provider (anthropic | openai |
  // openrouter | ollama) with env fallback. Ollama needs no key.
  const resolved = await resolveReasonProvider(user.org_id);
  if (!resolved.apiKey && resolved.provider !== 'ollama') {
    return { _kind: 'error', error: `${resolved.provider} API key not configured`, code: 'NO_API_KEY', status: 503 };
  }

  // Derive agent_employee_id from the space members: find the non-user member,
  // then look up their agent_employees row. The old agentConversations table is gone.
  const spaceAgentMembers = await db
    .select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, convoId), sql`${spaceMembers.user_id} != ${user.id}`));
  const agentMemberUserId = spaceAgentMembers[0]?.user_id;
  let agentEmployeeId: string | undefined;
  if (agentMemberUserId) {
    const [emp] = await db.select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(eq(agentEmployees.user_id, agentMemberUserId))
      .limit(1);
    agentEmployeeId = emp?.id;
  }

  // Load conversation history from the unified messages table (space_id = convoId).
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.space_id, convoId))
    .orderBy(messages.created_at);

  const [org] = await db
    .select()
    .from(orgs)
    .where(eq(orgs.id, user.org_id))
    .limit(1);

  const trustLevel = (org?.trust_level || 'conservative') as TrustLevel;

  // Build dynamic tool list — always include manager tools (privacy enforced at execution time)
  let tools: Anthropic.Tool[] = [...AGENT_TOOLS, ...CALENDAR_READ_TOOLS, ...MANAGER_TOOLS];
  const allActionTools = new Set([...ACTION_TOOLS]);

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

  if (agentEmployeeId) {
    const [emp] = await db.select().from(agentEmployees)
      .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.is_active, true)))
      .limit(1);
    if (emp) {
      employeeTrustLevel = emp.trust_level;

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

  // Task 4.12 — per-employee native-tool filtering previously read
  // agent_employees.native_tools[]. The column was dropped (migration
  // 0038) in favour of the skills primitive; employee tool selection now
  // flows through agent_employee_skills + capability packs. No filter
  // is applied here — scope enforcement lives in the skills loader.

  let connectionInfo = '\nYou can read native Deft calendar events and imported ICS calendar feeds with check_calendar.';

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
    const lastUserMsg = [...history].reverse().find(m => m.user_id === user.id);
    const rawQuery = lastUserMsg?.content || '';
    const searchQuery = rawQuery.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (searchQuery.length > 2) {
      const wikiResults = await retrieveContext({
        query: searchQuery,
        org_id: user.org_id,
        agent_employee_id: agentEmployeeId,
        types: ['wiki'],
        limit: 5,
      });
      if (wikiResults.length > 0) {
        const wikiContext = wikiResults.map(r =>
          `- **${r.title}** (${(r.metadata?.type as string) || 'wiki'}, confidence: ${r.confidence ?? 1}): ${r.content || 'No summary'}`
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

  // Resolve the agent's user_id from space_members (the non-current-user member).
  // Must happen before history rehydration so we can distinguish user vs assistant rows.
  const otherMembers = await db
    .select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(and(
      eq(spaceMembers.space_id, convoId),
      sql`${spaceMembers.user_id} != ${user.id}`,
    ));
  const resolvedAgentUserId = otherMembers[0]?.user_id;
  if (!resolvedAgentUserId) {
    return { _kind: 'error', error: 'Conversation has no agent member', code: 'INVALID_STATE', status: 400 };
  }

  // Rehydrate history into Anthropic message format.
  // messages rows use user_id (not role) — agent user_id → 'assistant', current user → 'user'.
  // metadata.agent_blocks carries structured content (replaces old content_blocks column).
  // Rows with metadata.hidden=true are tool_use iterations that should stay in the
  // message history so the model sees its previous reasoning (just not shown in UI).
  const apiMessages: Anthropic.MessageParam[] = [];
  for (const m of history) {
    const meta = (m.metadata as any) ?? {};
    const role: 'user' | 'assistant' = m.user_id === resolvedAgentUserId ? 'assistant' : 'user';
    const blocks = meta.agent_blocks;
    if (blocks && Array.isArray(blocks) && blocks.length > 0) {
      apiMessages.push({ role, content: blocks as any });
    } else if (m.content && m.content.trim().length > 0) {
      apiMessages.push({ role, content: m.content });
    }
  }

  return {
    _kind: 'ok',
    apiMessages,
    systemPrompt,
    tools,
    allActionTools,
    trustLevel: (employeeTrustLevel ?? trustLevel) as TrustLevel,
    resolved,
    agentEmployeeId,
    agentUserId: resolvedAgentUserId,
  };
}

// ── CRUD routes ──

agentRoutes.get('/conversations', async (c) => {
  const user = c.get('user');
  const employeeIdFilter = c.req.query('employee') ?? c.req.query('agent_employee_id') ?? null;

  // Resolve the agent's user_id so we can filter by space membership.
  let agentFilterUserId: string | null = null;
  if (employeeIdFilter) {
    const [emp] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, employeeIdFilter))
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

agentRoutes.post('/conversations', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));

  const conversationId = randomUUID();
  let agentUserId: string;
  if (body.agent_employee_id) {
    const [emp] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, body.agent_employee_id))
      .limit(1);
    if (!emp) {
      return c.json({ error: 'Unknown agent employee', code: 'NOT_FOUND' }, 404);
    }
    agentUserId = emp.user_id;
  } else {
    agentUserId = await ensureDeftyMembership(user.org_id);
  }

  const title = body.title || 'New conversation';
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
  const id = c.req.param('id');
  // Verify the current user is a member of this agent_conversation space.
  const rows = await db.execute(sql`
    SELECT s.id, s.name AS title, s.created_at, s.updated_at, s.org_id,
           ae.id AS agent_employee_id
    FROM spaces s
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id != ${user.id}
    LEFT JOIN agent_employees ae ON ae.user_id = sm.user_id
    WHERE s.id = ${id}
      AND s.org_id = ${user.org_id}
      AND s.type = 'agent_conversation'
      AND EXISTS (SELECT 1 FROM space_members usm WHERE usm.space_id = s.id AND usm.user_id = ${user.id})
    LIMIT 1
  `);
  const conv = rows.rows[0] as any;
  if (!conv) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: conv.id,
    user_id: user.id,
    org_id: conv.org_id,
    agent_employee_id: conv.agent_employee_id ?? null,
    title: conv.title,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
  });
});

agentRoutes.patch('/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const { title } = body;
  if (title) {
    // Verify membership before allowing rename.
    const [membership] = await db.select({ space_id: spaceMembers.space_id })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.space_id, id), eq(spaceMembers.user_id, user.id)))
      .limit(1);
    if (membership) {
      await db
        .update(spaces)
        .set({ name: title })
        .where(and(eq(spaces.id, id), eq(spaces.org_id, user.org_id)));
    }
  }
  return c.json({ success: true });
});

agentRoutes.delete('/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Verify the requester is a member of this agent_conversation space.
  const [membership] = await db.select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, id), eq(spaceMembers.user_id, user.id)))
    .limit(1);

  if (!membership) {
    return c.json({ success: true });
  }

  // Soft-delete: archive the space and soft-delete its messages.
  await db.update(spaces)
    .set({ is_archived: true })
    .where(and(eq(spaces.id, id), eq(spaces.org_id, user.org_id)));
  await db.update(messages)
    .set({ is_deleted: true })
    .where(and(eq(messages.space_id, id), eq(messages.org_id, user.org_id)));

  return c.json({ success: true });
});

agentRoutes.get('/conversations/:id/messages', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Expire stale pending actions (older than 1 hour)
  await db.update(agentActions)
    .set({ approval_status: 'expired' })
    .where(and(
      eq(agentActions.conversation_id, id),
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, new Date(Date.now() - 60 * 60 * 1000)),
    ));

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

  // Determine the agent user id for role assignment (the non-current-user member of the DM space).
  const otherMembers = await db
    .select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(and(
      eq(spaceMembers.space_id, id),
      sql`${spaceMembers.user_id} != ${user.id}`,
    ));
  const agentUserId = otherMembers[0]?.user_id ?? null;

  // Filter out tool_result rows and explicitly hidden rows (user-visible list only).
  const visible = rows.filter((r) => {
    const m = (r.metadata as any) || {};
    return m.kind !== 'tool_result' && m.hidden !== true;
  });

  // Fetch all actions for this conversation
  const actionList = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.conversation_id, id));

  // Map to the shape AgentChat expects and attach pending_actions.
  const messagesWithActions = visible.map((r) => {
    const m = (r.metadata as any) || {};
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

// ── Main chat endpoint ──

agentRoutes.post('/conversations/:id/messages', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');
  const body = await c.req.json();
  const { content, agent_employee_id, hidden } = body;

  // Insert the user message into the unified messages table (space_id = convoId).
  await db.insert(messages).values({
    org_id: user.org_id,
    space_id: convoId,
    user_id: user.id,
    content,
  });

  // Auto-title on first message: update spaces.name when it is still the default.
  const [spaceRow] = await db
    .select({ name: spaces.name })
    .from(spaces)
    .where(and(eq(spaces.id, convoId), eq(spaces.org_id, user.org_id)))
    .limit(1);
  if (spaceRow && (!spaceRow.name || spaceRow.name === 'New conversation')) {
    await db
      .update(spaces)
      .set({ name: content.slice(0, 60) + (content.length > 60 ? '...' : '') })
      .where(and(eq(spaces.id, convoId), eq(spaces.org_id, user.org_id)));
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
        agentUserId: ctx.agentUserId,
        agentEmployeeId: ctx.agentEmployeeId,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        allActionTools: ctx.allActionTools,
        trustLevel: ctx.trustLevel,
        apiMessages: ctx.apiMessages,
        write,
        abortSignal: abortController.signal,
        resolved: ctx.resolved,
      });
      if (result.citations.length > 0) await write({ type: 'citations', citations: result.citations });
      if (result.pendingActions.length > 0) await write({ type: 'actions', actions: result.pendingActions });
      clearInterval(keepalive);
      await write({ type: 'done', model: ctx.resolved.model, tokens_in: result.totalTokensIn, tokens_out: result.totalTokensOut });
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

  // Verify the current user is a member of this agent_conversation space.
  const [convoMembership] = await db
    .select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, convoId), eq(spaceMembers.user_id, user.id)))
    .limit(1);
  if (!convoMembership) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

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
        agentUserId: ctx.agentUserId,
        agentEmployeeId: ctx.agentEmployeeId,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        allActionTools: ctx.allActionTools,
        trustLevel: ctx.trustLevel,
        apiMessages: ctx.apiMessages,
        write,
        abortSignal: abortController.signal,
        resolved: ctx.resolved,
      });
      if (result.citations.length > 0) await write({ type: 'citations', citations: result.citations });
      if (result.pendingActions.length > 0) await write({ type: 'actions', actions: result.pendingActions });
      clearInterval(keepalive);
      await write({ type: 'done', model: ctx.resolved.model, tokens_in: result.totalTokensIn, tokens_out: result.totalTokensOut });
    } catch (err) {
      clearInterval(keepalive);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      try { await write({ type: 'error', error: errMsg }); } catch { /* closed */ }
    }
  });
});

// ── Action approval / rejection / undo ──

// Phase 6.5 — Pending approvals list for the Settings → Agent pending
// approvals section. Returns the current user's org's pending MCP-sourced
// actions (the new employee-write kinds) plus the legacy Defty actions.
// The UI uses the `proposer` field + `employee_name` to show a source badge.
agentRoutes.get('/actions/pending', async (c) => {
  const user = c.get('user');
  // Auto-expire stale pending actions so the list doesn't grow forever.
  await db.update(agentActions)
    .set({ approval_status: 'expired' })
    .where(and(
      eq(agentActions.org_id, user.org_id),
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, new Date(Date.now() - 24 * 60 * 60 * 1000)),
    ));

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
      eq(agentActions.agent_employee_id, agentEmployees.id),
    )
    .where(
      and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
        // Auto-tier rows are routing/queue entries (chat_mention, heartbeat,
        // trigger, task assignment) that BYOA runtimes pull via MCP. Not
        // user-actionable — exclude from approvals view.
        inArray(agentActions.approval_tier, ['quick', 'full']),
      ),
    )
    .orderBy(desc(agentActions.created_at))
    .limit(50);

  const actions = rows.map((r) => ({
    ...r,
    proposer: r.agent_employee_id ? 'employee' : 'defty',
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
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)))
    .limit(1);
  if (!membership) {
    return c.json([], 200);
  }

  const rows = await db.execute(sql`
    SELECT a.*
    FROM agent_actions a
    JOIN messages msg ON msg.id = a.message_id
    WHERE msg.space_id = ${spaceId}
      AND msg.org_id = ${user.org_id}
      AND a.approval_status = 'pending'
      AND a.approval_tier IN ('quick', 'full')
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
// tool_calls + citations. Ownership: caller must be in the
// conversation's org; agent_actions attached to each message are
// also joined in so the downloaded trace matches what renders in
// the session inspector.
agentRoutes.get('/conversations/:id/trace.json', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');

  // P2-7: Look up from spaces (conversations are now spaces of type agent_conversation).
  // Ownership check: the caller must be a member of the space within their org.
  const [convo] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, convoId), eq(spaces.org_id, user.org_id)))
    .limit(1);
  if (!convo) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  // Verify caller is a member of this space.
  const [membership] = await db
    .select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, convoId), eq(spaceMembers.user_id, user.id)))
    .limit(1);
  if (!membership) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

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

  // Determine agent user id for role assignment.
  const traceOtherMembers = await db
    .select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(and(
      eq(spaceMembers.space_id, convoId),
      sql`${spaceMembers.user_id} != ${user.id}`,
    ));
  const traceAgentUserId = traceOtherMembers[0]?.user_id ?? null;

  const msgs = msgRows.map((r) => {
    const m = (r.metadata as any) || {};
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
    .where(eq(agentActions.conversation_id, convoId))
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
    .leftJoin(agentEmployees, eq(agentActions.agent_employee_id, agentEmployees.id))
    .where(eq(agentActions.org_id, user.org_id))
    .orderBy(desc(agentActions.created_at))
    .limit(limit);

  return c.json({
    actions: rows.map((r) => ({
      ...r,
      proposer: r.agent_employee_id ? 'employee' : 'defty',
    })),
  });
});

agentRoutes.post('/actions/:id/approve', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, user.org_id)))
    .limit(1);
  if (!action) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  // Phase 6.5 — MCP-sourced actions (task_create/task_update/message_post/
  // memory_update) go through the approval resolver, which rebuilds the
  // ToolContext from the employee row and dispatches to the inner execute*
  // functions. Legacy Defty actions (create_task/update_task_status/…)
  // still use the original executeAction path.
  if (MCP_ACTION_KINDS.has(action.action)) {
    const result = await resolveApproveAction(actionId, user.id);
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
    return c.json({
      status: result.status,
      message: 'message' in result ? result.message : undefined,
      result: 'result' in result ? result.result : undefined,
    });
  }

  if (action.approval_status !== 'pending') {
    return c.json({ error: 'Already processed', code: 'ALREADY_PROCESSED' }, 400);
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
      .set({ approval_status: 'approved', approved_at: new Date() })
      .where(eq(agentActions.id, actionId));
  } else {
    await db
      .update(agentActions)
      .set({ error: execResult.error ?? 'Action failed' })
      .where(eq(agentActions.id, actionId));
  }

  // Insert a hidden tool_result message into the unified messages table so
  // the next streaming turn (via /continue) sees a valid Anthropic tool_use →
  // tool_result pair. This eliminates the "messages repeated over and over"
  // disclaimers — the model can see its own prior call and its real result.
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
    await db.insert(messages).values({
      org_id: action.org_id,
      space_id: action.conversation_id,
      user_id: action.user_id,
      content: '',
      metadata: {
        kind: 'tool_result',
        hidden: true,
        agent_blocks: [toolResultBlock],
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
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, user.org_id)))
    .limit(1);

  if (!action) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }

  // Phase 6.5 — MCP-sourced actions go through the resolver for idempotency
  // + permission enforcement + reason capture.
  if (MCP_ACTION_KINDS.has(action.action)) {
    const result = await resolveRejectAction(actionId, user.id, reason);
    if (result.status === 'error') {
      const statusCode =
        result.code === 'NOT_FOUND' ? 404
        : result.code === 'FORBIDDEN' ? 403
        : 400;
      return c.json({ error: result.message, code: result.code }, statusCode);
    }
    return c.json({ status: result.status });
  }

  await db
    .update(agentActions)
    .set({ approval_status: 'rejected', error: reason ?? null })
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

  // Auto-expire stale pending actions (older than 1 hour)
  await db.update(agentActions)
    .set({ approval_status: 'expired' })
    .where(and(
      eq(agentActions.org_id, user.org_id),
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, new Date(Date.now() - 60 * 60 * 1000)),
    ));

  // Phase 7 — LEFT JOIN action_receipts so the UI can show a "View receipt"
  // button only when there's something to show. We materialize has_receipt
  // via EXISTS rather than DISTINCT-on to keep one row per action regardless
  // of how many receipts are attached (future-proofing for re-execution).
  const rows = await db.execute(sql`
    SELECT a.*,
           EXISTS (SELECT 1 FROM action_receipts r WHERE r.action_id = a.id) AS has_receipt
    FROM agent_actions a
    WHERE a.org_id = ${user.org_id}
    ORDER BY a.created_at DESC
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
