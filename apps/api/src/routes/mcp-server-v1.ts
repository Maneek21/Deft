/**
 * Phase 3 — MCP streamable-http server mounted at `/api/mcp/v1`.
 *
 * Endpoints:
 *   POST /initialize   — MCP handshake. No bearer required.
 *   POST /tools/list   — Returns the filtered tool catalog for the caller.
 *   POST /tools/call   — Dispatches a tool, returns ToolResult.
 *   POST /ping         — Gateway health check. Validates bearer.
 *   GET  /sse          — 501 Not Implemented (Phase 7 feature).
 *
 * The resolver pattern:
 *   1. Extract the bearer.
 *   2. `resolveGatewayToken(bearer)` → { org_id, gateway_employees[] }.
 *   3. On tools/call, read `arguments.caller_employee_slug` and call
 *      `validateCallerSlug()` to narrow to one employee → ToolContext.
 *   4. Dispatch to handler, wrap any thrown error as an MCP tool error.
 *
 * This file deliberately lives at `mcp-server-v1.ts` rather than overwriting
 * the existing `mcp-server.ts` (which hosts the earlier api-keys-based MCP
 * surface mounted at `/mcp`). See handoff notes for why.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  extractBearer,
  resolveMcpPrincipal,
  resolveGatewayToken,
  validateCallerSlug,
  McpAuthError,
  type ResolvedGateway,
  type GatewayEmployee,
} from '../lib/mcp-token.js';
import { agentMcpCallAudit } from '@deft/db/schema';
import {
  ALL_TOOLS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  TOOL_ALIASES,
  toolSchemas,
  type ToolHandler,
} from '../lib/mcp-tools/index.js';
import type { ToolContext, ToolResult } from '../lib/mcp-tools/types.js';
import {
  HUMAN_TOOLS,
  buildHumanToolSchemas,
  type HumanToolContext,
} from '../lib/mcp-tools/human.js';
import { auditOAuth, metadataUrls } from '../lib/oauth-mcp.js';

export const mcpServerV1Routes = new Hono();

// ─── helpers ──────────────────────────────────────────────────────────────

async function requireGateway(
  c: Context,
): Promise<ResolvedGateway | { error: true }> {
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) {
    c.status(401);
    c.json({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
    return { error: true };
  }
  try {
    return await resolveGatewayToken(bearer);
  } catch (err) {
    if (err instanceof McpAuthError) {
      c.status(err.status as 401 | 403 | 400);
      c.json({ error: { code: err.code, message: err.message } });
      return { error: true };
    }
    c.status(500);
    c.json({ error: { code: 'internal', message: 'Auth resolver error' } });
    return { error: true };
  }
}

// Convenience typed JSON responder that also sets the status cleanly — Hono's
// c.json returns a Response so we short-circuit with it.
function errorResponse(c: Context, status: 400 | 401 | 403 | 404 | 500, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function setOAuthChallenge(c: Context, scope = 'read:workspace') {
  const urls = metadataUrls();
  c.header(
    'WWW-Authenticate',
    `Bearer resource_metadata="${urls.protectedResourceMetadata}", scope="${scope}"`,
  );
}

async function auditMcpCall(params: {
  ctx: ToolContext;
  toolName: string;
  success: boolean;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(agentMcpCallAudit).values({
      org_id: params.ctx.org_id,
      employee_id: params.ctx.employee_id,
      tool_name: params.toolName,
      success: params.success,
      error: params.error ?? null,
      metadata: params.metadata ?? null,
    });

    await db.execute(sql`
      UPDATE agent_employees
      SET
        last_mcp_call_at = now(),
        last_work_outcome_at = CASE
          WHEN ${params.success} AND ${params.toolName} = 'record_outcome' THEN now()
          ELSE last_work_outcome_at
        END,
        certification_status = CASE
          WHEN certification_status IN ('draft', 'token_issued') THEN 'mcp_reachable'
          ELSE certification_status
        END,
        updated_at = now()
      WHERE id = ${params.ctx.employee_id}
        AND org_id = ${params.ctx.org_id}
    `);
  } catch (err) {
    console.warn('[mcp-v1] auditMcpCall failed:', err);
  }
}

async function auditMcpDiscovery(params: {
  resolved: ResolvedGateway;
  metadata?: Record<string, unknown>;
}) {
  try {
    for (const employee of params.resolved.gateway_employees) {
      await db.insert(agentMcpCallAudit).values({
        org_id: params.resolved.org_id,
        employee_id: employee.employee_id,
        tool_name: 'tools/list',
        success: true,
        error: null,
        metadata: params.metadata ?? null,
      });

      await db.execute(sql`
        UPDATE agent_employees
        SET
          last_mcp_call_at = now(),
          certification_status = CASE
            WHEN certification_status IN ('draft', 'token_issued') THEN 'mcp_reachable'
            ELSE certification_status
          END,
          updated_at = now()
        WHERE id = ${employee.employee_id}
          AND org_id = ${params.resolved.org_id}
      `);
    }
  } catch (err) {
    console.warn('[mcp-v1] auditMcpDiscovery failed:', err);
  }
}

async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  metadata: Record<string, unknown>,
): Promise<ToolResult> {
  const canonicalToolName = TOOL_ALIASES[toolName] ?? toolName;
  const handler: ToolHandler | undefined = ALL_TOOLS[canonicalToolName];
  const auditMetadata =
    canonicalToolName === toolName
      ? metadata
      : { ...metadata, requested_tool_name: toolName, canonical_tool_name: canonicalToolName };

  if (!handler) {
    const result = { isError: true, content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] } satisfies ToolResult;
    await auditMcpCall({ ctx, toolName, success: false, error: `Unknown tool: ${toolName}`, metadata: auditMetadata });
    return result;
  }

  try {
    const result = await handler(args, ctx);
    const success = !result.isError;
    await auditMcpCall({
      ctx,
      toolName,
      success,
      error: success ? null : result.content?.map((c) => c.text).join('\n') || 'Tool returned an MCP error',
      metadata: auditMetadata,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await auditMcpCall({ ctx, toolName, success: false, error: msg, metadata: auditMetadata });
    return { isError: true, content: [{ type: 'text', text: `Tool "${toolName}" threw: ${msg}` }] } satisfies ToolResult;
  }
}

const HUMAN_TOOL_SCOPE: Record<string, string> = {
  search: 'read:workspace',
  fetch: 'read:workspace',
  platform_context: 'read:workspace',
  member_list: 'read:workspace',
  resolve_member: 'read:workspace',
  resolve_targets: 'read:workspace',
  member_get: 'read:workspace',
  activity_query: 'read:workspace',
  events_query: 'read:calendar',
  memory_recall: 'read:wiki',
  wiki_search: 'read:wiki',
  memory_list: 'read:wiki',
  list_my_tasks: 'read:tasks',
  task_get: 'read:tasks',
  task_query: 'read:tasks',
  project_list: 'read:workspace',
  resolve_project: 'read:workspace',
  project_get: 'read:workspace',
  space_list: 'read:messages',
  resolve_space: 'read:messages',
  space_get: 'read:messages',
  project_progress: 'read:tasks',
  team_workload: 'read:tasks',
  thread_fetch: 'read:messages',
  messages_recent: 'read:messages',
  messages_search: 'read:messages',
  memory_write: 'write:wiki',
  wiki_upsert: 'write:wiki',
  task_create: 'write:tasks',
  task_update: 'write:tasks',
  task_transition: 'write:tasks',
  comment_on_task: 'write:tasks',
  message_post: 'write:messages',
  send_message: 'write:messages',
};

function humanCatalog(scopes: string[]) {
  return buildHumanToolSchemas(toolSchemas as unknown as Array<Record<string, unknown>>)
    .filter((schema) => {
      const name = String(schema.name ?? '');
      const required = HUMAN_TOOL_SCOPE[name];
      return !required || scopes.includes(required);
    });
}

async function dispatchHumanTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: HumanToolContext,
): Promise<ToolResult> {
  const canonicalToolName = TOOL_ALIASES[toolName] ?? toolName;
  const handler = HUMAN_TOOLS[canonicalToolName];
  if (!handler) {
    return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable personal MCP tool: ${toolName}` }] };
  }
  const requiredScope = HUMAN_TOOL_SCOPE[canonicalToolName];
  if (requiredScope && !ctx.scopes.includes(requiredScope)) {
    return { isError: true, content: [{ type: 'text', text: `Missing MCP scope: ${requiredScope}` }] };
  }
  try {
    return await handler(args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `Tool "${toolName}" threw: ${msg}` }] };
  }
}

// ─── MCP streamable-http single-endpoint dispatcher ──────────────────────
//
// The MCP streamable-http spec (modelcontextprotocol.io) POSTs every
// JSON-RPC envelope to one URL — the mount path itself. Clients like
// Claude Code's `claude mcp add --transport http` target this root. We
// parse the envelope, dispatch to the matching handler, and wrap the
// response back into `{ jsonrpc: '2.0', id, result | error }`. The
// sub-path routes below (`/initialize`, `/tools/list`, etc.) remain for
// callers that happen to target them directly — they're not MCP-spec
// but harmless.
mcpServerV1Routes.post('/', async (c) => {
  let body: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const id = body.id ?? null;
  const method = body.method;
  if (!method || typeof method !== 'string') {
    return c.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: missing method' } }, 400);
  }

  // Helper: run a thunk, wrap success in { jsonrpc, id, result }, errors
  // in { jsonrpc, id, error }.
  const wrap = async <T>(fn: () => Promise<T>): Promise<Response> => {
    try {
      const result = await fn();
      return c.json({ jsonrpc: '2.0', id, result });
    } catch (err) {
      if (err instanceof McpAuthError) {
        // JSON-RPC error codes: -32001 for auth, -32002 for forbidden.
        const code = err.status === 401 ? -32001 : err.status === 403 ? -32002 : -32000;
        if (err.status === 401) setOAuthChallenge(c);
        return c.json({ jsonrpc: '2.0', id, error: { code, message: err.message, data: { status: err.status, code: err.code } } }, err.status as 400 | 401 | 403);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ jsonrpc: '2.0', id, error: { code: -32603, message: msg } }, 500);
    }
  };

  if (method === 'initialize') {
    return wrap(async () => ({
      serverInfo: { name: 'deft-mcp', version: '1.0.0' },
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
    }));
  }

  if (method === 'notifications/initialized') {
    // MCP clients send this post-initialize handshake as a JSON-RPC
    // notification. Notifications do not receive JSON-RPC responses; Codex's
    // streamable HTTP client treats a response object here as a handshake
    // protocol error.
    return c.body(null, 202);
  }

  if (method === 'ping') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const principal = await resolveMcpPrincipal(bearer);
      if (principal.kind !== 'agent') {
        return { ok: true, org_id: principal.org_id, principal_kind: 'human', user_id: principal.user_id };
      }
      return { ok: true, org_id: principal.org_id, principal_kind: 'agent', employee_count: principal.gateway_employees.length };
    });
  }

  if (method === 'tools/list') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const principal = await resolveMcpPrincipal(bearer);
      if (principal.kind === 'human' || principal.kind === 'oauth') {
        return { tools: humanCatalog(principal.scopes) };
      }
      const resolved = principal as ResolvedGateway;
      const allConservative = resolved.gateway_employees.every((e) => e.trust_level === 'conservative');
      const writeNames = new Set(Object.keys(WRITE_TOOLS));
      const catalog = toolSchemas.filter((t) => (allConservative ? !writeNames.has(t.name) : true));
      await auditMcpDiscovery({
        resolved,
        metadata: { surface: 'jsonrpc', request_id: id, method: 'tools/list' },
      });
      return { tools: catalog };
    });
  }

  if (method === 'tools/call') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const principal = await resolveMcpPrincipal(bearer);
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const toolName = params.name;
      const args = params.arguments ?? {};
      if (!toolName || typeof toolName !== 'string') {
        throw new McpAuthError(400, 'bad_request', 'Missing params.name');
      }
      if (principal.kind === 'human' || principal.kind === 'oauth') {
        const result = await dispatchHumanTool(toolName, args, {
          org_id: principal.org_id,
          user_id: principal.user_id,
          role: principal.role,
          scopes: principal.scopes,
          token_id: principal.token_id,
          client_id: principal.client_id,
          grant_id: principal.grant_id,
          principal_kind: principal.kind,
        });
        if (principal.kind === 'oauth') {
          await auditOAuth({
            orgId: principal.org_id,
            userId: principal.user_id,
            clientId: principal.client_id ?? null,
            event: 'mcp_tool_call',
            metadata: {
              tool_name: toolName,
              success: !result.isError,
              surface: 'jsonrpc',
              grant_id: principal.grant_id ?? null,
              idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : null,
              target_id: typeof args.task_id === 'string'
                ? args.task_id
                : typeof args.space_id === 'string'
                  ? args.space_id
                  : typeof args.project_id === 'string'
                    ? args.project_id
                    : null,
            },
          });
        }
        return result;
      }
      const resolved = principal as ResolvedGateway;
      const employee = validateCallerSlug(resolved, String(args.caller_employee_slug ?? ''));
      const ctx: ToolContext = {
        org_id: resolved.org_id,
        employee_id: employee.employee_id,
        employee_slug: employee.slug,
        trust_level: employee.trust_level,
      };
      return await dispatchTool(toolName, args, ctx, {
        surface: 'jsonrpc',
        caller_employee_slug: employee.slug,
        request_id: id,
      });
    });
  }

  return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, 404);
});

// ─── Legacy sub-path endpoints (kept for pre-JSON-RPC callers) ───────────

mcpServerV1Routes.post('/initialize', async (c) => {
  return c.json({
    serverInfo: {
      name: 'deft-mcp',
      version: '1.0.0',
    },
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
    },
  });
});

mcpServerV1Routes.get('/sse', async (c) => {
  return c.json(
    {
      error: {
        code: 'not_implemented',
        message: 'SSE approval-queue stream is a Phase 7 feature',
      },
    },
    501,
  );
});

mcpServerV1Routes.post('/ping', async (c) => {
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) {
    setOAuthChallenge(c);
    return errorResponse(c, 401, 'unauthorized', 'Missing bearer token');
  }
  try {
    const principal = await resolveMcpPrincipal(bearer);
    if (principal.kind !== 'agent') {
      return c.json({ ok: true, org_id: principal.org_id, principal_kind: 'human', user_id: principal.user_id });
    }
    return c.json({ ok: true, org_id: principal.org_id, principal_kind: 'agent', employee_count: principal.gateway_employees.length });
  } catch (err) {
    if (err instanceof McpAuthError && err.status === 401) setOAuthChallenge(c);
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 401, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Auth resolver error');
  }
});

mcpServerV1Routes.post('/tools/list', async (c) => {
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) {
    setOAuthChallenge(c);
    return errorResponse(c, 401, 'unauthorized', 'Missing bearer token');
  }

  let principal: Awaited<ReturnType<typeof resolveMcpPrincipal>>;
  try {
    principal = await resolveMcpPrincipal(bearer);
  } catch (err) {
    if (err instanceof McpAuthError && err.status === 401) setOAuthChallenge(c);
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 401, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Auth resolver error');
  }

  if (principal.kind === 'human' || principal.kind === 'oauth') {
    return c.json({ tools: humanCatalog(principal.scopes) });
  }

  const resolved = principal as ResolvedGateway;

  // Phase 3: if EVERY employee on this Gateway is conservative, strip write
  // tools from the catalog. Any single non-conservative employee exposes the
  // full set — the caller-slug validation inside /tools/call still runs.
  const allConservative = resolved.gateway_employees.every(
    (e) => e.trust_level === 'conservative',
  );
  const writeNames = new Set(Object.keys(WRITE_TOOLS));
  const catalog = toolSchemas.filter((t) =>
    allConservative ? !writeNames.has(t.name) : true,
  );

  await auditMcpDiscovery({
    resolved,
    metadata: { surface: 'legacy', method: 'tools/list' },
  });

  return c.json({ tools: catalog });
});

mcpServerV1Routes.post('/tools/call', async (c) => {
  // 1. Bearer auth
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) {
    setOAuthChallenge(c);
    return errorResponse(c, 401, 'unauthorized', 'Missing bearer token');
  }

  let principal: Awaited<ReturnType<typeof resolveMcpPrincipal>>;
  try {
    principal = await resolveMcpPrincipal(bearer);
  } catch (err) {
    if (err instanceof McpAuthError && err.status === 401) setOAuthChallenge(c);
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 401, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Auth resolver error');
  }

  // 2. Parse body
  let body: { name?: string; arguments?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, 400, 'bad_request', 'Invalid JSON body');
  }
  const toolName = body?.name;
  const args = body?.arguments ?? {};
  if (!toolName || typeof toolName !== 'string') {
    return errorResponse(c, 400, 'bad_request', 'Missing tools/call.name');
  }

  if (principal.kind === 'human' || principal.kind === 'oauth') {
    const result = await dispatchHumanTool(toolName, args, {
      org_id: principal.org_id,
      user_id: principal.user_id,
      role: principal.role,
      scopes: principal.scopes,
      token_id: principal.token_id,
      client_id: principal.client_id,
      grant_id: principal.grant_id,
      principal_kind: principal.kind,
    });
    if (principal.kind === 'oauth') {
      await auditOAuth({
        orgId: principal.org_id,
        userId: principal.user_id,
        clientId: principal.client_id ?? null,
        event: 'mcp_tool_call',
        metadata: {
          tool_name: toolName,
          success: !result.isError,
          surface: 'legacy',
          grant_id: principal.grant_id ?? null,
          idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : null,
          target_id: typeof args.task_id === 'string'
            ? args.task_id
            : typeof args.space_id === 'string'
              ? args.space_id
              : typeof args.project_id === 'string'
                ? args.project_id
                : null,
        },
      });
    }
    return c.json(result);
  }

  // 3. Caller slug validation
  const resolved = principal as ResolvedGateway;
  let employee: GatewayEmployee;
  try {
    employee = validateCallerSlug(resolved, String(args.caller_employee_slug ?? ''));
  } catch (err) {
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 400 | 403, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Slug validation error');
  }

  // 4. Tool dispatch — unknown tool => MCP-level error content (isError)
  const ctx: ToolContext = {
    org_id: resolved.org_id,
    employee_id: employee.employee_id,
    employee_slug: employee.slug,
    trust_level: employee.trust_level,
  };

  return c.json(await dispatchTool(toolName, args, ctx, {
    surface: 'legacy',
    caller_employee_slug: employee.slug,
  }));
});

// ─── exports used only for test composition ──────────────────────────────

export { READ_ONLY_TOOLS, WRITE_TOOLS };
