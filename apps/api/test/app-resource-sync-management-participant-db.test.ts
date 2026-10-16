import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import type { ServerType } from '@hono/node-server';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const u = new URL(target); return ['postgres:', 'postgresql:'].includes(u.protocol)
    && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260926_scheduler$/.test(u.pathname)
    && !u.search && !u.hash; } catch { return false; }
})();
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`management-http:${purpose}`).digest('base64') } });
const keyring = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('mgmt-enc'), receipt_signing: ring('mgmt-sign'), fingerprint: ring('mgmt-fp') });
process.env.DEFT_APP_RUN_KEYRINGS = keyring;
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

async function harness() {
  const [{ db }, schema, drizzle, session, keysModule, routes, hono, serverModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/routes/app-resource-sync-management.js'), import('hono'), import('@hono/node-server'),
  ]);
  const keys = keysModule.parseEnvironmentAppRunKeyrings(keyring);
  const fixture = await createReviewedResourceSyncFixture({ keys, clock: () => new Date() });
  const app = new hono.Hono();
  app.route('/manage', routes.createAppResourceSyncManagementRoutes({ management: async () => fixture.management }));
  let server!: ServerType;
  const base = await new Promise<string>((resolve) => {
    server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      resolve(`http://127.0.0.1:${info.port}/manage`);
    });
  });
  const token = async (id: string, orgId = fixture.org_id) => {
    const [user] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, id));
    return session.createWebSession({ id, org_id: orgId, email: user!.email });
  };
  const owner = await token(fixture.owner_user_id);
  const operator = await token(fixture.operator_user_id);
  const call = async (path: string, method = 'GET', value?: unknown, bearer = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() as any };
  };
  return { db, schema, ...drizzle, ...fixture, owner, operator, call, token, session, base,
    close: async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); keys.destroy(); } };
}

test('private sync management rejects other participant kind changes during final SID waits', { skip: !safe }, async (t) => {
  for (const operation of ['session', 'activation'] as const) await t.test(operation, async () => {
    const h = await harness();
    let release = () => {};
    try {
      let activation: unknown;
      if (operation === 'activation') {
        await h.management.revokeConsent(h.owner_actor, h.binding_id);
        const review = await h.management.prepareConsent(h.owner_actor, h.consent_request);
        activation = { ...h.consent_request, expected_review_digest: review.review_digest, accept_host_policy: true };
      }
      const auditAction = operation === 'session' ? 'app.resource_sync_session_issue' : 'app.resource_sync_consent_activate';
      const before = await h.db.select().from(h.schema.auditLog).where(h.and(
        h.eq(h.schema.auditLog.org_id, h.org_id), h.eq(h.schema.auditLog.action, auditAction)));
      let acquired!: () => void;
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      let blockerPid = 0;
      const blocker = h.db.transaction(async tx => {
        blockerPid = (await tx.execute(h.sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
        const requester = operation === 'session' ? h.operator_user_id : h.owner_user_id;
        await tx.execute(h.sql`SELECT id FROM web_sessions WHERE org_id = ${h.org_id} AND user_id = ${requester} FOR UPDATE`);
        acquired(); await released;
      });
      await locked;
      const pending = operation === 'session'
        ? h.call(`/bindings/${h.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken)
        : h.call('/bindings/activate', 'POST', activation);
      let waited = false;
      for (let i = 0; i < 250; i++) {
        const result = await h.db.execute(h.sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))`);
        if (result.rows[0]!.waiting > 0) { waited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(waited, `${operation} waits on its exact requester SID blocker`);
      const otherParticipant = operation === 'session' ? h.owner_user_id : h.operator_user_id;
      await h.db.update(h.schema.users).set({ kind: 'agent' }).where(h.eq(h.schema.users.id, otherParticipant));
      release(); await blocker;
      const response = await pending;
      assert.ok(response.status === 403 || response.status === 409,
        `${operation} must deny nonhuman other participant after SID wait; observed ${response.status}`);
      assert.ok(!JSON.stringify(response.body).includes('session_token'));
      const after = await h.db.select().from(h.schema.auditLog).where(h.and(
        h.eq(h.schema.auditLog.org_id, h.org_id), h.eq(h.schema.auditLog.action, auditAction)));
      assert.equal(after.length, before.length, 'stale authority audit rolls back');
      if (operation === 'session') {
        const sessions = await h.db.select().from(h.schema.appRuntimeSessions).where(h.eq(h.schema.appRuntimeSessions.resource_binding_id, h.binding_id));
        assert.equal(sessions.length, 0, 'no stale session remains');
      } else {
        const bindings = await h.db.select().from(h.schema.appResourceBindings).where(h.and(
          h.eq(h.schema.appResourceBindings.org_id, h.org_id), h.eq(h.schema.appResourceBindings.state, 'active')));
        assert.equal(bindings.length, 0, 'no stale active binding remains');
      }
    } finally { release(); await h.close(); }
  });
});