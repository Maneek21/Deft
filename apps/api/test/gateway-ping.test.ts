/**
 * Phase 11 — gateway-ping handler tests.
 *
 * The gateway-ping worker groups OpenClaw employees by connection_url,
 * fires ONE GET /v1/models per Gateway, and updates every employee in the
 * group based on the outcome. Three consecutive failures flip the employee
 * from 'connected' to 'error'; a success resets the fail counter.
 *
 * Covers:
 *   1. grouping — two employees sharing a connection_url → 1 fetch call
 *   2. first failure keeps connection_status='connected', increments counter
 *   3. third consecutive failure flips connection_status='error'
 *   4. native employees are never pinged and never touched
 *   5. provider_instances.last_status_check_at is updated on success
 *
 * Run: pnpm --filter @deft/api test -- gateway-ping
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { encrypt } from '../src/lib/encryption.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

type Fixture = {
  orgId: string;
  userId: string;
  empIds: string[];
  providerInstanceIds: string[];
};

async function seedEmployees(opts: {
  connectionUrl: string | null;
  count: number;
  kind?: 'openclaw' | 'native';
  connectionStatus?: 'pending' | 'connected' | 'error' | 'revoked';
  gatewayPingFailCount?: number;
  tokenPlain?: string;
}): Promise<Fixture> {
  const orgId = crypto.randomUUID();
  const userId = `gwping-user-${crypto.randomUUID()}`;
  const empIds: string[] = [];
  const tokenEnc = opts.tokenPlain ? encrypt(opts.tokenPlain) : null;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Gateway Ping Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );

    for (let i = 0; i < opts.count; i++) {
      const id = `gwping-emp-${crypto.randomUUID()}`;
      empIds.push(id);
      await c.query(
        `INSERT INTO agent_employees
           (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
            kind, connection_url, gateway_token_encrypted, connection_status,
            gateway_ping_fail_count, is_active, created_by)
         VALUES
           ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
            $6, $7, $8, $9, $10, true, $3)`,
        [
          id,
          orgId,
          userId,
          `gwping-emp-${i}`,
          id,
          opts.kind ?? 'openclaw',
          opts.connectionUrl,
          tokenEnc,
          opts.connectionStatus ?? 'connected',
          opts.gatewayPingFailCount ?? 0,
        ],
      );
    }
  });

  return { orgId, userId, empIds, providerInstanceIds: [] };
}

async function teardown(fx: Fixture): Promise<void> {
  await withClient(async (c) => {
    if (fx.providerInstanceIds.length > 0) {
      await c.query(
        `DELETE FROM provider_instances WHERE id = ANY($1::text[])`,
        [fx.providerInstanceIds],
      );
    }
    if (fx.empIds.length > 0) {
      await c.query(
        `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
        [fx.empIds],
      );
    }
    await c.query(`DELETE FROM users WHERE id = $1`, [fx.userId]);
  });
}

async function selectEmployees(ids: string[]): Promise<any[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, connection_status, connection_error, gateway_ping_fail_count,
              last_gateway_ping_at, kind
       FROM agent_employees
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [ids],
    );
    return r.rows;
  });
}

function mockFetch(
  responder: (url: string) => Promise<Response> | Response,
  urlFilter?: string,
): {
  restore: () => void;
  calls: string[];
  filteredCalls: () => string[];
} {
  const calls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    calls.push(url);
    return responder(url);
  };
  return {
    calls,
    filteredCalls: () =>
      urlFilter ? calls.filter((u) => u.startsWith(urlFilter)) : calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. success grouping: two employees sharing a connection_url = one fetch, both flip to connected', async () => {
  const gatewayUrl = `http://127.0.0.1:47001-${Date.now()}`;
  const fx = await seedEmployees({
    connectionUrl: gatewayUrl,
    count: 2,
    connectionStatus: 'pending',
    gatewayPingFailCount: 1,
    tokenPlain: 'test-gateway-token-group',
  });

  // We share the global handler with every other openclaw row in the DB, so
  // we only assert on calls to *our* gateway URL and on *our* seeded employees.
  const fetchMock = mockFetch(() => okResponse(), gatewayUrl);
  try {
    const { handleGatewayPing } = await import('../src/workers/handlers/gateway-ping.js');
    await handleGatewayPing({ id: 'job-1', name: 'gateway-ping', data: {} });

    // Exactly one /v1/models call FOR OUR GATEWAY.
    const ourCalls = fetchMock.filteredCalls();
    assert.equal(ourCalls.length, 1, `expected 1 fetch to our gateway, got ${ourCalls.length}`);
    assert.ok(
      ourCalls[0]!.endsWith('/v1/models'),
      `fetch should hit /v1/models, got ${ourCalls[0]}`,
    );

    const rows = await selectEmployees(fx.empIds);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.connection_status, 'connected');
      assert.equal(row.gateway_ping_fail_count, 0);
      assert.equal(row.connection_error, null);
      assert.ok(row.last_gateway_ping_at, 'last_gateway_ping_at should be set');
    }
  } finally {
    fetchMock.restore();
    await teardown(fx);
  }
});

test('2. first failure keeps connection_status=connected, increments fail counter', async () => {
  const gatewayUrl = `http://127.0.0.1:47002-${Date.now()}`;
  const fx = await seedEmployees({
    connectionUrl: gatewayUrl,
    count: 1,
    connectionStatus: 'connected',
    gatewayPingFailCount: 0,
    tokenPlain: 'test-gateway-token-fail1',
  });

  // Only reject for OUR gateway. Any other openclaw rows in the DB still
  // resolve OK so they don't pollute this test.
  const fetchMock = mockFetch((url) => {
    if (url.startsWith(gatewayUrl)) throw new Error('connection refused');
    return okResponse();
  });
  try {
    const { handleGatewayPing } = await import('../src/workers/handlers/gateway-ping.js');
    await handleGatewayPing({ id: 'job-2', name: 'gateway-ping', data: {} });

    const [row] = await selectEmployees(fx.empIds);
    assert.equal(row.connection_status, 'connected', 'should stay connected after 1 failure');
    assert.equal(row.gateway_ping_fail_count, 1);
    assert.ok(row.last_gateway_ping_at, 'last_gateway_ping_at should be set');
  } finally {
    fetchMock.restore();
    await teardown(fx);
  }
});

test('3. third consecutive failure flips connection_status to error', async () => {
  const gatewayUrl = `http://127.0.0.1:47003-${Date.now()}`;
  const fx = await seedEmployees({
    connectionUrl: gatewayUrl,
    count: 1,
    connectionStatus: 'connected',
    gatewayPingFailCount: 2, // next failure is the 3rd
    tokenPlain: 'test-gateway-token-fail3',
  });

  const fetchMock = mockFetch((url) => {
    if (url.startsWith(gatewayUrl)) throw new Error('ECONNREFUSED 127.0.0.1:47003');
    return okResponse();
  });
  try {
    const { handleGatewayPing } = await import('../src/workers/handlers/gateway-ping.js');
    await handleGatewayPing({ id: 'job-3', name: 'gateway-ping', data: {} });

    const [row] = await selectEmployees(fx.empIds);
    assert.equal(row.connection_status, 'error');
    assert.equal(row.gateway_ping_fail_count, 3);
    assert.ok(
      row.connection_error && row.connection_error.length > 0,
      `connection_error should be set, got ${row.connection_error}`,
    );
  } finally {
    fetchMock.restore();
    await teardown(fx);
  }
});

test('4. native employees are ignored — no fetch, no status change', async () => {
  const gatewayUrl = `http://127.0.0.1:47004-${Date.now()}`;
  const fx = await seedEmployees({
    connectionUrl: gatewayUrl,
    count: 1,
    kind: 'native',
    connectionStatus: 'connected',
    gatewayPingFailCount: 0,
  });

  // Only assert on calls to OUR gateway URL.
  const fetchMock = mockFetch(() => okResponse(), gatewayUrl);
  try {
    const { handleGatewayPing } = await import('../src/workers/handlers/gateway-ping.js');
    await handleGatewayPing({ id: 'job-4', name: 'gateway-ping', data: {} });

    const ourCalls = fetchMock.filteredCalls();
    assert.equal(
      ourCalls.length,
      0,
      `native employee should not trigger a fetch to its url, got ${ourCalls.length}`,
    );

    const [row] = await selectEmployees(fx.empIds);
    assert.equal(row.kind, 'native');
    assert.equal(row.connection_status, 'connected');
    assert.equal(row.gateway_ping_fail_count, 0);
    assert.equal(row.last_gateway_ping_at, null);
  } finally {
    fetchMock.restore();
    await teardown(fx);
  }
});

test('5. provider_instances.last_status_check_at is updated on success', async () => {
  const gatewayUrl = `http://127.0.0.1:47005-${Date.now()}`;
  const fx = await seedEmployees({
    connectionUrl: gatewayUrl,
    count: 1,
    connectionStatus: 'connected',
    gatewayPingFailCount: 0,
    tokenPlain: 'test-gateway-token-pi',
  });

  // Seed a provider_instances row pointing at the employee.
  const piId = `gwping-pi-${crypto.randomUUID()}`;
  fx.providerInstanceIds.push(piId);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO provider_instances
         (id, org_id, employee_id, provider, status, last_status_check_at)
       VALUES ($1, $2, $3, 'byo', 'running', NULL)`,
      [piId, fx.orgId, fx.empIds[0]],
    );
  });

  const fetchMock = mockFetch(() => okResponse());
  try {
    const { handleGatewayPing } = await import('../src/workers/handlers/gateway-ping.js');
    await handleGatewayPing({ id: 'job-5', name: 'gateway-ping', data: {} });

    const piRow = await withClient(async (c) => {
      const r = await c.query(
        `SELECT last_status_check_at FROM provider_instances WHERE id = $1`,
        [piId],
      );
      return r.rows[0];
    });
    assert.ok(
      piRow.last_status_check_at != null,
      'provider_instances.last_status_check_at should be set after a successful ping',
    );
  } finally {
    fetchMock.restore();
    await teardown(fx);
  }
});
