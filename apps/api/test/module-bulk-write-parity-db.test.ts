import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';

import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { closeDb } from '../src/lib/db.js';
import { MODULE_MCP_WRITE_TOOLS } from '../src/lib/mcp-tools/modules.js';
import { issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import { humanModuleActor, installModuleFromManifest, updateModuleInstallation } from '../src/lib/module-service.js';
import { verifyReceipt } from '../src/lib/receipts.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { agentRoutes } from '../src/routes/agent.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);
after(closeDb);

function payload(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

test('equipment bulk create is reviewed, idempotent, and executes under its proposing principal', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID().slice(0, 8);
  const triggerName = `bulk_disable_${suffix.replaceAll('-', '')}`;
  const functionName = `${triggerName}_fn`;
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const employeeUserId = randomUUID();
  const employeeId = randomUUID();
  const employeeSlug = `bulk-equipment-${suffix}`;
  const moduleSlug = `bulk-equipment-${suffix}`;
  const base = {
    caller_employee_slug: employeeSlug,
    module_id: '', collection_key: 'assets', expected_manifest_digest: '',
    rows: [{ data: { serial: `CAM-${suffix}` } }], idempotency_key: `bulk-${suffix}`,
  };
  const employeeCtx: ToolContext = {
    org_id: orgId, employee_id: employeeId, employee_slug: employeeSlug,
    trust_level: 'autonomous', scopes: ['write:modules'],
  };
  const personalCall = async (token: string, args: Record<string, unknown>) => {
    const app = new Hono();
    app.route('/api/mcp/v1', mcpServerV1Routes);
    const response = await app.request('/api/mcp/v1/tools/call', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'module_record_bulk_create', arguments: args }),
    });
    return { status: response.status, body: await response.json() as ToolResult };
  };

  try {
    await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3)', [orgId, 'Bulk equipment', `bulk-equipment-${suffix}`]);
    await client.query('INSERT INTO users (id,name,email) VALUES ($1,$2,$3),($4,$5,$6)', [
      ownerId, 'Bulk owner', `bulk-owner-${suffix}@example.test`, employeeUserId, 'Bulk employee', `bulk-employee-${suffix}@example.test`,
    ]);
    await client.query(`INSERT INTO org_members (id,org_id,user_id,role) VALUES
      ($1,$2,$3,'owner'),($4,$2,$5,'member')`, [randomUUID(), orgId, ownerId, randomUUID(), employeeUserId]);
    await client.query(`INSERT INTO agent_employees
      (id,org_id,user_id,name,slug,role,system_prompt,trust_level,created_by)
      VALUES ($1,$2,$3,'Bulk equipment employee',$4,'custom','Test bulk write','autonomous',$5)`,
    [employeeId, orgId, employeeUserId, employeeSlug, ownerId]);
    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1', id: `test.deft.${moduleSlug}`, slug: moduleSlug, version: '1.0.0', name: 'Equipment register',
      collections: [{ key: 'assets', name: 'Assets', singular_name: 'Asset',
        fields: [{ key: 'serial', label: 'Serial', type: 'text', required: true }],
        search: { title_field: 'serial', fields: ['serial'] },
        views: [{ key: 'all', name: 'All', type: 'table', fields: ['serial'] }],
      }],
    }, { source: 'sideloaded' });
    await updateModuleInstallation(owner, moduleSlug, { agent_access: 'write' });
    const input = { ...base, module_id: installation.module_id, expected_manifest_digest: installation.manifest_digest };

    const missingEmployeeScope = await MODULE_MCP_WRITE_TOOLS.module_record_bulk_create!(input, {
      ...employeeCtx, scopes: [],
    });
    assert.equal(missingEmployeeScope.isError, true);
    assert.match(missingEmployeeScope.content[0]!.text, /write:modules/);

    const employeeProposal = payload(await MODULE_MCP_WRITE_TOOLS.module_record_bulk_create!(input, employeeCtx));
    assert.equal(employeeProposal.status, 'queued_for_approval');
    const employeeReplay = payload(await MODULE_MCP_WRITE_TOOLS.module_record_bulk_create!(input, employeeCtx));
    assert.equal(employeeReplay.approval_id, employeeProposal.approval_id);
    const noEmployeeRecords = await client.query('SELECT count(*)::int AS count FROM module_records WHERE org_id = $1', [orgId]);
    assert.equal(noEmployeeRecords.rows[0].count, 0);
    const changedEmployee = await MODULE_MCP_WRITE_TOOLS.module_record_bulk_create!({
      ...input, rows: [{ data: { serial: `OTHER-${suffix}` } }],
    }, employeeCtx);
    assert.equal(changedEmployee.isError, true);

    await updateModuleInstallation(owner, moduleSlug, { agent_access: 'read' });
    const actionCountBeforeSpoof = await client.query('SELECT count(*)::int AS count FROM agent_actions WHERE org_id = $1', [orgId]);
    await assert.rejects(() => executeActionDirect('module_record_bulk_create', {
      ...input,
      idempotency_key: `native-spoof-${suffix}`,
      __deft_human_mcp_principal: { kind: 'human_mcp_v1', client_id: 'model-supplied' },
    }, orgId, ownerId, null, 'full', { source: 'defty_capture' }));
    const actionCountAfterSpoof = await client.query('SELECT count(*)::int AS count FROM agent_actions WHERE org_id = $1', [orgId]);
    assert.equal(actionCountAfterSpoof.rows[0].count, actionCountBeforeSpoof.rows[0].count);
    const spoofedHumanReceipt = await client.query(
      "SELECT count(*)::int AS count FROM action_receipts WHERE org_id = $1 AND proposer = 'user'",
      [orgId],
    );
    assert.equal(spoofedHumanReceipt.rows[0].count, 0);
    await updateModuleInstallation(owner, moduleSlug, { agent_access: 'write' });

    const token = (await issuePersonalMcpToken({
      orgId, userId: ownerId, name: 'Bulk personal MCP', scopes: ['write:modules'], createdBy: ownerId,
    })).raw;
    const missingScopeToken = (await issuePersonalMcpToken({
      orgId, userId: ownerId, name: 'Missing bulk module scope', scopes: ['read:modules'], createdBy: ownerId,
    })).raw;
    const humanInput = {
      ...input,
      idempotency_key: `human-${suffix}`,
      rows: [{ data: { serial: `HUMAN-${suffix}` } }],
      module_name: 'MALICIOUS ADMIN MODULE',
      collection_name: 'MALICIOUS ADMIN COLLECTION',
      source_file_name: 'not-an-attached-file.csv',
    };
    const missingHumanScope = await personalCall(missingScopeToken, humanInput);
    assert.equal(missingHumanScope.body.isError, true);
    assert.match(missingHumanScope.body.content[0]?.text ?? '', /write:modules/);
    const humanProposal = await personalCall(token, humanInput);
    assert.equal(humanProposal.status, 200);
    assert.equal(humanProposal.body.isError, false, humanProposal.body.content[0]?.text);
    const humanPending = payload(humanProposal.body);
    assert.equal(humanPending.status, 'pending_approval');
    const agentApp = new Hono();
    agentApp.use('*', async (c, next) => {
      c.set('user', {
        id: ownerId,
        email: `bulk-owner-${suffix}@example.test`,
        org_id: orgId,
        role: 'owner',
      } as any);
      await next();
    });
    agentApp.route('/api/agent', agentRoutes);
    const pendingActionsResponse = await agentApp.request('/api/agent/actions/pending');
    assert.equal(pendingActionsResponse.status, 200);
    const pendingActions = await pendingActionsResponse.json() as { actions: Array<{ id: string; proposer: string }> };
    assert.equal(
      pendingActions.actions.find((action) => action.id === humanPending.action_id)?.proposer,
      'user',
    );
    const humanReplay = payload((await personalCall(token, humanInput)).body);
    assert.equal(humanReplay.action_id, humanPending.action_id);
    const changedHuman = await personalCall(token, { ...humanInput, rows: [{ data: { serial: `CONFLICT-${suffix}` } }] });
    assert.equal(changedHuman.body.isError, true);
    const stored = await client.query('SELECT user_id, agent_employee_id, params FROM agent_actions WHERE id = $1', [humanPending.action_id]);
    assert.equal(stored.rows[0].user_id, ownerId);
    assert.equal(stored.rows[0].agent_employee_id, null);
    assert.equal(stored.rows[0].params.__deft_human_mcp_principal.client_id.length > 0, true);
    assert.equal(stored.rows[0].params.module_name, 'Equipment register');
    assert.equal(stored.rows[0].params.collection_name, 'Assets');
    assert.equal(stored.rows[0].params.source_file_name, undefined);
    assert.doesNotMatch(JSON.stringify(stored.rows[0].params), /MALICIOUS|not-an-attached-file/i);

    const approved = await approveAction(humanPending.action_id, ownerId);
    assert.equal(approved.status, 'approved', approved.message);
    const records = await client.query('SELECT data FROM module_records WHERE org_id = $1 AND is_deleted = false', [orgId]);
    assert.equal(records.rows.length, 1);
    assert.equal(records.rows[0].data.serial, `HUMAN-${suffix}`);
    const receipt = await client.query(
      'SELECT * FROM action_receipts WHERE action_id = $1 AND decision = $2',
      [humanPending.action_id, 'approved'],
    );
    assert.equal(receipt.rows[0].proposer, 'user');
    assert.equal(receipt.rows[0].proposer_id, ownerId);
    assert.equal(await verifyReceipt(receipt.rows[0]), true);
    assert.doesNotMatch(JSON.stringify(receipt.rows[0].action_params_json), /HUMAN-|client_id|rows/i);
    const completedReplay = await personalCall(token, humanInput);
    assert.equal(completedReplay.body.isError, false, completedReplay.body.content[0]?.text);
    assert.equal(payload(completedReplay.body).status, 'completed');

    const rejectedInput = { ...input, idempotency_key: `rejected-${suffix}`, rows: [{ data: { serial: `REJECT-${suffix}` } }] };
    const rejectedProposal = payload((await personalCall(token, rejectedInput)).body);
    assert.equal(rejectedProposal.status, 'pending_approval');
    assert.equal((await rejectAction(rejectedProposal.action_id, ownerId, 'not now')).status, 'rejected');
    const rejectedReplay = await personalCall(token, rejectedInput);
    assert.equal(rejectedReplay.body.isError, true);
    const rejectedAction = await client.query(
      'SELECT approval_status FROM agent_actions WHERE id = $1', [rejectedProposal.action_id],
    );
    assert.equal(rejectedAction.rows[0].approval_status, 'rejected');
    const rejectedReceipt = await client.query(
      'SELECT proposer, proposer_id FROM action_receipts WHERE action_id = $1 AND decision = $2',
      [rejectedProposal.action_id, 'rejected'],
    );
    assert.deepEqual(rejectedReceipt.rows[0], { proposer: 'user', proposer_id: ownerId });

    // A fixture trigger raises only for row one. Each createModuleRecord call
    // commits independently, so row zero must survive for the exact retry.
    const partialKey = `partial-${suffix}`;
    const partialRows = [{ data: { serial: `PARTIAL-A-${suffix}` } }, { data: { serial: `PARTIAL-B-${suffix}` } }];
    await client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id = '${orgId}' AND NEW.data->>'serial' = 'PARTIAL-B-${suffix}' THEN
          RAISE EXCEPTION 'forced second-row bulk failure';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await client.query(`CREATE TRIGGER ${triggerName} AFTER INSERT ON module_records FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    const partialInput = {
      ...input, idempotency_key: partialKey, rows: partialRows,
    };
    const partialResponse = await personalCall(token, partialInput);
    assert.equal(partialResponse.body.isError, false, partialResponse.body.content[0]?.text);
    const partialProposal = payload(partialResponse.body);
    const partialApproval = await approveAction(partialProposal.action_id, ownerId);
    assert.equal(partialApproval.status, 'error');
    const partialAction = await client.query('SELECT result FROM agent_actions WHERE id = $1', [partialProposal.action_id]);
    assert.equal(partialAction.rows[0].result.status, 'partial_failed');
    const firstPartialRow = await client.query(
      "SELECT count(*)::int AS count FROM module_records WHERE org_id = $1 AND data->>'serial' = $2",
      [orgId, `PARTIAL-A-${suffix}`],
    );
    assert.equal(firstPartialRow.rows[0].count, 1);
    await client.query(`DROP TRIGGER ${triggerName} ON module_records`);
    await client.query(`DROP FUNCTION ${functionName}()`);
    const [retryResponse, concurrentRetryResponse] = await Promise.all([
      personalCall(token, partialInput),
      personalCall(token, partialInput),
    ]);
    assert.equal(retryResponse.body.isError, false, retryResponse.body.content[0]?.text);
    assert.equal(concurrentRetryResponse.body.isError, false, concurrentRetryResponse.body.content[0]?.text);
    const retryProposal = payload(retryResponse.body);
    assert.equal(payload(concurrentRetryResponse.body).action_id, retryProposal.action_id);
    assert.equal(retryProposal.status, 'pending_retry_approval');
    assert.notEqual(retryProposal.action_id, partialProposal.action_id);
    const retryRow = await client.query('SELECT params FROM agent_actions WHERE id = $1', [retryProposal.action_id]);
    assert.equal(retryRow.rows[0].params.__deft_bulk_retry_of_action_id, partialProposal.action_id);
    const retryApproval = await approveAction(retryProposal.action_id, ownerId);
    assert.equal(retryApproval.status, 'approved');
    const retryResult = retryApproval.result as { status: string; created: number; replayed: number };
    assert.equal(retryResult.status, 'completed');
    assert.equal(retryResult.created, 1);
    assert.equal(retryResult.replayed, 1);
    const originalAction = await client.query('SELECT result, error FROM agent_actions WHERE id = $1', [partialProposal.action_id]);
    assert.equal(originalAction.rows[0].result.status, 'partial_failed');
    assert.match(originalAction.rows[0].error, /Bulk import stopped at row 2: record creation failed/i);
    assert.doesNotMatch(originalAction.rows[0].error, new RegExp(`PARTIAL-[AB]-${suffix}`));
    const immutablePartialReceipt = await client.query(
      'SELECT result_json, decision_reason FROM action_receipts WHERE action_id = $1 AND decision = $2',
      [partialProposal.action_id, 'approved'],
    );
    assert.equal(immutablePartialReceipt.rows[0].result_json, null);
    assert.match(immutablePartialReceipt.rows[0].decision_reason, /execution failed/i);
    const retryReceipt = await client.query(
      'SELECT * FROM action_receipts WHERE action_id = $1 AND decision = $2',
      [retryProposal.action_id, 'approved'],
    );
    assert.equal(retryReceipt.rows[0].proposer, 'user');
    assert.equal(retryReceipt.rows[0].proposer_id, ownerId);
    assert.equal(await verifyReceipt(retryReceipt.rows[0]), true);
    assert.equal(retryReceipt.rows[0].result_json.status, 'completed');
    const partialRecords = await client.query(
      "SELECT count(*)::int AS count FROM module_records WHERE org_id = $1 AND data->>'serial' LIKE $2",
      [orgId, `PARTIAL-%-${suffix}`],
    );
    assert.equal(partialRecords.rows[0].count, 2);
  } finally {
    await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON module_records`).catch(() => undefined);
    await client.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
    for (const table of ['attention_items', 'action_receipts', 'module_mutation_receipts', 'agent_actions', 'mcp_tokens', 'module_record_relations', 'module_records', 'module_versions', 'module_installations', 'agent_employees', 'org_members']) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    }
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, employeeUserId]]);
    await client.end();
  }
});
