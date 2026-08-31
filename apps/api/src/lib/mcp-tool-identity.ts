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
