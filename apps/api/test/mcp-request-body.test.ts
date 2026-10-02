import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_REQUEST_BYTES, McpRequestBodyError, readMcpRequestJson } from '../src/lib/mcp-request-body.js';

function request(body: ReadableStream<Uint8Array> | string, headers?: HeadersInit, signal?: AbortSignal) {
  return new Request('http://localhost/api/mcp/v1', { method: 'POST', body, headers, signal, duplex: 'half' } as RequestInit);
}

test('MCP transport preserves maximum bounded bulk/App/document envelopes', async () => {
  // Each record is exactly the existing 256KiB canonical record ceiling.
  const row = { a: 'x'.repeat(100000), b: 'x'.repeat(100000), c: '' };
  row.c = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(row)));
  assert.equal(Buffer.byteLength(JSON.stringify(row)), 256 * 1024);
  const bulk = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'module_record_bulk_create', arguments: { rows: Array.from({ length: 100 }, () => row) } } };
  const app = { user_inputs: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`input_${i}`, '\u0001'.repeat(65536)])) };
  const document = { content: '\u0001'.repeat(65536), caption: 'x'.repeat(2000) };
  for (const value of [bulk, app, document]) {
    const wire = JSON.stringify(value);
    assert.ok(Buffer.byteLength(wire) < MCP_REQUEST_BYTES);
    assert.deepEqual(await readMcpRequestJson(request(wire)), value);
  }
});

test('MCP counts actual bytes with absent/lying Content-Length and cancels oversized chunks', async () => {
  for (const headers of [undefined, { 'content-length': '1' }]) {
    let cancelled = false;
    let dispatched = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MCP_REQUEST_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(async () => {
      await readMcpRequestJson(request(stream, headers));
      dispatched = true;
    }, (error: unknown) => error instanceof McpRequestBodyError && error.status === 413);
    assert.equal(cancelled, true);
    assert.equal(dispatched, false);
  }
});

test('MCP rejects declared oversize and malformed JSON, abort cancels pending reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(readMcpRequestJson(request(stream, { 'content-length': String(MCP_REQUEST_BYTES + 1) })), { status: 413 });
  assert.equal(cancelled, true);
  await assert.rejects(readMcpRequestJson(request('{')), { status: 400 });
  const controller = new AbortController();
  cancelled = false;
  const pending = readMcpRequestJson(request(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), undefined, controller.signal));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
