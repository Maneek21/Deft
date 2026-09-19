import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { ModuleSummary } from '@deft/shared/modules';
import { employeeModuleActor } from '../src/lib/module-service.js';
import { projectModuleMcpReadResult } from '../src/lib/mcp-tools/modules.js';
import { closeDb } from '../src/lib/db.js';

after(closeDb);

const digest = `sha256:${'0'.repeat(64)}`;
const moduleSummary: ModuleSummary = {
  installation_id: 'module-installation-equipment',
  module_id: 'org.example.equipment',
  slug: 'equipment',
  version: '1.0.0',
  manifest_digest: digest,
  name: 'Equipment',
  enabled: true,
  collections: [{ key: 'assets', name: 'Assets' }],
};
const read = {
  result: { modules: [moduleSummary] },
  citations: [{
    type: 'module',
    id: moduleSummary.installation_id,
    title: moduleSummary.name,
    url: '/modules/equipment',
  }],
};

function employee(scopes: string[]) {
  return employeeModuleActor({
    orgId: 'org-a',
    employeeId: 'employee-a',
    trustLevel: 'standard',
    source: 'mcp',
    scopes,
  });
}

function block(result: Awaited<ReturnType<typeof projectModuleMcpReadResult>>, index: number) {
  return JSON.parse(result.content[index]!.text) as Record<string, unknown>;
}

test('employee MCP module_list keeps strict blocks and appends authorized App discovery', async () => {
  const result = await projectModuleMcpReadResult(
    'module_list',
    employee(['read:modules', 'read:apps']),
    read,
    async (actor, modules) => {
      assert.equal(actor.org_id, 'org-a');
      assert.deepEqual(modules, [moduleSummary]);
      return {
        installed_apps: [{
          app_id: 'org.example.equipment-app',
          installation_id: 'app-installation-equipment',
          name: 'Equipment App',
          version: '1.0.0',
          untrusted_metadata: true,
          modules: [],
        }],
        app_discovery: {
          status: 'ready',
          has_more: false,
          authority: 'discovery_only',
          setup_message: 'Use capability_list on an authorized record for current binding availability.',
        },
      };
    },
  );

  assert.equal(result.content.length, 3);
  assert.deepEqual(block(result, 0), read.result);
  assert.equal(block(result, 1).schema_version, 'deft.module_sources.v1');
  assert.equal(block(result, 2).schema_version, 'deft.app_discovery.v1');
  assert.equal((block(result, 2).installed_apps as Array<{ app_id: string }>)[0]?.app_id, 'org.example.equipment-app');
});

test('employee MCP module_list reports missing App scope without querying Apps', async () => {
  let queried = false;
  const result = await projectModuleMcpReadResult(
    'module_list',
    employee(['read:modules']),
    read,
    async () => {
      queried = true;
      throw new Error('must not run');
    },
  );

  assert.equal(queried, false);
  assert.deepEqual((block(result, 2).app_discovery as Record<string, unknown>), {
    status: 'unavailable',
    code: 'SCOPE_REQUIRED',
    message: 'App discovery requires read:apps. Do not infer that no Apps are installed.',
  });
});

test('employee MCP module_list distinguishes App lookup failure from a ready empty catalog', async () => {
  const result = await projectModuleMcpReadResult(
    'module_list',
    employee(['read:modules', 'read:apps']),
    read,
    async () => { throw new Error('private database failure'); },
  );
  const appBlock = block(result, 2);
  assert.deepEqual(appBlock.installed_apps, []);
  assert.deepEqual(appBlock.app_discovery, {
    status: 'unavailable',
    code: 'LOOKUP_FAILED',
    message: 'App discovery failed. Retry module_list before describing installed Apps.',
  });
  assert.doesNotMatch(JSON.stringify(appBlock), /private database failure/);
});
