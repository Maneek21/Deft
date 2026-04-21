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
import {
  extractBearer,
  resolveGatewayToken,
  validateCallerSlug,
  McpAuthError,
  type ResolvedGateway,
  type GatewayEmployee,
} from '../lib/mcp-token.js';
import {
  ALL_TOOLS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  toolSchemas,
  type ToolHandler,
} from '../lib/mcp-tools/index.js';
import type { ToolContext, ToolResult } from '../lib/mcp-tools/types.js';

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
    // MCP clients send this post-initialize handshake. No response body
    // expected but we return an empty 200 with JSON-RPC wrapper for
    // clients that still await.
    return c.json({ jsonrpc: '2.0', id, result: {} });
  }

  if (method === 'ping') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const gw = await resolveGatewayToken(bearer);
      return { ok: true, org_id: gw.org_id, employee_count: gw.gateway_employees.length };
    });
  }

  if (method === 'tools/list') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const resolved = await resolveGatewayToken(bearer);
      const allConservative = resolved.gateway_employees.every((e) => e.trust_level === 'conservative');
      const writeNames = new Set(Object.keys(WRITE_TOOLS));
      const catalog = toolSchemas.filter((t) => (allConservative ? !writeNames.has(t.name) : true));
      return { tools: catalog };
    });
  }

  if (method === 'tools/call') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const resolved = await resolveGatewayToken(bearer);
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const toolName = params.name;
      const args = params.arguments ?? {};
      if (!toolName || typeof toolName !== 'string') {
        throw new McpAuthError(400, 'bad_request', 'Missing params.name');
      }
      const employee = validateCallerSlug(resolved, String(args.caller_employee_slug ?? ''));
      const handler: ToolHandler | undefined = ALL_TOOLS[toolName];
      if (!handler) {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] } satisfies ToolResult;
      }
      const ctx: ToolContext = {
        org_id: resolved.org_id,
        employee_id: employee.employee_id,
        employee_slug: employee.slug,
        trust_level: employee.trust_level,
      };
      try {
        return await handler(args, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Tool "${toolName}" threw: ${msg}` }] } satisfies ToolResult;
      }
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
  if (!bearer) return errorResponse(c, 401, 'unauthorized', 'Missing bearer token');
  try {
    const gw = await resolveGatewayToken(bearer);
    return c.json({
      ok: true,
      org_id: gw.org_id,
      employee_count: gw.gateway_employees.length,
    });
  } catch (err) {
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 401, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Auth resolver error');
  }
});

mcpServerV1Routes.post('/tools/list', async (c) => {
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) return errorResponse(c, 401, 'unauthorized', 'Missing bearer token');

  let resolved: ResolvedGateway;
  try {
    resolved = await resolveGatewayToken(bearer);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 401, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Auth resolver error');
  }

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

  return c.json({ tools: catalog });
});

mcpServerV1Routes.post('/tools/call', async (c) => {
  // 1. Bearer auth
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) return errorResponse(c, 401, 'unauthorized', 'Missing bearer token');

  let resolved: ResolvedGateway;
  try {
    resolved = await resolveGatewayToken(bearer);
  } catch (err) {
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

  // 3. Caller slug validation
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
  const handler: ToolHandler | undefined = ALL_TOOLS[toolName];
  if (!handler) {
    const res: ToolResult = {
      isError: true,
      content: [
        { type: 'text', text: `Unknown tool: ${toolName}` },
      ],
    };
    return c.json(res);
  }

  const ctx: ToolContext = {
    org_id: resolved.org_id,
    employee_id: employee.employee_id,
    employee_slug: employee.slug,
    trust_level: employee.trust_level,
  };

  try {
    const result = await handler(args, ctx);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failResult: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: `Tool "${toolName}" threw: ${msg}` }],
    };
    return c.json(failResult);
  }
});

// ─── exports used only for test composition ──────────────────────────────

export { READ_ONLY_TOOLS, WRITE_TOOLS };
