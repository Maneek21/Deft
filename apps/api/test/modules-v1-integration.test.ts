import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import {
  archiveModuleRecord,
  createModuleRecord,
  deftyModuleActor,
  employeeModuleActor,
  getModuleRecord,
  humanModuleActor,
  installBundledModule,
  preflightModuleMutation,
  searchModuleRecords,
  updateModuleInstallation,
  updateModuleRecord,
} from '../src/lib/module-service.js';
import { closeDb } from '../src/lib/db.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const canRun = Boolean(TEST_DATABASE_URL && /(?:test|ci)/i.test(new URL(TEST_DATABASE_URL).pathname));
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;

after(async () => {
  await closeDb();
  await client?.end().catch(() => undefined);
});

test('Contacts completes the actor-aware module kernel journey', { skip: !canRun }, async () => {
  assert.ok(client && TEST_DATABASE_URL);
  await client.connect();

  const suffix = randomUUID().slice(0, 8);
  const orgId = `modules-test-org-${suffix}`;
  const userId = `modules-test-user-${suffix}`;
  await client.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
    [orgId, `Modules Test ${suffix}`, `modules-test-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
    [userId, `modules-${suffix}@example.test`, 'Modules Test Owner'],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [`modules-test-member-${suffix}`, orgId, userId],
  );

  try {
    const owner = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
    const installAttempts = await Promise.allSettled([
      installBundledModule(owner, 'contacts'),
      installBundledModule(owner, 'contacts'),
    ]);
    const successfulInstalls = installAttempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof installBundledModule>>> =>
        attempt.status === 'fulfilled',
    );
    const rejectedInstalls = installAttempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    assert.equal(successfulInstalls.length, 1);
    assert.equal(rejectedInstalls.length, 1);
    assert.equal(rejectedInstalls[0]?.reason?.code, 'MODULE_ALREADY_INSTALLED');
    const installed = successfulInstalls[0]!.value;
    assert.equal(installed.module_id, 'com.deft.contacts');
    assert.equal(installed.agent_access, 'none');
    const configured = await updateModuleInstallation(owner, 'contacts', { agent_access: 'write' });
    const manifestDigest = configured.manifest_digest;

    const defty = deftyModuleActor({
      orgId,
      userId,
      role: 'owner',
      conversationId: `conversation-${suffix}`,
      actionId: `action-create-${suffix}`,
    });
    await client.query(
      `INSERT INTO agent_actions
         (id, org_id, user_id, action, params, approval_tier, approval_status, approved_at)
       VALUES ($1, $2, $3, 'module_record_create', '{}'::jsonb, 'auto', 'approved', now())`,
      [`action-create-${suffix}`, orgId, userId],
    );
    const createInput = {
      module_id: 'com.deft.contacts' as const,
      collection_key: 'contacts' as const,
      data: {
        name: 'Ada Lovelace',
        company: 'Analytical Engines',
        email: 'ada@example.test',
        status: 'lead',
      },
      expected_manifest_digest: manifestDigest,
      idempotency_key: `create:${suffix}:ada@example.test`,
    };

    await preflightModuleMutation(defty, 'module_record_create', createInput);
    const [firstCreate, concurrentReplay] = await Promise.all([
      createModuleRecord(defty, createInput),
      createModuleRecord(defty, {
        ...createInput,
        data: {
          status: 'lead',
          email: 'ada@example.test',
          company: 'Analytical Engines',
          name: 'Ada Lovelace',
        },
      }),
    ]);
    const createResults = [firstCreate, concurrentReplay];
    assert.equal(createResults.filter((result) => !result.replayed).length, 1);
    assert.equal(createResults.filter((result) => result.replayed).length, 1);
    const created = createResults.find((result) => result.record)?.record;
    assert.ok(created);
    assert.equal(created.revision, 1);
    assert.equal(created.resource_id, `module_record:${created.id}`);

    const createReplay = await createModuleRecord(defty, createInput);
    assert.equal(createReplay.record, null);
    assert.deepEqual(createReplay.mutation, {
      ...firstCreate.mutation,
      replayed: true,
    });

    const search = await searchModuleRecords(owner, { query: 'Ada', limit: 25 });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.resource_id, created.resource_id);
    assert.match(search.items[0]?.url ?? '', new RegExp(created.id));

    const humanMcp = humanModuleActor({
      orgId,
      userId,
      role: 'owner',
      source: 'mcp',
      scopes: ['read:modules'],
    });
    assert.equal((await getModuleRecord(humanMcp, created.id)).id, created.id);
    const humanMcpWriteOnly = humanModuleActor({
      orgId,
      userId,
      role: 'owner',
      source: 'mcp',
      scopes: ['write:modules'],
    });
    await assert.rejects(
      () => getModuleRecord(humanMcpWriteOnly, created.id),
      /Missing MCP scope: read:modules/,
    );
    await preflightModuleMutation(humanMcpWriteOnly, 'module_record_update', {
      record_id: created.id,
      patch: { role: 'Write-only preflight' },
      unset_fields: [],
      expected_revision: 1,
      expected_manifest_digest: manifestDigest,
      idempotency_key: `write-only:${suffix}`,
    });
    await assert.rejects(
      () => getModuleRecord(humanModuleActor({
        orgId,
        userId,
        role: 'owner',
        source: 'mcp',
        scopes: [],
      }), created.id),
      /Missing MCP scope/,
    );

    const employeeId = `employee-${suffix}`;
    await client.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Modules Test Employee', $4,
               'project_manager', 'module kernel test', 'conservative',
               true, true, $3)`,
      [employeeId, orgId, userId, `modules-employee-${suffix}`],
    );
    const employee = employeeModuleActor({
      orgId,
      employeeId,
      trustLevel: 'conservative',
      source: 'mcp',
      actionId: `action-update-${suffix}`,
    });
    await client.query(
      `INSERT INTO agent_actions
         (id, org_id, user_id, agent_employee_id, action, params,
          approval_tier, approval_status, approved_at)
       VALUES ($1, $2, $3, $4, 'module_record_update', '{}'::jsonb,
               'quick', 'approved', now())`,
      [`action-update-${suffix}`, orgId, userId, employeeId],
    );
    const updateInput = {
      record_id: created.id,
      patch: { status: 'active', role: 'Computing pioneer' },
      unset_fields: [],
      expected_revision: 1,
      expected_manifest_digest: manifestDigest,
      idempotency_key: `update:${suffix}:ada@example.test`,
    };
    await preflightModuleMutation(employee, 'module_record_update', updateInput);
    const updated = await updateModuleRecord(employee, updateInput);
    assert.equal(updated.record?.revision, 2);
    assert.equal(updated.record?.data.status, 'active');
    const updateReplay = await updateModuleRecord(employee, updateInput);
    assert.equal(updateReplay.record, null);
    assert.equal(updateReplay.mutation.revision, 2);
    assert.equal(updateReplay.mutation.replayed, true);

    await assert.rejects(
      () => updateModuleRecord(employee, { ...updateInput, idempotency_key: `stale-${suffix}` }),
      /changed since it was read/,
    );
    await assert.rejects(
      () => updateModuleRecord(employee, {
        ...updateInput,
        expected_revision: 2,
        expected_manifest_digest: `sha256:${'0'.repeat(64)}`,
        idempotency_key: `digest-${suffix}`,
      }),
      /schema changed/,
    );

    const snapshotBeforeDisable = await client.query(
      `SELECT id, data, revision FROM module_records WHERE org_id = $1 AND id = $2`,
      [orgId, created.id],
    );
    await updateModuleInstallation(owner, 'contacts', { enabled: false });
    assert.equal((await searchModuleRecords(owner, { query: 'Ada', limit: 25 })).items.length, 0);
    await assert.rejects(() => getModuleRecord(owner, created.id), /disabled/);
    await assert.rejects(
      () => preflightModuleMutation(employee, 'module_record_update', {
        ...updateInput,
        expected_revision: 2,
        idempotency_key: `disabled-${suffix}`,
      }),
      /disabled/,
    );
    const snapshotWhileDisabled = await client.query(
      `SELECT id, data, revision FROM module_records WHERE org_id = $1 AND id = $2`,
      [orgId, created.id],
    );
    assert.deepEqual(snapshotWhileDisabled.rows, snapshotBeforeDisable.rows.map((row) => ({
      ...row,
      data: { ...row.data, status: 'active', role: 'Computing pioneer' },
      revision: 2,
    })));

    await updateModuleInstallation(owner, 'contacts', { enabled: true });
    const restored = await getModuleRecord(owner, created.id);
    assert.equal(restored.id, created.id);
    assert.equal(restored.revision, 2);
    assert.equal(restored.data.status, 'active');

    await assert.rejects(
      () => getModuleRecord(humanModuleActor({
        orgId,
        userId,
        role: 'guest',
        source: 'rest',
      }), created.id),
      /Guests cannot access/,
    );
    await assert.rejects(
      () => getModuleRecord(humanModuleActor({
        orgId: `other-${suffix}`,
        userId,
        role: 'owner',
        source: 'rest',
      }), created.id),
      /not found/,
    );

    const audit = await client.query(
      `SELECT entity_id, metadata FROM audit_log
       WHERE org_id = $1 AND action LIKE 'module_record.%'
       ORDER BY created_at`,
      [orgId],
    );
    assert.equal(audit.rows.length, 2);
    assert.ok(audit.rows.every((row) => row.entity_id === created.resource_id));
    assert.equal(audit.rows[0]?.metadata.action_id, `action-create-${suffix}`);
    assert.equal(audit.rows[0]?.metadata.conversation_id, `conversation-${suffix}`);
    assert.equal(audit.rows[1]?.metadata.action_id, `action-update-${suffix}`);

    const receipts = await client.query(
      `SELECT operation, idempotency_key, input_digest, changed_fields, result_revision
       FROM module_mutation_receipts WHERE org_id = $1 ORDER BY operation`,
      [orgId],
    );
    assert.equal(receipts.rows.length, 2);
    assert.ok(receipts.rows.every((row) => /^sha256:[a-f0-9]{64}$/.test(row.idempotency_key)));
    assert.ok(receipts.rows.every((row) => !JSON.stringify(row).includes('ada@example.test')));
    assert.deepEqual(receipts.rows.map((row) => row.operation).sort(), ['create', 'update']);

    const storedKey = await client.query(
      `SELECT create_idempotency_key FROM module_records WHERE org_id = $1 AND id = $2`,
      [orgId, created.id],
    );
    assert.match(storedKey.rows[0]?.create_idempotency_key, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(storedKey.rows[0]?.create_idempotency_key, createInput.idempotency_key);

    const archiveInput = {
      record_id: created.id,
      expected_revision: 2,
      expected_manifest_digest: manifestDigest,
      idempotency_key: `archive:${suffix}`,
    };
    const archived = await archiveModuleRecord(owner, archiveInput, {
      expectedInstallationId: installed.id,
    });
    const archiveReplay = await archiveModuleRecord(owner, archiveInput, {
      expectedInstallationId: installed.id,
    });
    assert.equal(archived.mutation.archived, true);
    assert.equal(archiveReplay.mutation.replayed, true);
    assert.equal(archiveReplay.record, null);
  } finally {
    await client.query(`DELETE FROM module_mutation_receipts WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_records WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_versions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_installations WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM audit_log WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
});
