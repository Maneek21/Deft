import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { buildDeftAppPackage, prepareModuleArtifact, SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT } from '@deft/app-kit';
import { CAPABILITY_CONTRACT_VERSIONS, createCapabilityProviderDiscoverySnapshot } from '@deft/shared';
import {
  appGrantSnapshots, appInstallations, appModuleBindings, appVersions, mcpConnections, moduleInstallations, orgMembers, orgs, users,
} from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { humanModuleActor, installModuleFromManifest, updateModuleInstallation } from '../src/lib/module-service.js';
import { createAppDeveloperPairing, exchangeAppDeveloperPairing } from '../src/lib/app-developer-pairing.js';
import { stageAppPackage } from '../src/lib/app-service.js';
import { activateConnectedAppInstallation, prepareConnectedAppReview } from '../src/lib/app-review-service.js';
import { appRoutes } from '../src/routes/apps.js';
import { appDeveloperRoutes } from '../src/routes/app-developer.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

async function seed() {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Tester 2', slug: `tester2-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const app = new Hono();
  app.use('/api/apps/*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId, email: `${userId}@example.test`, name: 'Owner', role: 'owner' });
    await next();
  });
  app.route('/api/apps', appRoutes);
  app.route('/api/app-developer', appDeveloperRoutes);
  return { orgId, actor, app };
}

const ownModule = (suffix: string) => ({
  schema_version: '2', id: `com.example.items${suffix}`, slug: `items${suffix}`, version: '1.0.0', name: 'Items',
  collections: [
    { key: 'items', name: 'Items', fields: [
      { key: 'name', label: 'Name', type: 'text' }, { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'body', label: 'Body', type: 'text' },
      { key: 'people', label: 'People', type: 'resource_ref', target: { module_id: `com.example.items${suffix}`, resource_type: 'people' }, multiple: true, display: 'label' },
    ] },
    { key: 'people', name: 'People', fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'email', label: 'Email', type: 'email' }] },
  ],
});

/** A package of the given protocol carrying `modules` (manifests). */
async function pkg(appId: string, protocol: '0' | '1', version: string, modules: Array<Record<string, unknown>>) {
  const artifacts = await Promise.all(modules.map((m) => prepareModuleArtifact({
    path: `modules/${String(m.slug)}/deft.module.json`, manifest: m,
  })));
  const refs = modules.map((m, i) => ({
    module_id: String(m.id), version: String(m.version), manifest_path: artifacts[i]!.path, manifest_digest: artifacts[i]!.digest,
  }));
  const first = modules[0]! as { id: string; version: string; collections: Array<{ key: string }> };
  const ownFirst = first.id.startsWith('com.example.');
  const navigation = [{ key: 'main', label: 'Main', module_id: first.id, collection_key: first.collections[0]!.key }];
  const manifest = protocol === '0'
    ? { schema_version: '0', id: appId, version, name: 'Customer CRM', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' }, modules: refs, navigation }
    : { schema_version: '1', id: appId, version, name: 'Customer CRM', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '1' }, modules: refs, navigation, dependencies: [],
      resource_requirements: [{ key: 'item', source: { kind: 'included_module', module_id: first.id, version: first.version },
        resource_type: first.collections[0]!.key, fields: ownFirst ? ['subject', 'body', 'people'] : ['name'] },
      ...(ownFirst ? [{ key: 'person', source: { kind: 'included_module', module_id: first.id, version: first.version },
        resource_type: 'people', fields: ['email'] }] : [])],
      capability_requirements: [{ key: 'send_email', interface: { kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1' } }],
      connector_requirements: [{ key: 'mail_provider', provider_kind: 'mcp' }],
      actions: [{ key: 'send_item_email', label: 'Send item email', capability_requirement_key: 'send_email',
        connector_requirement_key: 'mail_provider', placement: { kind: 'resource_detail', resource_requirement_key: 'item' },
        input_bindings: ownFirst
          ? [
            { input_key: 'to', source: { kind: 'selected_relation_field', source_resource_requirement_key: 'item',
              relation_field_key: 'people', target_resource_requirement_key: 'person', target_field_key: 'email', selection: 'one' } },
            { input_key: 'subject', source: { kind: 'resource_field', resource_requirement_key: 'item', field_key: 'subject' } },
            { input_key: 'body_text', source: { kind: 'resource_field', resource_requirement_key: 'item', field_key: 'body' } },
          ]
          : [
            { input_key: 'to', source: { kind: 'user_input', label: 'Recipient', input_type: 'email', required: true } },
            { input_key: 'subject', source: { kind: 'user_input', label: 'Subject', input_type: 'text', required: true } },
            { input_key: 'body_text', source: { kind: 'user_input', label: 'Message', input_type: 'text', required: true } },
          ] }] };
  return buildDeftAppPackage({ manifest: manifest as never, artifacts });
}

async function snapshot(orgId: string) {
  return {
    installations: await db.select().from(appInstallations).where(eq(appInstallations.org_id, orgId)),
    versions: await db.select().from(appVersions).where(eq(appVersions.org_id, orgId)),
    bindings: await db.select().from(appModuleBindings).where(eq(appModuleBindings.org_id, orgId)),
    modules: await db.select().from(moduleInstallations).where(eq(moduleInstallations.org_id, orgId)),
  };
}

async function expectReserved(r: Response, label: string) {
  const body = await r.json() as { code?: string; error?: string };
  assert.equal(r.status, 409, `${label}: ${r.status} ${JSON.stringify(body)}`);
  assert.equal(body.code, 'MODULE_IDENTITY_RESERVED', label);
}

test('hostile input: a connected v1 App carrying exact Contacts is refused at /api/apps/stage, Contacts absent', { skip: !canRun }, async () => {
  const { orgId, app } = await seed();
  const built = await pkg('com.example.v1-crm', '1', '1.0.0', [getBundledModule('contacts')!]);
  await expectReserved(await app.request('/api/apps/stage', { method: 'POST', body: built.json }), 'v1 stage');
  const after = await snapshot(orgId);
  assert.equal(after.installations.length + after.versions.length + after.modules.length, 0);
});

test('hostile input: a v0 or v1 App carrying exact Contacts leaves an installed, switched-off Contacts untouched', { skip: !canRun }, async () => {
  const { orgId, actor, app } = await seed();
  const contacts = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  await updateModuleInstallation(actor, 'contacts', { enabled: false });
  const [contactsBefore] = await db.select().from(moduleInstallations).where(eq(moduleInstallations.id, contacts.id));
  for (const protocol of ['0', '1'] as const) {
    // Contacts alone, and Contacts second behind an ordinary module.
    for (const modules of [[getBundledModule('contacts')!], [ownModule(`p${protocol}`), getBundledModule('contacts')!]]) {
      const built = await pkg(`com.example.crm-p${protocol}-${modules.length}`, protocol, '1.0.0', modules);
      await expectReserved(await app.request('/api/apps/stage', { method: 'POST', body: built.json }), `p${protocol} x${modules.length}`);
    }
  }
  const after = await snapshot(orgId);
  assert.equal(after.installations.length, 0);
  assert.equal(after.versions.length, 0);
  assert.equal(after.bindings.length, 0);
  assert.deepEqual(after.modules, [contactsBefore]);
});

test('hostile input: the developer install route refuses an App carrying exact Contacts', { skip: !canRun }, async () => {
  const { orgId, actor, app } = await seed();
  const pairing = await createAppDeveloperPairing(actor);
  const { token } = await exchangeAppDeveloperPairing(pairing.code);
  const built = await pkg('com.example.dev-crm', '0', '1.0.0', [getBundledModule('contacts')!]);
  const r = await app.request('/api/app-developer/install', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.deft.app.package+json' },
    body: built.json,
  });
  await expectReserved(r, 'developer install');
  const after = await snapshot(orgId);
  assert.equal(after.installations.length + after.modules.length, 0);
});

async function sandboxCapability(orgId: string, connectionId: string) {
  const snapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
    provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId },
    captured_at: '2026-08-31T12:00:00.000Z',
    operations: [{
      identity: { provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId }, operation_name: 'send_email' },
      title: 'Send sandbox email', description: 'Sandbox.',
      input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
      output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    }],
  });
  return {
    discover: async () => ({
      provider_kind: 'mcp' as const,
      tools: [{
        name: 'mcp__reviewed__send_email', originalName: 'send_email', description: 'Send sandbox email',
        inputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
        outputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
        connectionId, connectionSlug: 'reviewed', isWrite: true, approvalTier: 'full-review' as const, rawTool: { name: 'send_email' },
      }],
      snapshot,
    }),
  };
}

async function activeV1(orgId: string, actor: ReturnType<typeof humanModuleActor>, appId: string, own: Record<string, unknown>) {
  const staged = await stageAppPackage(actor, (await pkg(appId, '1', '1.0.0', [own])).json);
  const [version] = await db.select().from(appVersions).where(eq(appVersions.id, staged.version_id));
  const [requested] = await db.select().from(appGrantSnapshots).where(eq(appGrantSnapshots.id, version!.requested_grant_snapshot_id!));
  const [installation] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  const connectionId = randomUUID();
  await db.insert(mcpConnections).values({
    id: connectionId, org_id: orgId, name: 'Sandbox mail', slug: `sandbox-${connectionId}`, server_url: null,
    transport: 'stdio', stdio_command: process.execPath, stdio_args: [], auth_type: 'none', is_active: true,
    created_by: actor.actor_id,
  });
  const capability = await sandboxCapability(orgId, connectionId);
  const request = {
    app_version_id: version!.id,
    expected_package_digest: version!.package_digest,
    expected_requested_snapshot_digest: requested!.snapshot_digest,
    expected_lifecycle_epoch: installation!.lifecycle_epoch,
    expected_grant_epoch: installation!.grant_epoch,
    connector_selections: [{ connector_requirement_key: 'mail_provider', mcp_connection_id: connectionId }],
  };
  const review = await prepareConnectedAppReview(actor, staged.id, request, capability as never);
  await activateConnectedAppInstallation(actor, staged.id, {
    ...request, expected_review_digest: review.review_digest, accept_host_policy: true,
  }, capability as never);
  const [row] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(row!.state, 'active');
  return row!;
}

test('hostile input: a connected App upgrade that adds exact Contacts is refused, with and without Contacts installed', { skip: !canRun }, async () => {
  for (const contactsInstalled of [false, true]) {
    const { orgId, actor, app } = await seed();
    let contactsBefore: unknown = null;
    if (contactsInstalled) {
      const contacts = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
      [contactsBefore] = await db.select().from(moduleInstallations).where(eq(moduleInstallations.id, contacts.id));
    }
    const own = ownModule('u');
    const installed = await activeV1(orgId, actor, 'com.example.upgrade-crm', own);
    const before = await snapshot(orgId);
    for (const [label, modules] of [
      ['adds Contacts', [own, getBundledModule('contacts')!]],
      ['swaps own module for Contacts', [getBundledModule('contacts')!]],
    ] as const) {
      const next = await pkg('com.example.upgrade-crm', '1', label.startsWith('adds') ? '1.1.0' : '1.2.0', [...modules]);
      const r = await app.request(
        `/api/apps/${installed.id}/upgrades/stage?expected_lifecycle_epoch=${installed.lifecycle_epoch}`,
        { method: 'POST', body: next.json },
      );
      await expectReserved(r, `${label} (contacts installed: ${contactsInstalled})`);
    }
    const afterRows = await snapshot(orgId);
    assert.deepEqual(afterRows.versions.map((v) => v.id).sort(), before.versions.map((v) => v.id).sort(), 'no version stored');
    if (contactsBefore) {
      assert.deepEqual(
        (await db.select().from(moduleInstallations).where(and(eq(moduleInstallations.org_id, orgId), eq(moduleInstallations.slug, 'contacts'))))[0],
        contactsBefore,
      );
    }
  }
});
