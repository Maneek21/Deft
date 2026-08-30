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
  type MCPToolDiscovery,
} from '@deft/mcp';
import { closeDb } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { executeAction, executeActionDirect } from '../src/lib/agent-actions.js';
import { approveAction } from '../src/lib/agent-approval-resolver.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!DATABASE_URL) {
  throw new Error('Capability execution DB tests require an explicit disposable DEFT_TEST_DATABASE_URL');
}
if (
  process.env.CI !== 'true'
  && !/(?:test|ci|acceptance|phase2)/i.test(new URL(DATABASE_URL).pathname)
) {
  throw new Error('Capability execution DB tests refuse a database without a test/CI/phase2 name');
}
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `capability-immediate-org-${suffix}`;
const OTHER_ORG_ID = `capability-immediate-other-${suffix}`;
const USER_ID = `capability-immediate-user-${suffix}`;
const APPROVER_USER_ID = `capability-immediate-approver-${suffix}`;
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
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, 'Capability Immediate Org', $2)`,
    [ORG_ID, `capability-immediate-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
     VALUES
       ($1, $2, 'Capability Immediate User', 'human', false, true),
       ($3, $4, 'Capability Immediate Approver', 'human', false, true)`,
    [
      USER_ID,
      `${USER_ID}@test.local`,
      APPROVER_USER_ID,
      `${APPROVER_USER_ID}@test.local`,
    ],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)`,
    [randomUUID(), ORG_ID, APPROVER_USER_ID],
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
  await client.query('DELETE FROM action_receipts WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM agent_action_approvers WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM mcp_tool_overrides WHERE mcp_connection_id = $1', [CONNECTION_ID]);
  await client.query(
    `UPDATE mcp_connections
     SET is_active = true, enabled_tools = $2::text[], server_url = $3,
         transport = 'streamable-http', stdio_command = NULL, stdio_args = NULL,
         default_trust_tier = 'full'
     WHERE id = $1`,
    [CONNECTION_ID, [OPERATION_NAME], VALID_URL],
  );
  await client.query(
    `UPDATE agent_employees
     SET is_active = true, is_deleted = false, mcp_connection_ids = $2::text[],
         disabled_tools = '{}'::text[], trust_level = 'standard',
         daily_action_count = 0, max_daily_actions = 5,
         runtime_kind = 'defty_system'
     WHERE id = $1`,
    [EMPLOYEE_ID, [CONNECTION_ID]],
  );
});

after(async () => {
  if (!client) return;
  await client.query('DELETE FROM action_receipts WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM agent_action_approvers WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM mcp_tool_overrides WHERE mcp_connection_id = $1', [CONNECTION_ID]);
  await client.query('DELETE FROM agent_employees WHERE id = $1', [EMPLOYEE_ID]);
  await client.query('DELETE FROM mcp_connections WHERE id = $1', [CONNECTION_ID]);
  await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
  await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[USER_ID, APPROVER_USER_ID]]);
  await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
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

async function insertApprovedAction(options: {
  approvalTier?: 'auto' | 'quick' | 'full';
  approvedByUserId?: string | null;
  params?: Record<string, unknown>;
} = {}): Promise<string> {
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO agent_actions
      (id, org_id, user_id, agent_employee_id, source, mcp_connection_id,
       action, params, approval_tier, approval_status, approved_at,
       approved_by_user_id)
     VALUES ($1, $2, $3, $4, 'runner', $5, $6, $7::jsonb, $8, 'approved', now(), $9)`,
    [
      actionId,
      ORG_ID,
      USER_ID,
      EMPLOYEE_ID,
      CONNECTION_ID,
      PREFIXED_NAME,
      JSON.stringify(options.params ?? {}),
      options.approvalTier ?? 'auto',
      options.approvedByUserId ?? null,
    ],
  );
  return actionId;
}

async function actionRow(actionId: string) {
  const result = await client.query<{
    approval_tier: 'auto' | 'quick' | 'full';
    approval_status: 'pending' | 'approved' | 'rejected' | 'expired';
    approved_by_user_id: string | null;
    mcp_connection_id: string | null;
    result: unknown;
    error: string | null;
    executed_at: Date | null;
  }>(
    `SELECT approval_tier, approval_status, approved_by_user_id,
            mcp_connection_id, result, error, executed_at
     FROM agent_actions WHERE id = $1`,
    [actionId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!;
}

async function budgetCount(): Promise<number> {
  const result = await client.query<{ daily_action_count: number }>(
    'SELECT daily_action_count FROM agent_employees WHERE id = $1',
    [EMPLOYEE_ID],
  );
  return result.rows[0]!.daily_action_count;
}

function stubDiscovery(t: TestContext) {
  const original = mcpClientManager.getCachedToolDiscovery;
  const calls: MCPConnectionConfig[] = [];
  const discovered: MCPToolDiscovery = {
    tools: [{
      name: PREFIXED_NAME,
      originalName: OPERATION_NAME,
      description: 'Send a report',
      inputSchema: { type: 'object', properties: {} },
      connectionId: CONNECTION_ID,
      connectionSlug: CONNECTION_SLUG,
      isWrite: true,
      approvalTier: 'auto-execute',
      annotations: { destructiveHint: false },
      rawTool: {
        name: OPERATION_NAME,
        description: 'Send a report',
        inputSchema: { type: 'object', properties: {} },
      },
    }],
    providerTools: [{
      name: OPERATION_NAME,
      description: 'Send a report',
      inputSchema: { type: 'object', properties: {} },
    }],
  };
  mcpClientManager.getCachedToolDiscovery = async (config) => {
    calls.push(config);
    return discovered;
  };
  t.after(() => { mcpClientManager.getCachedToolDiscovery = original; });
  return calls;
}

async function queueReviewedAction(approvalTier: 'quick' | 'full'): Promise<string> {
  await client.query(
    `UPDATE mcp_connections
     SET is_active = true, default_trust_tier = $2, enabled_tools = $3::text[]
     WHERE id = $1`,
    [CONNECTION_ID, approvalTier, [OPERATION_NAME]],
  );
  await client.query(
    `UPDATE agent_employees
     SET trust_level = $2, daily_action_count = 0,
         mcp_connection_ids = $3::text[], disabled_tools = '{}'::text[]
     WHERE id = $1`,
    [
      EMPLOYEE_ID,
      approvalTier === 'quick' ? 'conservative' : 'standard',
      [CONNECTION_ID],
    ],
  );
  const queued = await executeActionDirect(
    PREFIXED_NAME,
    {},
    ORG_ID,
    USER_ID,
    null,
    approvalTier,
    { agentEmployeeId: EMPLOYEE_ID, source: 'runner' },
  );
  assert.equal(queued.success, false);
  assert.equal(queued.requiresApproval, true);
  assert.equal(queued.approvalTier, approvalTier);
  const durable = await actionRow(queued.actionId);
  assert.equal(durable.approval_status, 'pending');
  assert.equal(durable.approval_tier, approvalTier);
  assert.equal(durable.executed_at, null);
  assert.equal(await budgetCount(), 0);
  return queued.actionId;
}

async function receiptRows(actionId: string) {
  const result = await client.query<{
    approver_id: string | null;
    decision: string;
    decision_reason: string | null;
    result_json: unknown;
    signature_hmac: string;
  }>(
    `SELECT approver_id, decision, decision_reason, result_json, signature_hmac
     FROM action_receipts WHERE action_id = $1 ORDER BY created_at`,
    [actionId],
  );
  return result.rows;
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

test('governed MCP actions preserve exact success and provider-failure persistence', async (t) => {
  const successPayload = {
    content: [{ type: 'text', text: 'sent' }],
    structuredContent: { report_id: 'report-action' },
    _meta: { trace_id: 'trace-action-success' },
  };
  const calls = stubExecution(t, {
    success: true,
    content: successPayload.content,
    structuredContent: successPayload.structuredContent,
    meta: successPayload._meta,
    rawResult: successPayload,
    durationMs: 17,
  });
  const params = { recipient: 'ada@example.test' };
  const successActionId = await insertApprovedAction({ params });

  assert.deepEqual(
    await executeAction(
      successActionId,
      PREFIXED_NAME,
      params,
      ORG_ID,
      USER_ID,
      { agentEmployeeId: EMPLOYEE_ID },
    ),
    { success: true, result: successPayload },
  );
  const successRow = await actionRow(successActionId);
  assert.deepEqual(successRow.result, successPayload);
  assert.equal(successRow.error, null);
  assert.ok(successRow.executed_at);
  assert.equal(calls.length, 1);
  assert.equal(await budgetCount(), 1);

  const failurePayload = {
    content: [{ type: 'text', text: 'invalid report' }],
    structuredContent: { code: 'INVALID_REPORT' },
    isError: true,
    _meta: { trace_id: 'trace-action-error' },
  };
  mcpClientManager.executeTool = async (config, toolName, receivedParams) => {
    calls.push({ config, toolName, params: receivedParams });
    return {
      success: false,
      content: failurePayload.content,
      structuredContent: failurePayload.structuredContent,
      meta: failurePayload._meta,
      rawResult: failurePayload,
      error: 'invalid report',
      durationMs: 9,
    };
  };
  const failureActionId = await insertApprovedAction();
  const storedFailurePayload = { ...failurePayload, error: 'invalid report' };
  assert.deepEqual(
    await executeAction(
      failureActionId,
      PREFIXED_NAME,
      {},
      ORG_ID,
      USER_ID,
      { agentEmployeeId: EMPLOYEE_ID },
    ),
    { success: false, result: storedFailurePayload, error: 'invalid report' },
  );
  const failureRow = await actionRow(failureActionId);
  assert.deepEqual(failureRow.result, storedFailurePayload);
  assert.equal(failureRow.error, 'invalid report');
  assert.equal(failureRow.executed_at, null);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
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
  });
  assert.deepEqual(calls[1], {
    config: calls[0]!.config,
    toolName: OPERATION_NAME,
    params: {},
  });
  assert.equal(await budgetCount(), 2);
});

test('governed MCP action denials preserve policy and budget ordering with zero calls', async (t) => {
  const calls = stubExecution(t, {
    success: true,
    content: [],
    rawResult: { content: [] },
    durationMs: 1,
  });

  const policyActionId = await insertApprovedAction();
  await client.query(
    `UPDATE agent_employees
     SET disabled_tools = $2::text[], daily_action_count = max_daily_actions
     WHERE id = $1`,
    [EMPLOYEE_ID, [OPERATION_NAME]],
  );
  assert.deepEqual(
    await executeAction(
      policyActionId,
      PREFIXED_NAME,
      {},
      ORG_ID,
      USER_ID,
      { agentEmployeeId: EMPLOYEE_ID },
    ),
    {
      success: false,
      result: null,
      error: `Tool '${PREFIXED_NAME}' is disabled for this agent employee`,
    },
  );
  const policyRow = await actionRow(policyActionId);
  assert.equal(policyRow.result, null);
  assert.equal(policyRow.error, null);
  assert.equal(policyRow.executed_at, null);
  assert.equal(await budgetCount(), 5);

  await client.query(
    `UPDATE agent_employees
     SET disabled_tools = '{}'::text[], mcp_connection_ids = '{}'::text[],
         daily_action_count = 0
     WHERE id = $1`,
    [EMPLOYEE_ID],
  );
  const resolutionActionId = await insertApprovedAction();
  assert.deepEqual(
    await executeAction(
      resolutionActionId,
      PREFIXED_NAME,
      {},
      ORG_ID,
      USER_ID,
      { agentEmployeeId: EMPLOYEE_ID },
    ),
    {
      success: false,
      result: null,
      error: `MCP connection '${CONNECTION_SLUG}' is not assigned to this agent employee`,
    },
  );
  const resolutionRow = await actionRow(resolutionActionId);
  assert.equal(resolutionRow.result, null);
  assert.equal(resolutionRow.error, null);
  assert.equal(resolutionRow.executed_at, null);
  assert.equal(await budgetCount(), 1);

  await client.query(
    `UPDATE agent_employees
     SET mcp_connection_ids = $2::text[], daily_action_count = max_daily_actions
     WHERE id = $1`,
    [EMPLOYEE_ID, [CONNECTION_ID]],
  );
  const budgetActionId = await insertApprovedAction();
  const budgetError = 'Daily action limit reached. Ask an admin to increase the limit or wait for the daily reset.';
  assert.deepEqual(
    await executeAction(
      budgetActionId,
      PREFIXED_NAME,
      {},
      ORG_ID,
      USER_ID,
      { agentEmployeeId: EMPLOYEE_ID },
    ),
    { success: false, result: null, error: budgetError },
  );
  const budgetRow = await actionRow(budgetActionId);
  assert.equal(budgetRow.result, null);
  assert.equal(budgetRow.error, budgetError);
  assert.equal(budgetRow.executed_at, null);
  assert.equal(await budgetCount(), 5);
  assert.equal(calls.length, 0);
});

test('direct MCP actions preserve auto execution and stricter quick/full re-gating', async (t) => {
  const discoveryCalls = stubDiscovery(t);
  const rawResult = {
    content: [{ type: 'text', text: 'sent' }],
    structuredContent: { report_id: 'report-direct' },
  };
  const executionCalls = stubExecution(t, {
    success: true,
    content: rawResult.content,
    structuredContent: rawResult.structuredContent,
    rawResult,
    durationMs: 5,
  });
  await client.query(
    `UPDATE mcp_connections SET default_trust_tier = 'auto' WHERE id = $1`,
    [CONNECTION_ID],
  );
  await client.query(
    `UPDATE agent_employees SET trust_level = 'autonomous' WHERE id = $1`,
    [EMPLOYEE_ID],
  );

  const automatic = await executeActionDirect(
    PREFIXED_NAME,
    { recipient: 'ada@example.test' },
    ORG_ID,
    USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMPLOYEE_ID, source: 'runner' },
  );
  assert.equal(automatic.success, true, automatic.error);
  assert.deepEqual(automatic.result, rawResult);
  const automaticRow = await actionRow(automatic.actionId);
  assert.equal(automaticRow.approval_tier, 'auto');
  assert.equal(automaticRow.approval_status, 'approved');
  assert.equal(automaticRow.mcp_connection_id, CONNECTION_ID);
  assert.deepEqual(automaticRow.result, rawResult);
  assert.ok(automaticRow.executed_at);
  assert.equal(await budgetCount(), 1);
  assert.equal(executionCalls.length, 1);
  assert.equal((await receiptRows(automatic.actionId)).length, 0);

  for (const stricterTier of ['quick', 'full'] as const) {
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
    await client.query(
      `UPDATE mcp_connections SET default_trust_tier = $2 WHERE id = $1`,
      [CONNECTION_ID, stricterTier],
    );
    await client.query(
      'UPDATE agent_employees SET daily_action_count = 0 WHERE id = $1',
      [EMPLOYEE_ID],
    );

    const queued = await executeActionDirect(
      PREFIXED_NAME,
      {},
      ORG_ID,
      USER_ID,
      null,
      'auto',
      { agentEmployeeId: EMPLOYEE_ID, source: 'runner' },
    );
    assert.equal(queued.success, false);
    assert.equal(queued.requiresApproval, true);
    assert.equal(queued.approvalTier, stricterTier);
    assert.equal(
      queued.error,
      `Approval policy changed to '${stricterTier}'; action queued for fresh review`,
    );
    const queuedRow = await actionRow(queued.actionId);
    assert.equal(queuedRow.approval_tier, stricterTier);
    assert.equal(queuedRow.approval_status, 'pending');
    assert.equal(queuedRow.mcp_connection_id, CONNECTION_ID);
    assert.equal(queuedRow.result, null);
    assert.equal(queuedRow.error, queued.error);
    assert.equal(queuedRow.executed_at, null);
    assert.equal(await budgetCount(), 0);
    assert.equal(executionCalls.length, 1);
  }

  assert.equal(discoveryCalls.length, 3);
});

test('reviewed MCP actions preserve quick/full resolution, receipts, revocation, and replay', async (t) => {
  const discoveryCalls = stubDiscovery(t);
  const successPayload = { content: [{ type: 'text', text: 'reviewed send' }] };
  const calls = stubExecution(t, {
    success: true,
    content: successPayload.content,
    rawResult: successPayload,
    durationMs: 7,
  });

  const quickActionId = await queueReviewedAction('quick');
  const quickResults = await Promise.all([
    approveAction(quickActionId, APPROVER_USER_ID),
    approveAction(quickActionId, APPROVER_USER_ID),
  ]);
  assert.deepEqual(quickResults.map((result) => result.status), ['approved', 'approved']);
  assert.equal(calls.length, 1);
  assert.equal(await budgetCount(), 1);
  const quickRow = await actionRow(quickActionId);
  assert.equal(quickRow.approval_status, 'approved');
  assert.equal(quickRow.approved_by_user_id, APPROVER_USER_ID);
  assert.deepEqual(quickRow.result, successPayload);
  assert.equal(quickRow.error, null);
  assert.ok(quickRow.executed_at);
  const quickReceipts = await receiptRows(quickActionId);
  assert.equal(quickReceipts.length, 1);
  assert.equal(quickReceipts[0]!.approver_id, APPROVER_USER_ID);
  assert.equal(quickReceipts[0]!.decision, 'approved');
  assert.equal(quickReceipts[0]!.decision_reason, null);
  assert.deepEqual(quickReceipts[0]!.result_json, successPayload);
  assert.match(quickReceipts[0]!.signature_hmac, /^[a-f0-9]{64}$/);
  assert.equal((await approveAction(quickActionId, APPROVER_USER_ID)).status, 'approved');
  assert.equal(calls.length, 1);
  assert.equal(await budgetCount(), 1);
  assert.equal((await receiptRows(quickActionId)).length, 1);

  const providerFailure = {
    content: [{ type: 'text', text: 'invalid reviewed report' }],
    isError: true,
  };
  mcpClientManager.executeTool = async (config, toolName, params) => {
    calls.push({ config, toolName, params });
    return {
      success: false,
      content: providerFailure.content,
      rawResult: providerFailure,
      error: 'invalid reviewed report',
      durationMs: 8,
    };
  };
  const fullActionId = await queueReviewedAction('full');
  const fullLegacyPayload = { ...providerFailure, error: 'invalid reviewed report' };
  const fullError = JSON.stringify({
    error: 'invalid reviewed report',
    result: fullLegacyPayload,
  });
  const fullResult = await approveAction(fullActionId, APPROVER_USER_ID);
  assert.deepEqual(fullResult, {
    status: 'error',
    code: 'EXECUTE_FAILED',
    message: fullError,
  });
  assert.equal(calls.length, 2);
  assert.equal(await budgetCount(), 1);
  const fullRow = await actionRow(fullActionId);
  assert.equal(fullRow.approval_status, 'approved');
  assert.equal(fullRow.approved_by_user_id, APPROVER_USER_ID);
  assert.equal(fullRow.result, null);
  assert.equal(fullRow.error, fullError);
  assert.ok(fullRow.executed_at);
  const fullReceipts = await receiptRows(fullActionId);
  assert.equal(fullReceipts.length, 1);
  assert.equal(fullReceipts[0]!.decision, 'approved');
  assert.equal(fullReceipts[0]!.decision_reason, `execution failed: ${fullError}`);
  assert.equal(fullReceipts[0]!.result_json, null);
  assert.match(fullReceipts[0]!.signature_hmac, /^[a-f0-9]{64}$/);
  assert.equal((await approveAction(fullActionId, APPROVER_USER_ID)).status, 'approved');
  assert.equal(calls.length, 2);
  assert.equal(await budgetCount(), 1);
  assert.equal((await receiptRows(fullActionId)).length, 1);

  const revokedActionId = await queueReviewedAction('full');
  await client.query('UPDATE mcp_connections SET is_active = false WHERE id = $1', [CONNECTION_ID]);
  const revocationError = JSON.stringify({
    error: `MCP connection '${CONNECTION_SLUG}' is unavailable`,
    result: null,
  });
  const revokedResult = await approveAction(revokedActionId, APPROVER_USER_ID);
  assert.deepEqual(revokedResult, {
    status: 'error',
    code: 'EXECUTE_FAILED',
    message: revocationError,
  });
  assert.equal(calls.length, 2);
  assert.equal(await budgetCount(), 1);
  const revokedRow = await actionRow(revokedActionId);
  assert.equal(revokedRow.approval_status, 'approved');
  assert.equal(revokedRow.approved_by_user_id, APPROVER_USER_ID);
  assert.equal(revokedRow.result, null);
  assert.equal(revokedRow.error, revocationError);
  assert.ok(revokedRow.executed_at);
  const revokedReceipts = await receiptRows(revokedActionId);
  assert.equal(revokedReceipts.length, 1);
  assert.equal(revokedReceipts[0]!.decision_reason, `execution failed: ${revocationError}`);
  assert.equal(revokedReceipts[0]!.result_json, null);
  assert.equal((await approveAction(revokedActionId, APPROVER_USER_ID)).status, 'approved');
  assert.equal(calls.length, 2);
  assert.equal(await budgetCount(), 1);
  assert.equal((await receiptRows(revokedActionId)).length, 1);

  assert.equal(discoveryCalls.length, 3);
});
