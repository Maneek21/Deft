/** Finite transport limit; individual tools retain their narrower contracts. */
export const MCP_REQUEST_BYTES = 32 * 1024 * 1024;

export class McpRequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = 'McpRequestBodyError';
  }
}

/** Count actual streamed bytes, including absent or dishonest Content-Length. */
export async function readMcpRequestJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MCP_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new McpRequestBodyError(413, 'MCP request exceeds the transport limit');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new McpRequestBodyError(400, 'Invalid MCP JSON request');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      request.signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MCP_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new McpRequestBodyError(413, 'MCP request exceeds the transport limit');
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    } catch {
      throw new McpRequestBodyError(400, 'Invalid MCP JSON request');
    }
  } finally {
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
