import {
  Client,
  type CallToolResult,
  type ClientOptions,
  type Tool,
} from "@modelcontextprotocol/client";
import { createTransport } from "./transports.js";
import { ToolCache } from "./cache.js";
import type {
  MCPConnectionConfig,
  MCPProviderTool,
  MCPTool,
  MCPToolDiscovery,
  MCPToolOverride,
  MCPResult,
} from "./types.js";

/**
 * Classify an MCP tool into an approval tier based on protocol annotations
 * and a name-based fallback. Returns isWrite and approvalTier.
 *
 * Precedence (highest to lowest):
 *   1. Name heuristics for known tool families (browser_*, filesystem_*, git_*)
 *      — these take top priority because we have explicit knowledge of each tool.
 *   2. annotations.destructiveHint === true → full-review, isWrite=true
 *   3. annotations.readOnlyHint === true    → auto-execute, isWrite=false
 *   4. Default: full-review, isWrite=false (conservative)
 *
 * Note: name heuristics run before annotation checks for known families because
 * some MCP servers (e.g. Playwright) set destructiveHint=true on interactive
 * actions (navigate, click, type) that we intentionally classify as quick-approve.
 */
function classifyTool(
  name: string,
  annotations: Record<string, unknown> | null
): { approvalTier: MCPTool["approvalTier"]; isWrite: boolean } {
  // browser_* (Playwright): reads auto, state changes quick, code-exec/file-upload full.
  if (name.startsWith("browser_")) {
    const READ_ONLY_BROWSER = new Set([
      "browser_snapshot",
      "browser_take_screenshot",
      "browser_console_messages",
      "browser_network_requests",
      "browser_tabs",
      "browser_wait_for",
    ]);
    if (READ_ONLY_BROWSER.has(name)) {
      return { approvalTier: "auto-execute", isWrite: false };
    }

    const DESTRUCTIVE_BROWSER = new Set([
      "browser_run_code",
      "browser_evaluate",
      "browser_file_upload",
      "browser_close",
      "browser_handle_dialog",
    ]);
    if (DESTRUCTIVE_BROWSER.has(name)) {
      return { approvalTier: "full-review", isWrite: true };
    }

    return { approvalTier: "quick-approve", isWrite: false };
  }

  // filesystem_*
  if (name.startsWith("filesystem_read") || name === "filesystem_list") {
    return { approvalTier: "auto-execute", isWrite: false };
  }
  if (name.startsWith("filesystem_")) {
    return { approvalTier: "full-review", isWrite: true };
  }

  // git_*
  if (name === "git_log" || name === "git_diff" || name === "git_show" || name === "git_status") {
    return { approvalTier: "auto-execute", isWrite: false };
  }
  if (name.startsWith("git_")) {
    return { approvalTier: "full-review", isWrite: true };
  }

  // Search MCPs — read-only lookups that should never gate the agent.
  // Matches tavily-search, tavily-extract, tavily-crawl, tavily_search, etc.
  // Also covers brave_web_search / brave_news / brave_image / brave_video,
  // exa_search / exa_contents / exa_find_similar, perplexity_ask, and the
  // common `web_search` / `search` aliases community servers expose.
  const SEARCH_PATTERNS = [
    /^tavily[-_]/,
    /^brave[-_]/,
    /^exa[-_]/,
    /^perplexity[-_]/,
    /^web[-_]search$/,
    /^search$/,
  ];
  if (SEARCH_PATTERNS.some((rx) => rx.test(name))) {
    return { approvalTier: "auto-execute", isWrite: false };
  }

  // Time / clock tools — pure reads. Covers the official Python server
  // (get_current_time, convert_time) and yokingma/time-mcp
  // (current_time, relative_time, days_in_month, get_timestamp, get_week_year).
  const TIME_TOOL_NAMES = new Set([
    "get_current_time",
    "convert_time",
    "current_time",
    "relative_time",
    "days_in_month",
    "get_timestamp",
    "get_week_year",
  ]);
  if (TIME_TOOL_NAMES.has(name) || name.startsWith("time_")) {
    return { approvalTier: "auto-execute", isWrite: false };
  }

  // Simple HTTP fetch — read-only URL grab. Covers the official Python fetch
  // server (`fetch`), plain `http_get`, and fetch-mcp (`fetch_url`,
  // `fetch_youtube_transcript`, etc — any name starting with `fetch_`).
  if (name === "fetch" || name === "http_get" || /^fetch[_-]/.test(name)) {
    return { approvalTier: "auto-execute", isWrite: false };
  }

  // Sequential thinking — pure reasoning, no side effects.
  if (name === "sequentialthinking" || name === "sequential_thinking") {
    return { approvalTier: "auto-execute", isWrite: false };
  }

  // Context7 / library docs lookup — read-only.
  if (name === "resolve-library-id" || name === "get-library-docs" || name === "query-docs") {
    return { approvalTier: "auto-execute", isWrite: false };
  }

  // Annotation-based fallback for unknown tool families.
  if (annotations) {
    if (annotations.destructiveHint === true) {
      return { approvalTier: "full-review", isWrite: true };
    }
    if (annotations.readOnlyHint === true) {
      return { approvalTier: "auto-execute", isWrite: false };
    }
  }

  return { approvalTier: "full-review", isWrite: false };
}

interface PoolEntry {
  client: Client;
  config: MCPConnectionConfig;
  lastUsed: number;
}

interface HealthEntry {
  failureCount: number;
  firstFailureAt: number;
  backoffUntil: number;
}

const MAX_CONNECTIONS_DEFAULT = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds
const EXECUTE_TIMEOUT_MS = 30 * 1000; // 30 seconds
const HEALTH_FAILURE_THRESHOLD = 3;
const HEALTH_FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const BACKOFF_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The 2026 MCP protocol is opt-in in the v2 SDK. Streamable HTTP and stdio
 * connections negotiate automatically; deprecated HTTP+SSE stays on the
 * byte-compatible legacy handshake.
 */
export function clientOptionsForTransport(
  transport: MCPConnectionConfig["transport"]
): ClientOptions {
  return {
    capabilities: {},
    ...(transport !== "sse"
      ? { versionNegotiation: { mode: "auto" as const } }
      : {}),
  };
}

function isAuthenticationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\b401\b/.test(normalized) ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("invalid token")
  );
}

function toolErrorMessage(result: CallToolResult): string {
  const text = result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
      item.type === "text"
    )
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n");
  return text || "MCP tool reported an error";
}

/**
 * Manages MCP client connections with pooling, caching, and health tracking.
 *
 * - Connection pool is per-org, max connections controlled by MCP_MAX_CONNECTIONS_PER_ORG env
 * - LRU eviction when pool is full
 * - Health tracking: 3 failures in 5 minutes triggers 10-minute backoff
 * - Idle connections cleaned up after 5 minutes of inactivity
 */
export class MCPClientManager {
  private pool = new Map<string, PoolEntry>();
  private health = new Map<string, HealthEntry>();
  private orgConnectionCount = new Map<string, Set<string>>();
  private toolCache = new ToolCache();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private onAuthError?: (connectionId: string, error: string) => void;

  setAuthErrorHandler(handler: (connectionId: string, error: string) => void) {
    this.onAuthError = handler;
  }

  constructor() {
    this.startIdleCleanup();
  }

  private get maxConnectionsPerOrg(): number {
    const envVal = process.env.MCP_MAX_CONNECTIONS_PER_ORG;
    return envVal ? parseInt(envVal, 10) : MAX_CONNECTIONS_DEFAULT;
  }

  /**
   * Connect to an MCP server. Returns the pooled client if already connected.
   * Evicts LRU connection if org is at max capacity.
   */
  async connect(config: MCPConnectionConfig): Promise<Client> {
    const health = this.health.get(config.connectionId);
    if (health && Date.now() < health.backoffUntil) {
      throw new Error(
        `Connection ${config.connectionId} is in backoff until ${new Date(health.backoffUntil).toISOString()}`
      );
    }
    if (health?.backoffUntil && Date.now() >= health.backoffUntil) {
      this.health.delete(config.connectionId);
    }

    const existing = this.pool.get(config.connectionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // Enforce per-org limit, evict LRU if needed
    await this.enforceOrgLimit(config.orgId);

    let client: Client;
    try {
      client = await this.connectFreshClient(
        config,
        `deft-mcp-${config.connectionSlug}`
      );
    } catch (error) {
      throw error;
    }

    const entry: PoolEntry = {
      client,
      config,
      lastUsed: Date.now(),
    };

    this.pool.set(config.connectionId, entry);
    this.trackOrgConnection(config.orgId, config.connectionId);

    return client;
  }

  /**
   * Disconnect a specific connection and remove from pool.
   */
  async disconnect(connectionId: string, clearHealth = true): Promise<void> {
    const entry = this.pool.get(connectionId);
    if (!entry) {
      this.toolCache.invalidate(connectionId);
      if (clearHealth) this.health.delete(connectionId);
      return;
    }

    try {
      await entry.client.close();
    } catch {
      // Ignore close errors
    }

    this.pool.delete(connectionId);
    this.removeOrgConnection(entry.config.orgId, connectionId);
    this.toolCache.invalidate(connectionId);
    if (clearHealth) this.health.delete(connectionId);
  }

  /**
   * Test a connection by connecting, listing tools, and disconnecting.
   * Returns the list of discovered tools on success.
   */
  async testConnection(config: MCPConnectionConfig): Promise<MCPTool[]> {
    return (await this.testToolDiscovery(config)).tools;
  }

  /** Test a connection once and retain a policy-free provider projection from
   * the same listTools response. */
  async testToolDiscovery(config: MCPConnectionConfig): Promise<MCPToolDiscovery> {
    const client = await this.connectFreshClient(
      config,
      `deft-mcp-test-${config.connectionSlug}`
    );

    try {
      const result = await client.listTools();
      return {
        tools: result.tools.map((tool) => this.mapTool(tool, config, [])),
        providerTools: result.tools.map((tool) => this.mapProviderTool(tool)),
      };
    } finally {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Discover tools from an MCP server, applying overrides.
   * Always fetches fresh from the server and updates cache.
   */
  async discoverTools(
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[] = []
  ): Promise<MCPTool[]> {
    return (await this.discoverToolDiscovery(config, overrides)).tools;
  }

  /** Discover once, returning both the exact legacy projection and a raw
   * provider projection captured before overrides/filtering/classification. */
  async discoverToolDiscovery(
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[] = []
  ): Promise<MCPToolDiscovery> {
    let result;
    try {
      const client = await this.connect(config);
      result = await client.listTools({}, { cacheMode: "refresh" });
      this.clearFailures(config.connectionId);
    } catch (error) {
      this.recordFailure(config.connectionId);
      await this.disconnect(config.connectionId, false);
      throw error;
    }

    const providerTools = result.tools.map((tool) => this.mapProviderTool(tool));
    const tools = result.tools
      .map((tool) => this.mapTool(tool, config, overrides))
      .filter((tool) => {
        const override = overrides.find((o) => o.toolName === tool.originalName);
        return !override?.disabled;
      });

    const discovery = { tools, providerTools };
    this.toolCache.setDiscovery(config.connectionId, discovery);
    return discovery;
  }

  /**
   * Get cached tools if available and fresh, otherwise re-discover.
   */
  async getCachedTools(
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[] = []
  ): Promise<MCPTool[]> {
    const cached = this.toolCache.get(config.connectionId);
    if (cached) return cached;

    return this.discoverTools(config, overrides);
  }

  /** Get the paired legacy/provider projections from cache, or produce both
   * from one fresh provider request. */
  async getCachedToolDiscovery(
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[] = []
  ): Promise<MCPToolDiscovery> {
    const cached = this.toolCache.getDiscovery(config.connectionId);
    if (cached) return cached;
    return this.discoverToolDiscovery(config, overrides);
  }

  /**
   * Execute a tool on an MCP server once. The v2 SDK owns the cancellable
   * request timeout, so there is no orphaned Promise.race timer and no blind
   * replay of potentially non-idempotent writes.
   */
  async executeTool(
    config: MCPConnectionConfig,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<MCPResult> {
    const startTime = Date.now();

    try {
      const client = await this.connect(config);
      const entry = this.pool.get(config.connectionId);
      if (entry) entry.lastUsed = Date.now();

      const result = await client.callTool(
        { name: toolName, arguments: params },
        { timeout: EXECUTE_TIMEOUT_MS }
      );

      // The connection itself worked even when the tool returned isError.
      this.clearFailures(config.connectionId);

      return {
        success: result.isError !== true,
        content: result.content,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result._meta ? { meta: result._meta } : {}),
        rawResult: result as unknown as Record<string, unknown>,
        ...(result.isError === true ? { error: toolErrorMessage(result) } : {}),
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      // Authentication failures are never retried and immediately enter backoff.
      if (isAuthenticationError(message)) {
        this.health.set(config.connectionId, {
          failureCount: 0,
          firstFailureAt: 0,
          backoffUntil: Date.now() + BACKOFF_DURATION_MS,
        });
        await this.disconnect(config.connectionId, false);
        this.onAuthError?.(
          config.connectionId,
          "Auth token expired — reconnect required"
        );
        return {
          success: false,
          content: null,
          error:
            "MCP connection auth expired. Please reconnect in Settings > Integrations.",
          durationMs: Date.now() - startTime,
        };
      }

      this.recordFailure(config.connectionId);
      await this.disconnect(config.connectionId, false);
      return {
        success: false,
        content: null,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Shut down the manager: disconnect all connections, stop idle cleanup.
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    const disconnects = Array.from(this.pool.keys()).map((id) =>
      this.disconnect(id)
    );
    await Promise.allSettled(disconnects);

    this.toolCache.clear();
    this.orgConnectionCount.clear();
    this.health.clear();
  }

  // --- Private helpers ---

  /**
   * Connect a new client. Streamable HTTP and stdio opt into 2026 version
   * negotiation; legacy SSE remains available only when explicitly selected.
   * An outage or malformed HTTP response is not evidence of SSE support.
   */
  private async connectFreshClient(
    config: MCPConnectionConfig,
    clientName: string
  ): Promise<Client> {
    const client = new Client(
      { name: clientName, version: "0.0.1" },
      clientOptionsForTransport(config.transport)
    );
    try {
      await client.connect(createTransport(config));
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch {
        // Ignore teardown errors from a connection that never completed.
      }
      throw error;
    }
  }

  private mapTool(
    tool: Tool,
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[]
  ): MCPTool {
    const override = overrides.find((o) => o.toolName === tool.name);
    const annotations = (tool as { annotations?: Record<string, unknown> }).annotations ?? null;

    const classified = classifyTool(tool.name, annotations);

    return {
      name: `mcp__${config.connectionSlug}__${tool.name}`,
      originalName: tool.name,
      description: override?.description ?? tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
      ...(tool.outputSchema
        ? { outputSchema: tool.outputSchema as Record<string, unknown> }
        : {}),
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.icons ? { icons: tool.icons } : {}),
      ...(tool.execution
        ? { execution: tool.execution as Record<string, unknown> }
        : {}),
      connectionId: config.connectionId,
      connectionSlug: config.connectionSlug,
      isWrite: override?.isWrite ?? classified.isWrite,
      approvalTier: override?.approvalTier ?? classified.approvalTier,
      annotations,
      rawTool: tool as unknown as Record<string, unknown>,
    };
  }

  private mapProviderTool(tool: Tool): MCPProviderTool {
    return {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
      ...(tool.outputSchema
        ? { outputSchema: tool.outputSchema as Record<string, unknown> }
        : {}),
      ...(tool.title ? { title: tool.title } : {}),
    };
  }

  private trackOrgConnection(orgId: string, connectionId: string): void {
    let connections = this.orgConnectionCount.get(orgId);
    if (!connections) {
      connections = new Set();
      this.orgConnectionCount.set(orgId, connections);
    }
    connections.add(connectionId);
  }

  private removeOrgConnection(orgId: string, connectionId: string): void {
    const connections = this.orgConnectionCount.get(orgId);
    if (connections) {
      connections.delete(connectionId);
      if (connections.size === 0) {
        this.orgConnectionCount.delete(orgId);
      }
    }
  }

  private async enforceOrgLimit(orgId: string): Promise<void> {
    const connections = this.orgConnectionCount.get(orgId);
    if (!connections || connections.size < this.maxConnectionsPerOrg) return;

    // Find LRU connection for this org
    let lruId: string | null = null;
    let lruTime = Infinity;

    for (const connId of connections) {
      const entry = this.pool.get(connId);
      if (entry && entry.lastUsed < lruTime) {
        lruTime = entry.lastUsed;
        lruId = connId;
      }
    }

    if (lruId) {
      await this.disconnect(lruId);
    }
  }

  private recordFailure(connectionId: string): void {
    const now = Date.now();
    const entry = this.health.get(connectionId) ?? {
      failureCount: 0,
      firstFailureAt: 0,
      backoffUntil: 0,
    };

    // Reset failure window if first failure is too old
    if (
      entry.firstFailureAt > 0 &&
      now - entry.firstFailureAt > HEALTH_FAILURE_WINDOW_MS
    ) {
      entry.failureCount = 0;
      entry.firstFailureAt = 0;
    }

    if (entry.failureCount === 0) {
      entry.firstFailureAt = now;
    }

    entry.failureCount++;

    if (entry.failureCount >= HEALTH_FAILURE_THRESHOLD) {
      entry.backoffUntil = now + BACKOFF_DURATION_MS;
      entry.failureCount = 0;
      entry.firstFailureAt = 0;
    }
    this.health.set(connectionId, entry);
  }

  private clearFailures(connectionId: string): void {
    this.health.delete(connectionId);
  }

  private startIdleCleanup(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [connectionId, entry] of this.pool) {
        if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
          this.disconnect(connectionId).catch(() => {
            // Ignore cleanup errors
          });
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);

    // Allow the process to exit even if timer is running
    if (this.idleTimer && typeof this.idleTimer.unref === "function") {
      this.idleTimer.unref();
    }
  }
}

/** Singleton MCP client manager instance */
export const mcpClientManager = new MCPClientManager();
