import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTransport } from "./transports.js";
import { ToolCache } from "./cache.js";
import type {
  MCPConnectionConfig,
  MCPTool,
  MCPToolOverride,
  MCPResult,
} from "./types.js";

interface PoolEntry {
  client: Client;
  config: MCPConnectionConfig;
  lastUsed: number;
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
 * Manages MCP client connections with pooling, caching, and health tracking.
 *
 * - Connection pool is per-org, max connections controlled by MCP_MAX_CONNECTIONS_PER_ORG env
 * - LRU eviction when pool is full
 * - Health tracking: 3 failures in 5 minutes triggers 10-minute backoff
 * - Idle connections cleaned up after 5 minutes of inactivity
 */
export class MCPClientManager {
  private pool = new Map<string, PoolEntry>();
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
    const existing = this.pool.get(config.connectionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // Check backoff
    const backoffEntry = this.findBackoffEntry(config.connectionId);
    if (backoffEntry && Date.now() < backoffEntry.backoffUntil) {
      throw new Error(
        `Connection ${config.connectionId} is in backoff until ${new Date(backoffEntry.backoffUntil).toISOString()}`
      );
    }

    // Enforce per-org limit, evict LRU if needed
    await this.enforceOrgLimit(config.orgId);

    const transport = createTransport(config);
    const client = new Client(
      { name: `deft-mcp-${config.connectionSlug}`, version: "0.0.1" },
      { capabilities: {} }
    );

    await client.connect(transport);

    const entry: PoolEntry = {
      client,
      config,
      lastUsed: Date.now(),
      failureCount: 0,
      firstFailureAt: 0,
      backoffUntil: 0,
    };

    this.pool.set(config.connectionId, entry);
    this.trackOrgConnection(config.orgId, config.connectionId);

    return client;
  }

  /**
   * Disconnect a specific connection and remove from pool.
   */
  async disconnect(connectionId: string): Promise<void> {
    const entry = this.pool.get(connectionId);
    if (!entry) return;

    try {
      await entry.client.close();
    } catch {
      // Ignore close errors
    }

    this.pool.delete(connectionId);
    this.removeOrgConnection(entry.config.orgId, connectionId);
    this.toolCache.invalidate(connectionId);
  }

  /**
   * Test a connection by connecting, listing tools, and disconnecting.
   * Returns the list of discovered tools on success.
   */
  async testConnection(config: MCPConnectionConfig): Promise<MCPTool[]> {
    const transport = createTransport(config);
    const client = new Client(
      { name: `deft-mcp-test-${config.connectionSlug}`, version: "0.0.1" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();
      return result.tools.map((tool) =>
        this.mapTool(tool, config, [])
      );
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
    const client = await this.connect(config);
    const result = await client.listTools();

    const tools = result.tools
      .map((tool) => this.mapTool(tool, config, overrides))
      .filter((tool) => {
        const override = overrides.find((o) => o.toolName === tool.originalName);
        return !override?.disabled;
      });

    this.toolCache.set(config.connectionId, tools);
    return tools;
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

  /**
   * Execute a tool on an MCP server. Retries once on failure.
   * Times out after 30 seconds.
   */
  async executeTool(
    config: MCPConnectionConfig,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<MCPResult> {
    const startTime = Date.now();

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = await this.connect(config);
        const entry = this.pool.get(config.connectionId);
        if (entry) entry.lastUsed = Date.now();

        const result = await Promise.race([
          client.callTool({ name: toolName, arguments: params }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Tool execution timed out after 30s")),
              EXECUTE_TIMEOUT_MS
            )
          ),
        ]);

        // Reset failure tracking on success
        if (entry) {
          entry.failureCount = 0;
          entry.firstFailureAt = 0;
        }

        return {
          success: true,
          content: result.content,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        // Detect auth errors — no retry, immediately mark as errored
        if (
          message.includes("401") ||
          message.includes("Unauthorized") ||
          message.includes("auth")
        ) {
          const entry = this.pool.get(config.connectionId);
          if (entry) {
            entry.failureCount = HEALTH_FAILURE_THRESHOLD;
            entry.firstFailureAt = Date.now();
            entry.backoffUntil = Date.now() + BACKOFF_DURATION_MS;
          }
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

        if (attempt === 1) {
          this.recordFailure(config.connectionId);
          return {
            success: false,
            content: null,
            error: message,
            durationMs: Date.now() - startTime,
          };
        }

        // First attempt failed, disconnect and retry
        await this.disconnect(config.connectionId);
      }
    }

    // Unreachable, but TypeScript needs it
    return {
      success: false,
      content: null,
      error: "Unexpected execution path",
      durationMs: Date.now() - startTime,
    };
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
  }

  // --- Private helpers ---

  private mapTool(
    tool: { name: string; description?: string; inputSchema?: unknown },
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[]
  ): MCPTool {
    const override = overrides.find((o) => o.toolName === tool.name);

    return {
      name: `mcp__${config.connectionSlug}__${tool.name}`,
      originalName: tool.name,
      description: override?.description ?? tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
      connectionId: config.connectionId,
      connectionSlug: config.connectionSlug,
      isWrite: override?.isWrite ?? false,
      approvalTier: override?.approvalTier ?? "full-review",
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
    const entry = this.pool.get(connectionId);
    if (!entry) return;

    const now = Date.now();

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
  }

  private findBackoffEntry(
    connectionId: string
  ): PoolEntry | undefined {
    return this.pool.get(connectionId);
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
