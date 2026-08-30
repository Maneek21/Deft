/**
 * Golden coverage for the existing immediate outbound MCP path. Keep this
 * projection unchanged while moving provider mechanics behind Capability
 * Service. Run only against a disposable database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, beforeEach, type TestContext } from 'node:test';
import pg from 'pg';
import {
  mcpClientManager,
  type MCPConnectionConfig,
  type MCPResult,
} from '@deft/mcp';
import { closeDb } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `capability-immediate-org-${suffix}`;
const OTHER_ORG_ID = `capability-immediate-other-${suffix}`;
const USER_ID = `capability-immediate-user-${suffix}`;
const EMPLOYEE_ID = `capability-immediate-employee-${suffix}`;
const CONNECTION_ID = `capability-immediate-connection-${suffix}`;
const CONNECTION_SLUG = `phase2-immediate-${suffix}`;
const OPERATION_NAME = 'send_report';
const PREFIXED_NAME = `mcp__${CONNECTION_SLUG}__${OPERATION_NAME}`;
const VALID_URL = 'https://api.example.com/mcp';

let client: pg.Client;

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
     VALUES ($1, $2, 'Capability Immediate User', 'human', false, true)`,
    [USER_ID, `${USER_ID}@test.local`],
  );
  await client.query(
    `INSERT INTO mcp_connections
      (id, org_id, name, slug, server_url, transport, auth_type, is_active,
       default_trust_tier, enabled_tools, created_by)
     VALUES ($1, $2, 'Phase 2 Immediate Provider', $3, $4,
       'streamable-http', 'none', true, 'full', $5::text[], $6)`,
    [CONNECTION_ID, ORG_ID, CONNECTION_SLUG, VALID_URL, [OPERATION_NAME], USER_ID],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt,
       mcp_connection_ids, disabled_tools, trust_level, max_daily_actions,
       daily_action_count, created_by, is_active, is_deleted, is_byoa)
     VALUES ($1, $2, $3, 'Phase 2 Immediate Employee', $4, 'custom', 'test',
       $5::text[], '{}'::text[], 'standard', 5, 0, $3, true, false, false)`,
    [EMPLOYEE_ID, ORG_ID, USER_ID, `phase2-immediate-employee-${suffix}`, [CONNECTION_ID]],
  );
});

beforeEach(async () => {
  await client.query('DELETE FROM mcp_tool_overrides WHERE mcp_connection_id = $1', [CONNECTION_ID]);
  await client.query(
    `UPDATE mcp_connections
     SET is_active = true, enabled_tools = $2::text[], server_url = $3,
         transport = 'streamable-http', stdio_command = NULL, stdio_args = NULL
     WHERE id = $1`,
    [CONNECTION_ID, [OPERATION_NAME], VALID_URL],
  );
  await client.query(
    `UPDATE agent_employees
     SET is_active = true, is_deleted = false, mcp_connection_ids = $2::text[],
         disabled_tools = '{}'::text[], daily_action_count = 0, max_daily_actions = 5
     WHERE id = $1`,
    [EMPLOYEE_ID, [CONNECTION_ID]],
  );
});

after(async () => {
  if (!client) return;
  await client.query('DELETE FROM mcp_tool_overrides WHERE mcp_connection_id = $1', [CONNECTION_ID]);
  await client.query('DELETE FROM agent_employees WHERE id = $1', [EMPLOYEE_ID]);
  await client.query('DELETE FROM mcp_connections WHERE id = $1', [CONNECTION_ID]);
  await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);
  await client.end();
  await closeDb();
});

function stubExecution(t: TestContext, result: MCPResult) {
  const original = mcpClientManager.executeTool;
  const calls: Array<{
    config: MCPConnectionConfig;
    toolName: string;
    params: Record<string, unknown>;
  }> = [];
  mcpClientManager.executeTool = async (config, toolName, params) => {
    calls.push({ config, toolName, params });
    return result;
  };
  t.after(() => { mcpClientManager.executeTool = original; });
  return calls;
}

test('immediate MCP success preserves exact structured output, citation, config, and one call', async (t) => {
  const rawResult = {
    content: [{ type: 'text', text: 'sent' }],
    structuredContent: { report_id: 'report-1' },
    _meta: { trace_id: 'trace-success' },
  };
  const calls = stubExecution(t, {
    success: true,
    content: rawResult.content,
    structuredContent: rawResult.structuredContent,
    meta: rawResult._meta,
    rawResult,
    durationMs: 17,
  });
  const params = { recipient: 'ada@example.test' };

  const actual = await executeToolCall(
    PREFIXED_NAME,
    params,
    ORG_ID,
    USER_ID,
    undefined,
    EMPLOYEE_ID,
  );

  assert.equal(actual.result, rawResult);
  assert.deepEqual(actual.citations, [{
    type: 'mcp',
    id: CONNECTION_ID,
    title: `Phase 2 Immediate Provider: ${OPERATION_NAME}`,
  }]);
  assert.deepEqual(calls, [{
    config: {
      connectionId: CONNECTION_ID,
      connectionSlug: CONNECTION_SLUG,
      orgId: ORG_ID,
      transport: 'streamable-http',
      url: VALID_URL,
      command: undefined,
      args: undefined,
    },
    toolName: OPERATION_NAME,
    params,
  }]);
  assert.equal('durationMs' in actual.result, false);
  const budget = await client.query<{ daily_action_count: number }>(
    'SELECT daily_action_count FROM agent_employees WHERE id = $1',
    [EMPLOYEE_ID],
  );
  assert.equal(budget.rows[0]?.daily_action_count, 0);
});

test('immediate MCP compatibility output survives an unavailable strict projection', async (t) => {
  const rawResult = {
    content: [{ type: 'text', text: 'provider completed the effect' }],
    structuredContent: { unsupported_counter: 1n },
  };
  const calls = stubExecution(t, {
    success: true,
    content: rawResult.content,
    structuredContent: rawResult.structuredContent,
    rawResult,
    durationMs: 3,
  });

  const actual = await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID, undefined, EMPLOYEE_ID);
  assert.equal(actual.result, rawResult);
  assert.deepEqual(actual.citations, [{
    type: 'mcp',
    id: CONNECTION_ID,
    title: `Phase 2 Immediate Provider: ${OPERATION_NAME}`,
  }]);
  assert.equal(calls.length, 1);
});

test('immediate MCP tool and transport failures retain exact payloads and resolved citations', async (t) => {
  const rawError = {
    content: [{ type: 'text', text: 'invalid report' }],
    structuredContent: { code: 'INVALID_REPORT' },
    isError: true,
    _meta: { trace_id: 'trace-tool-error' },
  };
  const toolCalls = stubExecution(t, {
    success: false,
    content: rawError.content,
    structuredContent: rawError.structuredContent,
    meta: rawError._meta,
    rawResult: rawError,
    error: 'invalid report',
    durationMs: 9,
  });

  const toolFailure = await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID, undefined, EMPLOYEE_ID);
  assert.deepEqual(toolFailure, {
    result: { ...rawError, error: 'invalid report' },
    citations: [{
      type: 'mcp',
      id: CONNECTION_ID,
      title: `Phase 2 Immediate Provider: ${OPERATION_NAME}`,
    }],
  });
  assert.equal(toolCalls.length, 1);

  mcpClientManager.executeTool = async (config, toolName, params) => {
    toolCalls.push({ config, toolName, params });
    return {
      success: false,
      content: null,
      error: 'connection reset',
      durationMs: 11,
    };
  };
  const transportFailure = await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID, undefined, EMPLOYEE_ID);
  assert.deepEqual(transportFailure, {
    result: { content: null, error: 'connection reset' },
    citations: [{
      type: 'mcp',
      id: CONNECTION_ID,
      title: `Phase 2 Immediate Provider: ${OPERATION_NAME}`,
    }],
  });
  assert.equal(toolCalls.length, 2);
});

test('immediate MCP authorization denials preserve messages, ordering, and zero calls', async (t) => {
  const calls = stubExecution(t, {
    success: true,
    content: [],
    rawResult: { content: [] },
    durationMs: 1,
  });

  await client.query(
    'UPDATE agent_employees SET disabled_tools = $2::text[], daily_action_count = max_daily_actions WHERE id = $1',
    [EMPLOYEE_ID, [OPERATION_NAME]],
  );
  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID, undefined, EMPLOYEE_ID),
    { result: { error: `Tool '${PREFIXED_NAME}' is disabled for this agent employee` }, citations: [] },
  );

  await client.query(
    `UPDATE agent_employees
     SET disabled_tools = '{}'::text[], mcp_connection_ids = '{}'::text[], daily_action_count = 0
     WHERE id = $1`,
    [EMPLOYEE_ID],
  );
  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID, undefined, EMPLOYEE_ID),
    { result: { error: `MCP connection '${CONNECTION_SLUG}' is not assigned to this agent employee` }, citations: [] },
  );

  await client.query(
    `UPDATE agent_employees
     SET mcp_connection_ids = $2::text[], daily_action_count = max_daily_actions
     WHERE id = $1`,
    [EMPLOYEE_ID, [CONNECTION_ID]],
  );
  await client.query('UPDATE mcp_connections SET is_active = false WHERE id = $1', [CONNECTION_ID]);
  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID, undefined, EMPLOYEE_ID),
    {
      result: {
        error: 'Daily action limit reached (5/5). Please ask an admin to increase the limit or wait until tomorrow.',
      },
      citations: [],
    },
  );
  assert.equal(calls.length, 0);
});

test('immediate MCP live connection, allowlist, override, and tenant denials make zero calls', async (t) => {
  const calls = stubExecution(t, {
    success: true,
    content: [],
    rawResult: { content: [] },
    durationMs: 1,
  });

  await client.query('UPDATE mcp_connections SET is_active = false WHERE id = $1', [CONNECTION_ID]);
  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID),
    { result: { error: `MCP connection '${CONNECTION_SLUG}' is unavailable` }, citations: [] },
  );

  await client.query(
    `UPDATE mcp_connections SET is_active = true, enabled_tools = ARRAY['other_tool']::text[] WHERE id = $1`,
    [CONNECTION_ID],
  );
  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID),
    {
      result: { error: `MCP tool '${OPERATION_NAME}' is not enabled on connection '${CONNECTION_SLUG}'` },
      citations: [],
    },
  );

  await client.query(
    'UPDATE mcp_connections SET enabled_tools = $2::text[] WHERE id = $1',
    [CONNECTION_ID, [OPERATION_NAME]],
  );
  await client.query(
    `INSERT INTO mcp_tool_overrides
      (id, org_id, mcp_connection_id, tool_name, is_disabled)
     VALUES ($1, $2, $3, $4, true)`,
    [`capability-immediate-override-${suffix}`, ORG_ID, CONNECTION_ID, OPERATION_NAME],
  );
  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID),
    {
      result: { error: `MCP tool '${OPERATION_NAME}' is disabled on connection '${CONNECTION_SLUG}'` },
      citations: [],
    },
  );

  assert.deepEqual(
    await executeToolCall(PREFIXED_NAME, {}, OTHER_ORG_ID, USER_ID),
    { result: { error: `MCP connection '${CONNECTION_SLUG}' is unavailable` }, citations: [] },
  );
  assert.equal(calls.length, 0);
});

test('malformed names and invalid targets still throw before provider execution', async (t) => {
  const calls = stubExecution(t, {
    success: true,
    content: [],
    rawResult: { content: [] },
    durationMs: 1,
  });

  await assert.rejects(
    executeToolCall('mcp__malformed', {}, ORG_ID, USER_ID),
    /Invalid MCP tool name format: mcp__malformed/,
  );

  await client.query(
    `UPDATE mcp_connections
     SET server_url = 'http://127.0.0.1/private', enabled_tools = $2::text[], is_active = true
     WHERE id = $1`,
    [CONNECTION_ID, [OPERATION_NAME]],
  );
  await assert.rejects(
    executeToolCall(PREFIXED_NAME, {}, ORG_ID, USER_ID),
    /Invalid MCP connection target:/,
  );
  assert.equal(calls.length, 0);
});
