import { agentEmployees, mcpConnections, mcpToolOverrides } from '@deft/db/schema';
import {
  type MCPConnectionConfig,
  type MCPResult,
} from '@deft/mcp';
import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import { resolveMcpRuntimeAuth } from './mcp-connection-auth.js';
import { validateMcpConnectionTarget } from './mcp-connection-validation.js';

/** Convert a DB row from mcp_connections to a validated runtime config. */
export function toConnectionConfig(
  row: typeof mcpConnections.$inferSelect,
): MCPConnectionConfig {
  const targetError = validateMcpConnectionTarget({
    transport: row.transport,
    serverUrl: row.server_url,
    stdioCommand: row.stdio_command,
    stdioArgs: (row.stdio_args as string[] | null) ?? null,
  });
  if (targetError) throw new Error(`Invalid MCP connection target: ${targetError}`);

  const runtimeAuth = resolveMcpRuntimeAuth(
    row.auth_type,
    row.auth_config_encrypted,
    row.transport,
  );

  return {
    connectionId: row.id,
    connectionSlug: row.slug,
    orgId: row.org_id,
    transport: row.transport,
    url: row.server_url ?? undefined,
    command: row.stdio_command ?? undefined,
    args: (row.stdio_args as string[] | null) ?? undefined,
    ...runtimeAuth,
  };
}

/** Preserve structured output and protocol metadata instead of flattening a
 * modern tool result back to its legacy content array. */
export function mcpResultPayload(result: MCPResult): unknown {
  const payload = result.rawResult ?? {
    content: result.content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.meta ? { _meta: result.meta } : {}),
  };
  if (result.success) return payload;
  return {
    ...payload,
    error: result.error ?? 'MCP tool error',
  };
}

/** Normalize the historical mcp__<slug>__<tool> storage form to the
 * connection-local tool name. Connection slugs never contain `__`. */
export function canonicalMcpToolName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const separator = toolName.indexOf('__', 'mcp__'.length);
  return separator >= 0 ? toolName.slice(separator + 2) : toolName;
}

export function isMcpToolEnabled(
  enabledTools: string[] | null,
  _connectionSlug: string,
  toolName: string,
): boolean {
  if (enabledTools === null) return true;
  return enabledTools.some((configuredName) => canonicalMcpToolName(configuredName) === toolName);
}

export type McpExecutionUnavailableReason = 'provider_unavailable' | 'operation_unavailable';
export type ExecutableMcpConnectionResult =
  | { connection: typeof mcpConnections.$inferSelect; error?: never; reason?: never }
  | {
      connection: null;
      error: string;
      reason: McpExecutionUnavailableReason;
    };

/**
 * Resolve an MCP connection at execution time, not only at planning time.
 * This closes stale-plan and hallucinated-tool paths after a connection is
 * disabled or removed from an employee's explicit assignment list.
 */
export async function getExecutableMcpConnection(
  orgId: string,
  connectionSlug: string,
  toolName: string,
  agentEmployeeId?: string | null,
): Promise<ExecutableMcpConnectionResult> {
  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(and(
      eq(mcpConnections.org_id, orgId),
      eq(mcpConnections.slug, connectionSlug),
      eq(mcpConnections.is_active, true),
    ))
    .limit(1);
  if (!connection) {
    return {
      connection: null,
      error: `MCP connection '${connectionSlug}' is unavailable`,
      reason: 'provider_unavailable',
    };
  }

  if (agentEmployeeId) {
    const [employee] = await db
      .select({
        mcp_connection_ids: agentEmployees.mcp_connection_ids,
        disabled_tools: agentEmployees.disabled_tools,
      })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, agentEmployeeId),
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (!employee || !(employee.mcp_connection_ids ?? []).includes(connection.id)) {
      return {
        connection: null,
        error: `MCP connection '${connectionSlug}' is not assigned to this agent employee`,
        reason: 'provider_unavailable',
      };
    }
    if ((employee.disabled_tools ?? []).some((disabledName) => canonicalMcpToolName(disabledName) === toolName)) {
      return {
        connection: null,
        error: `MCP tool '${toolName}' is disabled for this agent employee`,
        reason: 'operation_unavailable',
      };
    }
  }

  if (!isMcpToolEnabled(connection.enabled_tools, connection.slug, toolName)) {
    return {
      connection: null,
      error: `MCP tool '${toolName}' is not enabled on connection '${connectionSlug}'`,
      reason: 'operation_unavailable',
    };
  }

  const overrideRows = await db
    .select({ tool_name: mcpToolOverrides.tool_name, is_disabled: mcpToolOverrides.is_disabled })
    .from(mcpToolOverrides)
    .where(and(
      eq(mcpToolOverrides.org_id, orgId),
      eq(mcpToolOverrides.mcp_connection_id, connection.id),
    ));
  const disabledOverride = overrideRows.some((row) => (
    row.is_disabled && canonicalMcpToolName(row.tool_name) === toolName
  ));
  if (disabledOverride) {
    return {
      connection: null,
      error: `MCP tool '${toolName}' is disabled on connection '${connectionSlug}'`,
      reason: 'operation_unavailable',
    };
  }

  return { connection };
}

/** Resolve the exact provider identity pinned into an App Run. Slug lookup is
 * intentionally unavailable on this path: a renamed or replacement
 * connection must never inherit an already-authorized Run. Actor assignment
 * and token authority are rechecked by App Run live authorization immediately
 * before this provider boundary. */
export async function getExecutableMcpConnectionById(
  orgId: string,
  connectionId: string,
  toolName: string,
): Promise<ExecutableMcpConnectionResult> {
  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(and(
      eq(mcpConnections.org_id, orgId),
      eq(mcpConnections.id, connectionId),
      eq(mcpConnections.is_active, true),
    ))
    .limit(1);
  if (!connection) {
    return {
      connection: null,
      error: 'Pinned MCP connection is unavailable',
      reason: 'provider_unavailable',
    };
  }

  if (!isMcpToolEnabled(connection.enabled_tools, connection.slug, toolName)) {
    return {
      connection: null,
      error: 'Pinned MCP operation is unavailable',
      reason: 'operation_unavailable',
    };
  }

  const overrideRows = await db
    .select({ tool_name: mcpToolOverrides.tool_name, is_disabled: mcpToolOverrides.is_disabled })
    .from(mcpToolOverrides)
    .where(and(
      eq(mcpToolOverrides.org_id, orgId),
      eq(mcpToolOverrides.mcp_connection_id, connection.id),
    ));
  if (overrideRows.some((row) => (
    row.is_disabled && canonicalMcpToolName(row.tool_name) === toolName
  ))) {
    return {
      connection: null,
      error: 'Pinned MCP operation is unavailable',
      reason: 'operation_unavailable',
    };
  }

  return { connection };
}
