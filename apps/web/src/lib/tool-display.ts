/**
 * Tool name display helpers for agent chat UI.
 *
 * The agent uses internal routing names like `mcp__playwright-browser__browser_navigate`.
 * Users see raw underscores and double-colons, which is developer-facing.
 * This module humanizes them into readable labels.
 */

export type ToolDisplay = {
  /** Humanized connection name, or null for native tools. */
  connection: string | null;
  /** Humanized tool name (without the connection prefix). */
  tool: string;
  /** Combined label suitable for a pill or card header. */
  full: string;
};

/**
 * Parse an MCP or native tool name into display parts.
 *
 * Examples:
 *   mcp__playwright-browser__browser_navigate
 *     → { connection: 'Playwright Browser', tool: 'Browser Navigate', full: 'Playwright Browser · Browser Navigate' }
 *   mcp__tavily-search__tavily_search
 *     → { connection: 'Tavily Search', tool: 'Tavily Search', full: 'Tavily Search · Tavily Search' }
 *   create_task
 *     → { connection: null, tool: 'Create Task', full: 'Create Task' }
 *   sequentialthinking
 *     → { connection: null, tool: 'Sequential Thinking', full: 'Sequential Thinking' }
 */
export function humanizeToolName(raw: string): ToolDisplay {
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    if (parts.length >= 3) {
      const slug = parts[1]!;
      const toolName = parts.slice(2).join('__');
      const connection = titleCase(slug.replace(/[-_]/g, ' '));
      const tool = titleCase(toolName.replace(/[-_]/g, ' '));
      return { connection, tool, full: `${connection} · ${tool}` };
    }
  }

  // Native tool like create_task, post_message, sequentialthinking
  const spaced = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → spaces
    .replace(/[-_]/g, ' ');
  const tool = titleCase(spaced);
  return { connection: null, tool, full: tool };
}

/**
 * Shorthand — returns the combined `full` label string.
 */
export function formatToolLabel(raw: string): string {
  return humanizeToolName(raw).full;
}

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}
