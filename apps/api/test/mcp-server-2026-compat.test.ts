import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

function createApp() {
  const app = new Hono();
  app.route('/api/mcp/v1', mcpServerV1Routes);
  app.get('/outside-mcp', (c) => c.json({ ok: true }));
  return app;
}

function modernParams(
  params: Record<string, unknown> = {},
  options: {
    protocolVersion?: string;
    includeClientInfo?: boolean;
    includeClientCapabilities?: boolean;
  } = {},
) {
  const protocolVersion = options.protocolVersion ?? MODERN_PROTOCOL_VERSION;
  return {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': protocolVersion,
      ...(options.includeClientInfo === false
        ? {}
        : {
            'io.modelcontextprotocol/clientInfo': {
              name: 'deft-compat-test',
              version: '1.0.0',
            },
          }),
      ...(options.includeClientCapabilities === false
        ? {}
        : { 'io.modelcontextprotocol/clientCapabilities': {} }),
    },
  };
}

async function postJson(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return createApp().request('/api/mcp/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    protocolVersion?: string;
    headers?: Record<string, string | undefined>;
    includeClientInfo?: boolean;
    includeClientCapabilities?: boolean;
  } = {},
) {
  const protocolVersion = options.protocolVersion ?? MODERN_PROTOCOL_VERSION;
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': method,
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return postJson(
    {
      jsonrpc: '2.0',
      id: 'modern-1',
      method,
      params: modernParams(params, {
        protocolVersion,
        includeClientInfo: options.includeClientInfo,
        includeClientCapabilities: options.includeClientCapabilities,
      }),
    },
    headers,
  );
}

test('MCP Origin validation rejects untrusted browser origins without affecting other routes', async () => {
  const app = createApp();
  const rejected = await app.request('/api/mcp/v1/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: '{}',
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json() as any).error.code, 'invalid_origin');

  const allowed = await app.request('/api/mcp/v1/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    body: '{}',
  });
  assert.equal(allowed.status, 200);

  const outside = await app.request('/outside-mcp', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(outside.status, 200);
});

test('single-endpoint MCP rejects non-JSON request media types', async () => {
  const response = await createApp().request('/api/mcp/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json() as any).error.code, 'unsupported_media_type');
});

test('legacy JSON-RPC initialize negotiates a supported legacy version without modern fields', async () => {
  const response = await postJson({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'legacy-test', version: '1.0.0' },
      capabilities: {},
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.result.protocolVersion, '2025-11-25');
  assert.equal(body.result.serverInfo.name, 'deft-mcp');
  assert.equal(body.result.resultType, undefined);
  assert.equal(body.result._meta, undefined);
});

test('legacy initialize counter-offers the newest supported legacy version', async () => {
  const response = await postJson({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2023-01-01', capabilities: {}, clientInfo: {} },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).result.protocolVersion, '2025-11-25');
});

test('legacy notifications/initialized remains a response-free accepted notification', async () => {
  const response = await postJson({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
});

test('server/discover advertises modern support and stamps complete private metadata', async () => {
  const response = await modernPost('server/discover');
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.result.resultType, 'complete');
  assert.deepEqual(body.result.supportedVersions, [MODERN_PROTOCOL_VERSION]);
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.equal(body.result.ttlMs, 0);
  assert.equal(body.result.cacheScope, 'private');
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'deft-mcp');
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].version, '1.0.0');
});

test('modern clientInfo is optional but clientCapabilities remains required', async () => {
  const withoutInfo = await modernPost('server/discover', {}, { includeClientInfo: false });
  assert.equal(withoutInfo.status, 200);

  const withoutCapabilities = await modernPost('server/discover', {}, {
    includeClientCapabilities: false,
  });
  assert.equal(withoutCapabilities.status, 400);
  assert.equal((await withoutCapabilities.json() as any).error.code, -32602);
});

test('modern requests require a protocol header matching request metadata', async () => {
  const missingHeader = await modernPost('server/discover', {}, {
    headers: { 'MCP-Protocol-Version': undefined },
  });
  assert.equal(missingHeader.status, 400);
  assert.equal((await missingHeader.json() as any).error.code, -32020);

  const mismatch = await postJson(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'server/discover',
      params: modernParams({}, { protocolVersion: MODERN_PROTOCOL_VERSION }),
    },
    {
      'MCP-Protocol-Version': '2026-01-01',
      'Mcp-Method': 'server/discover',
    },
  );
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json() as any).error.code, -32020);
});

test('modern requests reject mismatched routing headers with HeaderMismatch', async () => {
  const methodMismatch = await modernPost('server/discover', {}, {
    headers: { 'Mcp-Method': 'tools/list' },
  });
  assert.equal(methodMismatch.status, 400);
  assert.equal((await methodMismatch.json() as any).error.code, -32020);

  const missingName = await modernPost(
    'tools/call',
    { name: 'platform_context', arguments: {} },
  );
  assert.equal(missingName.status, 400);
  assert.equal((await missingName.json() as any).error.code, -32020);

  const nameMismatch = await modernPost(
    'tools/call',
    { name: 'platform_context', arguments: {} },
    { headers: { 'Mcp-Name': 'task_query' } },
  );
  assert.equal(nameMismatch.status, 400);
  assert.equal((await nameMismatch.json() as any).error.code, -32020);
});

test('unsupported modern protocol versions return the standardized downgrade data', async () => {
  const response = await modernPost('server/discover', {}, {
    protocolVersion: '2027-01-01',
  });
  assert.equal(response.status, 400);
  const body = await response.json() as any;
  assert.equal(body.error.code, -32022);
  assert.equal(body.error.data.requested, '2027-01-01');
  assert.deepEqual(body.error.data.supported, [MODERN_PROTOCOL_VERSION]);
});
