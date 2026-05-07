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
} from '@deft/mcp';

/**
 * Convert a DB row from mcp_connections to an MCPConnectionConfig.
 */
export function toConnectionConfig(
  row: typeof mcpConnections.$inferSelect,
): MCPConnectionConfig {
  return {
    connectionId: row.id,
    connectionSlug: row.slug,
    orgId: row.org_id,
    transport: row.transport,
    url: row.server_url ?? undefined,
    command: row.stdio_command ?? undefined,
    args: (row.stdio_args as string[] | null) ?? undefined,
    env: undefined, // env vars are not stored separately in the schema
  };
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

  // 2. Filter by agent employee's allowed connections if specified
  if (agentEmployeeId) {
    const [employee] = await db
      .select({ mcp_connection_ids: agentEmployees.mcp_connection_ids })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.org_id, orgId)))
      .limit(1);

    if (employee?.mcp_connection_ids && employee.mcp_connection_ids.length > 0) {
      const allowedIds = new Set(employee.mcp_connection_ids);
      activeConnections = activeConnections.filter((c) => allowedIds.has(c.id));
    }
    // If employee has no mcp_connection_ids, allow all org connections
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
  const overridesByConnection = new Map<string, MCPToolOverride[]>();
  for (const row of overrideRows) {
    const connOverrides = overridesByConnection.get(row.mcp_connection_id) || [];
    connOverrides.push({
      toolName: row.tool_name,
      approvalTier: row.trust_tier_override
        ? (row.trust_tier_override === 'auto' ? 'auto-execute' : row.trust_tier_override === 'quick' ? 'quick-approve' : 'full-review')
        : undefined,
      disabled: row.is_disabled,
    });
    overridesByConnection.set(row.mcp_connection_id, connOverrides);
  }

  // 4. Discover tools from each connection (uses cache internally)
  const allTools: (MCPTool & { approvalTierMapped: 'auto' | 'quick' | 'full' })[] = [];

  for (const conn of activeConnections) {
    try {
      const config = toConnectionConfig(conn);
      const overrides = overridesByConnection.get(conn.id) || [];
      const tools = await mcpClientManager.getCachedTools(config, overrides);

      for (const tool of tools) {
        allTools.push({
          ...tool,
          // Prefix description with connection context
          description: `[MCP: ${conn.slug}] ${tool.description}`,
          approvalTierMapped: mapApprovalTier(tool.approvalTier),
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
