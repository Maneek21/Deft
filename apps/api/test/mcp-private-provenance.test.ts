import test from 'node:test';
import assert from 'node:assert/strict';
import { firstClassMcpAuthentication, createPrivateMcpInvocation, privateMcpInvocationAuthority, type PrivateMcpInvocation, type ResolvedMcpPrincipal } from '../src/lib/mcp-token.js';
import { Hono } from 'hono';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { MCP_REQUEST_BYTES } from '../src/lib/mcp-request-body.js';

test('Serialized actor/token/scopes cannot fabricate first-class MCP invocation provenance', () => {
  const principal: ResolvedMcpPrincipal = {
    kind: 'human', token_id: '00000000-0000-4000-8000-000000000001',
    org_id: '00000000-0000-4000-8000-000000000002', user_id: '00000000-0000-4000-8000-000000000003',
    role: 'owner', scopes: ['read:app-private-resources'],
  };
  assert.equal(firstClassMcpAuthentication(principal), null);
  assert.equal(createPrivateMcpInvocation(principal, new AbortController().signal), null);
  assert.equal(privateMcpInvocationAuthority({} as PrivateMcpInvocation), null);
  assert.equal(privateMcpInvocationAuthority(JSON.parse(JSON.stringify(principal)) as PrivateMcpInvocation), null);
});

test('Actual MCP router bounds parsed input while legacy authentication precedes body consumption', async () => {
  const app = new Hono();
  app.route('/api/mcp/v1', mcpServerV1Routes);
  for (const path of ['/api/mcp/v1']) {
    const response = await app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' },
      body: new Uint8Array(MCP_REQUEST_BYTES + 1),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'request_too_large');
  }
  const unauthenticated = new Request('http://local.test/api/mcp/v1/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' },
    body: new Uint8Array(MCP_REQUEST_BYTES + 1),
  });
  assert.equal((await app.request(unauthenticated)).status, 401);
  assert.equal(unauthenticated.bodyUsed, false, 'legacy auth failure never consumes or allocates the JSON body');
  const malformed = await app.request('/api/mcp/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const initialize = await app.request('/api/mcp/v1/initialize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(initialize.status, 200);
});
