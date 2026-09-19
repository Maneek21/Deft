import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import { appInstallations, orgMembers, orgs, users } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { buildContactsCrmManifest } from '../../../modules/projects/contacts/author/manifest.mjs';
import { loadAuthorizedAppDiscovery } from '../src/lib/app-discovery.js';
import { activateAppInstallation, stageAppPackage } from '../src/lib/app-service.js';
import { closeDb, db } from '../src/lib/db.js';
import { humanModuleActor, listModuleSummaries } from '../src/lib/module-service.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('App discovery DB proof requires DEFT_TEST_DATABASE_URL');
if (process.env.DATABASE_URL?.trim() !== DATABASE_URL.trim()) {
  throw new Error('App discovery DB proof requires DATABASE_URL to equal DEFT_TEST_DATABASE_URL');
}
if (
  process.env.CI !== 'true'
  && !/(?:test|ci|acceptance|phase5)/i.test(new URL(DATABASE_URL).pathname)
) throw new Error('App discovery DB proof requires a disposable database');

after(closeDb);

test('DB loader discovers an active Protocol 0 App and every authorized no-action collection', async () => {
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Base App Discovery Proof', slug: `app-discovery-${suffix}` });
  await db.insert(users).values({
    id: userId,
    email: `app-discovery-${suffix}@example.test`,
    name: 'Discovery Proof Owner',
  });
  await db.insert(orgMembers).values({
    id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true,
  });

  const moduleManifest = JSON.parse(await readFile(
    new URL('../../../modules/bundled/contacts/deft.module.json', import.meta.url),
    'utf8',
  ));
  const artifact = await prepareModuleArtifact({
    path: 'modules/contacts/deft.module.json',
    manifest: moduleManifest,
  });
  const packageResult = await buildDeftAppPackage({
    manifest: buildContactsCrmManifest(moduleManifest, artifact, {
      connected: false,
      appVersion: '8.0.0',
    }),
    artifacts: [artifact],
  });
  const actor = humanModuleActor({ orgId, userId, role: 'owner' });
  const staged = await stageAppPackage(actor, packageResult.json);
  const active = await activateAppInstallation(actor, staged.id, staged.package_digest);
  const [row] = await db.select({
    state: appInstallations.state,
    grant_id: appInstallations.active_grant_snapshot_id,
  }).from(appInstallations).where(eq(appInstallations.id, active.id));
  assert.deepEqual(row, { state: 'active', grant_id: null });

  const modules = await listModuleSummaries(actor);
  const result = await loadAuthorizedAppDiscovery(actor, modules);
  const discovered = result.installed_apps.find((app) => app.installation_id === active.id);
  assert.ok(discovered);
  assert.equal(discovered.app_id, packageResult.package.manifest.id);
  assert.ok(discovered.modules[0]?.collections.length > 1);
  assert.ok(discovered.modules[0]?.collections.some((collection) => collection.collection_key === 'contacts'));
  assert.ok(discovered.modules[0]?.collections.every((collection) => collection.actions.length === 0));
  assert.equal(result.app_discovery.status, 'ready');
  assert.equal(result.app_discovery.has_more, false);
});
