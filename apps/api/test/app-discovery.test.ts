import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import type { ModuleSummary } from '@deft/shared/modules';
import { DeftAppManifestV0Schema, DeftAppManifestV1Schema } from '@deft/app-kit';
import {
  appDiscoveryActorCanUseBinding,
  projectAuthorizedAppDiscovery,
  type AppDiscoveryCandidate,
} from '../src/lib/app-discovery.js';
import { closeDb } from '../src/lib/db.js';

after(closeDb);

const digest = `sha256:${'0'.repeat(64)}`;
const equipmentModule: ModuleSummary = {
  installation_id: 'module-installation-equipment',
  module_id: 'org.example.equipment',
  slug: 'equipment',
  version: '1.0.0',
  manifest_digest: digest,
  name: 'Equipment',
  enabled: true,
  collections: [
    { key: 'assets', name: 'Assets' },
    { key: 'manuals', name: 'Manuals' },
  ],
};

function baseEquipmentManifest(appId = 'org.example.equipment-base') {
  return DeftAppManifestV0Schema.parse({
    schema_version: '0',
    id: appId,
    version: '1.0.0',
    name: `Equipment Base ${appId}`,
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '0' },
    modules: [{
      module_id: equipmentModule.module_id,
      version: equipmentModule.version,
      manifest_path: 'modules/equipment/deft.module.json',
      manifest_digest: equipmentModule.manifest_digest,
    }],
    navigation: [],
  });
}

async function equipmentManifest(): Promise<Record<string, unknown>> {
  const source = await readFile(
    new URL('../../../examples/connected-resource-campaigns-app/deft.app.json', import.meta.url),
    'utf8',
  );
  return DeftAppManifestV1Schema.parse(JSON.parse(source
    .replaceAll('org.deft.reference.resource-campaigns-app', 'org.example.equipment-actions')
    .replaceAll('org.deft.reference.resource-campaigns', 'org.example.equipment')
    .replaceAll('org.deft.reference.resource-contacts-app', 'org.example.operator-directory-app')
    .replaceAll('org.deft.reference.resource-contacts', 'org.example.operator-directory')
    .replaceAll('Connected Resource Campaigns', 'Equipment Operations')
    .replaceAll('contacts_app', 'operators_app')
    .replaceAll('send_campaign_email', 'schedule_maintenance')
    .replaceAll('Send campaign email', 'Schedule maintenance')
    .replaceAll('campaigns', 'assets')
    .replaceAll('campaign', 'asset')
    .replaceAll('contacts', 'operators')
    .replaceAll('contact', 'operator'))) as Record<string, unknown>;
}

async function candidate(overrides: Partial<AppDiscoveryCandidate> = {}): Promise<AppDiscoveryCandidate> {
  return {
    org_id: 'org-a',
    installation_id: 'app-installation-equipment',
    version_id: 'app-version-equipment',
    grant_snapshot_id: 'grant-equipment',
    app_id: 'org.example.equipment-actions',
    version: '3.0.0',
    manifest: await equipmentManifest(),
    authority_healthy: true,
    module_bindings: [{
      owner_installation_id: 'app-installation-equipment',
      owner_version_id: 'app-version-equipment',
      module_id: equipmentModule.module_id,
      module_installation_id: equipmentModule.installation_id,
      module_version: equipmentModule.version,
      module_manifest_digest: equipmentModule.manifest_digest,
    }],
    dependency_locks: [{
      dependency_key: 'operators_app',
      dependency_installation_id: 'operator-app-installation',
      dependency_version_id: 'operator-app-version',
      healthy: true,
    }],
    action_setup: { schedule_maintenance: true },
    ...overrides,
  };
}

test('an unfamiliar App is discoverable from its authorized Module without caller-supplied ids', async () => {
  const result = projectAuthorizedAppDiscovery('org-a', [equipmentModule], [await candidate()]);
  assert.equal(result.app_discovery.status, 'ready');
  assert.equal(result.installed_apps[0]?.name, 'Equipment Operations');
  const collection = result.installed_apps[0]?.modules[0]?.collections[0];
  assert.equal(collection?.collection_key, 'assets');
  assert.deepEqual(collection?.actions, [{
    action_key: 'schedule_maintenance',
    label: 'Schedule maintenance',
    setup_state: 'available',
  }]);
  assert.equal(collection?.record_retrieval_hint.tool, 'module_record_search');
  assert.equal(collection?.action_retrieval_hint.tool, 'capability_list');
  assert.doesNotMatch(JSON.stringify(result), /binding_id|mcp_connection|provider_snapshot/);
});

test('tenant and exact visible Module installation intersections omit unrelated candidates', async () => {
  const otherTenant = await candidate({ org_id: 'org-b' });
  const wrongInstallation = { ...equipmentModule, installation_id: 'module-installation-hidden' };
  const wrongVersion = { ...equipmentModule, version: '2.0.0' };
  const wrongDigest = { ...equipmentModule, manifest_digest: `sha256:${'1'.repeat(64)}` };
  assert.deepEqual(
    projectAuthorizedAppDiscovery('org-a', [equipmentModule], [otherTenant]).installed_apps,
    [],
  );
  assert.deepEqual(
    projectAuthorizedAppDiscovery('org-a', [wrongInstallation], [await candidate()]).installed_apps,
    [],
  );
  assert.deepEqual(
    projectAuthorizedAppDiscovery('org-a', [wrongVersion], [await candidate()]).installed_apps,
    [],
  );
  assert.deepEqual(
    projectAuthorizedAppDiscovery('org-a', [wrongDigest], [await candidate()]).installed_apps,
    [],
  );
});

test('stale connector setup or dependency locks never project an available action', async () => {
  const connectorRevoked = projectAuthorizedAppDiscovery(
    'org-a',
    [equipmentModule],
    [await candidate({ action_setup: { schedule_maintenance: false } })],
  );
  assert.equal(
    connectorRevoked.installed_apps[0]?.modules[0]?.collections[0]?.actions[0]?.setup_state,
    'setup_required',
  );
  const dependencyRevoked = projectAuthorizedAppDiscovery(
    'org-a',
    [equipmentModule],
    [await candidate({
      dependency_locks: [{
        dependency_key: 'operators_app',
        dependency_installation_id: 'operator-app-installation',
        dependency_version_id: 'operator-app-version',
        healthy: false,
      }],
    })],
  );
  assert.equal(
    dependencyRevoked.installed_apps[0]?.modules[0]?.collections[0]?.actions[0]?.setup_state,
    'setup_required',
  );
});

test('employee App action readiness follows assignment, disabled operation, health, membership, and write budget', () => {
  const actor = {
    kind: 'agent_employee' as const,
    org_id: 'org-a',
    actor_id: 'employee-a',
    trust_level: 'standard' as const,
    source: 'mcp' as const,
    scopes: ['read:modules', 'read:apps'],
  };
  const binding = {
    mcp_connection_id: 'connection-a',
    operation_name: 'send_message',
    risk_class: 'external_write',
  };
  const usable = {
    id: 'employee-a',
    org_id: 'org-a',
    is_active: true,
    is_deleted: false,
    unhealthy: false,
    daily_action_count: 0,
    max_daily_actions: 10,
    mcp_connection_ids: ['connection-a'],
    disabled_tools: [] as string[],
    membership_active: true,
  };

  assert.equal(appDiscoveryActorCanUseBinding(actor, binding, usable), true);
  assert.equal(appDiscoveryActorCanUseBinding(actor, binding, {
    ...usable,
    mcp_connection_ids: [],
  }), false);
  assert.equal(appDiscoveryActorCanUseBinding(actor, binding, {
    ...usable,
    disabled_tools: ['mcp__mail__send_message'],
  }), false);
  assert.equal(appDiscoveryActorCanUseBinding(actor, binding, {
    ...usable,
    unhealthy: true,
  }), false);
  assert.equal(appDiscoveryActorCanUseBinding(actor, binding, {
    ...usable,
    membership_active: false,
  }), false);
  assert.equal(appDiscoveryActorCanUseBinding(actor, binding, {
    ...usable,
    daily_action_count: 10,
  }), false);
  assert.equal(appDiscoveryActorCanUseBinding(actor, {
    ...binding,
    risk_class: 'read',
  }, {
    ...usable,
    daily_action_count: 10,
  }), true);
});

test('Protocol 0 Apps and included collections remain discoverable without actions or a grant', async () => {
  const appId = 'org.example.equipment-base';
  const result = projectAuthorizedAppDiscovery('org-a', [equipmentModule], [{
    ...await candidate(),
    app_id: appId,
    version: '1.0.0',
    manifest: baseEquipmentManifest(appId),
    authority_healthy: false,
    module_bindings: [{
      owner_installation_id: 'app-installation-equipment',
      owner_version_id: 'app-version-equipment',
      module_id: equipmentModule.module_id,
      module_installation_id: equipmentModule.installation_id,
      module_version: equipmentModule.version,
      module_manifest_digest: equipmentModule.manifest_digest,
    }],
    dependency_locks: [],
    action_setup: {},
  }]);
  assert.equal(result.installed_apps[0]?.app_id, appId);
  assert.deepEqual(
    result.installed_apps[0]?.modules[0]?.collections.map((item) => [item.collection_key, item.actions]),
    [['assets', []], ['manuals', []]],
  );
});

test('a connected App with missing effective authority stays visible and marks actions setup_required', async () => {
  const result = projectAuthorizedAppDiscovery('org-a', [equipmentModule], [await candidate({
    authority_healthy: false,
    dependency_locks: [],
    action_setup: {},
  })]);
  assert.equal(result.installed_apps[0]?.app_id, 'org.example.equipment-actions');
  assert.equal(
    result.installed_apps[0]?.modules[0]?.collections[0]?.actions[0]?.setup_state,
    'setup_required',
  );
  assert.deepEqual(result.installed_apps[0]?.modules[0]?.collections[1]?.actions, []);
});

test('the App cap is deterministic and reports authorized truncation', async () => {
  const candidates = await Promise.all(Array.from({ length: 27 }, async (_, index) => {
    const suffix = String(26 - index).padStart(2, '0');
    const appId = `org.example.equipment-${suffix}`;
    const installationId = `app-installation-${suffix}`;
    const versionId = `app-version-${suffix}`;
    return {
      ...await candidate(),
      installation_id: installationId,
      version_id: versionId,
      app_id: appId,
      version: '1.0.0',
      manifest: baseEquipmentManifest(appId),
      authority_healthy: false,
      module_bindings: [{
        owner_installation_id: installationId,
        owner_version_id: versionId,
        module_id: equipmentModule.module_id,
        module_installation_id: equipmentModule.installation_id,
        module_version: equipmentModule.version,
        module_manifest_digest: equipmentModule.manifest_digest,
      }],
      dependency_locks: [],
      action_setup: {},
    };
  }));
  const result = projectAuthorizedAppDiscovery('org-a', [equipmentModule], candidates);
  assert.equal(result.installed_apps.length, 25);
  assert.equal(result.installed_apps[0]?.app_id, 'org.example.equipment-00');
  assert.equal(result.installed_apps[24]?.app_id, 'org.example.equipment-24');
  assert.deepEqual(result.app_discovery, {
    status: 'partial',
    code: 'TRUNCATED',
    has_more: true,
    authority: 'discovery_only',
    setup_message: 'Use capability_list on an authorized record for current binding availability.',
    message: 'More authorized Apps are installed than fit in this context response.',
  });
});
