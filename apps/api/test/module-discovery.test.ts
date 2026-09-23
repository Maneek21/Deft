import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readEmployeeModuleDiscovery } from '../src/lib/module-discovery.js';
import { mergeFreshEmployeeDiscovery } from '../src/lib/mcp-tools/context.js';
import { closeDb } from '../src/lib/db.js';
after(closeDb);

const ctx = { org_id: 'org', employee_id: 'employee', employee_slug: 'inspector', trust_level: 'conservative' as const, scopes: ['read:modules'] };

test('failed discovery is distinguishable from no installations without leaking the underlying error', async () => {
  const empty = await readEmployeeModuleDiscovery(ctx, async () => []);
  assert.equal(empty.module_discovery.status, 'ready');
  assert.deepEqual(empty.installed_modules, []);
  const failed = await readEmployeeModuleDiscovery(ctx, async () => { throw new Error('private connection and record details'); });
  assert.equal(failed.module_discovery.status, 'unavailable');
  assert.deepEqual(failed.installed_modules, []);
  assert.doesNotMatch(JSON.stringify(failed), /private connection/);
  assert.match(JSON.stringify(failed), /Retry module_list/);
});

test('discovery without Module scope does not query or expose installation metadata', async () => {
  let called = false;
  const result = await readEmployeeModuleDiscovery({ ...ctx, scopes: ['read:workspace'] }, async () => { called = true; return []; });
  assert.equal(called, false);
  assert.equal(result.module_discovery.status, 'unavailable');
  assert.deepEqual(result.installed_modules, []);
});

test('missing App scope preserves Module discovery and never queries Apps', async () => {
  let called = false;
  const module = {
    installation_id: 'module-installation', module_id: 'org.example.equipment', slug: 'equipment',
    version: '1.0.0', manifest_digest: `sha256:${'0'.repeat(64)}`, name: 'Equipment', enabled: true,
    collections: [{ key: 'assets', name: 'Assets' }],
  };
  const result = await readEmployeeModuleDiscovery(
    ctx,
    async () => [module],
    async () => { called = true; throw new Error('must not run'); },
  );
  assert.equal(result.module_discovery.status, 'ready');
  assert.equal(result.installed_modules.length, 1);
  assert.equal(result.app_discovery.status, 'unavailable');
  assert.equal(called, false);
});

test('ready-empty App discovery differs from a failed lookup without exposing the failure', async () => {
  const appCtx = { ...ctx, scopes: ['read:modules', 'read:apps'] };
  const empty = await readEmployeeModuleDiscovery(appCtx, async () => [], async () => ({
    installed_apps: [],
    app_discovery: {
      status: 'ready' as const,
      has_more: false as const,
      authority: 'discovery_only' as const,
      setup_message: 'Use capability_list on an authorized record for current binding availability.' as const,
    },
  }));
  assert.equal(empty.app_discovery.status, 'ready');
  const failed = await readEmployeeModuleDiscovery(
    appCtx,
    async () => [],
    async () => { throw new Error('secret provider account'); },
  );
  assert.equal(failed.app_discovery.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /secret provider/);
});

test('fresh cache overlay drops an App immediately after scope or lifecycle revocation', async () => {
  const stale = {
    _cache_hit: true,
    installed_apps: [{ app_id: 'org.example.equipment-actions' }],
    app_discovery: { status: 'ready' },
  };
  const afterScopeRevocation = await mergeFreshEmployeeDiscovery(
    stale,
    { ...ctx, scopes: ['read:modules'] },
    async () => ({
      installed_modules: [], module_discovery: { status: 'ready' as const },
      installed_apps: [], app_discovery: { status: 'unavailable' as const, code: 'SCOPE_REQUIRED' as const, message: 'scope changed' },
    }),
  );
  assert.deepEqual(afterScopeRevocation.installed_apps, []);
  assert.equal((afterScopeRevocation.app_discovery as { status: string }).status, 'unavailable');

  const afterLifecycleRevocation = await mergeFreshEmployeeDiscovery(
    stale,
    { ...ctx, scopes: ['read:modules', 'read:apps'] },
    async () => ({
      installed_modules: [], module_discovery: { status: 'ready' as const },
      installed_apps: [], app_discovery: {
        status: 'ready' as const, has_more: false as const, authority: 'discovery_only' as const,
        setup_message: 'Use capability_list on an authorized record for current binding availability.' as const,
      },
    }),
  );
  assert.deepEqual(afterLifecycleRevocation.installed_apps, []);
  assert.equal((afterLifecycleRevocation.app_discovery as { status: string }).status, 'ready');
});
