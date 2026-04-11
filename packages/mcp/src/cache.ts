import type { MCPTool } from "./types.js";

interface CacheEntry {
  tools: MCPTool[];
  cachedAt: number;
}

/**
 * In-memory cache for discovered MCP tools.
 * Default TTL is 5 minutes. Keyed by connection ID.
 */
export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get cached tools for a connection. Returns undefined if cache miss or expired.
   */
  get(connectionId: string): MCPTool[] | undefined {
    const entry = this.cache.get(connectionId);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(connectionId);
      return undefined;
    }

    return entry.tools;
  }

  /**
   * Cache tools for a connection.
   */
  set(connectionId: string, tools: MCPTool[]): void {
    this.cache.set(connectionId, {
      tools,
      cachedAt: Date.now(),
    });
  }

  /**
   * Invalidate cache for a specific connection.
   */
  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }
}
