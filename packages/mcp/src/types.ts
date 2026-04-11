/**
 * MCP connection configuration for connecting to external MCP servers.
 */
export interface MCPConnectionConfig {
  /** Unique identifier for this connection */
  connectionId: string;
  /** Human-readable slug used in tool name prefixing */
  connectionSlug: string;
  /** Organization ID (multi-tenant isolation) */
  orgId: string;
  /** Transport type */
  transport: "stdio" | "sse" | "streamable-http";
  /** Server URL for SSE or Streamable HTTP transports */
  url?: string;
  /** Custom headers for HTTP-based transports */
  headers?: Record<string, string>;
  /** Command for stdio transport */
  command?: string;
  /** Arguments for stdio transport */
  args?: string[];
  /** Environment variables for stdio transport */
  env?: Record<string, string>;
}

/**
 * Represents a tool discovered from an MCP server, with Deft-specific metadata.
 * Tool names are prefixed as `mcp__{connection_slug}__{tool_name}` to avoid
 * collisions with native Deft tools.
 */
export interface MCPTool {
  /** Prefixed tool name: mcp__{connectionSlug}__{originalName} */
  name: string;
  /** Original tool name from the MCP server */
  originalName: string;
  /** Tool description from the MCP server */
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;
  /** Connection ID this tool belongs to */
  connectionId: string;
  /** Connection slug used in the name prefix */
  connectionSlug: string;
  /** Whether this tool performs write operations */
  isWrite: boolean;
  /** Approval tier for the agent's three-tier approval system */
  approvalTier: "auto-execute" | "quick-approve" | "full-review";
}

/**
 * Result from executing an MCP tool.
 */
export interface MCPResult {
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Result content from the MCP server */
  content: unknown;
  /** Error message if execution failed */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Per-tool overrides applied during tool discovery.
 * Allows orgs to customize approval tiers and mark tools as write operations.
 */
export interface MCPToolOverride {
  /** Original tool name to match */
  toolName: string;
  /** Override the approval tier */
  approvalTier?: "auto-execute" | "quick-approve" | "full-review";
  /** Override the isWrite flag */
  isWrite?: boolean;
  /** Override the description */
  description?: string;
  /** Whether this tool is disabled (hidden from agent) */
  disabled?: boolean;
}
