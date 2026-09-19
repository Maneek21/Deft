import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { executeActionDirect } from '../src/lib/agent-actions.js';
import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { closeDb } from '../src/lib/db.js';
import { issueEmployeeToken, issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import { retrieveContext } from '../src/lib/retrieve-context.js';
import { verifyReceipt, type ActionReceipt } from '../src/lib/receipts.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { moduleRoutes } from '../src/routes/modules.js';
import { searchRoutes } from '../src/routes/search.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const TEST_DATABASE_URL = safeTestDatabaseUrl();
const canRun = Boolean(TEST_DATABASE_URL);
const ciRequiresDatabase = /^(?:1|true)$/i.test(process.env.CI ?? '');

after(async () => {
  await closeDb();
});

type ToolResult = {
  isError?: boolean;
  content: Array<{ type?: string; text: string }>;
};

function toolPayload(result: ToolResult): any {
  assert.ok(result.content[0]?.text, 'MCP result must contain a text payload');
  return JSON.parse(result.content[0].text);
}

test(
  'Contacts crosses Defty, universal search, MCP, approvals, REST, audit, disable, and restore',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL,
      'CI must provide matching DEFT_TEST_DATABASE_URL and runtime DATABASE_URL for a disposable PostgreSQL database',
    );

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const orgId = `modules-accept-org-${suffix}`;
    const foreignOrgId = `modules-accept-foreign-org-${suffix}`;
    const ownerId = `modules-accept-owner-${suffix}`;
    const recoveryAdminId = `modules-accept-recovery-admin-${suffix}`;
    const foreignOwnerId = `modules-accept-foreign-owner-${suffix}`;
    const employeeUserId = `modules-accept-shadow-${suffix}`;
    const employeeId = `modules-accept-employee-${suffix}`;
    const employeeSlug = `contacts-accept-${suffix}`;
    const conversationId = `contacts-accept-conversation-${suffix}`;
    const contactName = `Ada Acceptance ${suffix}`;
    const contactEmail = `ada-${suffix}@example.test`;

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    const nativeApp = new Hono();
    nativeApp.use('*', async (c, next) => {
      c.set('user', {
        id: ownerId,
        org_id: orgId,
        email: `owner-${suffix}@example.test`,
        name: 'Modules Acceptance Owner',
        role: 'owner',
      });
      await next();
    });
    nativeApp.route('/api/search', searchRoutes);
    nativeApp.route('/api/modules', moduleRoutes);

    // Use a different admin for lifecycle changes so receipt assertions can
    // distinguish the original human reviewer from the later lifecycle actor.
    const lifecycleApp = new Hono();
    lifecycleApp.use('*', async (c, next) => {
      c.set('user', {
        id: recoveryAdminId,
        org_id: orgId,
        email: `recovery-admin-${suffix}@example.test`,
        name: 'Modules Recovery Admin',
        role: 'admin',
      });
      await next();
    });
    lifecycleApp.route('/api/modules', moduleRoutes);

    const mcpApp = new Hono();
    mcpApp.route('/api/mcp/v1', mcpServerV1Routes);

    const callMcp = async (
      token: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const response = await mcpApp.request('/api/mcp/v1/tools/call', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, arguments: args }),
      });
      assert.equal(response.status, 200, `${name} should reach the MCP adapter`);
      return response.json() as Promise<ToolResult>;
    };

    const nativeJson = async (
      path: string,
      init?: RequestInit,
    ): Promise<{ response: Response; body: any }> => {
      const response = await nativeApp.request(path, init);
      const body = await response.json();
      return { response, body };
    };
    const lifecycleJson = async (
      path: string,
      init?: RequestInit,
    ): Promise<{ response: Response; body: any }> => {
      const response = await lifecycleApp.request(path, init);
      const body = await response.json();
      return { response, body };
    };

    await client.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
      [orgId, `Modules Acceptance ${suffix}`, `modules-accept-${suffix}`],
    );
    await client.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
      [
        foreignOrgId,
        `Modules Acceptance Foreign ${suffix}`,
        `modules-accept-foreign-${suffix}`,
      ],
    );
    await client.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'Modules Acceptance Owner', true),
               ($3, $4, 'Modules Recovery Admin', true),
               ($5, $6, 'Contacts Acceptance Employee', true),
               ($7, $8, 'Foreign Org Owner', true)`,
      [
        ownerId,
        `owner-${suffix}@example.test`,
        recoveryAdminId,
        `recovery-admin-${suffix}@example.test`,
        employeeUserId,
        `employee-${suffix}@example.test`,
        foreignOwnerId,
        `foreign-owner-${suffix}@example.test`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [`modules-accept-member-${suffix}`, orgId, ownerId],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'admin', true)`,
      [`modules-accept-recovery-member-${suffix}`, orgId, recoveryAdminId],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [`modules-accept-foreign-member-${suffix}`, foreignOrgId, foreignOwnerId],
    );
    await client.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         max_daily_actions, daily_action_count, is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Contacts Acceptance Employee', $4, 'custom',
         'Acceptance-test employee', 'conservative', 50, 0, true, true, $5)`,
      [employeeId, orgId, employeeUserId, employeeSlug, ownerId],
    );

    try {
      // Install and configure Contacts through the native lifecycle route.
      const installed = await nativeJson('/api/modules/bundled/contacts/install', {
        method: 'POST',
      });
      assert.equal(installed.response.status, 201);
      assert.equal(installed.body.module.module_id, 'com.deft.contacts');
      const manifestDigest = installed.body.module.manifest_digest as string;

      const configured = await nativeJson('/api/modules/contacts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_access: 'write' }),
      });
      assert.equal(configured.response.status, 200);
      assert.equal(configured.body.module.agent_access, 'write');

      // Defty uses the real direct-execution seam, producing an action row,
      // a module mutation receipt, an audit row, and a signed action receipt.
      const create = await executeActionDirect(
        'module_record_create',
        {
          module_id: 'com.deft.contacts',
          collection_key: 'contacts',
          data: {
            name: contactName,
            company: 'Analytical Engines',
            email: contactEmail,
            status: 'lead',
          },
          expected_manifest_digest: manifestDigest,
          idempotency_key: `defty-create-${suffix}`,
        },
        orgId,
        ownerId,
        conversationId,
        'quick',
        { source: 'agent_chat' },
      );
      assert.equal(create.success, true, create.error);
      assert.equal(create.requiresApproval, undefined);
      assert.equal(create.result.module_id, 'com.deft.contacts');
      assert.equal(create.result.revision, 1);
      assert.equal(JSON.stringify(create.result).includes(contactEmail), false);
      const recordId = create.result.record_id as string;
      const resourceId = `module_record:${recordId}`;

      const deftyRead = await executeToolCall(
        'module_record_get',
        { record_id: recordId },
        orgId,
        ownerId,
        conversationId,
      );
      assert.equal(deftyRead.result.record.data.name, contactName);
      assert.deepEqual(deftyRead.citations.map((citation) => citation.id), [resourceId]);
      assert.equal(deftyRead.citations[0]?.url, `/modules/contacts/contacts/${recordId}`);
      assert.equal(deftyRead.citations[0]?.title, contactName);

      // The universal app search returns the canonical resource id and the
      // generic module deep link, which resolves through the native REST route.
      const universal = await nativeJson(`/api/search?q=${encodeURIComponent(contactName)}`);
      assert.equal(universal.response.status, 200);
      const universalHit = universal.body.modules.find((item: any) => item.id === resourceId);
      assert.ok(universalHit, 'universal search should return the created contact');
      assert.equal(universalHit.url, `/modules/contacts/contacts/${recordId}`);

      const nativeDeepLink = `/api/modules/contacts/records/${recordId}`;
      const nativeRecord = await nativeJson(nativeDeepLink);
      assert.equal(nativeRecord.response.status, 200);
      assert.equal(nativeRecord.body.record.resource_id, resourceId);
      assert.equal(nativeRecord.body.record.data.email, contactEmail);

      // Runtime retrieval is an implicit module_record_search call, so an
      // employee's disabled-tools policy must govern it exactly like explicit
      // MCP discovery. Restore the policy before continuing the native chain.
      const implicitEnabled = await retrieveContext({
        query: contactName,
        org_id: orgId,
        user_id: employeeUserId,
        agent_employee_id: employeeId,
        types: ['modules'],
        hybrid: false,
        limit: 10,
      });
      assert.ok(
        implicitEnabled.some((item) => item.source_id === recordId),
        'enabled implicit retrieval should see the contact',
      );
      await client.query(
        `UPDATE agent_employees
         SET disabled_tools = ARRAY['module_record_search']::text[]
         WHERE id = $1 AND org_id = $2`,
        [employeeId, orgId],
      );
      try {
        const implicitDisabled = await retrieveContext({
          query: contactName,
          org_id: orgId,
          user_id: employeeUserId,
          agent_employee_id: employeeId,
          types: ['modules'],
          hybrid: false,
          limit: 10,
        });
        assert.deepEqual(implicitDisabled, []);
      } finally {
        await client.query(
          `UPDATE agent_employees SET disabled_tools = NULL
           WHERE id = $1 AND org_id = $2`,
          [employeeId, orgId],
        );
      }

      const employeeToken = await issueEmployeeToken(orgId, employeeId);
      const personalToken = (await issuePersonalMcpToken({
        orgId,
        userId: ownerId,
        name: 'Contacts acceptance personal MCP',
        scopes: ['read:workspace', 'write:workspace', 'read:modules', 'write:modules', 'write:tasks'],
        createdBy: ownerId,
      })).raw;

      // Generic human MCP search -> fetch is a real resource-id round trip.
      const humanSearch = await callMcp(personalToken, 'search', {
        query: contactName,
        limit: 10,
      });
      assert.notEqual(humanSearch.isError, true);
      const humanHit = toolPayload(humanSearch).find((item: any) => item.id === resourceId);
      assert.ok(humanHit, 'human MCP search should return the contact');
      const humanFetch = await callMcp(personalToken, 'fetch', { id: humanHit.id });
      assert.notEqual(humanFetch.isError, true);
      assert.equal(toolPayload(humanFetch).data.email, contactEmail);

      // A Conservative employee cannot bypass review: the real employee MCP
      // route queues the update, and the real human approval tool executes it.
      const queuedUpdate = await callMcp(employeeToken, 'module_record_update', {
        caller_employee_slug: employeeSlug,
        record_id: recordId,
        patch: { status: 'active', role: 'Computing pioneer' },
        unset_fields: [],
        expected_revision: 1,
        expected_manifest_digest: manifestDigest,
        idempotency_key: `employee-update-${suffix}`,
      });
      assert.notEqual(queuedUpdate.isError, true);
      const approvalId = toolPayload(queuedUpdate).approval_id as string;
      assert.match(approvalId, /\S+/);

      const beforeApproval = await nativeJson(nativeDeepLink);
      assert.equal(beforeApproval.body.record.revision, 1);
      assert.equal(beforeApproval.body.record.data.status, 'lead');

      const approved = await callMcp(personalToken, 'approval_approve', {
        action_id: approvalId,
        idempotency_key: `approve-update-${suffix}`,
      });
      assert.notEqual(approved.isError, true);
      assert.equal(toolPayload(approved).status, 'approved');

      const finalNative = await nativeJson(nativeDeepLink);
      assert.equal(finalNative.response.status, 200);
      assert.equal(finalNative.body.record.revision, 2);
      assert.equal(finalNative.body.record.data.status, 'active');
      assert.equal(finalNative.body.record.data.role, 'Computing pioneer');
      const stableSnapshot = {
        data: finalNative.body.record.data,
        revision: finalNative.body.record.revision,
        archived_at: finalNative.body.record.archived_at,
      };

      // Both the Defty auto-execution and reviewed employee mutation have a
      // tamper-evident signed receipt and actor-linked module audit evidence.
      const receiptRows = await client.query(
        `SELECT * FROM action_receipts
         WHERE org_id = $1 AND action_id = ANY($2::text[])
         ORDER BY created_at`,
        [orgId, [create.actionId, approvalId]],
      );
      assert.equal(receiptRows.rows.length, 2);
      assert.deepEqual(
        receiptRows.rows.map((row) => row.decision).sort(),
        ['approved', 'auto_executed'],
      );
      for (const receipt of receiptRows.rows) {
        assert.match(receipt.signature_hmac, /^[a-f0-9]{64}$/);
        assert.equal(await verifyReceipt(receipt as ActionReceipt), true);
        assert.equal(JSON.stringify(receipt.action_params_json).includes(contactEmail), false);
      }
      const initialAutoReceipt = receiptRows.rows.find((row) => row.action_id === create.actionId);
      const initialHumanReceipt = receiptRows.rows.find((row) => row.action_id === approvalId);
      assert.equal(initialAutoReceipt?.decision, 'auto_executed');
      assert.equal(initialAutoReceipt?.approver_id, null);
      assert.equal(initialHumanReceipt?.decision, 'approved');
      assert.equal(initialHumanReceipt?.approver_id, ownerId);

      // Terminal receipt repair is a write, not a read. Even an owner of a
      // different organization must not repair an absent receipt or touch
      // Attention/WorkIntent state through approve/reject retries.
      await client.query('DELETE FROM action_receipts WHERE action_id = $1', [create.actionId]);
      const terminalSideEffects = async () => (await client.query(
        `SELECT
           (SELECT count(*)::int FROM action_receipts WHERE action_id = $1) AS receipts,
           (SELECT count(*)::int FROM attention_items
             WHERE org_id = $2 AND source_type = 'agent_action' AND source_id = $1) AS attention,
           (SELECT count(*)::int FROM work_intents
             WHERE org_id = $2 AND converted_action_id = $1) AS work_intents,
           (SELECT count(*)::int FROM agent_actions
             WHERE id = $1 AND org_id = $2 AND approval_status = 'approved'
               AND executed_at IS NOT NULL) AS terminal_actions`,
        [create.actionId, orgId],
      )).rows[0];
      const beforeForbiddenRepair = await terminalSideEffects();
      const forbiddenApprove = await approveAction(create.actionId, foreignOwnerId);
      assert.equal(forbiddenApprove.status, 'error');
      assert.equal('code' in forbiddenApprove ? forbiddenApprove.code : null, 'FORBIDDEN');
      const forbiddenReject = await rejectAction(
        create.actionId,
        foreignOwnerId,
        'cross-org retry must not repair',
      );
      assert.equal(forbiddenReject.status, 'error');
      assert.equal('code' in forbiddenReject ? forbiddenReject.code : null, 'FORBIDDEN');
      assert.deepEqual(await terminalSideEffects(), beforeForbiddenRepair);
      assert.equal(beforeForbiddenRepair.receipts, 0);
      assert.equal(beforeForbiddenRepair.terminal_actions, 1);

      // Authorized concurrent approve retries repair exactly one receipt while
      // preserving the original automatic decision and its null approver.
      const autoRepairResults = await Promise.all(
        Array.from({ length: 4 }, () => approveAction(create.actionId, recoveryAdminId)),
      );
      assert.ok(autoRepairResults.every((result) => result.status === 'approved'));
      const autoRepairReceipt = await client.query(
        `SELECT * FROM action_receipts WHERE action_id = $1 ORDER BY created_at`,
        [create.actionId],
      );
      assert.equal(autoRepairReceipt.rows.length, 1);
      assert.equal(autoRepairReceipt.rows[0].decision, 'auto_executed');
      assert.equal(autoRepairReceipt.rows[0].approver_id, null);
      assert.equal(await verifyReceipt(autoRepairReceipt.rows[0] as ActionReceipt), true);

      const auditRows = await client.query(
        `SELECT action, entity_id, metadata
         FROM audit_log
         WHERE org_id = $1 AND action LIKE 'module_record.%'
         ORDER BY created_at`,
        [orgId],
      );
      assert.equal(auditRows.rows.length, 2);
      assert.ok(auditRows.rows.every((row) => row.entity_id === resourceId));
      assert.deepEqual(
        auditRows.rows.map((row) => row.metadata.action_id),
        [create.actionId, approvalId],
      );

      // Crash recovery: an action whose approval commit landed but whose
      // execution stamp did not must resume exactly once through approveAction.
      const recoveryName = `Grace Recovery ${suffix}`;
      const recoveryActionId = randomUUID();
      await client.query(
        `INSERT INTO agent_actions
          (id, org_id, user_id, source, action, params, approval_tier,
           approval_status, approved_at, approved_by_user_id, executed_at)
         VALUES ($1, $2, $3, 'agent_chat', 'module_record_create', $4::jsonb,
           'quick', 'approved', NOW(), $5, NULL)`,
        [
          recoveryActionId,
          orgId,
          ownerId,
          JSON.stringify({
            module_id: 'com.deft.contacts',
            collection_key: 'contacts',
            data: { name: recoveryName, email: `recovery-${suffix}@example.test` },
            expected_manifest_digest: manifestDigest,
            idempotency_key: `approval-recovery-${suffix}`,
          }),
          ownerId,
        ],
      );
      // Admin A's durable claim must remain the receipt approver even though
      // Admin B is the process/user that resumes execution after the crash.
      const recovered = await approveAction(recoveryActionId, recoveryAdminId);
      assert.equal(recovered.status, 'approved');

      const recoveryState = await client.query(
        `SELECT
           (SELECT count(*)::int FROM module_records
             WHERE org_id = $1 AND data->>'name' = $2) AS records,
           (SELECT count(*)::int FROM module_mutation_receipts mmr
             JOIN module_records mr ON mr.id = mmr.record_id AND mr.org_id = mmr.org_id
             WHERE mmr.org_id = $1 AND mr.data->>'name' = $2) AS mutation_receipts,
           (SELECT count(*)::int FROM action_receipts
             WHERE org_id = $1 AND action_id = $3) AS action_receipts,
           (SELECT approver_id FROM action_receipts
             WHERE org_id = $1 AND action_id = $3 LIMIT 1) AS receipt_approver,
           (SELECT count(*)::int FROM agent_actions
             WHERE org_id = $1 AND id = $3 AND approval_status = 'approved'
               AND executed_at IS NOT NULL) AS completed_actions`,
        [orgId, recoveryName, recoveryActionId],
      );
      assert.deepEqual(recoveryState.rows[0], {
        records: 1,
        mutation_receipts: 1,
        action_receipts: 1,
        receipt_approver: ownerId,
        completed_actions: 1,
      });
      const recoveryReceipt = await client.query(
        `SELECT decision, approver_id FROM action_receipts WHERE action_id = $1`,
        [recoveryActionId],
      );
      assert.deepEqual(recoveryReceipt.rows, [{ decision: 'approved', approver_id: ownerId }]);

      // Receipt-overlay recovery is also exact-once: if the mutation executed
      // but its signed receipt was lost, concurrent approval retries repair
      // one receipt without re-running the durable module mutation.
      await client.query('DELETE FROM action_receipts WHERE action_id = $1', [recoveryActionId]);
      const repairResults = await Promise.all(
        Array.from({ length: 5 }, () => approveAction(recoveryActionId, recoveryAdminId)),
      );
      assert.ok(repairResults.every((result) => result.status === 'approved'));
      const repaired = await client.query(
        `SELECT
           (SELECT count(*)::int FROM module_records
             WHERE org_id = $1 AND data->>'name' = $2) AS records,
           (SELECT count(*)::int FROM module_mutation_receipts mmr
             JOIN module_records mr ON mr.id = mmr.record_id AND mr.org_id = mmr.org_id
             WHERE mmr.org_id = $1 AND mr.data->>'name' = $2) AS mutation_receipts,
           (SELECT count(*)::int FROM action_receipts
             WHERE org_id = $1 AND action_id = $3) AS action_receipts,
           (SELECT approver_id FROM action_receipts
             WHERE org_id = $1 AND action_id = $3 LIMIT 1) AS receipt_approver`,
        [orgId, recoveryName, recoveryActionId],
      );
      assert.deepEqual(repaired.rows[0], {
        records: 1,
        mutation_receipts: 1,
        action_receipts: 1,
        receipt_approver: ownerId,
      });
      const [repairedReceipt] = await client.query(
        'SELECT * FROM action_receipts WHERE action_id = $1',
        [recoveryActionId],
      ).then((result) => result.rows);
      assert.equal(await verifyReceipt(repairedReceipt as ActionReceipt), true);

      // Simulate the crash window where each durable mutation committed but
      // its action stamp and overlay receipt did not. Lifecycle disable must
      // recover both truths: automatic stays auto_executed/null approver, and
      // human-approved keeps Admin A rather than the later lifecycle admin.
      await client.query(
        `DELETE FROM action_receipts WHERE action_id = ANY($1::text[])`,
        [[create.actionId, approvalId]],
      );
      await client.query(
        `UPDATE agent_actions
         SET executed_at = NULL, result = NULL, after_state = NULL
         WHERE org_id = $1 AND id = ANY($2::text[])`,
        [orgId, [create.actionId, approvalId]],
      );

      // Disable is a reversible visibility boundary, not a data mutation.
      const disabled = await lifecycleJson('/api/modules/contacts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(disabled.response.status, 200);
      assert.equal(disabled.body.module.enabled, false);

      const lifecycleReceipts = await client.query(
        `SELECT * FROM action_receipts
         WHERE action_id = ANY($1::text[])
         ORDER BY action_id`,
        [[create.actionId, approvalId]],
      );
      assert.equal(lifecycleReceipts.rows.length, 2);
      const lifecycleAuto = lifecycleReceipts.rows.find((row) => row.action_id === create.actionId);
      const lifecycleHuman = lifecycleReceipts.rows.find((row) => row.action_id === approvalId);
      assert.equal(lifecycleAuto?.decision, 'auto_executed');
      assert.equal(lifecycleAuto?.approver_id, null);
      assert.equal(lifecycleHuman?.decision, 'approved');
      assert.equal(lifecycleHuman?.approver_id, ownerId);
      for (const receipt of lifecycleReceipts.rows) {
        assert.equal(await verifyReceipt(receipt as ActionReceipt), true);
      }
      const lifecycleRecoveredActions = await client.query(
        `SELECT count(*)::int AS count FROM agent_actions
         WHERE org_id = $1 AND id = ANY($2::text[])
           AND approval_status = 'approved' AND executed_at IS NOT NULL
           AND result IS NOT NULL`,
        [orgId, [create.actionId, approvalId]],
      );
      assert.equal(lifecycleRecoveredActions.rows[0].count, 2);

      const disabledUniversal = await nativeJson(`/api/search?q=${encodeURIComponent(contactName)}`);
      assert.equal(disabledUniversal.body.modules.some((item: any) => item.id === resourceId), false);

      const disabledNative = await nativeJson(nativeDeepLink);
      assert.equal(disabledNative.response.status, 409);
      assert.equal(disabledNative.body.code, 'MODULE_DISABLED');

      const disabledHumanSearch = await callMcp(personalToken, 'search', {
        query: contactName,
        limit: 10,
      });
      assert.equal(toolPayload(disabledHumanSearch).some((item: any) => item.id === resourceId), false);
      const disabledHumanFetch = await callMcp(personalToken, 'fetch', { id: resourceId });
      assert.equal(disabledHumanFetch.isError, true);
      assert.match(disabledHumanFetch.content[0]!.text, /MODULE_DISABLED/);

      const disabledEmployeeRead = await callMcp(employeeToken, 'module_record_get', {
        caller_employee_slug: employeeSlug,
        record_id: recordId,
      });
      assert.equal(disabledEmployeeRead.isError, true);
      assert.match(disabledEmployeeRead.content[0]!.text, /MODULE_DISABLED/);

      await assert.rejects(
        () => executeToolCall(
          'module_record_get',
          { record_id: recordId },
          orgId,
          ownerId,
          conversationId,
        ),
        /disabled/i,
      );

      const storedWhileDisabled = await client.query(
        `SELECT data, revision, deleted_at AS archived_at
         FROM module_records WHERE org_id = $1 AND id = $2`,
        [orgId, recordId],
      );
      assert.deepEqual(storedWhileDisabled.rows[0], stableSnapshot);

      const reenabled = await nativeJson('/api/modules/contacts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(reenabled.response.status, 200);
      assert.equal(reenabled.body.module.enabled, true);

      const restored = await nativeJson(nativeDeepLink);
      assert.equal(restored.response.status, 200);
      assert.deepEqual({
        data: restored.body.record.data,
        revision: restored.body.record.revision,
        archived_at: restored.body.record.archived_at,
      }, stableSnapshot);

      const restoredUniversal = await nativeJson(`/api/search?q=${encodeURIComponent(contactName)}`);
      assert.equal(restoredUniversal.body.modules.some((item: any) => item.id === resourceId), true);
      const restoredFetch = await callMcp(personalToken, 'fetch', { id: resourceId });
      assert.notEqual(restoredFetch.isError, true);
      assert.equal(toolPayload(restoredFetch).revision, 2);

      // Flagship outreach uses the same contact identity and governed native
      // record path. This deterministic tool journey does not call an LLM or
      // an email provider and must not be described as a live-agent demo.
      const crmSchema = await executeToolCall(
        'module_schema_get', { module_id: 'com.deft.contacts' }, orgId, ownerId, conversationId,
      );
      const outreachCollection = crmSchema.result.manifest.collections.find((collection: any) => collection.key === 'outreach');
      assert.ok(outreachCollection, 'agent schema must expose canonical outreach drafts');
      assert.ok(outreachCollection.fields.some((field: any) => field.key === 'contacts' && field.target_collection === 'contacts'));
      const currentDigest = crmSchema.result.manifest_digest;
      const draftName = `Reviewed CRM introduction ${suffix}`;
      const draftInput = {
        caller_employee_slug: employeeSlug,
        module_id: 'com.deft.contacts', collection_key: 'outreach',
        data: { name: draftName, subject: 'A useful next step', body: 'Hello Ada, let us discuss the next step.', status: 'draft' },
        relations: { contacts: [recordId] },
        expected_manifest_digest: currentDigest,
        idempotency_key: `crm-draft-${suffix}`,
      };
      const draftCount = async () => (await client.query(
        "SELECT count(*)::int AS count FROM module_records WHERE org_id=$1 AND collection_key='outreach'",
        [orgId],
      )).rows[0].count;
      const beforeDrafts = await draftCount();
      const proposedDraft = await callMcp(employeeToken, 'module_record_create', draftInput);
      assert.notEqual(proposedDraft.isError, true, JSON.stringify(proposedDraft));
      const draftApprovalId = toolPayload(proposedDraft).approval_id;
      assert.ok(draftApprovalId, 'conservative employee must propose the draft for review');
      assert.equal(await draftCount(), beforeDrafts, 'proposal must not create the draft before approval');
      const draftApproval = await callMcp(personalToken, 'approval_approve', {
        action_id: draftApprovalId, idempotency_key: `approve-crm-draft-${suffix}`,
      });
      assert.notEqual(draftApproval.isError, true, JSON.stringify(draftApproval));
      const draftReplay = await callMcp(employeeToken, 'module_record_create', draftInput);
      assert.notEqual(draftReplay.isError, true, JSON.stringify(draftReplay));
      const draftId = toolPayload(draftReplay).record_id;
      assert.ok(draftId);
      assert.equal(await draftCount(), beforeDrafts + 1);
      const draftRead = await executeToolCall('module_record_get', { record_id: draftId }, orgId, ownerId, conversationId);
      assert.equal(draftRead.result.record.data.subject, draftInput.data.subject);
      assert.equal(draftRead.result.record.data.body, draftInput.data.body);
      assert.deepEqual(draftRead.result.record.relations[0].records.map((record: any) => record.id), [recordId]);
      assert.deepEqual(draftRead.citations.map((citation) => citation.id), [`module_record:${draftId}`]);
      const sharedDraft = await nativeJson(`/api/modules/contacts/records/${draftId}`);
      assert.equal(sharedDraft.response.status, 200);
      assert.deepEqual(sharedDraft.body.record.data, draftRead.result.record.data);
      const draftReceipts = await client.query('SELECT * FROM action_receipts WHERE org_id=$1 AND action_id=$2', [orgId, draftApprovalId]);
      assert.equal(draftReceipts.rows.length, 1);
      assert.equal(await verifyReceipt(draftReceipts.rows[0] as ActionReceipt), true);
      assert.equal(JSON.stringify(draftReceipts.rows[0].action_params_json).includes(draftInput.data.body), false);

      const followupProjectId = randomUUID();
      await client.query('INSERT INTO projects (id,org_id,name,prefix) VALUES ($1,$2,$3,$4)',
        [followupProjectId, orgId, 'CRM follow-ups', 'CRM']);
      const proposedTask = await callMcp(employeeToken, 'task_create', {
        caller_employee_slug: employeeSlug, title: 'Confirm the next CRM conversation',
        project_id: followupProjectId, assignee_id: ownerId, due_date: '2026-10-01',
        description: `Follow up with ${contactName}. Source: /modules/contacts/contacts/${recordId}`,
      });
      assert.notEqual(proposedTask.isError, true, JSON.stringify(proposedTask));
      const taskApprovalId = toolPayload(proposedTask).approval_id;
      assert.ok(taskApprovalId);
      const taskRows = () => client.query('SELECT *, due_date::date::text AS due_day FROM tasks WHERE org_id=$1 AND project_id=$2', [orgId, followupProjectId]);
      assert.equal((await taskRows()).rowCount, 0, 'task remains a proposal before approval');
      const taskApproved = await callMcp(personalToken, 'approval_approve', {
        action_id: taskApprovalId, idempotency_key: `approve-followup-${suffix}`,
      });
      assert.notEqual(taskApproved.isError, true, JSON.stringify(taskApproved));
      const createdTasks = await taskRows();
      assert.equal(createdTasks.rowCount, 1);
      const followup = createdTasks.rows[0];
      assert.equal(followup.assignee_id, ownerId);
      assert.equal(followup.due_day, '2026-10-01');
      const linkInput = { resource_id: resourceId, task_identifier: followup.id, idempotency_key: `link-followup-${suffix}` };
      const linkProposal = await executeActionDirect('module_record_task_link', linkInput,
        orgId, ownerId, conversationId, 'quick', { source: 'agent_chat', agentEmployeeId: employeeId });
      assert.equal(linkProposal.requiresApproval, true);
      assert.equal((await client.query('SELECT id FROM cross_references WHERE org_id=$1 AND target_id=$2', [orgId, followup.id])).rowCount, 0);
      const linkApproved = await approveAction(linkProposal.actionId, ownerId);
      assert.equal(linkApproved.status, 'approved');
      const linkReplay = await executeActionDirect('module_record_task_link', linkInput,
        orgId, ownerId, conversationId, 'quick', { source: 'agent_chat', agentEmployeeId: employeeId });
      assert.equal(linkReplay.actionId, linkProposal.actionId);
      assert.equal(linkReplay.success, true, linkReplay.error);
      assert.equal((await client.query('SELECT id FROM cross_references WHERE org_id=$1 AND target_id=$2', [orgId, followup.id])).rowCount, 1);
      const linkedWork = await executeToolCall('module_record_task_links', { resource_id: resourceId }, orgId, ownerId, conversationId, employeeId);
      assert.equal(linkedWork.result.tasks[0].task_id, followup.id);
      assert.deepEqual(linkedWork.citations.map(citation => citation.id), [followup.id]);
      await client.query('UPDATE agent_employees SET project_ids=$1 WHERE id=$2', [[randomUUID()], employeeId]);
      const revokedWork = await executeToolCall('module_record_task_links', { resource_id: resourceId }, orgId, ownerId, conversationId, employeeId);
      assert.deepEqual(revokedWork.result.tasks, []);
      assert.deepEqual(revokedWork.citations, []);
      const ownerWork = await executeToolCall('module_record_task_links', { resource_id: resourceId }, orgId, ownerId, conversationId);
      assert.equal(ownerWork.result.tasks[0].task_id, followup.id, 'employee scope does not remove shared human work');
      // Hidden canonical Defty uses the same identity exception as tool policy.
      // A deleted ordinary employee or runtime-kind-only impostor stays denied.
      const { listModuleRecordTaskLinks } = await import('../src/lib/module-task-links.js');
      const { employeeModuleActor } = await import('../src/lib/module-service.js');
      const hiddenActor = employeeModuleActor({ orgId, employeeId, trustLevel: 'conservative' });
      await client.query('UPDATE agent_employees SET project_ids=NULL,is_deleted=true WHERE id=$1', [employeeId]);
      await assert.rejects(listModuleRecordTaskLinks(hiddenActor, 'contacts', recordId));
      await client.query("UPDATE agent_employees SET runtime_kind='defty_system',is_byoa=false WHERE id=$1", [employeeId]);
      await assert.rejects(listModuleRecordTaskLinks(hiddenActor, 'contacts', recordId));
      await client.query("UPDATE agent_employees SET slug='defty-system' WHERE id=$1", [employeeId]);
      const canonicalWork = await listModuleRecordTaskLinks(hiddenActor, 'contacts', recordId);
      assert.equal(canonicalWork[0]?.task_id, followup.id);



    } catch (error) {
      console.error('CRM agent acceptance assertion:', error);
      throw error;
    } finally {
      try {
        // Delete only this test's unique tenant, in dependency order.
        await client.query('DELETE FROM attention_deliveries WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM attention_events WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM attention_items WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM action_receipts WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM agent_mcp_call_audit WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM oauth_audit_events WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM mcp_tokens WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM cross_references WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM task_activity WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM job_queue WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM tasks WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM projects WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM module_record_relations WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM module_records WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM module_versions WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM module_installations WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM audit_log WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM agent_employees WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]);
        await client.query('DELETE FROM org_members WHERE org_id = $1', [foreignOrgId]);
        await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
        await client.query('DELETE FROM orgs WHERE id = $1', [foreignOrgId]);
        await client.query(
          'DELETE FROM users WHERE id = ANY($1::text[])',
          [[ownerId, recoveryAdminId, employeeUserId, foreignOwnerId]],
        );
      } finally {
        await client.end();
      }
    }
  },
);
