import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { humanModuleActor, installModuleFromManifest, createModuleRecord, updateModuleInstallation } from '../src/lib/module-service.js';
import { linkModuleRecordToTask } from '../src/lib/module-task-links.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { MODULE_MCP_READ_TOOLS } from '../src/lib/mcp-tools/modules.js';
import { platformContext } from '../src/lib/mcp-tools/context.js';
import { humanModuleOperation, humanToolHasRequiredScope } from '../src/lib/mcp-tools/human.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);
after(closeDb);

test('an unfamiliar equipment Module exposes paged native tasks with identical employee boundaries', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = randomUUID(), ownerId = randomUUID(), employeeUser = randomUUID(), employeeId = randomUUID();
  const projectId = randomUUID(), otherProject = randomUUID(), employeeSlug = `inspector-${randomUUID().slice(0, 8)}`;
  const slug = `equipment-${randomUUID().slice(0, 8)}`;
  const taskIds = Array.from({ length: 4 }, randomUUID);
  const payload = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);
  try {
    await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$1,$1)', [orgId]);
    for (const id of [ownerId, employeeUser]) {
      await client.query('INSERT INTO users (id,name,email) VALUES ($1,$1,$2)', [id, `${id}@example.test`]);
      await client.query("INSERT INTO org_members (id,org_id,user_id,role) VALUES ($1,$2,$3,'owner')", [randomUUID(), orgId, id]);
    }
    await client.query("INSERT INTO agent_employees (id,org_id,user_id,name,slug,role,system_prompt,trust_level,created_by,project_ids) VALUES ($1,$2,$3,'Inspector',$4,'custom','Inspect equipment','conservative',$5,$6)", [employeeId, orgId, employeeUser, employeeSlug, ownerId, [projectId]]);
    for (const id of [projectId, otherProject]) {
      await client.query('INSERT INTO projects (id,org_id,name,prefix,lead_id) VALUES ($1,$2,$1,$3,$4)', [id, orgId, `EQ${id.slice(0, 6).toUpperCase()}`, ownerId]);
    }
    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1', id: `test.${slug}`, slug, version: '1.0.0', name: 'Equipment loans',
      collections: [{ key: 'assets', name: 'Assets', fields: [{ key: 'serial', label: 'Serial', type: 'text', required: true }],
        search: { title_field: 'serial', fields: ['serial'] }, views: [{ key: 'register', name: 'Register', type: 'table', fields: ['serial'] }],
        latest_related: [{ key: 'last_check', label: 'Last inspection', source_collection: 'checks', relation_field: 'asset', date_field: 'inspected_at' }],
      }, { key: 'checks', name: 'Inspections', fields: [
        { key: 'subject', label: 'Subject', type: 'text', required: true },
        { key: 'inspected_at', label: 'Inspected at', type: 'datetime' },
        { key: 'asset', label: 'Asset', type: 'relation', target_collection: 'assets', multiple: false },
      ], search: { title_field: 'subject', fields: ['subject'] } }],
    }, { source: 'sideloaded' });
    await updateModuleInstallation(owner, slug, { agent_access: 'read' });
    const { record } = await createModuleRecord(owner, { module_id: installation.module_id, collection_key: 'assets', data: { serial: 'CAM-204' }, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() });
    assert.ok(record);
    const check = await createModuleRecord(owner, { module_id: installation.module_id, collection_key: 'checks',
      data: { subject: 'Lens checked', inspected_at: '2000-01-02T03:04:05Z' }, relations: { asset: [record.id] },
      expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() });
    for (const [index, id] of taskIds.entries()) {
      const metadata = index === 2 ? { visibility: 'restricted', visible_user_ids: [ownerId] } : {};
      await client.query('INSERT INTO tasks (id,org_id,project_id,number,title,created_by,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, orgId, index === 3 ? otherProject : projectId, index + 1, `Inspection ${index}`, ownerId, metadata]);
      await linkModuleRecordToTask(owner, id, record.resource_id);
    }
    const ctx = { org_id: orgId, employee_id: employeeId, employee_slug: employeeSlug, trust_level: 'conservative' as const, scopes: ['read:modules', 'read:tasks'] };
    const args = { resource_id: record.resource_id, limit: 1 };
    for (const [operation, input] of [
      ['module_list', {}], ['module_schema_get', { module_id: installation.module_id }],
      ['module_record_get', { record_id: record.id }],
      ['module_record_query', { module_id: installation.module_id, collection_key: 'assets' }],
      ['module_record_search', { query: 'CAM-204' }],
      ['module_record_latest_related', { record_id: record.id }],
      ['module_record_incoming', { record_id: record.id, collection_key: 'checks', field_key: 'asset', limit: 1 }],
    ] as const) {
      const nativeRead = await executeToolCall(operation, input, orgId, employeeUser, undefined, employeeId);
      const mcpRead = await MODULE_MCP_READ_TOOLS[operation]!(input, ctx);
      assert.equal(mcpRead.isError, false, operation);
      if (operation === 'module_list') {
        assert.deepEqual(
          payload(mcpRead),
          { modules: (nativeRead.result as { modules: unknown[] }).modules },
          'MCP block one preserves the strict shared Module result',
        );
        assert.deepEqual(JSON.parse(mcpRead.content[2]!.text), {
          schema_version: 'deft.app_discovery.v1',
          installed_apps: [],
          app_discovery: {
            status: 'unavailable',
            code: 'SCOPE_REQUIRED',
            message: 'App discovery requires read:apps. Do not infer that no Apps are installed.',
          },
        });
        assert.equal(
          (nativeRead.result as { app_discovery: { status: string } }).app_discovery.status,
          'ready',
        );
      } else {
        assert.deepEqual(payload(mcpRead), nativeRead.result, operation);
      }
      assert.deepEqual(JSON.parse(mcpRead.content[1]!.text).sources, nativeRead.citations, `${operation} sources`);
      if (operation === 'module_record_get') {
        assert.equal(nativeRead.citations[0]!.url, `/modules/${slug}/assets/${record.id}`);
        assert.equal(JSON.parse(mcpRead.content[1]!.text).sources[0].ref.resource_id, record.id);
      }
      if (operation === 'module_record_latest_related' || operation === 'module_record_incoming') {
        assert.equal(nativeRead.citations[0]!.url, `/modules/${slug}/checks/${check.record!.id}`);
      }
    }
    const native = await executeToolCall('module_record_task_links', args, orgId, employeeUser, undefined, employeeId);
    const mcp = await MODULE_MCP_READ_TOOLS.module_record_task_links!({ ...args, caller_employee_slug: employeeSlug }, ctx);
    assert.equal(mcp.isError, false);
    assert.deepEqual(payload(mcp), native.result);
    assert.deepEqual(JSON.parse(mcp.content[1]!.text).sources, native.citations,
      'MCP models receive the same canonical sources without changing the legacy result block');
    assert.equal(native.result.count, 1);
    assert.equal(native.result.next_offset, 1);
    assert.equal(native.citations[0]!.url, native.result.tasks[0].url);
    const second = payload(await MODULE_MCP_READ_TOOLS.module_record_task_links!({ ...args, offset: 1 }, ctx));
    assert.equal(second.next_offset, null);
    assert.deepEqual(new Set([...native.result.tasks, ...second.tasks].map((task) => task.task_id)), new Set(taskIds.slice(0, 2)), 'private and out-of-scope tasks never enter pages');
    for (const scopes of [['read:modules'], ['read:tasks'], []]) {
      assert.equal((await MODULE_MCP_READ_TOOLS.module_record_task_links!(args, { ...ctx, scopes })).isError, true);
      assert.equal(humanToolHasRequiredScope(scopes, 'module_record_task_links'), false);
      assert.equal((await humanModuleOperation('module_record_task_links', args, { org_id: orgId, user_id: ownerId, role: 'owner', scopes })).isError, true);
    }
    const human = await humanModuleOperation('module_record_task_links', { resource_id: record.resource_id }, { org_id: orgId, user_id: ownerId, role: 'owner', scopes: ['read:modules', 'read:tasks'] });
    assert.equal(payload(human).count, 4, 'the owner sees all tasks they are allowed to read');
    await client.query('UPDATE agent_employees SET project_ids=$2 WHERE id=$1', [employeeId, [otherProject]]);
    const changed = payload(await MODULE_MCP_READ_TOOLS.module_record_task_links!({ resource_id: record.resource_id }, ctx));
    assert.deepEqual(changed.tasks.map((task: { task_id: string }) => task.task_id), [taskIds[3]], 'project revocation takes effect immediately');
    const contextBefore = payload(await platformContext({ caller_employee_slug: employeeSlug }, ctx));
    assert.ok(contextBefore.installed_modules.some((module: { module_id: string }) => module.module_id === installation.module_id));
    const narrowedContext = payload(await platformContext({ caller_employee_slug: employeeSlug }, { ...ctx, scopes: ['read:workspace'] }));
    assert.equal(narrowedContext._cache_hit, true);
    assert.deepEqual(narrowedContext.installed_modules, []);
    assert.equal(narrowedContext.module_discovery.status, 'unavailable');
    await updateModuleInstallation(owner, slug, { agent_access: 'none' });
    const contextAfter = payload(await platformContext({ caller_employee_slug: employeeSlug }, ctx));
    assert.deepEqual(contextAfter.installed_modules, [], 'cached discovery cannot outlive Module access');
    assert.equal(contextAfter.module_discovery.status, 'ready');
    const denied = await MODULE_MCP_READ_TOOLS.module_record_task_links!(args, ctx);
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /CAM-204|Inspection/);
  } finally {
    for (const table of ['cross_references', 'audit_log', 'module_record_relations', 'module_mutation_receipts', 'module_records', 'module_versions', 'module_installations', 'tasks', 'projects', 'agent_employees', 'org_members']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[ownerId, employeeUser]]);
    await client.end();
  }
});
