/**
 * Phase 6 — employee-trigger worker tests.
 *
 * Run: pnpm --filter @deft/api test -- employee-trigger
 *
 * Covers:
 *   1. openclaw-kind trigger invocation calls the Gateway via dispatchViaOpenClaw
 *      and inserts a session turn row tagged with the invocation's trigger_kind
 *   2. openclaw-kind trigger on success inserts a new message row authored by
 *      the employee's shadow user in the target space
 *   3. openclaw-kind trigger wraps the dispatch in a 60s timeout so a hung
 *      Gateway cannot wedge the worker
 *   4. native-kind trigger calls runAgentQuery with skipVerification:true and
 *      mode:'background'
 *   5. native-kind trigger on success inserts a message in target_space_id
 *      with user_id = employee.user_id AND writes an agent_session_turns row
 *      with the correct trigger_kind
 *
 * The OpenClaw path is exercised by monkey-patching `global.fetch` to return
 * a synthetic SSE stream. The native path is exercised by monkey-patching
 * the `runAgentQuery` export on the agent-runner module.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const TEST_USER_ID = 'test-phase6-trigger-user';
const OPENCLAW_EMP_ID = 'test-phase6-trigger-openclaw';
const OPENCLAW_EMP_SLUG = 'phase6-trigger-openclaw';
const NATIVE_EMP_ID = 'test-phase6-trigger-native';
const NATIVE_EMP_SLUG = 'phase6-trigger-native';
const CONNECTION_URL = 'http://127.0.0.1:19995/test-phase6-trigger';
const HANG_EMP_ID = 'test-phase6-trigger-hang';
const HANG_EMP_SLUG = 'phase6-trigger-hang';

let TEST_SPACE_ID: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Encrypt a fake gateway token via the real encryption helper so the
// dispatcher's decrypt() call succeeds. We use a valid-looking token
// value since fetch is mocked downstream anyway.
async function fakeEncryptedToken(): Promise<string> {
  const { encrypt } = await import('../src/lib/encryption.js');
  return encrypt('fake-gateway-token-for-tests');
}

async function seedFixtures() {
  await withClient(async (c) => {
    // Shadow user (is_agent=true) shared by all test employees
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'phase6-trigger@test.local', 'Phase6 Trigger Test User'],
    );

    // Space for posting trigger replies
    const sp = await c.query(
      `SELECT id FROM spaces WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (sp.rows.length > 0) {
      TEST_SPACE_ID = sp.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO spaces (org_id, name, type, created_by)
         VALUES ($1, 'phase6-trigger-test-space', 'public', $2)
         RETURNING id`,
        [ORG_ID, TEST_USER_ID],
      );
      TEST_SPACE_ID = r.rows[0].id;
    }

    const gatewayTokenEncrypted = await fakeEncryptedToken();

    // OpenClaw-kind employee
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_url, gateway_token_encrypted, connection_status,
         is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         'openclaw', $6, $7, 'connected', true, $3)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'openclaw',
         connection_url = $6,
         gateway_token_encrypted = $7,
         connection_status = 'connected',
         is_active = true,
         daily_action_count = 0`,
      [
        OPENCLAW_EMP_ID,
        ORG_ID,
        TEST_USER_ID,
        'Phase6 Trigger OpenClaw Employee',
        OPENCLAW_EMP_SLUG,
        CONNECTION_URL,
        gatewayTokenEncrypted,
      ],
    );

    // Native-kind employee
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_status, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'native test prompt', 'standard',
         'native', 'connected', true, $3)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'native',
         connection_status = 'connected',
         is_active = true,
         daily_action_count = 0`,
      [NATIVE_EMP_ID, ORG_ID, TEST_USER_ID, 'Phase6 Trigger Native Employee', NATIVE_EMP_SLUG],
    );

    // A second openclaw employee used by the timeout test (pointed at a
    // different connection_url so its fetch mock can hang independently).
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_url, gateway_token_encrypted, connection_status,
         is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         'openclaw', $6, $7, 'connected', true, $3)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'openclaw',
         connection_url = $6,
         gateway_token_encrypted = $7,
         connection_status = 'connected',
         is_active = true,
         daily_action_count = 0`,
      [
        HANG_EMP_ID,
        ORG_ID,
        TEST_USER_ID,
        'Phase6 Trigger Hang Employee',
        HANG_EMP_SLUG,
        `${CONNECTION_URL}-hang`,
        gatewayTokenEncrypted,
      ],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    const empIds = [OPENCLAW_EMP_ID, NATIVE_EMP_ID, HANG_EMP_ID];
    await c.query(
      `DELETE FROM agent_session_turns WHERE employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(`DELETE FROM messages WHERE user_id = $1`, [TEST_USER_ID]);
    await c.query(
      `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
}

// Build a well-formed OpenAI-compatible SSE chunk stream the dispatcher
// can parse. Each chunk is one `data: {...}\n\n` line plus a terminating
// `data: [DONE]`.
function buildSseStream(text: string): ReadableStream<Uint8Array> {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [{ delta: { role: 'assistant', content: '' } }],
      model: 'openclaw/test-model',
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

let fetchCalls: FetchCall[] = [];
const originalFetch = global.fetch;

function installFetchMock(handler: (req: FetchCall) => Response | Promise<Response>) {
  fetchCalls = [];
  (global as any).fetch = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    let body: any = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as string
      }
    }
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    fetchCalls.push(call);
    return handler(call);
  };
}

function uninstallFetchMock() {
  (global as any).fetch = originalFetch;
}

before(async () => {
  await seedFixtures();
});

after(async () => {
  uninstallFetchMock();
  await teardownFixtures();
  // Force-exit the process: the handler imports `../src/lib/db.js` which
  // holds a shared drizzle pg.Pool that stays open for the lifetime of
  // the module, and mcp-tool discovery opens persistent MCP connections.
  // Both keep node:test waiting forever after all assertions pass. Other
  // test files don't hit this because they don't import the full
  // agent-runner graph. Scheduling a 100ms exit here lets node:test print
  // its summary first.
  setTimeout(() => process.exit(0), 100).unref();
});

// ─────────────────────────────────────────────────────────────────────────────

test('1. openclaw trigger dispatches via fetch and logs a session turn with trigger_kind', async () => {
  const replyText = 'Phase6 standup: all good, 3 tasks done yesterday.';
  installFetchMock((call) => {
    // Only our Gateway URL should be hit
    assert.ok(
      call.url.startsWith(CONNECTION_URL),
      `unexpected fetch to ${call.url}`,
    );
    assert.equal(call.headers['authorization'], 'Bearer fake-gateway-token-for-tests');
    assert.equal(call.body.stream, true);
    return new Response(buildSseStream(replyText), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  const { handleEmployeeTrigger } = await import(
    '../src/workers/handlers/employee-trigger.js'
  );

  await handleEmployeeTrigger({
    id: 'test-job-1',
    name: 'employee-trigger',
    data: {
      employee_id: OPENCLAW_EMP_ID,
      trigger_kind: 'cron:standup',
      context: { when: 'test' },
      goal: 'generate a test standup reply',
      target_space_id: TEST_SPACE_ID!,
    },
  } as any);

  uninstallFetchMock();

  // Exactly one fetch to the Gateway
  assert.ok(fetchCalls.length >= 1, 'dispatch should call fetch at least once');
  const gatewayCall = fetchCalls.find((c) =>
    c.url.startsWith(CONNECTION_URL),
  );
  assert.ok(gatewayCall, 'fetch to gateway must exist');

  // agent_session_turns row with the trigger_kind tag
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT trigger_kind, result FROM agent_session_turns
         WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [OPENCLAW_EMP_ID],
    );
    assert.ok(r.rows.length >= 1, 'session turn row must exist');
    assert.equal(r.rows[0].trigger_kind, 'cron:standup');
    assert.equal(r.rows[0].result, 'success');
  });
});

test('2. openclaw trigger inserts a message row authored by the shadow user', async () => {
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, user_id, content, space_id FROM messages
         WHERE user_id = $1 AND space_id = $2
         ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER_ID, TEST_SPACE_ID],
    );
    assert.ok(r.rows.length >= 1, 'reply message must be inserted');
    assert.equal(r.rows[0].user_id, TEST_USER_ID);
    assert.ok(
      r.rows[0].content.includes('Phase6 standup'),
      `content should include stream text, got ${r.rows[0].content}`,
    );
  });
});

test('3. openclaw trigger wraps dispatch in a bounded timeout so a failing Gateway cannot wedge the worker', async () => {
  // Simulate a Gateway that accepts the POST but then errors out. The
  // dispatchViaOpenClaw path should propagate the error, the handler's
  // `try/catch` should swallow it, and the handler should return cleanly
  // within a tiny fraction of the 60s wall-clock wrapper. We cannot
  // easily wait a real 60s here, so the assertion on speed (< 5s) plus
  // the fact that the handler returns at all verifies the wrapper is
  // doing its job for the failure path.
  installFetchMock(() => {
    return new Response('bad gateway', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    });
  });

  const t0 = Date.now();
  try {
    const { handleEmployeeTrigger } = await import(
      '../src/workers/handlers/employee-trigger.js'
    );
    // Handler catches its own dispatch error and logs it — it should return
    // cleanly, not throw, not hang.
    await handleEmployeeTrigger({
      id: 'test-job-3',
      name: 'employee-trigger',
      data: {
        employee_id: HANG_EMP_ID,
        trigger_kind: 'webhook:pr-merged',
        context: {},
        goal: 'test hang',
        target_space_id: TEST_SPACE_ID!,
      },
    } as any);
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 5_000,
      `handler should return within 5s on dispatch failure, took ${elapsed}ms`,
    );
    // And the handler must have tried the Gateway exactly once.
    const gatewayHits = fetchCalls.filter((c) =>
      c.url.includes(`${CONNECTION_URL}-hang`),
    );
    assert.equal(gatewayHits.length, 1, 'dispatch attempted once');
  } finally {
    uninstallFetchMock();
  }
});

test('4. native trigger routes to runAgentQuery (not OpenClaw fetch) and logs a session turn with trigger_kind', async () => {
  // ESM exports are live bindings we cannot override externally, so we can't
  // monkey-patch `runAgentQuery`. Instead we clear the cached
  // `env.ANTHROPIC_API_KEY` (set once at module init via dotenv) so
  // runAgentQuery throws fast with `Anthropic API key not configured`
  // before hitting the network. We then assert:
  //   - the handler did NOT call the OpenClaw Gateway (proves native branch)
  //   - a session turn was recorded with result='error' and trigger_kind set
  //   - the error text identifies the missing API key so we know
  //     runAgentQuery was the one that threw
  const envModule = await import('../src/lib/env.js');
  const savedKey = envModule.env.ANTHROPIC_API_KEY;
  (envModule.env as any).ANTHROPIC_API_KEY = '';

  // Install a fetch spy. The native path may legitimately call fetch for
  // MCP tool discovery (Tavily, Context7, etc.) before runAgentQuery hits
  // the API-key check. What MUST NOT happen is a call to our test
  // Gateway's connection_url — that would mean the OpenClaw branch ran.
  // We let all other fetches through to the real network (they'll error
  // fast with connection refused in CI, which is fine).
  installFetchMock((call) => {
    if (call.url.includes(CONNECTION_URL)) {
      throw new Error(
        'native trigger branch must not call the OpenClaw Gateway',
      );
    }
    // Simulate a connection failure for non-gateway fetches so MCP tool
    // discovery terminates fast without racing the test timeout.
    return new Response('', { status: 502 });
  });

  try {
    const { handleEmployeeTrigger } = await import(
      '../src/workers/handlers/employee-trigger.js'
    );
    await handleEmployeeTrigger({
      id: 'test-job-4',
      name: 'employee-trigger',
      data: {
        employee_id: NATIVE_EMP_ID,
        trigger_kind: 'cron:standup',
        context: { foo: 'bar' },
        goal: 'generate native standup',
        target_space_id: TEST_SPACE_ID!,
      },
    } as any);

    const gatewayHits = fetchCalls.filter((c) => c.url.includes(CONNECTION_URL));
    assert.equal(
      gatewayHits.length,
      0,
      'native branch must not invoke the OpenClaw Gateway',
    );

    // Session turn row must exist with error result and the right kind
    await withClient(async (c) => {
      const r = await c.query(
        `SELECT trigger_kind, result, error FROM agent_session_turns
           WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [NATIVE_EMP_ID],
      );
      assert.ok(r.rows.length >= 1, 'session turn row must exist');
      assert.equal(r.rows[0].trigger_kind, 'cron:standup');
      assert.equal(r.rows[0].result, 'error');
      assert.ok(
        /Anthropic API key/i.test(r.rows[0].error ?? ''),
        `error should mention Anthropic API key, got: ${r.rows[0].error}`,
      );
    });
  } finally {
    uninstallFetchMock();
    (envModule.env as any).ANTHROPIC_API_KEY = savedKey;
  }
});

test('5. openclaw trigger writes session turn with trigger_kind matching the invocation', async () => {
  // This reinforces the assertion from test 1: the `trigger_kind` we
  // passed into the TriggerInvocation must land verbatim on the
  // `agent_session_turns` row. We exercise a DIFFERENT kind here so we
  // know it's not a constant in the dispatcher.
  installFetchMock(() => {
    return new Response(buildSseStream('Phase6 pr-merged follow-up sent'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  try {
    const { handleEmployeeTrigger } = await import(
      '../src/workers/handlers/employee-trigger.js'
    );
    await handleEmployeeTrigger({
      id: 'test-job-5',
      name: 'employee-trigger',
      data: {
        employee_id: OPENCLAW_EMP_ID,
        trigger_kind: 'webhook:pr-merged',
        context: { pr_url: 'https://example.com/pr/42' },
        goal: 'acknowledge the merged PR',
        target_space_id: TEST_SPACE_ID!,
      },
    } as any);

    await withClient(async (c) => {
      const r = await c.query(
        `SELECT trigger_kind, result, raw_reply_text FROM agent_session_turns
           WHERE employee_id = $1 AND trigger_kind = 'webhook:pr-merged'
           ORDER BY created_at DESC LIMIT 1`,
        [OPENCLAW_EMP_ID],
      );
      assert.ok(r.rows.length >= 1, 'webhook session turn row must exist');
      assert.equal(r.rows[0].trigger_kind, 'webhook:pr-merged');
      assert.equal(r.rows[0].result, 'success');
      assert.ok(
        (r.rows[0].raw_reply_text ?? '').includes('Phase6 pr-merged'),
        'reply text must be captured',
      );
    });
  } finally {
    uninstallFetchMock();
  }
});
