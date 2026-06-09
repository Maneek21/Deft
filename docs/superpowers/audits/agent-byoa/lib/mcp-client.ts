// docs/superpowers/audits/agent-byoa/lib/mcp-client.ts
export interface McpClient {
  initialize(): Promise<unknown>;
  toolsList(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>;
  toolsCall<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export function createMcpClient(opts: { apiUrl: string; bearer: string }): McpClient {
  const url = `${opts.apiUrl.replace(/\/$/, '')}/api/mcp/v1`;
  let nextId = 1;
  const auditToken = process.env.DEFT_AUDIT_BYPASS_TOKEN;

  async function rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.bearer}`,
        ...(auditToken ? { 'x-deft-audit-token': auditToken } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
    }
    return body.result as T;
  }

  return {
    initialize: () => rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
    toolsList: () => rpc('tools/list', {}),
    toolsCall: async <T>(name: string, args: Record<string, unknown>) => {
      const result = await rpc<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>(
        'tools/call',
        { name, arguments: args },
      );
      // MCP wraps tool results as content[].text JSON. Unwrap to the
      // parsed JSON for ergonomic assertions.
      const text = result.content?.[0]?.text ?? '{}';
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
  };
}
