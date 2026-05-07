import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPConnectionConfig } from "./types.js";

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
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
    }

    case "sse": {
      if (!config.url) {
        throw new Error("SSE transport requires a url");
      }
      return new SSEClientTransport(new URL(config.url), {
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
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    }

    default:
      throw new Error(`Unknown transport type: ${config.transport}`);
  }
}
