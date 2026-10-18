import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { and, count, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { signPublicHmacClaim, publicHmacClaimPath } from '@deft/app-kit';
import { appPublicEndpoints, appPublicHmacKeys, users, webSessions } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { disablePublicEndpoint } from '../src/lib/app-public-management.js';
import { appPublicManagementRoutes } from '../src/routes/app-public-management.js';
import { createAppPublicRoutes } from '../src/routes/app-public.js';
import { AppPublicClaimService } from '../src/lib/app-public-service.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { createWebSession } from '../src/lib/web-sessions.js';
import { publicAvailabilityFixture } from './fixtures/public-availability.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c13_public_hmac_test(?:_v[0-9]+)?$/.test(target);
const policy = { schema_version: 'deft.app_public_hmac.v1' as const, mode: 'hmac_sha256' as const, max_clock_skew_seconds: 300 as const };
after(async () => { if (safe) { await shutdownAppRunRuntime(); await closeDb(); } });
async function server(app: Hono) {
  const owned = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!owned.listening) await new Promise<void>(resolve => owned.once('listening', resolve));
  const address = owned.address(); assert.ok(address && typeof address !== 'string');
  return { owned, base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => owned.close(error => error ? reject(error) : resolve())) };
}
async function waitForLock(observer: pg.Client, pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await delay(15);
  }
  throw new Error('Management request did not reach held App lock');
}

test('public signing key rotation denies initiating web session revocation after actual App lock wait', { skip: !safe, timeout: 15000 }, async () => {
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const f = await publicAvailabilityFixture({ authenticationPolicy: policy });
  await disablePublicEndpoint(f.owner, f.endpoint.endpoint_id);
  const [endpoint] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, f.endpoint.endpoint_id)); assert.ok(endpoint);
  const [owner] = await db.select().from(users).where(eq(users.id, f.ownerId)); assert.ok(owner);
  const session = await createWebSession({ id: owner.id, org_id: f.orgId, email: owner.email });
  const [sid] = await db.select().from(webSessions).where(and(eq(webSessions.user_id, owner.id), eq(webSessions.org_id, f.orgId))); assert.ok(sid);
  const app = new Hono(); app.use('*', authMiddleware); app.route('/api/apps/public', appPublicManagementRoutes);
  const http = await server(app); const locker = new pg.Client({ connectionString: target }); const observer = new pg.Client({ connectionString: target });
  await locker.connect(); await observer.connect();
  try {
    await locker.query('BEGIN'); await locker.query('SELECT id FROM app_installations WHERE id=$1 FOR UPDATE', [endpoint.app_installation_id]);
    const pending = fetch(`${http.base}/api/apps/public/endpoints/${endpoint.id}/rotate-signing-key`, { method: 'POST', headers: {
      authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ expected_review_digest: endpoint.review_digest, expected_endpoint_epoch: endpoint.endpoint_epoch }) });
    let pid = 0; const deadline = Date.now() + 3000;
    while (!pid && Date.now() < deadline) {
      const row = (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%app_installations%' AND pid<>pg_backend_pid() LIMIT 1")).rows[0];
      pid = Number(row?.pid ?? 0); if (!pid) await delay(15);
    }
    assert.ok(pid); await waitForLock(observer, pid);
    await db.update(webSessions).set({ revoked_at: new Date() }).where(eq(webSessions.id, sid.id));
    await locker.query('COMMIT');
    const response = await pending;
    const keys = (await db.select({ value: count() }).from(appPublicHmacKeys).where(eq(appPublicHmacKeys.endpoint_id, endpoint.id)))[0]!.value;
    console.log(JSON.stringify({ observation: 'held_app_rotation_after_logout', status: response.status, persisted_key_count: keys }));
    assert.ok([401, 403].includes(response.status), `rotation status must deny after logout; received ${response.status}`);
    assert.equal(keys, 1);
  } finally { await locker.query('ROLLBACK'); await locker.end(); await observer.end(); await http.close(); }
});

test('signed public HTTP rejects raw dot and encoded-dot path aliases before normalized canonical path authentication', { skip: !safe, timeout: 15000 }, async () => {
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const f = await publicAvailabilityFixture({ authenticationPolicy: policy }); const record = await f.record('Raw path');
  const [endpoint] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, f.endpoint.endpoint_id)); assert.ok(endpoint && f.endpoint.signing_key);
  const body = f.body(record.id, record.revision);
  const timestamp = String(Math.floor(Number((await db.execute(sql`SELECT extract(epoch FROM clock_timestamp()) AS seconds`)).rows[0]!.seconds)));
  const app = new Hono(); let receivedUrl = ''; app.use('*', async (c, next) => { receivedUrl = c.req.url; await next(); });
  app.route('/api/public/apps', createAppPublicRoutes(new AppPublicClaimService({ enabled: true })));
  const http = await server(app); let rawPath = ''; http.owned.on('request', incoming => { rawPath = incoming.url ?? ''; });
  try {
    for (const segment of ['..', '%2e%2e']) {
      const headers = await signPublicHmacClaim(Buffer.from(f.endpoint.signing_key.secret, 'base64url'), { slug: f.endpoint.slug,
        endpoint_epoch: endpoint.endpoint_epoch, key_id: f.endpoint.signing_key.key_id, timestamp, nonce: randomBytes(32).toString('hex'), body });
      const path = `/api/public/apps/alias/${segment}/${f.endpoint.slug}/claims`;
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(http.base, { method: 'POST', path, headers: { ...headers, 'content-type': 'application/json' } }, incoming => {
          incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode ?? 0));
        }); request.on('error', reject); request.end(body);
      });
      console.log(JSON.stringify({ observation: 'raw_path_alias', raw_path: rawPath.replace(f.endpoint.slug, '<slug>'), request_url: receivedUrl.replace(f.endpoint.slug, '<slug>'), status }));
      assert.notEqual(status, 201); assert.notEqual(status, 200);
    }
  } finally { await http.close(); }
});

test('public endpoint management denies human kind and agent flag withdrawal after real SID waits with no stage activation disable or rotation mutation', { skip: !safe, timeout: 30000 }, async () => {
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  for (const [operation, change] of [['stage', { kind: 'agent' as const }], ['activate', { is_agent: true }],
    ['disable', { kind: 'agent' as const }], ['rotate-signing-key', { is_agent: true }]] as const) {
    const f = await publicAvailabilityFixture({ authenticationPolicy: policy });
    if (operation === 'activate' || operation === 'rotate-signing-key') await disablePublicEndpoint(f.owner, f.endpoint.endpoint_id);
    const [endpoint] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, f.endpoint.endpoint_id)); assert.ok(endpoint);
    const [owner] = await db.select().from(users).where(eq(users.id, f.ownerId)); assert.ok(owner);
    const session = await createWebSession({ id: owner.id, org_id: f.orgId, email: owner.email });
    const [sid] = await db.select().from(webSessions).where(and(eq(webSessions.user_id, owner.id), eq(webSessions.org_id, f.orgId))); assert.ok(sid);
    const app = new Hono(); app.use('*', authMiddleware); app.route('/api/apps/public', appPublicManagementRoutes);
    const http = await server(app); const locker = new pg.Client({ connectionString: target }); const observer = new pg.Client({ connectionString: target });
    await locker.connect(); await observer.connect();
    try {
      await locker.query('BEGIN'); await locker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [sid.id]);
      const path = operation === 'stage' ? 'endpoints/stage' : `endpoints/${endpoint.id}/${operation}`;
      const body = operation === 'stage' ? { ...f.endpointInput, authentication_policy: policy }
        : operation === 'disable' ? {} : { expected_review_digest: endpoint.review_digest, expected_endpoint_epoch: endpoint.endpoint_epoch,
          ...(operation === 'activate' ? { accept_host_policy: true } : {}) };
      const pending = fetch(`${http.base}/api/apps/public/${path}`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json' }, body: JSON.stringify(body) });
      const deadline = Date.now() + 3000; let blocked = false;
      while (Date.now() < deadline) {
        const row = (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%web_sessions%' AND pid<>pg_backend_pid() LIMIT 1")).rows[0];
        if (row) { blocked = true; break; } await delay(15);
      }
      assert.ok(blocked, `${operation} must reach final held SID`);
      await db.update(users).set(change).where(eq(users.id, owner.id)); await locker.query('COMMIT');
      const response = await pending; assert.equal(response.status, 403);
      const [retained] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, endpoint.id));
      assert.deepEqual(retained, endpoint);
      assert.equal((await db.select({ value: count() }).from(appPublicEndpoints).where(eq(appPublicEndpoints.org_id, f.orgId)))[0]!.value, 1);
      assert.equal((await db.select({ value: count() }).from(appPublicHmacKeys).where(eq(appPublicHmacKeys.endpoint_id, endpoint.id)))[0]!.value, 1);
    } finally { await locker.query('ROLLBACK'); await locker.end(); await observer.end(); await http.close(); }
  }
});

test('current web manager can stage activate disable and rotate signed endpoint through ordinary HTTP while missing raw target proof fails closed', { skip: !safe, timeout: 15000 }, async () => {
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const f = await publicAvailabilityFixture({ authenticationPolicy: policy });
  const [owner] = await db.select().from(users).where(eq(users.id, f.ownerId)); assert.ok(owner);
  const session = await createWebSession({ id: owner.id, org_id: f.orgId, email: owner.email });
  const app = new Hono(); app.use('*', authMiddleware); app.route('/api/apps/public', appPublicManagementRoutes);
  const http = await server(app);
  const call = async (path: string, body: unknown) => {
    const response = await fetch(`${http.base}/api/apps/public/${path}`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.status === 200 || response.status === 201); assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as { endpoint_id: string; endpoint_epoch: number; review_digest: string; signing_key?: { key_id: string; secret: string } };
  };
  try {
    const staged = await call('endpoints/stage', { ...f.endpointInput, authentication_policy: policy }); assert.ok(staged.signing_key);
    const accepted = await call(`endpoints/${staged.endpoint_id}/activate`, { expected_review_digest: staged.review_digest,
      expected_endpoint_epoch: staged.endpoint_epoch, accept_host_policy: true }); assert.equal(accepted.signing_key, undefined);
    await call(`endpoints/${staged.endpoint_id}/disable`, {});
    const [disabled] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, staged.endpoint_id)); assert.ok(disabled);
    const rotated = await call(`endpoints/${staged.endpoint_id}/rotate-signing-key`, { expected_review_digest: disabled.review_digest,
      expected_endpoint_epoch: disabled.endpoint_epoch }); assert.ok(rotated.signing_key); assert.notEqual(rotated.signing_key.key_id, staged.signing_key.key_id);
    const record = await f.record('No raw adapter'); const body = f.body(record.id, record.revision);
    const [endpoint] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, f.endpoint.endpoint_id)); assert.ok(endpoint && f.endpoint.signing_key);
    const timestamp = String(Math.floor(Number((await db.execute(sql`SELECT extract(epoch FROM clock_timestamp()) AS seconds`)).rows[0]!.seconds)));
    const headers = await signPublicHmacClaim(Buffer.from(f.endpoint.signing_key.secret, 'base64url'), { slug: f.endpoint.slug,
      endpoint_epoch: endpoint.endpoint_epoch, key_id: f.endpoint.signing_key.key_id, timestamp, nonce: randomBytes(32).toString('hex'), body });
    const requestOnly = new Hono().route('/api/public/apps', createAppPublicRoutes(new AppPublicClaimService({ enabled: true })));
    const response = await requestOnly.request(publicHmacClaimPath(f.endpoint.slug), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    assert.equal(response.status, 401);
  } finally { await http.close(); }
});
