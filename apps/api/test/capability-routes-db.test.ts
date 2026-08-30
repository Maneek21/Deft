import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { mcpClientManager, type MCPToolDiscovery } from '@deft/mcp';
import { mcpConnections } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { mcpConnectionRoutes } from '../src/routes/mcp-connections.js';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const OTHER_ORG_ID = '760b7a2b-a4ce-4b75-897c-c86d8e5d8047';
const USER_ID = 'd4f985f6-6c37-4102-a7e8-32e22cfbe962';
const CONNECTION_ID = `phase2-capability-route-${process.pid}`;

const app = new Hono();
let requestOrgId = ORG_ID;
app.use('*', async (c, next) => {
  c.set('user', {
    id: USER_ID,
    email: 'maneek@test.com',
    org_id: requestOrgId,
    role: 'owner',
  });
  return next();
});
app.route('/api/mcp-connections', mcpConnectionRoutes);

const discovered: MCPToolDiscovery = {
  tools: [{
    name: 'mcp__phase2-route__read_status',
    originalName: 'read_status',
    description: 'Read status',
    inputSchema: { type: 'object', properties: {} },
    connectionId: CONNECTION_ID,
    connectionSlug: 'phase2-route',
    isWrite: false,
    approvalTier: 'auto-execute',
    annotations: { readOnlyHint: true },
    rawTool: {
      name: 'read_status',
      description: 'Read status',
      inputSchema: { type: 'object', properties: {} },
    },
  }],
  providerTools: [{
    name: 'read_status',
    description: 'Read status',
    inputSchema: { type: 'object', properties: {} },
  }],
};

before(async () => {
  await db.insert(mcpConnections).values({
    id: CONNECTION_ID,
    org_id: ORG_ID,
    name: 'Phase 2 Route Provider',
    slug: 'phase2-route',
    server_url: 'https://phase2-route.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    default_trust_tier: 'full',
    created_by: USER_ID,
  }).onConflictDoNothing();
});

after(async () => {
  await db.delete(mcpConnections).where(eq(mcpConnections.id, CONNECTION_ID));
});

test('admin test mode preserves response and compatibility-cache writes', async (t) => {
  const original = mcpClientManager.testToolDiscovery;
  let calls = 0;
  mcpClientManager.testToolDiscovery = async (config) => {
    calls++;
    assert.equal(config.connectionId, CONNECTION_ID);
    assert.equal(config.orgId, ORG_ID);
    return discovered;
  };
  t.after(() => { mcpClientManager.testToolDiscovery = original; });

  const response = await app.request(`/api/mcp-connections/${CONNECTION_ID}/test`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    tools_count: 1,
    tools: discovered.tools,
  });
  assert.equal(calls, 1);

  const [stored] = await db.select().from(mcpConnections)
    .where(eq(mcpConnections.id, CONNECTION_ID)).limit(1);
  assert.deepEqual(stored?.tools_cache, discovered.tools);
  assert.ok(stored?.tools_cached_at);
  assert.ok(stored?.last_connected_at);
  assert.equal(stored?.connection_error, null);
});

test('admin refresh mode preserves response and compatibility-cache writes', async (t) => {
  const original = mcpClientManager.discoverToolDiscovery;
  let calls = 0;
  mcpClientManager.discoverToolDiscovery = async (config, receivedOverrides) => {
    calls++;
    assert.equal(config.connectionId, CONNECTION_ID);
    assert.deepEqual(receivedOverrides, []);
    return discovered;
  };
  t.after(() => { mcpClientManager.discoverToolDiscovery = original; });

  const response = await app.request(`/api/mcp-connections/${CONNECTION_ID}/refresh-tools`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    tools_count: 1,
    tools: discovered.tools,
  });
  assert.equal(calls, 1);

  const [stored] = await db.select().from(mcpConnections)
    .where(eq(mcpConnections.id, CONNECTION_ID)).limit(1);
  assert.deepEqual(stored?.tools_cache, discovered.tools);
  assert.ok(stored?.tools_cached_at);
  assert.ok(stored?.last_connected_at);
  assert.equal(stored?.connection_error, null);
});

test('admin discovery failure retains the 502/error persistence contract', async (t) => {
  const original = mcpClientManager.discoverToolDiscovery;
  mcpClientManager.discoverToolDiscovery = async () => {
    throw new Error('phase2 provider unavailable');
  };
  t.after(() => { mcpClientManager.discoverToolDiscovery = original; });

  const response = await app.request(`/api/mcp-connections/${CONNECTION_ID}/refresh-tools`, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    success: false,
    error: 'phase2 provider unavailable',
  });

  const [stored] = await db.select({ connection_error: mcpConnections.connection_error })
    .from(mcpConnections).where(eq(mcpConnections.id, CONNECTION_ID)).limit(1);
  assert.equal(stored?.connection_error, 'phase2 provider unavailable');
});

test('admin discovery cannot resolve another organization provider', async (t) => {
  const original = mcpClientManager.testToolDiscovery;
  let calls = 0;
  mcpClientManager.testToolDiscovery = async () => {
    calls++;
    return discovered;
  };
  t.after(() => { mcpClientManager.testToolDiscovery = original; });
  requestOrgId = OTHER_ORG_ID;
  t.after(() => { requestOrgId = ORG_ID; });

  const response = await app.request(`/api/mcp-connections/${CONNECTION_ID}/test`, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Connection not found', code: 'NOT_FOUND' });
  assert.equal(calls, 0);
});
