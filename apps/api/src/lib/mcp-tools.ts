/**
 * MCP tool integration for the agent pipeline.
 *
 * Bridges the @deft/mcp client manager with the agent's tool system:
 * - Discovers tools from active MCP connections
 * - Applies per-tool overrides and disabled_tools filtering
 * - Converts MCP tools to Anthropic API format
 * - Parses prefixed tool names for routing
 */

import { db } from './db.js';
import { mcpConnections, mcpToolOverrides, agentEmployees } from '@deft/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import {
  mcpClientManager,
  type MCPConnectionConfig,
  type MCPTool,
  type MCPToolOverride,
  type MCPResult,
} from '@deft/mcp';
import { resolveMcpRuntimeAuth } from './mcp-connection-auth.js';
import { validateMcpConnectionTarget } from './mcp-connection-validation.js';

/**
 * Convert a DB row from mcp_connections to an MCPConnectionConfig.
 */
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
): Promise<{ connection: typeof mcpConnections.$inferSelect | null; error?: string }> {
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
    return { connection: null, error: `MCP connection '${connectionSlug}' is unavailable` };
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
      return { connection: null, error: `MCP connection '${connectionSlug}' is not assigned to this agent employee` };
    }
    if ((employee.disabled_tools ?? []).some((disabledName) => canonicalMcpToolName(disabledName) === toolName)) {
      return { connection: null, error: `MCP tool '${toolName}' is disabled for this agent employee` };
    }
  }

  if (!isMcpToolEnabled(connection.enabled_tools, connection.slug, toolName)) {
    return { connection: null, error: `MCP tool '${toolName}' is not enabled on connection '${connectionSlug}'` };
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
    return { connection: null, error: `MCP tool '${toolName}' is disabled on connection '${connectionSlug}'` };
  }

  return { connection };
}

/**
 * Map an MCP tool's approval tier to the agent's approval tier names.
 * MCP uses "auto-execute" | "quick-approve" | "full-review",
 * but the agent system uses "auto" | "quick" | "full".
 */
function mapApprovalTier(mcpTier: MCPTool['approvalTier']): 'auto' | 'quick' | 'full' {
  switch (mcpTier) {
    case 'auto-execute': return 'auto';
    case 'quick-approve': return 'quick';
    case 'full-review': return 'full';
    default: return 'full';
  }
}

const MCP_APPROVAL_TIER_RANK: Record<MCPTool['approvalTier'], number> = {
  'auto-execute': 0,
  'quick-approve': 1,
  'full-review': 2,
};

/** Merge duplicate legacy/canonical override rows without weakening policy.
 * Disabled wins, and conflicting trust tiers resolve to the stricter tier. */
export function mergeMcpToolOverrides(
  existing: MCPToolOverride | undefined,
  incoming: MCPToolOverride,
): MCPToolOverride {
  if (!existing) return { ...incoming };
  const approvalTier = existing.approvalTier && incoming.approvalTier
    ? (MCP_APPROVAL_TIER_RANK[existing.approvalTier] >= MCP_APPROVAL_TIER_RANK[incoming.approvalTier]
        ? existing.approvalTier
        : incoming.approvalTier)
    : existing.approvalTier ?? incoming.approvalTier;
  return {
    ...existing,
    ...incoming,
    toolName: existing.toolName,
    approvalTier,
    disabled: Boolean(existing.disabled || incoming.disabled),
    isWrite: existing.isWrite === true || incoming.isWrite === true
      ? true
      : existing.isWrite ?? incoming.isWrite,
  };
}

export function configuredMcpApprovalTier(
  defaultTier: 'auto' | 'quick' | 'full',
  override?: MCPTool['approvalTier'],
  discoveredTier?: MCPTool['approvalTier'],
): MCPTool['approvalTier'] {
  if (override) return override;
  const configuredTier: MCPTool['approvalTier'] = defaultTier === 'auto'
    ? 'auto-execute'
    : defaultTier === 'quick'
      ? 'quick-approve'
      : 'full-review';
  if (!discoveredTier) return configuredTier;
  return MCP_APPROVAL_TIER_RANK[discoveredTier] > MCP_APPROVAL_TIER_RANK[configuredTier]
    ? discoveredTier
    : configuredTier;
}

/**
 * Discover MCP tools available for the agent, filtered by org and optionally
 * by an agent employee's allowed MCP connections.
 *
 * - Queries active MCP connections for the org
 * - If agentEmployeeId is provided, filters to only the connections in that employee's mcp_connection_ids
 * - Discovers/caches tools via MCPClientManager
 * - Applies tool overrides and disabled_tools filtering
 */
export async function getMCPToolsForAgent(
  orgId: string,
  agentEmployeeId?: string,
): Promise<(MCPTool & { approvalTierMapped: 'auto' | 'quick' | 'full' })[]> {
  // 1. Get active MCP connections for the org
  let activeConnections = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.org_id, orgId), eq(mcpConnections.is_active, true)));

  if (activeConnections.length === 0) return [];

  let employeeDisabledTools = new Set<string>();

  // 2. Filter by agent employee's allowed connections if specified
  if (agentEmployeeId) {
    const [employee] = await db
      .select({
        mcp_connection_ids: agentEmployees.mcp_connection_ids,
        disabled_tools: agentEmployees.disabled_tools,
        is_active: agentEmployees.is_active,
        is_deleted: agentEmployees.is_deleted,
      })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.org_id, orgId)))
      .limit(1);

    if (!employee?.is_active || employee.is_deleted) return [];
    const allowedIds = new Set(employee.mcp_connection_ids ?? []);
    activeConnections = activeConnections.filter((c) => allowedIds.has(c.id));
    employeeDisabledTools = new Set((employee.disabled_tools ?? []).map(canonicalMcpToolName));
  }

  if (activeConnections.length === 0) return [];

  // 3. Load all tool overrides for these connections
  const connectionIds = activeConnections.map((c) => c.id);
  const overrideRows = await db
    .select()
    .from(mcpToolOverrides)
    .where(
      and(
        eq(mcpToolOverrides.org_id, orgId),
        inArray(mcpToolOverrides.mcp_connection_id, connectionIds),
      ),
    );

  // Group overrides by connection ID
  const overridesByConnection = new Map<string, Map<string, MCPToolOverride>>();
  for (const row of overrideRows) {
    const connOverrides = overridesByConnection.get(row.mcp_connection_id) || new Map<string, MCPToolOverride>();
    const canonicalToolName = canonicalMcpToolName(row.tool_name);
    const incomingOverride: MCPToolOverride = {
      toolName: canonicalToolName,
      approvalTier: row.trust_tier_override
        ? (row.trust_tier_override === 'auto' ? 'auto-execute' : row.trust_tier_override === 'quick' ? 'quick-approve' : 'full-review')
        : undefined,
      disabled: row.is_disabled,
    };
    connOverrides.set(
      canonicalToolName,
      mergeMcpToolOverrides(connOverrides.get(canonicalToolName), incomingOverride),
    );
    overridesByConnection.set(row.mcp_connection_id, connOverrides);
  }

  // 4. Discover tools from each connection (uses cache internally)
  const allTools: (MCPTool & { approvalTierMapped: 'auto' | 'quick' | 'full' })[] = [];

  for (const conn of activeConnections) {
    try {
      const config = toConnectionConfig(conn);
      const overrides = [...(overridesByConnection.get(conn.id)?.values() ?? [])];
      const tools = await mcpClientManager.getCachedTools(config, overrides);
      const disabledTools = new Set(
        overrides.filter((override) => override.disabled).map((override) => override.toolName),
      );

      for (const tool of tools) {
        if (disabledTools.has(tool.originalName)) continue;
        if (employeeDisabledTools.has(tool.originalName)) continue;
        if (!isMcpToolEnabled(conn.enabled_tools, conn.slug, tool.originalName)) continue;
        const tierOverride = overrides.find((override) => (
          override.toolName === tool.originalName && override.approvalTier
        ));
        const effectiveApprovalTier = configuredMcpApprovalTier(
          conn.default_trust_tier,
          tierOverride?.approvalTier,
          tool.approvalTier,
        );
        allTools.push({
          ...tool,
          approvalTier: effectiveApprovalTier,
          // Prefix description with connection context
          description: `[MCP: ${conn.slug}] ${tool.description}`,
          approvalTierMapped: mapApprovalTier(effectiveApprovalTier),
        });
      }
    } catch (err) {
      console.warn(
        `[mcp-tools] Failed to discover tools for connection "${conn.slug}" (${conn.id}):`,
        err instanceof Error ? err.message : err,
      );
      // Continue with other connections — don't fail the whole agent
    }
  }

  return allTools;
}

/**
 * Parse a prefixed MCP tool name into its connection slug and original tool name.
 * Format: mcp__{connectionSlug}__{toolName}
 */
export function parseMCPToolName(prefixedName: string): {
  connectionSlug: string;
  toolName: string;
} {
  // Format: mcp__{slug}__{toolName}
  const match = prefixedName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) {
    throw new Error(`Invalid MCP tool name format: ${prefixedName}`);
  }
  // The slug uses single underscores, tool name is everything after the second double-underscore
  const parts = prefixedName.split('__');
  if (parts.length < 3) {
    throw new Error(`Invalid MCP tool name format: ${prefixedName}`);
  }
  return {
    connectionSlug: parts[1]!,
    toolName: parts.slice(2).join('__'),
  };
}

/**
 * Convert an MCPTool to Anthropic's tool format for the API.
 * Note: description is passed through as-is — getMCPToolsForAgent already
 * prefixes it with [MCP: slug].
 */
export function mcpToolToAnthropicFormat(tool: MCPTool): {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown };
} {
  // MCP tools return JSON Schema; ensure it has the 'type' field Anthropic requires
  const schema = tool.inputSchema as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      ...schema,
    },
  };
}
