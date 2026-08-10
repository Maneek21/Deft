import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import type { MCPConnectionConfig } from "./types.js";
import { createSecureMcpFetch, isStdioCommandAllowed } from "./transport-security.js";

/**
 * Creates the appropriate MCP transport based on connection config.
 * Stdio transport is only allowed when DEFT_SELF_HOSTED=true (security).
 */
export function createTransport(config: MCPConnectionConfig): Transport {
  switch (config.transport) {
    case "stdio": {
      if (process.env.DEFT_SELF_HOSTED !== "true") {
        throw new Error(
          "Stdio transport is only allowed in self-hosted mode (DEFT_SELF_HOSTED=true)"
        );
      }
      if (!config.command) {
        throw new Error("Stdio transport requires a command");
      }
      if (!isStdioCommandAllowed(config.command)) {
        throw new Error(
          "Stdio command is not allowed by the host MCP_STDIO_ALLOWED_COMMANDS policy"
        );
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
          ? { ...getDefaultEnvironment(), ...config.env }
          : undefined,
      });
    }

    case "sse": {
      if (!config.url) {
        throw new Error("SSE transport requires a url");
      }
      return new SSEClientTransport(new URL(config.url), {
        fetch: createSecureMcpFetch(config.url),
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    }

    case "streamable-http": {
      if (!config.url) {
        throw new Error("Streamable HTTP transport requires a url");
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: createSecureMcpFetch(config.url),
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    }

    default:
      throw new Error(`Unknown transport type: ${config.transport}`);
  }
}
