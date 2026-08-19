import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import type { DeftModuleManifestV1Input } from '@deft/shared/modules';
import { executeToolCall } from '../src/lib/agent-context.js';
import { closeDb } from '../src/lib/db.js';
import { issueEmployeeToken, issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { moduleRoutes } from '../src/routes/modules.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

function isSafeTestDatabase(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return /(?:test|ci|acceptance)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

const canRun = isSafeTestDatabase(TEST_DATABASE_URL);

after(async () => {
  await closeDb();
});

type ToolResult = {
  isError?: boolean;
  content: Array<{ type?: string; text: string }>;
};

function toolPayload(result: ToolResult): any {
  assert.ok(result.content[0]?.text, 'MCP result must contain text');
  return JSON.parse(result.content[0].text);
}

function assetRegisterManifest(): DeftModuleManifestV1Input {
  return {
    schema_version: '1',
    id: 'ing.deft.tests.asset-register',
    slug: 'asset-register',
    version: '1.0.0',
    name: 'Asset register',
    collections: [
      {
        key: 'assets',
        name: 'Assets',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'owner_id', label: 'Owner', type: 'member' },
          {
            key: 'site_id',
            label: 'Site',
            type: 'relation',
            target_collection: 'sites',
          },
        ],
        search: { title_field: 'name', fields: ['name', 'status'] },
      },
      {
        key: 'sites',
        name: 'Sites',
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
        search: { title_field: 'name', fields: ['name'] },
      },
    ],
  };
}

test('generic relation writes share governed MCP/Defty/REST record semantics', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const orgId = `module-rel-agent-org-${suffix}`;
  const foreignOrgId = `module-rel-agent-foreign-org-${suffix}`;
  const ownerId = `module-rel-agent-owner-${suffix}`;
  const foreignOwnerId = `module-rel-agent-foreign-owner-${suffix}`;
  const employeeUserId = `module-rel-agent-shadow-${suffix}`;
  const employeeId = `module-rel-agent-employee-${suffix}`;
  const employeeSlug = `asset-agent-${suffix}`;
  const manifest = assetRegisterManifest();

  const nativeApp = new Hono();
  nativeApp.use('*', async (c, next) => {
    c.set('user', {
      id: ownerId,
      org_id: orgId,
      email: `owner-${suffix}@example.test`,
      name: 'Asset Register Owner',
      role: 'owner',
    });
    await next();
  });
  nativeApp.route('/api/modules', moduleRoutes);

  const mcpApp = new Hono();
  mcpApp.route('/api/mcp/v1', mcpServerV1Routes);
  const callMcp = async (
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const response = await mcpApp.request('/api/mcp/v1/tools/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    assert.equal(response.status, 200, `${name} should reach its MCP adapter`);
    return response.json() as Promise<ToolResult>;
  };

  await client.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)`,
    [
      orgId,
      `Module Relations ${suffix}`,
      `module-relations-${suffix}`,
      foreignOrgId,
      `Foreign Module Relations ${suffix}`,
      `foreign-module-relations-${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO users (id, email, name, email_verified)
     VALUES ($1, $2, 'Asset Register Owner', true),
            ($3, $4, 'Asset Register Employee', true),
            ($5, $6, 'Foreign Asset Owner', true)`,
    [
      ownerId,
      `owner-${suffix}@example.test`,
      employeeUserId,
      `employee-${suffix}@example.test`,
      foreignOwnerId,
      `foreign-owner-${suffix}@example.test`,
    ],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true), ($4, $5, $6, 'owner', true)`,
    [
      `module-rel-agent-member-${suffix}`,
      orgId,
      ownerId,
      `module-rel-agent-foreign-member-${suffix}`,
      foreignOrgId,
      foreignOwnerId,
    ],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
       max_daily_actions, daily_action_count, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Asset Register Employee', $4, 'custom',
       'Generic module relation test', 'conservative', 50, 0, true, true, $5)`,
    [employeeId, orgId, employeeUserId, employeeSlug, ownerId],
  );

  try {
    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const foreignOwner = humanModuleActor({
      orgId: foreignOrgId,
      userId: foreignOwnerId,
      role: 'owner',
      source: 'rest',
    });
    const installed = await installModuleFromManifest(owner, manifest, { source: 'sideloaded' });
    await updateModuleInstallation(owner, manifest.slug, { agent_access: 'write' });
    const foreignInstalled = await installModuleFromManifest(foreignOwner, manifest, { source: 'sideloaded' });

    const site = await createModuleRecord(owner, {
      module_id: manifest.id,
      collection_key: 'sites',
      data: { name: 'London Lab' },
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: `site-${suffix}`,
    });
    const wrongCollection = await createModuleRecord(owner, {
      module_id: manifest.id,
      collection_key: 'assets',
      data: { name: 'Wrong target asset' },
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: `wrong-target-${suffix}`,
    });
    const source = await createModuleRecord(owner, {
      module_id: manifest.id,
      collection_key: 'assets',
      data: { name: 'Difference Engine', status: 'commissioning', owner_id: ownerId },
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: `asset-${suffix}`,
    });
    const secondSource = await createModuleRecord(owner, {
      module_id: manifest.id,
      collection_key: 'assets',
      data: { name: 'Difference Engine Mk II', status: 'active', owner_id: ownerId },
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: `asset-second-${suffix}`,
    });
    const foreignSite = await createModuleRecord(foreignOwner, {
      module_id: manifest.id,
      collection_key: 'sites',
      data: { name: 'Foreign Site' },
      expected_manifest_digest: foreignInstalled.manifest_digest,
      idempotency_key: `foreign-site-${suffix}`,
    });
    assert.ok(site.record && wrongCollection.record && source.record && secondSource.record && foreignSite.record);

    const employeeToken = await issueEmployeeToken(orgId, employeeId);
    const personalToken = (await issuePersonalMcpToken({
      orgId,
      userId: ownerId,
      name: 'Module relation integration',
      scopes: ['read:workspace', 'write:workspace', 'read:modules', 'write:modules'],
      createdBy: ownerId,
    })).raw;
    const relationInput = {
      caller_employee_slug: employeeSlug,
      record_id: source.record.id,
      patch: { status: 'active' },
      unset_fields: [],
      relations: { site_id: [site.record.id] },
      expected_revision: 1,
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: `governed-relation-${suffix}`,
    };

    const proposed = await callMcp(employeeToken, 'module_record_update', relationInput);
    assert.notEqual(proposed.isError, true);
    const approvalId = toolPayload(proposed).approval_id as string;
    assert.match(approvalId, /\S+/);
    const beforeApproval = await client.query(
      `SELECT revision, data,
        (SELECT count(*)::int FROM module_record_relations
         WHERE org_id = $1 AND source_record_id = $2 AND is_deleted = false) AS relations
       FROM module_records WHERE org_id = $1 AND id = $2`,
      [orgId, source.record.id],
    );
    assert.equal(beforeApproval.rows[0].revision, 1);
    assert.equal(beforeApproval.rows[0].data.status, 'commissioning');
    assert.equal(beforeApproval.rows[0].relations, 0);

    const approved = await callMcp(personalToken, 'approval_approve', {
      action_id: approvalId,
      idempotency_key: `approve-${suffix}`,
    });
    assert.notEqual(approved.isError, true);
    assert.equal(toolPayload(approved).status, 'approved');

    const nativeResponse = await nativeApp.request(
      `/api/modules/${manifest.slug}/records/${source.record.id}`,
    );
    assert.equal(nativeResponse.status, 200);
    const nativeRecord = (await nativeResponse.json() as any).record;
    assert.equal(nativeRecord.revision, 2);
    assert.equal(nativeRecord.data.status, 'active');
    assert.deepEqual(nativeRecord.relations, [{
      field_key: 'site_id',
      records: [{ id: site.record.id, collection_key: 'sites', label: 'London Lab' }],
    }]);
    assert.deepEqual(nativeRecord.members, [{
      field_key: 'owner_id',
      members: [{ id: ownerId, label: 'Asset Register Owner' }],
    }]);

    const firstQueryPage = await nativeApp.request(`/api/modules/${manifest.slug}/records/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection_key: 'assets',
        search: 'Difference Engine',
        filters: [{ field: 'status', operator: 'eq', value: 'active' }],
        sort: { field: 'name', direction: 'asc' },
        limit: 1,
      }),
    });
    assert.equal(firstQueryPage.status, 200);
    const firstPage = await firstQueryPage.json() as any;
    assert.equal(firstPage.records[0].id, source.record.id);
    assert.deepEqual(firstPage.records[0].relations, nativeRecord.relations);
    assert.deepEqual(firstPage.records[0].members, nativeRecord.members);
    assert.match(firstPage.next_cursor, /\S+/);

    const secondQueryPage = await nativeApp.request(`/api/modules/${manifest.slug}/records/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection_key: 'assets',
        search: 'Difference Engine',
        filters: [{ field: 'status', operator: 'eq', value: 'active' }],
        sort: { field: 'name', direction: 'asc' },
        limit: 1,
        cursor: firstPage.next_cursor,
      }),
    });
    assert.equal(secondQueryPage.status, 200);
    const secondPage = await secondQueryPage.json() as any;
    assert.equal(secondPage.records[0].id, secondSource.record.id);
    assert.equal(secondPage.next_cursor, null);

    const employeeRead = await callMcp(employeeToken, 'module_record_get', {
      caller_employee_slug: employeeSlug,
      record_id: source.record.id,
    });
    assert.notEqual(employeeRead.isError, true);
    assert.deepEqual(toolPayload(employeeRead).record.relations, nativeRecord.relations);
    assert.deepEqual(toolPayload(employeeRead).record.members, nativeRecord.members);

    const employeeQuery = await callMcp(employeeToken, 'module_record_query', {
      caller_employee_slug: employeeSlug,
      module_id: manifest.id,
      collection_key: 'assets',
      filters: [{ field: 'name', operator: 'eq', value: 'Difference Engine' }],
      limit: 10,
    });
    assert.notEqual(employeeQuery.isError, true);
    const queriedSource = toolPayload(employeeQuery).items.find(
      (record: any) => record.id === source.record!.id,
    );
    assert.deepEqual(queriedSource.relations, nativeRecord.relations);
    assert.deepEqual(queriedSource.members, nativeRecord.members);

    const humanRead = await callMcp(personalToken, 'module_record_get', {
      record_id: source.record.id,
    });
    assert.notEqual(humanRead.isError, true);
    assert.deepEqual(toolPayload(humanRead).record.relations, nativeRecord.relations);

    const deftyRead = await executeToolCall(
      'module_record_get',
      { record_id: source.record.id },
      orgId,
      ownerId,
      `module-relations-conversation-${suffix}`,
    );
    assert.deepEqual(deftyRead.result.record.relations, nativeRecord.relations);
    assert.deepEqual(deftyRead.result.record.members, nativeRecord.members);

    const [beforeReplayAction] = (await client.query(
      `SELECT params, result, approval_status, agent_employee_id
       FROM agent_actions WHERE id = $1 AND org_id = $2`,
      [approvalId, orgId],
    )).rows;
    assert.match(beforeReplayAction.params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(beforeReplayAction.params.input_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(beforeReplayAction.approval_status, 'approved');
    assert.equal(beforeReplayAction.agent_employee_id, employeeId);

    const replay = await callMcp(employeeToken, 'module_record_update', relationInput);
    assert.notEqual(replay.isError, true, JSON.stringify(toolPayload(replay)));
    const replayPayload = toolPayload(replay);
    const [terminalAction] = (await client.query(
      `SELECT params, result FROM agent_actions WHERE id = $1 AND org_id = $2`,
      [approvalId, orgId],
    )).rows;
    assert.deepEqual(replayPayload, { ...terminalAction.result, replayed: true });
    assert.deepEqual(terminalAction.params.changed_fields, ['site_id', 'status']);
    assert.equal(JSON.stringify(terminalAction.params).includes(site.record.id), false);

    const relationAudit = await client.query(
      `SELECT before_state, after_state, metadata FROM audit_log
       WHERE org_id = $1 AND entity_id = $2 AND action = 'module_record.update'`,
      [orgId, source.record.resource_id],
    );
    assert.equal(relationAudit.rows.length, 1);
    assert.deepEqual(relationAudit.rows[0].metadata.changed_fields, ['site_id', 'status']);
    assert.deepEqual(relationAudit.rows[0].metadata.relation_fields, ['site_id']);
    assert.match(relationAudit.rows[0].before_state.relations_digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(relationAudit.rows[0].after_state.relations_digest, /^sha256:[a-f0-9]{64}$/);
    const relationReceipts = await client.query(
      `SELECT changed_fields, result_revision FROM module_mutation_receipts
       WHERE org_id = $1 AND record_id = $2 AND operation = 'update'`,
      [orgId, source.record.id],
    );
    assert.deepEqual(relationReceipts.rows, [{
      changed_fields: ['site_id', 'status'],
      result_revision: 2,
    }]);
    const signedReceipt = await client.query(
      `SELECT action_params_json, result_json FROM action_receipts
       WHERE org_id = $1 AND action_id = $2`,
      [orgId, approvalId],
    );
    assert.equal(signedReceipt.rows.length, 1);
    assert.equal(JSON.stringify(signedReceipt.rows[0]).includes(site.record.id), false);
    assert.equal(JSON.stringify(signedReceipt.rows[0]).includes('London Lab'), false);

    const expectRejectedUpdate = async (
      overrides: Record<string, unknown>,
      expectedCode: string,
    ) => {
      const result = await callMcp(employeeToken, 'module_record_update', {
        ...relationInput,
        patch: {},
        relations: { site_id: [] },
        expected_revision: 2,
        idempotency_key: `rejected-${randomUUID()}`,
        ...overrides,
      });
      assert.equal(result.isError, true);
      assert.equal(toolPayload(result).code, expectedCode);
    };
    await expectRejectedUpdate({ expected_revision: 1 }, 'MODULE_REVISION_CONFLICT');
    await expectRejectedUpdate(
      { expected_manifest_digest: `sha256:${'0'.repeat(64)}` },
      'MODULE_MANIFEST_STALE',
    );
    await expectRejectedUpdate(
      { relations: { site_id: [wrongCollection.record.id] } },
      'MODULE_VALIDATION_ERROR',
    );
    await expectRejectedUpdate(
      { relations: { site_id: [foreignSite.record.id] } },
      'MODULE_VALIDATION_ERROR',
    );

    await updateModuleInstallation(owner, manifest.slug, { agent_access: 'read' });
    await expectRejectedUpdate({}, 'MODULE_ACCESS_DENIED');
    await updateModuleInstallation(owner, manifest.slug, { agent_access: 'write' });
    await updateModuleInstallation(owner, manifest.slug, { enabled: false });
    await expectRejectedUpdate({}, 'MODULE_DISABLED');
    const disabledRead = await callMcp(employeeToken, 'module_record_get', {
      caller_employee_slug: employeeSlug,
      record_id: source.record.id,
    });
    assert.equal(disabledRead.isError, true);
    assert.equal(toolPayload(disabledRead).code, 'MODULE_DISABLED');
    await updateModuleInstallation(owner, manifest.slug, { enabled: true });

    const finalState = await client.query(
      `SELECT revision, data FROM module_records WHERE org_id = $1 AND id = $2`,
      [orgId, source.record.id],
    );
    assert.equal(finalState.rows[0].revision, 2);
    assert.equal(finalState.rows[0].data.status, 'active');
    const actionCount = await client.query(
      `SELECT count(*)::int AS count FROM agent_actions
       WHERE org_id = $1 AND action = 'module_record_update'`,
      [orgId],
    );
    assert.equal(actionCount.rows[0].count, 1);
  } finally {
    for (const targetOrgId of [orgId, foreignOrgId]) {
      await client.query('DELETE FROM attention_deliveries WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM attention_events WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM attention_items WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM action_receipts WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM agent_actions WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM agent_mcp_call_audit WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM oauth_audit_events WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM mcp_tokens WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM module_record_relations WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM module_records WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM module_versions WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM module_installations WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM audit_log WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM agent_employees WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM org_members WHERE org_id = $1', [targetOrgId]);
      await client.query('DELETE FROM orgs WHERE id = $1', [targetOrgId]);
    }
    await client.query(
      'DELETE FROM users WHERE id = ANY($1::text[])',
      [[ownerId, employeeUserId, foreignOwnerId]],
    );
    await client.end();
  }
});
