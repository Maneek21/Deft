import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { appDeveloperPairings, appInstallations } from '@deft/db/schema';
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
import { buildPhase5ConnectedAppPackage } from './fixtures/phase5-connected-app-package.js';

const orgId = 'apps-v0-test-org';
const userId = 'apps-v0-test-owner';
const actor = humanModuleActor({ orgId, userId, role: 'owner' });

before(async () => {
  await db.execute(`
    INSERT INTO orgs (id, name, slug) VALUES ('${orgId}', 'Apps v0 test', 'apps-v0-test') ON CONFLICT DO NOTHING;
    INSERT INTO users (id, email, name) VALUES ('${userId}', 'apps-v0-pairing-owner@example.test', 'Apps owner') ON CONFLICT DO NOTHING;
    INSERT INTO org_members (id, org_id, user_id, role, is_active)
      VALUES ('apps-v0-member', '${orgId}', '${userId}', 'owner', true)
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', is_active = true;
  `);
});

after(async () => closeDb());

test('developer pairing is expiring, single-use, audience-bound, and revocable', {
  skip: !APP_DEVELOPER_PAIRING_ENABLED,
}, async () => {
  const pairing = await createAppDeveloperPairing(actor);
  assert.equal(pairing.audience, 'app-developer');
  const session = await exchangeAppDeveloperPairing(pairing.code);
  assert.match(session.token, /^deft_app_dev_/);
  await assert.rejects(() => exchangeAppDeveloperPairing(pairing.code), /already used|invalid/);
  await assert.rejects(() => claimAppDeveloperSession(`wrong_audience_${session.token}`), /invalid/);
  const claimed = await claimAppDeveloperSession(session.token);
  assert.equal(claimed.org_id, orgId);
  await assert.rejects(() => claimAppDeveloperSession(session.token), /already used|invalid/);

  const revokedPairing = await createAppDeveloperPairing(actor);
  const revokedSession = await exchangeAppDeveloperPairing(revokedPairing.code);
  await revokeAppDeveloperPairing(actor, revokedPairing.pairing_id);
  await assert.rejects(() => claimAppDeveloperSession(revokedSession.token), /revoked|invalid/);

  const expired = await createAppDeveloperPairing(actor);
  await db.update(appDeveloperPairings).set({ expires_at: new Date(0) }).where(eq(appDeveloperPairings.id, expired.pairing_id));
  await assert.rejects(() => exchangeAppDeveloperPairing(expired.code), /expired|invalid/);
});

test('developer install rejects Protocol v1 before consuming the session or staging', {
  skip: !APP_DEVELOPER_PAIRING_ENABLED,
}, async () => {
  const routeApp = new Hono();
  routeApp.route('/api/app-developer', appDeveloperRoutes);
  const statusResponse = await routeApp.request('/api/app-developer/status');
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    app_protocol: '0',
    audience: 'app-developer',
    single_use_install: true,
  });

  const pairing = await createAppDeveloperPairing(actor);
  const session = await exchangeAppDeveloperPairing(pairing.code);
  const built = await buildPhase5ConnectedAppPackage();
  const response = await routeApp.request('/api/app-developer/install', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: built.json,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'App Protocol v1 packages must use the workspace review flow',
    code: 'APP_REVIEW_REQUIRED',
    details: {
      app_protocol: '1',
      required_flow: 'workspace_review',
    },
  });

  const [persistedPairing] = await db.select().from(appDeveloperPairings)
    .where(eq(appDeveloperPairings.id, pairing.pairing_id));
  assert.equal(persistedPairing?.install_used_at, null);
  assert.equal((await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.app_id, built.package.manifest.id),
  ))).length, 0);
});
