import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  agentActions,
  appActionBindings,
  appDependencyLocks,
  appDeveloperPairings,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appRuns,
  appVersions,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpTokens,
  orgMembers,
} from '@deft/db/schema';
import { DEFT_APP_DEVELOPER_COMPATIBILITY } from '@deft/app-kit';
import { db, closeDb } from '../src/lib/db.js';
import { APP_DEVELOPER_PAIRING_ENABLED } from '../src/lib/env.js';
import {
  claimAppDeveloperSession,
  createAppDeveloperPairing,
  exchangeAppDeveloperPairing,
  revokeAppDeveloperPairing,
} from '../src/lib/app-developer-pairing.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import { appDeveloperRoutes } from '../src/routes/app-developer.js';
import {
  buildPhase5ConnectedAppPackage,
  buildPhase5DependencyAppPackage,
} from './fixtures/phase5-connected-app-package.js';

const suffix = randomUUID().replaceAll('-', '');
const orgId = `apps-pairing-${suffix}`;
const userId = `apps-pairing-owner-${suffix}`;
const memberId = `apps-pairing-member-${suffix}`;
const actor = humanModuleActor({ orgId, userId, role: 'owner' });

function routeApp() {
  const app = new Hono();
  app.route('/api/app-developer', appDeveloperRoutes);
  return app;
}

async function sessionToken() {
  const pairing = await createAppDeveloperPairing(actor);
  const session = await exchangeAppDeveloperPairing(pairing.code);
  return { pairing, token: session.token };
}

async function install(app: Hono, token: string, packageJson: string) {
  return app.request('/api/app-developer/install', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/vnd.deft.app.package+json',
    },
    body: packageJson,
  });
}

before(async () => {
  assert.equal(
    APP_DEVELOPER_PAIRING_ENABLED,
    true,
    'The disposable API runner must execute pairing coverage instead of skipping it',
  );
  await db.execute(`
    INSERT INTO orgs (id, name, slug)
      VALUES ('${orgId}', 'Apps pairing test', 'apps-pairing-${suffix}')
      ON CONFLICT DO NOTHING;
    INSERT INTO users (id, email, name)
      VALUES ('${userId}', 'apps-pairing-${suffix}@example.test', 'Apps owner')
      ON CONFLICT DO NOTHING;
    INSERT INTO org_members (id, org_id, user_id, role, is_active)
      VALUES ('${memberId}', '${orgId}', '${userId}', 'owner', true)
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', is_active = true;
  `);
});

after(async () => closeDb());

test('developer pairing is expiring, single-use, audience-bound, manager-rechecked, and revocable', async () => {
  const pairing = await createAppDeveloperPairing(actor);
  assert.equal(pairing.audience, 'app-developer');
  const session = await exchangeAppDeveloperPairing(pairing.code);
  assert.match(session.token, /^deft_app_dev_/);
  await assert.rejects(() => exchangeAppDeveloperPairing(pairing.code), /already used|invalid/);
  await assert.rejects(() => claimAppDeveloperSession(`wrong_audience_${session.token}`), /invalid/);
  const claimed = await claimAppDeveloperSession(session.token);
  assert.equal(claimed.org_id, orgId);
  await assert.rejects(() => claimAppDeveloperSession(session.token), /already used|invalid/);

  const managerRecheck = await sessionToken();
  await db.update(orgMembers).set({ role: 'member' }).where(and(
    eq(orgMembers.org_id, orgId),
    eq(orgMembers.user_id, userId),
  ));
  await assert.rejects(() => claimAppDeveloperSession(managerRecheck.token), /owner|admin|manager|invalid/i);
  await db.update(orgMembers).set({ role: 'owner', is_active: true }).where(and(
    eq(orgMembers.org_id, orgId),
    eq(orgMembers.user_id, userId),
  ));

  const revokedPairing = await createAppDeveloperPairing(actor);
  const revokedSession = await exchangeAppDeveloperPairing(revokedPairing.code);
  await revokeAppDeveloperPairing(actor, revokedPairing.pairing_id);
  await assert.rejects(() => claimAppDeveloperSession(revokedSession.token), /revoked|invalid/);

  const expired = await createAppDeveloperPairing(actor);
  await db.update(appDeveloperPairings).set({ expires_at: new Date(0) })
    .where(eq(appDeveloperPairings.id, expired.pairing_id));
  await assert.rejects(() => exchangeAppDeveloperPairing(expired.code), /expired|invalid/);
});

test('developer status advertises additive exact v0/v1 flows without changing legacy fields', async () => {
  const response = await routeApp().request('/api/app-developer/status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    app_protocol: '0',
    audience: 'app-developer',
    single_use_install: true,
    compatibility: DEFT_APP_DEVELOPER_COMPATIBILITY,
  });
});

test('Protocol v1 inspection precedes token claim and valid delivery stages at zero authority', async () => {
  const app = routeApp();
  const pairing = await sessionToken();
  const built = await buildPhase5ConnectedAppPackage();
  const corrupt = JSON.parse(built.json) as any;
  corrupt.manifest_digest = `sha256:${'0'.repeat(64)}`;
  const rejected = await install(app, pairing.token, JSON.stringify(corrupt));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as any).code, 'APP_INVALID_PACKAGE');

  const [persistedPairing] = await db.select().from(appDeveloperPairings)
    .where(eq(appDeveloperPairings.id, pairing.pairing.pairing_id));
  assert.equal(persistedPairing?.install_used_at, null);
  assert.equal((await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.app_id, built.package.manifest.id),
  ))).length, 0);

  const accepted = await install(app, pairing.token, built.json);
  assert.equal(accepted.status, 201);
  const body = await accepted.json() as any;
  assert.deepEqual(Object.keys(body), ['app']);
  assert.equal(body.app.app_id, built.package.manifest.id);
  assert.equal(body.app.state, 'staged');
  assert.equal(body.app.active_version_id, null);
  assert.equal(body.app.grant_epoch, 0);

  const [installation] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, body.app.id),
  ));
  const [version] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.installation_id, body.app.id),
  ));
  assert.equal(installation?.state, 'staged');
  assert.equal(installation?.active_version_id, null);
  assert.equal(installation?.active_grant_snapshot_id, null);
  assert.equal(version?.state, 'staged');
  assert.ok(version?.requested_grant_snapshot_id);
  const grants = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.app_installation_id, body.app.id),
  ));
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.snapshot_kind, 'requested');
  assert.equal(grants[0]!.classification.executable, false);
  assert.equal(grants[0]!.classification.provider_access, false);

  for (const [label, rows] of [
    ['Module bindings', await db.select().from(appModuleBindings).where(and(
      eq(appModuleBindings.org_id, orgId), eq(appModuleBindings.app_installation_id, body.app.id),
    ))],
    ['dependency locks', await db.select().from(appDependencyLocks).where(and(
      eq(appDependencyLocks.org_id, orgId), eq(appDependencyLocks.app_installation_id, body.app.id),
    ))],
    ['action bindings', await db.select().from(appActionBindings).where(and(
      eq(appActionBindings.org_id, orgId), eq(appActionBindings.app_installation_id, body.app.id),
    ))],
    ['App Runs', await db.select().from(appRuns).where(and(
      eq(appRuns.org_id, orgId), eq(appRuns.origin_app_installation_id, body.app.id),
    ))],
  ] as const) {
    assert.equal(rows.length, 0, label);
  }
  assert.equal((await db.select().from(agentActions).where(eq(agentActions.org_id, orgId))).length, 0);
  assert.equal((await db.select().from(capabilityProviderSnapshots).where(
    eq(capabilityProviderSnapshots.org_id, orgId),
  )).length, 0);
  assert.equal((await db.select().from(mcpConnections).where(eq(mcpConnections.org_id, orgId))).length, 0);
  assert.equal((await db.select().from(mcpTokens).where(eq(mcpTokens.org_id, orgId))).length, 0);

  const replay = await install(app, pairing.token, built.json);
  assert.equal(replay.status, 403);
  assert.equal((await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.app_id, built.package.manifest.id),
  ))).length, 1);
  assert.equal((await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.installation_id, body.app.id),
  ))).length, 1);
});

test('Protocol v0 keeps the exact stage-and-activate response and replay behavior', async () => {
  const app = routeApp();
  const pairing = await sessionToken();
  const built = await buildPhase5DependencyAppPackage();
  const accepted = await install(app, pairing.token, built.json);
  assert.equal(accepted.status, 201);
  const body = await accepted.json() as any;
  assert.deepEqual(Object.keys(body), ['app']);
  assert.equal(body.app.app_id, built.package.manifest.id);
  assert.equal(body.app.state, 'active');
  assert.ok(body.app.active_version_id);

  const [installation] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, body.app.id),
  ));
  assert.equal(installation?.state, 'active');
  assert.ok(installation?.active_version_id);
  assert.equal((await db.select().from(appModuleBindings).where(and(
    eq(appModuleBindings.org_id, orgId),
    eq(appModuleBindings.app_installation_id, body.app.id),
  ))).length, 1);

  const replay = await install(app, pairing.token, built.json);
  assert.equal(replay.status, 403);
  assert.equal((await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.app_id, built.package.manifest.id),
  ))).length, 1);
});
