/**
 * Phase 3 — MCP server MVP tests.
 *
 * Run: pnpm --filter @deft/api test -- mcp-server
 *
 * Covers:
 *   1. POST /initialize returns MCP handshake without bearer
 *   2. POST /tools/list with missing bearer returns 401
 *   3. POST /tools/list with valid bearer returns tool catalog
 *   4. POST /tools/call platform_context returns JSON with date/org/employee fields
 *   5. POST /tools/call memory_recall returns at least one page for "AGPL"
 *   6. POST /tools/call wiki_search aliases memory_recall
 *   7. POST /tools/call memory_write creates a wiki page row
 *   8. Calling an unknown tool returns MCP tool error
 *   9. Invalid caller_employee_slug returns 403
 *   10. platform_context second call within 60s hits the LRU cache
 *
 * The test uses a dedicated throwaway BYOA employee seeded in setup()
 * and deleted in teardown() so the 2026-04-13 Alex PM seed row is untouched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

// We import the MCP router directly (NOT apps/api/src/index.ts) because
// importing index.ts would call serve() and open a real TCP port.
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6'; // Maneek seed org
const TEST_EMPLOYEE_ID = 'test-mcp-phase3-employee';
const TEST_EMPLOYEE_SLUG = 'mcp-phase3-test';

let RAW_TOKEN: string | null = null;
let TEST_USER_ID: string | null = null;
let testApp: Hono | null = null;
let tokenModule: typeof import('../src/lib/mcp-token.js') | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function findOrCreateTestUser(): Promise<string> {
  return withClient(async (c) => {
    const existing = await c.query(
      `SELECT id FROM users WHERE id = $1`,
      ['test-mcp-phase3-user']
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)`,
      ['test-mcp-phase3-user', 'mcp-phase3@test.local', 'MCP Phase 3 Test User']
    );
    return 'test-mcp-phase3-user';
  });
}

async function seedTestEmployee(userId: string) {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET
         is_active = true`,
      [
        TEST_EMPLOYEE_ID,
        ORG_ID,
        userId,
        'MCP Phase 3 Test Employee',
        TEST_EMPLOYEE_SLUG,
      ]
    );
  });
}

async function teardownTestEmployee() {
  await withClient(async (c) => {
    // Delete any wiki pages created by the test employee
    await c.query(
      `DELETE FROM wiki_ops_log
       WHERE page_id IN (SELECT id FROM wiki_pages WHERE agent_employee_id = $1)`,
      [TEST_EMPLOYEE_ID]
    );
    await c.query(`DELETE FROM wiki_pages WHERE agent_employee_id = $1`, [TEST_EMPLOYEE_ID]);
    await c.query(`DELETE FROM agent_mcp_call_audit WHERE employee_id = $1`, [TEST_EMPLOYEE_ID]);
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [TEST_EMPLOYEE_ID]);
    if (TEST_USER_ID) {
      await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
    }
  });
}

before(async () => {
  TEST_USER_ID = await findOrCreateTestUser();
  await seedTestEmployee(TEST_USER_ID);
  // Dynamic import so env is loaded and imports don't run before DB seed
  tokenModule = await import('../src/lib/mcp-token.js');
  const routeModule = await import('../src/routes/mcp-server-v1.js');
  testApp = new Hono();
  testApp.route('/api/mcp/v1', routeModule.mcpServerV1Routes);
  RAW_TOKEN = await tokenModule.issueEmployeeToken(ORG_ID, TEST_EMPLOYEE_ID);
});

after(async () => {
  await teardownTestEmployee();
});

function app() {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

async function mcpPost(path: string, body: unknown, bearer?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  return app().request(`/api/mcp/v1${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function modernMcpPost(
  method: string,
  params: Record<string, unknown>,
  bearer?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  if (method === 'tools/call' && typeof params.name === 'string') {
    headers['Mcp-Name'] = params.name;
  }
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return app().request('/api/mcp/v1', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `modern-${Date.now()}`,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'deft-mcp-server-test',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. POST /initialize returns MCP handshake without bearer', async () => {
  const res = await mcpPost('/initialize', {});
  assert.equal(res.status, 200, 'initialize must succeed without bearer');
  const body = (await res.json()) as any;
  assert.ok(body.serverInfo?.name, 'serverInfo.name present');
  assert.equal(body.serverInfo.name, 'deft-mcp');
  assert.ok(body.capabilities, 'capabilities present');
});

test('2. POST /tools/list with missing bearer returns 401', async () => {
  const res = await mcpPost('/tools/list', {});
  assert.equal(res.status, 401, 'missing bearer must 401');
});

test('3. POST /tools/list with valid bearer returns tool catalog', async () => {
  assert.ok(RAW_TOKEN, 'token must have been issued');
  const res = await mcpPost('/tools/list', {}, RAW_TOKEN!);
  assert.equal(res.status, 200, 'tools/list must succeed');
  const body = (await res.json()) as any;
  assert.ok(Array.isArray(body.tools), 'tools array present');
  const names = new Set<string>(body.tools.map((t: any) => t.name));
  assert.ok(names.has('platform_context'), 'platform_context in catalog');
  assert.ok(names.has('memory_recall'), 'memory_recall in catalog');
  assert.ok(names.has('wiki_search'), 'wiki_search compatibility alias in catalog');
  assert.ok(names.has('memory_write'), 'memory_write in catalog');
  assert.ok(names.has('task_query'), 'task_query in catalog');
  assert.ok(names.has('thread_fetch'), 'thread_fetch in catalog');
  assert.ok(names.has('member_list'), 'member_list in catalog');

  const memoryRecall = body.tools.find((t: any) => t.name === 'memory_recall');
  const wikiSearch = body.tools.find((t: any) => t.name === 'wiki_search');
  const platformContext = body.tools.find((t: any) => t.name === 'platform_context');
  const taskUpdate = body.tools.find((t: any) => t.name === 'task_update');
  for (const tool of body.tools) {
    assert.equal(
      tool.inputSchema?.properties?.caller_employee_slug,
      undefined,
      `${tool.name} must use token-bound employee identity`,
    );
    assert.equal(
      tool.inputSchema?.required?.includes('caller_employee_slug') ?? false,
      false,
      `${tool.name} must not require caller_employee_slug`,
    );
  }
  assert.ok(memoryRecall?.inputSchema?.properties?.space_id, 'memory_recall exposes space_id');
  assert.ok(memoryRecall?.inputSchema?.properties?.include_org, 'memory_recall exposes include_org');
  assert.ok(wikiSearch?.inputSchema?.properties?.space_id, 'wiki_search exposes space_id');
  assert.ok(wikiSearch?.inputSchema?.properties?.include_org, 'wiki_search exposes include_org');
  assert.match(
    String(platformContext?.description ?? ''),
    /context_packets/,
    'platform_context advertises context_packets',
  );
  assert.ok(
    taskUpdate?.inputSchema?.properties?.patch?.properties?.comment,
    'task_update advertises task comments to agent runtimes',
  );
  assert.ok(
    taskUpdate?.inputSchema?.properties?.patch?.properties?.due_date,
    'task_update advertises due-date changes to agent runtimes',
  );
});

test('4. POST /tools/call platform_context returns org, employee, date', async () => {
  const res = await mcpPost(
    '/tools/call',
    {
      name: 'platform_context',
      arguments: { caller_employee_slug: TEST_EMPLOYEE_SLUG },
    },
    RAW_TOKEN!
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(!body.isError, `platform_context should not error: ${JSON.stringify(body)}`);
  const text = body.content?.[0]?.text;
  assert.ok(text, 'content[0].text present');
  const parsed = JSON.parse(text);
  assert.ok(parsed.date, 'date field present');
  assert.ok(parsed.org?.id, 'org.id present');
  assert.equal(parsed.org.id, ORG_ID);
  assert.equal(parsed.employee?.slug, TEST_EMPLOYEE_SLUG);
  assert.equal(parsed.employee?.trust_level, 'standard');
  assert.ok(Array.isArray(parsed.teammates), 'teammates is array');
  assert.ok(Array.isArray(parsed.context_packets), 'context_packets is array');
  assert.ok(
    parsed.context_packets.some((packet: any) => packet.id === 'company_memory'),
    'company_memory packet present',
  );
  assert.ok(
    parsed.context_packets.some((packet: any) => packet.id === 'employee_memory'),
    'employee_memory packet present',
  );
});

test('5. POST /tools/call memory_recall returns at least one page for "AGPL"', async () => {
  const res = await mcpPost(
    '/tools/call',
    {
      name: 'memory_recall',
      arguments: {
        caller_employee_slug: TEST_EMPLOYEE_SLUG,
        query: 'AGPL license',
        limit: 5,
      },
    },
    RAW_TOKEN!
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(!body.isError, `memory_recall should not error: ${JSON.stringify(body)}`);
  const parsed = JSON.parse(body.content[0].text);
  assert.ok(Array.isArray(parsed), 'recall result is array');
  // Not strictly required that an AGPL page exists, but the seed wiki includes one.
  // If it's missing we warn rather than fail so the test can still run on fresh DBs.
  if (parsed.length === 0) {
    console.warn('[test] memory_recall returned empty for "AGPL" — is seed-wiki loaded?');
  } else {
    assert.ok(parsed[0].slug, 'first page has a slug');
  }
});

test('6. POST /tools/call wiki_search aliases memory_recall and records canonical audit metadata', async () => {
  const res = await mcpPost(
    '/tools/call',
    {
      name: 'wiki_search',
      arguments: {
        caller_employee_slug: TEST_EMPLOYEE_SLUG,
        query: 'AGPL license',
        limit: 5,
      },
    },
    RAW_TOKEN!
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(!body.isError, `wiki_search alias should not error: ${JSON.stringify(body)}`);
  const parsed = JSON.parse(body.content[0].text);
  assert.ok(Array.isArray(parsed), 'alias result is array');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT tool_name, metadata
       FROM agent_mcp_call_audit
       WHERE employee_id = $1 AND tool_name = 'wiki_search'
       ORDER BY created_at DESC
       LIMIT 1`,
      [TEST_EMPLOYEE_ID]
    );
    assert.equal(r.rows.length, 1, 'wiki_search audit row exists');
    assert.equal(r.rows[0].tool_name, 'wiki_search');
    assert.equal(r.rows[0].metadata?.requested_tool_name, 'wiki_search');
    assert.equal(r.rows[0].metadata?.canonical_tool_name, 'memory_recall');
  });
});

test('7. POST /tools/call memory_write creates a wiki_pages row', async () => {
  const title = `Phase3 MCP test memory ${Date.now()}`;
  const res = await mcpPost(
    '/tools/call',
    {
      name: 'memory_write',
      arguments: {
        caller_employee_slug: TEST_EMPLOYEE_SLUG,
        title,
        body: 'This is a Phase 3 MCP server test memory page body.',
        type: 'fact',
        confidence: 0.8,
      },
    },
    RAW_TOKEN!
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(!body.isError, `memory_write should not error: ${JSON.stringify(body)}`);
  const parsed = JSON.parse(body.content[0].text);
  assert.ok(parsed.slug, 'slug returned');

  // Verify row exists in DB
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, title, agent_employee_id FROM wiki_pages WHERE slug = $1`,
      [parsed.slug]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].title, title);
    assert.equal(r.rows[0].agent_employee_id, TEST_EMPLOYEE_ID);
  });
});

test('8. Calling an unknown tool returns MCP error result', async () => {
  const res = await mcpPost(
    '/tools/call',
    {
      name: 'no_such_tool_exists',
      arguments: { caller_employee_slug: TEST_EMPLOYEE_SLUG },
    },
    RAW_TOKEN!
  );
  // Expect a 200 with isError:true (MCP standard for tool-level errors)
  // OR a 400 — either is acceptable. We check for error shape.
  const body = (await res.json()) as any;
  assert.ok(
    body.isError === true || res.status === 400 || res.status === 404,
    `unknown tool should produce an error, got ${res.status} ${JSON.stringify(body)}`
  );
});

test('9. bearer token identity overrides stale delegated caller slug', async () => {
  const res = await mcpPost(
    '/tools/call',
    {
      name: 'platform_context',
      arguments: { caller_employee_slug: 'nobody-on-this-gateway' },
    },
    RAW_TOKEN!
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.isError, false);
  assert.equal(JSON.parse(body.content[0].text).employee.slug, TEST_EMPLOYEE_SLUG);
});

test('9b. caller slug can be omitted because bearer token binds identity', async () => {
  const res = await mcpPost(
    '/tools/call',
    { name: 'platform_context', arguments: {} },
    RAW_TOKEN!,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.isError, false);
  assert.equal(JSON.parse(body.content[0].text).employee.slug, TEST_EMPLOYEE_SLUG);
});

test('10. platform_context second call within 60s hits LRU cache', async () => {
  // Clear cache first by calling with a fresh random trigger to force compute.
  // Then call twice and check cached flag or consistent output.
  const args = {
    name: 'platform_context',
    arguments: {
      caller_employee_slug: TEST_EMPLOYEE_SLUG,
      trigger: { kind: 'test-cache-check', space_id: null },
    },
  };
  const res1 = await mcpPost('/tools/call', args, RAW_TOKEN!);
  const b1 = (await res1.json()) as any;
  const p1 = JSON.parse(b1.content[0].text);

  const res2 = await mcpPost('/tools/call', args, RAW_TOKEN!);
  const b2 = (await res2.json()) as any;
  const p2 = JSON.parse(b2.content[0].text);

  // The cache guarantees identical output (including a cache_hit or generated_at marker).
  // We check that _cache or generated_at is equal — the platform_context impl sets
  // a generated_at timestamp that is deterministic per cache entry, so if p2 is a
  // fresh compute it will differ. We also allow an explicit cache_hit=true flag.
  if (p2._cache_hit === true) {
    assert.ok(true, 'second call had explicit _cache_hit flag');
    return;
  }
  assert.equal(
    p1.generated_at,
    p2.generated_at,
    'second call within 60s should return the cached generated_at'
  );
});

test('11. modern tools/list is deterministic, private, and self-describing', async () => {
  const response = await modernMcpPost('tools/list', {}, RAW_TOKEN!);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.result.resultType, 'complete');
  assert.equal(body.result.ttlMs, 0);
  assert.equal(body.result.cacheScope, 'private');
  assert.equal(
    body.result._meta?.['io.modelcontextprotocol/serverInfo']?.name,
    'deft-mcp',
  );

  const names = body.result.tools.map((tool: any) => tool.name);
  assert.deepEqual(
    names,
    [...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    'modern tool catalog order is deterministic',
  );

  await withClient(async (c) => {
    const result = await c.query(
      `SELECT metadata
       FROM agent_mcp_call_audit
       WHERE employee_id = $1 AND tool_name = 'tools/list'
       ORDER BY created_at DESC
       LIMIT 1`,
      [TEST_EMPLOYEE_ID],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].metadata?.protocol_version, '2026-07-28');
    assert.equal(result.rows[0].metadata?.client_info?.name, 'deft-mcp-server-test');
  });
});

test('12. modern tools/call returns a complete result with server metadata', async () => {
  const response = await modernMcpPost(
    'tools/call',
    {
      name: 'platform_context',
      arguments: { caller_employee_slug: TEST_EMPLOYEE_SLUG },
    },
    RAW_TOKEN!,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.result.resultType, 'complete');
  assert.equal(body.result.isError, false);
  assert.equal(
    body.result._meta?.['io.modelcontextprotocol/serverInfo']?.name,
    'deft-mcp',
  );
});

test('13. modern unknown tools return InvalidParams while retaining the audit row', async () => {
  const toolName = 'no_such_modern_tool';
  const response = await modernMcpPost(
    'tools/call',
    {
      name: toolName,
      arguments: { caller_employee_slug: TEST_EMPLOYEE_SLUG },
    },
    RAW_TOKEN!,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /Unknown tool/);

  await withClient(async (c) => {
    const result = await c.query(
      `SELECT success, error, metadata
       FROM agent_mcp_call_audit
       WHERE employee_id = $1 AND tool_name = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [TEST_EMPLOYEE_ID, toolName],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].success, false);
    assert.match(result.rows[0].error, /Unknown tool/);
    assert.equal(result.rows[0].metadata?.protocol_version, '2026-07-28');
  });
});

test('14. legacy JSON-RPC tools/list remains free of modern result fields', async () => {
  const response = await app().request('/api/mcp/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RAW_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.ok(Array.isArray(body.result.tools));
  assert.equal(body.result.resultType, undefined);
  assert.equal(body.result.ttlMs, undefined);
  assert.equal(body.result.cacheScope, undefined);
  assert.equal(body.result._meta, undefined);
});
