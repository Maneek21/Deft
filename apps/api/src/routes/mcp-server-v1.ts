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
 *   3. On tools/call, bind the one employee authenticated by that token to
 *      ToolContext. Model-authored arguments never select identity.
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
  resolveAuthenticatedEmployee,
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
  humanToolChallengeScope,
  humanToolHasRequiredScope,
  humanToolScopeError,
  type HumanToolContext,
} from '../lib/mcp-tools/human.js';
import { auditOAuth, metadataUrls } from '../lib/oauth-mcp.js';
import {
  consumeAgentDailyActionBudget,
  isAgentToolDisabled,
} from '../lib/agent-tool-policy.js';
import { MODULE_MCP_WRITE_TOOLS } from '../lib/mcp-tools/modules.js';
import {
  humanModuleActor,
  moduleIdempotencyDigest,
} from '../lib/module-service.js';

export const mcpServerV1Routes = new Hono();

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
const DEFAULT_LEGACY_PROTOCOL_VERSION = '2024-11-05';
const LATEST_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];
const SERVER_INFO = {
  name: 'deft-mcp',
  version: '1.0.0',
  description: 'Deft workspace tools for people and agent employees.',
} as const;
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

type JsonRpcId = string | number | null;
type JsonRpcRequestBody = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type ClientInfo = {
  name: string;
  version: string;
  [key: string]: unknown;
};

type RequestProtocolMetadata = {
  era: 'legacy' | 'modern';
  protocolVersion?: string;
  clientInfo?: ClientInfo;
  clientCapabilities?: Record<string, unknown>;
};

class McpJsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: 200 | 400 = 200,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpJsonRpcError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenBoundAgentCatalog(tools: typeof toolSchemas): typeof toolSchemas {
  return tools.map((tool) => {
    const inputSchema = { ...tool.inputSchema };
    const properties = isRecord(inputSchema.properties)
      ? { ...inputSchema.properties }
      : undefined;
    if (properties) delete properties.caller_employee_slug;
    const required = Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name) => name !== 'caller_employee_slug')
      : undefined;
    return {
      ...tool,
      inputSchema: {
        ...inputSchema,
        ...(properties ? { properties } : {}),
        ...(required ? { required } : {}),
      },
    };
  });
}

function humanIdempotencyAuditMetadata(params: {
  canonicalToolName: string;
  args: Record<string, unknown>;
  orgId: string;
  userId: string;
  role: HumanToolContext['role'];
  scopes: string[];
}): Record<string, unknown> {
  const key = params.args.idempotency_key;
  if (typeof key !== 'string') return { idempotency_key: null };
  if (!MODULE_MCP_WRITE_TOOLS[params.canonicalToolName]) {
    return { idempotency_key: key };
  }
  const actor = humanModuleActor({
    orgId: params.orgId,
    userId: params.userId,
    role: params.role,
    source: 'mcp',
    scopes: params.scopes,
  });
  return {
    idempotency_key: null,
    idempotency_digest: moduleIdempotencyDigest(actor, key),
  };
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function allowedMcpOrigins(): Set<string> {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.DEFT_PUBLIC_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];
  return new Set(
    candidates
      .filter((value): value is string => Boolean(value))
      .map(normalizedOrigin)
      .filter((value): value is string => value !== null),
  );
}

// Streamable HTTP requires Origin validation to prevent DNS rebinding. Keep
// the guard local to the MCP surface so regular API routes retain their
// existing CORS behavior. Non-browser MCP clients normally omit Origin.
mcpServerV1Routes.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin) {
    const normalized = normalizedOrigin(origin);
    if (!normalized || !allowedMcpOrigins().has(normalized)) {
      return c.json(
        { error: { code: 'invalid_origin', message: 'Origin is not allowed for this MCP endpoint' } },
        403,
      );
    }
  }
  return next();
});

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

function jsonRpcErrorResponse(
  c: Context,
  id: JsonRpcId,
  code: number,
  message: string,
  status: 200 | 400 | 401 | 403 | 404 | 500,
  data?: Record<string, unknown>,
) {
  const error = data ? { code, message, data } : { code, message };
  return c.json({ jsonrpc: '2.0', id, error }, status);
}

function legacyProtocolVersion(params: unknown): string {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  if (typeof requested !== 'string' || requested.length === 0) {
    return DEFAULT_LEGACY_PROTOCOL_VERSION;
  }
  if ((LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_LEGACY_PROTOCOL_VERSION;
}

function legacyInitializeResult(params: unknown) {
  return {
    serverInfo: SERVER_INFO,
    protocolVersion: legacyProtocolVersion(params),
    capabilities: { tools: {} },
  };
}

function sortedCatalog<T extends { name?: unknown }>(catalog: readonly T[]): T[] {
  return [...catalog].sort((left, right) => {
    const leftName = String(left.name ?? '');
    const rightName = String(right.name ?? '');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
}

function completeModernResult(result: unknown): Record<string, unknown> {
  const source = isRecord(result) ? result : {};
  const resultMeta = isRecord(source._meta) ? source._meta : {};
  return {
    ...source,
    resultType: 'complete',
    _meta: {
      ...resultMeta,
      [SERVER_INFO_META_KEY]: SERVER_INFO,
    },
  };
}

function decodeMirroredHeader(value: string): string | null {
  const hasSentinelStart = value.startsWith('=?base64?');
  const hasSentinelEnd = value.endsWith('?=');
  if (hasSentinelStart || hasSentinelEnd) {
    const match = value.match(/^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/);
    if (!match) return null;
    try {
      const encoded = match[1]!;
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded) return null;
      const text = decoded.toString('utf8');
      if (Buffer.from(text, 'utf8').compare(decoded) !== 0) return null;
      return text;
    } catch {
      return null;
    }
  }

  if (!/^[\x20-\x7E\t]*$/.test(value)) return null;
  if (value !== value.trim()) return null;
  return value;
}

function hasModernEnvelopeClaim(c: Context, method: string, body: JsonRpcRequestBody): boolean {
  const params = isRecord(body.params) ? body.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const bodyProtocolVersion = meta?.[PROTOCOL_VERSION_META_KEY];
  const headerProtocolVersion = c.req.header('MCP-Protocol-Version');

  if (method === 'server/discover') return true;
  if (typeof bodyProtocolVersion === 'string') return true;
  if (c.req.header('Mcp-Method') || c.req.header('Mcp-Name')) return true;
  return Boolean(
    headerProtocolVersion &&
      !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerProtocolVersion),
  );
}

function validateRequestProtocolMetadata(
  c: Context,
  body: JsonRpcRequestBody,
  method: string,
): RequestProtocolMetadata {
  if (!hasModernEnvelopeClaim(c, method, body)) {
    return {
      era: 'legacy',
      protocolVersion: c.req.header('MCP-Protocol-Version'),
    };
  }

  const params = isRecord(body.params) ? body.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const bodyProtocolVersion = meta?.[PROTOCOL_VERSION_META_KEY];
  const headerProtocolVersion = c.req.header('MCP-Protocol-Version');
  const headerMethod = c.req.header('Mcp-Method');

  if (!headerProtocolVersion) {
    throw new McpJsonRpcError(-32020, 'Header mismatch: missing MCP-Protocol-Version header', 400);
  }
  if (typeof bodyProtocolVersion !== 'string' || bodyProtocolVersion.length === 0) {
    throw new McpJsonRpcError(
      -32020,
      `Header mismatch: MCP-Protocol-Version header value '${headerProtocolVersion}' has no matching request metadata`,
      400,
    );
  }
  if (headerProtocolVersion !== bodyProtocolVersion) {
    throw new McpJsonRpcError(
      -32020,
      `Header mismatch: MCP-Protocol-Version header value '${headerProtocolVersion}' does not match body value '${bodyProtocolVersion}'`,
      400,
    );
  }
  if (!headerMethod) {
    throw new McpJsonRpcError(-32020, 'Header mismatch: missing Mcp-Method header', 400);
  }
  if (headerMethod !== method) {
    throw new McpJsonRpcError(
      -32020,
      `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${method}'`,
      400,
    );
  }

  if (method === 'tools/call') {
    const headerName = c.req.header('Mcp-Name');
    if (!headerName) {
      throw new McpJsonRpcError(-32020, 'Header mismatch: missing Mcp-Name header', 400);
    }
    const decodedHeaderName = decodeMirroredHeader(headerName);
    if (decodedHeaderName === null) {
      throw new McpJsonRpcError(-32020, 'Header mismatch: malformed Mcp-Name header', 400);
    }
    const bodyName = params?.name;
    if (typeof bodyName !== 'string' || decodedHeaderName !== bodyName) {
      throw new McpJsonRpcError(
        -32020,
        `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${String(bodyName ?? '')}'`,
        400,
      );
    }
  }

  if (bodyProtocolVersion !== MODERN_PROTOCOL_VERSION) {
    throw new McpJsonRpcError(
      -32022,
      `Unsupported protocol version: ${bodyProtocolVersion}`,
      400,
      { supported: [MODERN_PROTOCOL_VERSION], requested: bodyProtocolVersion },
    );
  }

  const clientCapabilities = meta?.[CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(clientCapabilities)) {
    throw new McpJsonRpcError(
      -32602,
      `Invalid params: missing ${CLIENT_CAPABILITIES_META_KEY} request metadata`,
      400,
    );
  }

  const rawClientInfo = meta?.[CLIENT_INFO_META_KEY];
  let clientInfo: ClientInfo | undefined;
  if (rawClientInfo !== undefined) {
    if (
      !isRecord(rawClientInfo) ||
      typeof rawClientInfo.name !== 'string' ||
      rawClientInfo.name.length === 0 ||
      typeof rawClientInfo.version !== 'string' ||
      rawClientInfo.version.length === 0
    ) {
      throw new McpJsonRpcError(
        -32602,
        `Invalid params: malformed ${CLIENT_INFO_META_KEY} request metadata`,
        400,
      );
    }
    clientInfo = rawClientInfo as ClientInfo;
  }

  return {
    era: 'modern',
    protocolVersion: bodyProtocolVersion,
    clientInfo,
    clientCapabilities,
  };
}

function requestAuditMetadata(metadata: RequestProtocolMetadata): Record<string, unknown> {
  return {
    protocol_version: metadata.protocolVersion ?? null,
    client_info: metadata.clientInfo ?? null,
  };
}

function setOAuthChallenge(c: Context, scope = 'read:workspace', error?: string) {
  const urls = metadataUrls();
  const errorParameter = error ? `error="${error}", ` : '';
  c.header(
    'WWW-Authenticate',
    `Bearer ${errorParameter}resource_metadata="${urls.protectedResourceMetadata}", scope="${scope}"`,
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
    // Module proposals do not consume an execution slot. The module handler
    // charges direct writes; queued writes are charged once by the canonical
    // approval executor after a human approves them.
    if (WRITE_TOOLS[canonicalToolName] && !MODULE_MCP_WRITE_TOOLS[canonicalToolName]) {
      const budget = await consumeAgentDailyActionBudget(ctx.org_id, ctx.employee_id);
      if (!budget.allowed) {
        const result = {
          isError: true,
          content: [{ type: 'text', text: budget.error }],
        } satisfies ToolResult;
        await auditMcpCall({
          ctx,
          toolName,
          success: false,
          error: budget.error,
          metadata: { ...auditMetadata, budget_blocked: true },
        });
        return result;
      }
    }
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

function humanCatalog(scopes: string[]) {
  return buildHumanToolSchemas(toolSchemas as unknown as Array<Record<string, unknown>>)
    .filter((schema) => {
      const name = String(schema.name ?? '');
      return humanToolHasRequiredScope(scopes, name);
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
  if (!humanToolHasRequiredScope(ctx.scopes, canonicalToolName)) {
    return { isError: true, content: [{ type: 'text', text: humanToolScopeError(canonicalToolName) ?? 'Missing MCP scope' }] };
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
  const contentType = c.req.header('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return c.json(
      { error: { code: 'unsupported_media_type', message: 'MCP POST requests require application/json' } },
      415,
    );
  }

  let body: JsonRpcRequestBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const id =
    typeof body.id === 'string' || typeof body.id === 'number' || body.id === null
      ? body.id
      : null;
  const method = body.method;
  if (body.jsonrpc !== '2.0' || !method || typeof method !== 'string') {
    return c.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: missing method' } }, 400);
  }

  let requestMetadata: RequestProtocolMetadata;
  try {
    requestMetadata = validateRequestProtocolMetadata(c, body, method);
  } catch (err) {
    if (err instanceof McpJsonRpcError) {
      return jsonRpcErrorResponse(c, id, err.code, err.message, err.status, err.data);
    }
    return jsonRpcErrorResponse(c, id, -32603, 'Protocol metadata validation failed', 500);
  }

  // Helper: run a thunk, wrap success in { jsonrpc, id, result }, errors
  // in { jsonrpc, id, error }.
  const wrap = async <T>(fn: () => Promise<T>): Promise<Response> => {
    try {
      const result = await fn();
      return c.json({
        jsonrpc: '2.0',
        id,
        result: requestMetadata.era === 'modern' ? completeModernResult(result) : result,
      });
    } catch (err) {
      if (err instanceof McpJsonRpcError) {
        return jsonRpcErrorResponse(c, id, err.code, err.message, err.status, err.data);
      }
      if (err instanceof McpAuthError) {
        // JSON-RPC error codes: -32001 for auth, -32002 for forbidden.
        const code = err.status === 401 ? -32001 : err.status === 403 ? -32002 : -32000;
        if (err.status === 401) setOAuthChallenge(c);
        if (err.status === 403 && err.code === 'insufficient_scope') {
          setOAuthChallenge(c, err.scope ?? 'read:workspace', 'insufficient_scope');
        }
        return jsonRpcErrorResponse(
          c,
          id,
          code,
          err.message,
          err.status as 400 | 401 | 403,
          { status: err.status, code: err.code },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return jsonRpcErrorResponse(c, id, -32603, msg, 500);
    }
  };

  if (method === 'server/discover') {
    return wrap(async () => ({
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions:
        'Use tools/list to discover Deft workspace tools. Employee identity is bound to the bearer token.',
      ttlMs: 0,
      cacheScope: 'private',
    }));
  }

  if (method === 'initialize' && requestMetadata.era === 'legacy') {
    return wrap(async () => legacyInitializeResult(body.params));
  }

  if (method === 'notifications/initialized' && requestMetadata.era === 'legacy') {
    // MCP clients send this post-initialize handshake as a JSON-RPC
    // notification. Notifications do not receive JSON-RPC responses; Codex's
    // streamable HTTP client treats a response object here as a handshake
    // protocol error.
    return c.body(null, 202);
  }

  if (method === 'ping' && requestMetadata.era === 'legacy') {
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
        return {
          tools: sortedCatalog(humanCatalog(principal.scopes)),
          ...(requestMetadata.era === 'modern'
            ? { ttlMs: 0, cacheScope: 'private' as const }
            : {}),
        };
      }
      const resolved = principal as ResolvedGateway;
      const catalog = sortedCatalog(
        tokenBoundAgentCatalog(toolSchemas).filter((t) => (
          resolved.gateway_employees.every((employee) => (
            !isAgentToolDisabled(employee.disabled_tools, t.name, TOOL_ALIASES)
          ))
        )),
      );
      await auditMcpDiscovery({
        resolved,
        metadata: {
          surface: 'jsonrpc',
          request_id: id,
          method: 'tools/list',
          ...requestAuditMetadata(requestMetadata),
        },
      });
      return {
        tools: catalog,
        ...(requestMetadata.era === 'modern'
          ? { ttlMs: 0, cacheScope: 'private' as const }
          : {}),
      };
    });
  }

  if (method === 'tools/call') {
    return wrap(async () => {
      const bearer = extractBearer(c.req.header('Authorization'));
      if (!bearer) throw new McpAuthError(401, 'unauthorized', 'Missing bearer token');
      const principal = await resolveMcpPrincipal(bearer);
      const params = isRecord(body.params) ? body.params : {};
      const toolName = params.name;
      if (!toolName || typeof toolName !== 'string') {
        throw new McpJsonRpcError(-32602, 'Invalid params: missing tools/call name');
      }
      if (params.arguments !== undefined && !isRecord(params.arguments)) {
        throw new McpJsonRpcError(-32602, 'Invalid params: tools/call arguments must be an object');
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const canonicalToolName = TOOL_ALIASES[toolName] ?? toolName;
      if (principal.kind === 'human' || principal.kind === 'oauth') {
        if (principal.kind === 'oauth' && !humanToolHasRequiredScope(principal.scopes, canonicalToolName)) {
          const challengeScope = humanToolChallengeScope(canonicalToolName);
          throw new McpAuthError(
            403,
            'insufficient_scope',
            humanToolScopeError(canonicalToolName) ?? 'Missing MCP scope',
            challengeScope,
          );
        }
        const knownTool = Boolean(HUMAN_TOOLS[canonicalToolName]);
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
        await auditOAuth({
          orgId: principal.org_id,
          userId: principal.user_id,
          clientId: principal.client_id ?? `personal-token:${principal.token_id}`,
          event: 'mcp_tool_call',
          metadata: {
            tool_name: toolName,
            success: !result.isError,
            surface: 'jsonrpc',
            ...requestAuditMetadata(requestMetadata),
            principal_kind: principal.kind,
            token_id: principal.kind === 'human' ? principal.token_id : null,
            grant_id: principal.grant_id ?? null,
            ...humanIdempotencyAuditMetadata({
              canonicalToolName,
              args,
              orgId: principal.org_id,
              userId: principal.user_id,
              role: principal.role,
              scopes: principal.scopes,
            }),
            target_id: typeof args.record_id === 'string'
              ? args.record_id
              : typeof args.task_id === 'string'
                ? args.task_id
                : typeof args.space_id === 'string'
                  ? args.space_id
                  : typeof args.project_id === 'string'
                    ? args.project_id
                    : null,
          },
        });
        if (requestMetadata.era === 'modern' && !knownTool) {
          throw new McpJsonRpcError(
            -32602,
            `Unknown tool: ${toolName}`,
            200,
            { name: toolName },
          );
        }
        return result;
      }
      const resolved = principal as ResolvedGateway;
      const employee = resolveAuthenticatedEmployee(resolved);
      const boundArgs = { ...args, caller_employee_slug: employee.slug };
      const isModuleWrite = Boolean(MODULE_MCP_WRITE_TOOLS[canonicalToolName]);
      if (!isModuleWrite && isAgentToolDisabled(employee.disabled_tools, toolName, TOOL_ALIASES)) {
        throw new McpAuthError(403, 'forbidden', `Tool '${toolName}' is disabled for this agent employee`);
      }
      const ctx: ToolContext = {
        org_id: resolved.org_id,
        employee_id: employee.employee_id,
        employee_slug: employee.slug,
        trust_level: employee.trust_level,
      };
      const knownTool = Boolean(ALL_TOOLS[canonicalToolName]);
      const result = await dispatchTool(toolName, boundArgs, ctx, {
        surface: 'jsonrpc',
        caller_employee_slug: employee.slug,
        request_id: id,
        ...requestAuditMetadata(requestMetadata),
      });
      if (requestMetadata.era === 'modern' && !knownTool) {
        throw new McpJsonRpcError(
          -32602,
          `Unknown tool: ${toolName}`,
          200,
          { name: toolName },
        );
      }
      return result;
    });
  }

  return jsonRpcErrorResponse(c, id, -32601, `Method not found: ${method}`, 404);
});

// ─── Legacy sub-path endpoints (kept for pre-JSON-RPC callers) ───────────

mcpServerV1Routes.post('/initialize', async (c) => {
  let requestBody: unknown;
  try {
    requestBody = await c.req.json();
  } catch {
    requestBody = undefined;
  }
  const params = isRecord(requestBody) && 'params' in requestBody
    ? requestBody.params
    : requestBody;
  return c.json(legacyInitializeResult(params));
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
    return c.json({ tools: sortedCatalog(humanCatalog(principal.scopes)) });
  }

  const resolved = principal as ResolvedGateway;

  // Discovery describes capabilities; trust and approval policy is enforced
  // for the resolved caller at tools/call time. Conservative employees must
  // still be able to propose governed writes for human review.
  const catalog = sortedCatalog(
    tokenBoundAgentCatalog(toolSchemas).filter((t) => (
      resolved.gateway_employees.every((employee) => (
        !isAgentToolDisabled(employee.disabled_tools, t.name, TOOL_ALIASES)
      ))
    )),
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
    const canonicalToolName = TOOL_ALIASES[toolName] ?? toolName;
    if (principal.kind === 'oauth' && !humanToolHasRequiredScope(principal.scopes, canonicalToolName)) {
      setOAuthChallenge(c, humanToolChallengeScope(canonicalToolName), 'insufficient_scope');
      return errorResponse(
        c,
        403,
        'insufficient_scope',
        humanToolScopeError(canonicalToolName) ?? 'Missing MCP scope',
      );
    }
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
    await auditOAuth({
      orgId: principal.org_id,
      userId: principal.user_id,
      clientId: principal.client_id ?? `personal-token:${principal.token_id}`,
      event: 'mcp_tool_call',
      metadata: {
        tool_name: toolName,
        success: !result.isError,
        surface: 'legacy',
        principal_kind: principal.kind,
        token_id: principal.kind === 'human' ? principal.token_id : null,
        grant_id: principal.grant_id ?? null,
        ...humanIdempotencyAuditMetadata({
          canonicalToolName,
          args,
          orgId: principal.org_id,
          userId: principal.user_id,
          role: principal.role,
          scopes: principal.scopes,
        }),
        target_id: typeof args.record_id === 'string'
          ? args.record_id
          : typeof args.task_id === 'string'
            ? args.task_id
            : typeof args.space_id === 'string'
              ? args.space_id
              : typeof args.project_id === 'string'
                ? args.project_id
                : null,
      },
    });
    return c.json(result);
  }

  // 3. Token-bound employee identity
  const resolved = principal as ResolvedGateway;
  let employee: GatewayEmployee;
  try {
    employee = resolveAuthenticatedEmployee(resolved);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 400 | 403, err.code, err.message);
    }
    return errorResponse(c, 500, 'internal', 'Slug validation error');
  }
  const canonicalToolName = TOOL_ALIASES[toolName] ?? toolName;
  const isModuleWrite = Boolean(MODULE_MCP_WRITE_TOOLS[canonicalToolName]);
  if (!isModuleWrite && isAgentToolDisabled(employee.disabled_tools, toolName, TOOL_ALIASES)) {
    return errorResponse(c, 403, 'forbidden', `Tool '${toolName}' is disabled for this agent employee`);
  }

  // 4. Tool dispatch — unknown tool => MCP-level error content (isError)
  const ctx: ToolContext = {
    org_id: resolved.org_id,
    employee_id: employee.employee_id,
    employee_slug: employee.slug,
    trust_level: employee.trust_level,
  };

  return c.json(await dispatchTool(toolName, { ...args, caller_employee_slug: employee.slug }, ctx, {
    surface: 'legacy',
    caller_employee_slug: employee.slug,
  }));
});

// ─── exports used only for test composition ──────────────────────────────

export { READ_ONLY_TOOLS, WRITE_TOOLS };
