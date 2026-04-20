import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { apiKeys, agentEmployees, agentActions } from '@deft/db/schema';
import { executeToolCall } from '../lib/agent-context.js';
import { shouldAutoExecute, getApprovalTier } from '../lib/agent-approval.js';
import { executeActionDirect } from '../lib/agent-actions.js';
import { ACTION_TOOLS } from '../lib/agent-tools.js';

export const mcpServerRoutes = new Hono();

// ═══ DEPRECATION (Path C Phase 3) ═══
//
// The /mcp surface pre-dates the standard MCP protocol endpoint at
// /api/mcp/v1. Every /mcp response now carries the RFC-8594 deprecation
// headers + a Link relation pointing at the replacement route so
// integrators see it in their HTTP client logs.
//
// Sunset date: 2026-07-19 (≈90 days from initial deprecation).
// Before sunset, Phase 4 deletes this file + route mount.
const SUNSET_DATE = 'Sun, 19 Jul 2026 00:00:00 GMT';
mcpServerRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Deprecation', 'true');
  c.res.headers.set('Sunset', SUNSET_DATE);
  c.res.headers.set(
    'Link',
    '</api/mcp/v1>; rel="successor-version"; title="Standard MCP streamable-http endpoint"',
  );
});

// ═══ TOOL DEFINITIONS ═══

const READ_TOOLS = [
  { name: 'deft_search_tasks', description: 'Search tasks by query, status, assignee, project', permission: 'read' },
  { name: 'deft_get_task_detail', description: 'Get full detail of a specific task', permission: 'read' },
  { name: 'deft_search_messages', description: 'Search messages across spaces', permission: 'read' },
  { name: 'deft_search_knowledge', description: 'Search knowledge entries', permission: 'read' },
  { name: 'deft_wiki_search', description: 'Search wiki pages', permission: 'read' },
  { name: 'deft_wiki_read', description: 'Read a wiki page by slug or ID', permission: 'read' },
  { name: 'deft_get_project_progress', description: 'Get project progress summary', permission: 'read' },
  { name: 'deft_get_team_workload', description: 'Get team workload distribution', permission: 'read' },
] as const;

const WRITE_TOOLS = [
  { name: 'deft_create_task', description: 'Create a new task', permission: 'write' },
  { name: 'deft_update_task_status', description: 'Update a task status', permission: 'write' },
  { name: 'deft_assign_task', description: 'Assign a task to a user', permission: 'write' },
  { name: 'deft_post_message', description: 'Post a message to a space', permission: 'write' },
  { name: 'deft_add_knowledge', description: 'Add a knowledge entry', permission: 'write' },
  { name: 'deft_wiki_write', description: 'Create or update a wiki page', permission: 'write' },
] as const;

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

// ═══ AUTHENTICATION ═══

type ApiKeyRecord = typeof apiKeys.$inferSelect;

async function authenticateApiKey(authorization: string | undefined): Promise<ApiKeyRecord | null> {
  if (!authorization?.startsWith('Bearer ')) return null;

  const token = authorization.slice(7);
  if (!token || token.length < 12) return null;

  const prefix = token.slice(0, 12);

  const [keyRecord] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.key_prefix, prefix), eq(apiKeys.is_active, true)))
    .limit(1);

  if (!keyRecord) return null;

  const valid = await bcrypt.compare(token, keyRecord.key_hash);
  if (!valid) return null;

  // Check expiry
  if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
    return null;
  }

  return keyRecord;
}

// ═══ RATE LIMITING (in-memory) ═══

interface RateWindow {
  minuteCount: number;
  minuteWindowStart: number;
  dayCount: number;
  dayWindowStart: number;
}

const rateLimits = new Map<string, RateWindow>();

function checkRateLimit(keyId: string, perMinute: number, perDay: number): boolean {
  const now = Date.now();
  let window = rateLimits.get(keyId);

  if (!window) {
    window = { minuteCount: 0, minuteWindowStart: now, dayCount: 0, dayWindowStart: now };
    rateLimits.set(keyId, window);
  }

  // Reset minute window if expired
  if (now - window.minuteWindowStart > 60_000) {
    window.minuteCount = 0;
    window.minuteWindowStart = now;
  }

  // Reset day window if expired
  if (now - window.dayWindowStart > 86_400_000) {
    window.dayCount = 0;
    window.dayWindowStart = now;
  }

  if (window.minuteCount >= perMinute || window.dayCount >= perDay) {
    return false;
  }

  window.minuteCount++;
  window.dayCount++;
  return true;
}

// ═══ ENDPOINTS ═══

// Permission matcher: accept either the bare verb ("read"/"write") OR any
// namespaced variant ("read:tasks"/"write:messages"). The BYOA wizard issues
// namespaced permissions by default, the earlier REST-integration flow used
// bare verbs. Both are valid; filter to tools whose verb matches.
function keyGrantsPermission(permissions: string[], toolPerm: string): boolean {
  for (const p of permissions) {
    if (p === toolPerm) return true;
    if (p.startsWith(`${toolPerm}:`)) return true;
  }
  return false;
}

// GET /tools — List available tools for this API key
mcpServerRoutes.get('/tools', async (c) => {
  const keyRecord = await authenticateApiKey(c.req.header('Authorization'));
  if (!keyRecord) {
    return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired API key' } }, 401);
  }

  const tools = ALL_TOOLS.filter((t) => keyGrantsPermission(keyRecord.permissions, t.permission));

  return c.json({ tools });
});

// POST /call — Execute a tool
mcpServerRoutes.post('/call', async (c) => {
  // 1. Authenticate
  const keyRecord = await authenticateApiKey(c.req.header('Authorization'));
  if (!keyRecord) {
    return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired API key' } }, 401);
  }

  // 2. Rate limit
  if (!checkRateLimit(keyRecord.id, keyRecord.rate_limit_per_minute, keyRecord.rate_limit_per_day)) {
    return c.json({ error: { code: 'rate_limited', message: 'Rate limit exceeded', retry_after: 60 } }, 429);
  }

  // 3. Parse request
  const body = await c.req.json<{ tool: string; params: Record<string, any> }>();
  if (!body.tool || typeof body.tool !== 'string') {
    return c.json({ error: { code: 'bad_request', message: 'Missing or invalid tool name' } }, 400);
  }

  const toolDef = ALL_TOOLS.find((t) => t.name === body.tool);
  if (!toolDef) {
    return c.json({ error: { code: 'not_found', message: `Unknown tool: ${body.tool}` } }, 404);
  }

  // 4. Check permission — bare verb OR any namespaced variant.
  if (!keyGrantsPermission(keyRecord.permissions, toolDef.permission)) {
    return c.json({ error: { code: 'forbidden', message: 'Tool not permitted for this API key' } }, 403);
  }

  // Strip deft_ prefix to get the internal tool name
  const internalToolName = body.tool.replace(/^deft_/, '');
  const params = body.params || {};
  const orgId = keyRecord.org_id;

  // 5. Resolve agent employee for trust level
  let userId = keyRecord.created_by; // fallback
  let trustLevel: 'conservative' | 'standard' | 'autonomous' = 'conservative';
  let agentEmployeeId: string | undefined;

  if (keyRecord.agent_employee_id) {
    const [employee] = await db
      .select()
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, keyRecord.agent_employee_id), eq(agentEmployees.org_id, orgId)))
      .limit(1);

    if (employee) {
      userId = employee.user_id;
      trustLevel = employee.trust_level;
      agentEmployeeId = employee.id;
    }
  }

  let result: any;

  // 6. Write tools — check approval
  if (ACTION_TOOLS.has(internalToolName)) {
    if (shouldAutoExecute(internalToolName, trustLevel)) {
      const tier = getApprovalTier(internalToolName);
      const actionResult = await executeActionDirect(
        internalToolName,
        params,
        orgId,
        userId,
        null, // no conversation
        tier,
        { agentEmployeeId, source: 'mcp_api' },
      );
      result = actionResult;
    } else {
      // Create pending action for approval
      const tier = getApprovalTier(internalToolName);
      const [actionRecord] = await db
        .insert(agentActions)
        .values({
          org_id: orgId,
          user_id: userId,
          conversation_id: null,
          action: internalToolName,
          params,
          approval_tier: tier,
          approval_status: 'pending',
          ...(agentEmployeeId ? { agent_employee_id: agentEmployeeId } : {}),
          source: 'mcp_api',
        })
        .returning();

      return c.json({ status: 'pending_approval', action_id: actionRecord!.id });
    }
  } else {
    // 7. Read tools — execute directly
    const toolResult = await executeToolCall(internalToolName, params, orgId, userId);
    result = toolResult.result;
  }

  // 8. Update usage stats
  await db
    .update(apiKeys)
    .set({
      last_used_at: new Date(),
      request_count: sql`${apiKeys.request_count} + 1`,
    })
    .where(eq(apiKeys.id, keyRecord.id));

  return c.json({ status: 'ok', result });
});

// GET /actions/:id/status — Poll action approval status
mcpServerRoutes.get('/actions/:id/status', async (c) => {
  const keyRecord = await authenticateApiKey(c.req.header('Authorization'));
  if (!keyRecord) {
    return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired API key' } }, 401);
  }

  const actionId = c.req.param('id');
  const [action] = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      approval_status: agentActions.approval_status,
      result: agentActions.result,
      error: agentActions.error,
      executed_at: agentActions.executed_at,
      created_at: agentActions.created_at,
    })
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, keyRecord.org_id)))
    .limit(1);

  if (!action) {
    return c.json({ error: { code: 'not_found', message: 'Action not found' } }, 404);
  }

  return c.json(action);
});
