import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import { appInstallations, appModuleBindings, moduleInstallations, orgMembers, orgs, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import {
  humanModuleActor,
  installModuleFromManifest,
  moduleIdentityReservation,
} from '../src/lib/module-service.js';
import { ModuleError } from '../src/lib/module-errors.js';
import { appIdentityTrust, assertAppIdentityNotReserved, inspectAppPackageJson, stageAppPackage } from '../src/lib/app-service.js';
import { AppError } from '../src/lib/app-errors.js';
import { moduleRoutes } from '../src/routes/modules.js';
import { appRoutes } from '../src/routes/apps.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

function moduleManifest(id: string, slug: string) {
  return {
    schema_version: '1',
    id,
    slug,
    version: '1.0.0',
    name: 'Copy of Contacts',
    collections: [{ key: 'people', name: 'People', fields: [{ key: 'name', label: 'Name', type: 'text' }] }],
  };
}

async function appPackage(appId: string, module = moduleManifest('com.example.people', 'people')) {
  const artifact = await prepareModuleArtifact({ path: `modules/${module.slug}/deft.module.json`, manifest: module });
  return buildDeftAppPackage({
    manifest: {
      schema_version: '0',
      id: appId,
      version: '1.0.0',
      name: 'People app',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' },
      modules: [{ module_id: module.id, version: module.version, manifest_path: artifact.path, manifest_digest: artifact.digest }],
      navigation: [{ key: 'people', label: 'People', module_id: module.id, collection_key: 'people' }],
    },
    artifacts: [artifact],
  });
}

async function seedOwner() {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Reserved names', slug: `reserved-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('user', { id: userId, org_id: orgId, email: `${userId}@example.test`, name: 'Owner', role: 'owner' });
    await next();
  });
  app.route('/api/modules', moduleRoutes);
  app.route('/api/apps', appRoutes);
  return { orgId, actor, app };
}

async function sideload(app: Hono, manifest: unknown) {
  const response = await app.request('/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string } };
}

test('a sideload cannot take a bundled module slug or id, or a first-party id namespace', { skip: !canRun }, async () => {
  const { orgId, actor, app } = await seedOwner();
  const cases = [
    moduleManifest('com.example.contacts', 'contacts'),
    moduleManifest('com.deft.contacts', 'my-contacts'),
    moduleManifest('com.deft.crm', 'crm'),
    moduleManifest('io.deft.email', 'mail'),
    moduleManifest('com.deft', 'deft'),
  ];
  for (const manifest of cases) {
    const refused = await sideload(app, manifest);
    assert.equal(refused.status, 409, `${manifest.id} / ${manifest.slug}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, 'MODULE_IDENTITY_RESERVED');
    assert.match(refused.body.error ?? '', /ships with Deft|kept for apps made by Deft/);
    assert.doesNotMatch(refused.body.error ?? '', /\[\{|\{"/);
  }
  const rows = await db.select().from(moduleInstallations).where(eq(moduleInstallations.org_id, orgId));
  assert.equal(rows.length, 0, 'nothing refused was installed');

  // Look-alikes outside the namespaces still install.
  for (const manifest of [moduleManifest('com.deftly.people', 'people'), moduleManifest('com.example.deft', 'contacts-2')]) {
    const accepted = await sideload(app, manifest);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  }

  // Bundled Contacts still installs in one click after the refusals.
  const contacts = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  assert.equal(contacts.slug, 'contacts');
});

test('the reserved check also guards non-bundled install sources directly', { skip: !canRun }, async () => {
  const { app, actor } = await seedOwner();
  // An upload never takes Contacts' name, not even as an exact copy.
  const exactCopy = await sideload(app, getBundledModule('contacts')!);
  assert.equal(exactCopy.status, 409);
  assert.equal(exactCopy.body.code, 'MODULE_IDENTITY_RESERVED');

  // An App-owned install may carry the shipped manifest unchanged (Contacts
  // CRM does), but never a changed copy under the same name.
  const bundled = getBundledModule('contacts')!;
  const changed = { ...bundled, version: '99.0.0', name: 'Contacts (copy)' };
  for (const source of ['sideloaded', 'registry'] as const) {
    await assert.rejects(
      () => installModuleFromManifest(actor, changed, { source }),
      (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_IDENTITY_RESERVED' && error.status === 409,
    );
  }
  assert.equal(moduleIdentityReservation(bundled, { allowExactBundledCopy: true }), null);
  assert.notEqual(moduleIdentityReservation(bundled), null);
  assert.notEqual(moduleIdentityReservation(changed, { allowExactBundledCopy: true }), null);
  assert.equal(moduleIdentityReservation({ id: 'com.example.people', slug: 'people' }), null);
});

test('an App upload cannot take a first-party id or carry a reserved module', { skip: !canRun }, async () => {
  const { orgId, actor, app } = await seedOwner();
  for (const appId of ['io.deft.email', 'com.deft.contacts-app']) {
    const built = await appPackage(appId);
    await assert.rejects(
      () => stageAppPackage(actor, built.json),
      (error: unknown) => error instanceof AppError && error.code === 'MODULE_IDENTITY_RESERVED' && error.status === 409,
    );
    const response = await app.request('/api/apps/stage', { method: 'POST', body: built.json });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code?: string }).code, 'MODULE_IDENTITY_RESERVED');
  }
  const reservedModule = await appPackage('community.example.people', moduleManifest('com.example.contacts', 'contacts'));
  await assert.rejects(
    () => stageAppPackage(actor, reservedModule.json),
    (error: unknown) => error instanceof AppError && error.code === 'MODULE_IDENTITY_RESERVED',
  );
  const staged = await db.select().from(appInstallations).where(and(eq(appInstallations.org_id, orgId)));
  assert.equal(staged.length, 0, 'nothing refused was staged');

  const ordinary = await stageAppPackage(actor, (await appPackage('community.example.people')).json);
  assert.equal(ordinary.app_id, 'community.example.people');
});

test('the real Email package passes the reserved check on its reviewed entry point only', { skip: !canRun }, async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/supplemental-effects-manifest.json', import.meta.url), 'utf8')) as {
    manifest?: { id: string; modules: unknown[] };
    id?: string;
    modules?: unknown[];
  };
  const manifest = (fixture.manifest ?? fixture) as { id: string; modules: never[] };
  assert.equal(manifest.id, 'io.deft.email');
  const inspected = { manifest, package: { artifacts: [] } } as unknown as Parameters<typeof assertAppIdentityNotReserved>[0];
  assert.doesNotThrow(() => assertAppIdentityNotReserved(inspected, { firstPartyAppId: true, bundledCopies: false }));
  assert.throws(
    () => assertAppIdentityNotReserved(inspected, { firstPartyAppId: false, bundledCopies: false }),
    (error: unknown) => error instanceof AppError && error.code === 'MODULE_IDENTITY_RESERVED',
  );
  // Inspecting alone stays allowed, so a person can read why it would be refused.
  const built = await appPackage('io.deft.email');
  assert.equal((await inspectAppPackageJson(built.json)).manifest.id, 'io.deft.email');
});

async function contactsCopyPackage(appId: string) {
  const contacts = getBundledModule('contacts')!;
  const artifact = await prepareModuleArtifact({ path: 'modules/contacts/deft.module.json', manifest: contacts });
  return buildDeftAppPackage({
    manifest: {
      schema_version: '0',
      id: appId,
      version: '1.0.0',
      name: 'My CRM',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' },
      modules: [{ module_id: contacts.id, version: contacts.version, manifest_path: artifact.path, manifest_digest: artifact.digest }],
      navigation: [{ key: 'contacts', label: 'Contacts', module_id: contacts.id, collection_key: 'contacts' }],
    },
    artifacts: [artifact],
  });
}

test('a customer App carrying the exact Contacts manifest is refused while Contacts is not installed', { skip: !canRun }, async () => {
  const { orgId, actor, app } = await seedOwner();
  const built = await contactsCopyPackage('community.example.my-crm');
  const response = await app.request('/api/apps/stage', { method: 'POST', body: built.json });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code?: string }).code, 'MODULE_IDENTITY_RESERVED');
  assert.equal((await db.select().from(appInstallations).where(eq(appInstallations.org_id, orgId))).length, 0);
  assert.equal((await db.select().from(moduleInstallations).where(eq(moduleInstallations.org_id, orgId))).length, 0);
  // One-click Contacts still installs, as an ordinary bundled module.
  const contacts = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  assert.equal(contacts.source, 'bundled');
  assert.equal(contacts.owning_app_installation_id, null);
});

test('a customer App carrying the exact Contacts manifest cannot take over an installed Contacts', { skip: !canRun }, async () => {
  const { orgId, actor } = await seedOwner();
  const contacts = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  const built = await contactsCopyPackage('community.example.my-crm');
  await assert.rejects(
    () => stageAppPackage(actor, built.json),
    (error: unknown) => error instanceof AppError && error.code === 'MODULE_IDENTITY_RESERVED' && error.status === 409,
  );
  const [row] = await db.select().from(moduleInstallations).where(eq(moduleInstallations.id, contacts.id));
  assert.equal(row?.is_enabled, true);
  assert.equal(row?.source, 'bundled');
  assert.equal((await db.select().from(appModuleBindings).where(eq(appModuleBindings.org_id, orgId))).length, 0);
});

test('only a first-party package staged by the host may carry a shipped bundled manifest', { skip: !canRun }, async () => {
  const { actor } = await seedOwner();
  const built = await contactsCopyPackage('org.deft.contacts-crm-app');
  // No HTTP route sets this; it is the host's own decision, like Email's reviewed entry point.
  const staged = await stageAppPackage(actor, built.json, { firstPartyPackage: true });
  assert.equal(staged.app_id, 'org.deft.contacts-crm-app');
});

test('the reviewed attachment entry trusts only a Protocol 7 io.deft.email package', { skip: !canRun }, async () => {
  const { actor } = await seedOwner();
  for (const appId of ['io.deft.email', 'com.deft.anything']) {
    const built = await appPackage(appId);
    await assert.rejects(
      () => stageAppPackage(actor, built.json, { attachmentStage: true }),
      (error: unknown) => error instanceof AppError && error.code === 'MODULE_IDENTITY_RESERVED' && error.status === 409,
    );
  }
});

test('Email\'s reviewed entry may use its own id but never carry a bundled app', { skip: !canRun }, async () => {
  const email = { manifest: { schema_version: '7', id: 'io.deft.email' } } as unknown as Parameters<typeof appIdentityTrust>[0];
  assert.deepEqual(appIdentityTrust(email, { attachmentEntry: true }), { firstPartyAppId: true, bundledCopies: false });
  assert.deepEqual(appIdentityTrust(email, { attachmentEntry: false }), { firstPartyAppId: false, bundledCopies: false });
  const other = { manifest: { schema_version: '7', id: 'com.example.mail' } } as unknown as Parameters<typeof appIdentityTrust>[0];
  assert.deepEqual(appIdentityTrust(other, { attachmentEntry: true }), { firstPartyAppId: false, bundledCopies: false });
  assert.deepEqual(appIdentityTrust(other, { firstPartyPackage: true }), { firstPartyAppId: true, bundledCopies: true });

  // A package claiming the Email id that carries the exact Contacts manifest is refused.
  const built = await contactsCopyPackage('community.example.unused');
  const value = JSON.parse(built.json) as { manifest: Record<string, unknown>; artifacts: unknown };
  const inspected = {
    manifest: { ...value.manifest, schema_version: '7', id: 'io.deft.email' },
    package: { artifacts: value.artifacts },
  } as unknown as Parameters<typeof assertAppIdentityNotReserved>[0];
  assert.throws(
    () => assertAppIdentityNotReserved(inspected, appIdentityTrust(inspected, { attachmentEntry: true })),
    (error: unknown) => error instanceof AppError && error.code === 'MODULE_IDENTITY_RESERVED',
  );
});
