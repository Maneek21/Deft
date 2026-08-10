export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

import { isStdioCommandAllowed, validateMcpHttpUrl } from '@deft/mcp';

export interface McpConnectionTarget {
  transport: McpTransport;
  serverUrl: string | null | undefined;
  stdioCommand: string | null | undefined;
  stdioArgs: string[] | null | undefined;
}

const SENSITIVE_STDIO_ARGUMENT = /(?:^|[-_])(api[-_]?key|token|secret|password|credential|authorization)(?:$|[=_-])/i;

/** Return a user-safe validation error, or null when the target is coherent. */
export function validateMcpConnectionTarget(target: McpConnectionTarget): string | null {
  if (target.transport === 'stdio') {
    if (!target.stdioCommand?.trim()) return 'Stdio transport requires a command';
    if (target.serverUrl?.trim()) return 'Stdio transport cannot include a server URL';
    if (target.stdioArgs?.some((argument) => SENSITIVE_STDIO_ARGUMENT.test(argument))) {
      return 'Stdio credentials must use the encrypted environment-variable credential field, not command arguments';
    }
    if (!isStdioCommandAllowed(target.stdioCommand)) {
      return 'Stdio command is not allowed by the host MCP_STDIO_ALLOWED_COMMANDS policy';
    }
    return null;
  }

  if (!target.serverUrl?.trim()) return 'HTTP transports require a server URL';
  if (target.stdioCommand?.trim() || (target.stdioArgs?.length ?? 0) > 0) {
    return 'HTTP transports cannot include stdio command fields';
  }

  try {
    const parsed = new URL(target.serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'MCP server URL must use http or https';
    }
    if (parsed.username || parsed.password) {
      return 'MCP server URL cannot contain credentials';
    }
    const targetError = validateMcpHttpUrl(parsed);
    if (targetError) return targetError;
    if (parsed.search) {
      return 'MCP server URL cannot include query parameters; configure credentials separately';
    }
    if (parsed.hash) return 'MCP server URL cannot include a fragment';
  } catch {
    return 'MCP server URL is invalid';
  }

  return null;
}
