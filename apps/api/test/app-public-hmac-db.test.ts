import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { and, count, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { signPublicHmacClaim, publicHmacClaimPath } from '@deft/app-kit';
import { appPublicEndpoints, appPublicHmacKeys, appPublicHmacNonces, appCanonicalClaims, appPublicIngress, appRuns, jobQueue } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { AppPublicClaimService, publicEndpointReviewDigest } from '../src/lib/app-public-service.js';
import { activatePublicEndpoint, disablePublicEndpoint, rotatePublicHmacKey, stagePublicEndpoint } from '../src/lib/app-public-management.js';
import { openPublicHmacSecret } from '../src/lib/app-public-hmac.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { createAppPublicRoutes } from '../src/routes/app-public.js';
import { dequeueJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { publicAvailabilityFixture } from './fixtures/public-availability.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c13_public_hmac_test(?:_v[0-9]+)?$/.test(target);
before(() => { if (safe) process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true'; });
after(async () => { if (safe) { await shutdownAppRunRuntime(); await closeDb(); } });
const policy = { schema_version: 'deft.app_public_hmac.v1' as const, mode: 'hmac_sha256' as const, max_clock_skew_seconds: 300 as const };
const fixture = () => publicAvailabilityFixture({ authenticationPolicy: policy });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function clock() { return Number((await db.execute(sql`SELECT extract(epoch FROM clock_timestamp()) AS seconds`)).rows[0]!.seconds); }
async function current(f: Fixture) { const [row] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, f.endpoint.endpoint_id)); assert.ok(row); return row; }
async function signed(f: Fixture, body: Uint8Array, timestamp?: number, nonce = randomBytes(32).toString('hex')): Promise<Record<string, string>> {
  assert.ok(f.endpoint.signing_key); const endpoint = await current(f);
  return { 'content-type': 'application/json', ...await signPublicHmacClaim(Buffer.from(f.endpoint.signing_key.secret, 'base64url'),
    { slug: f.endpoint.slug, endpoint_epoch: endpoint.endpoint_epoch, key_id: f.endpoint.signing_key.key_id,
      timestamp: String(timestamp ?? Math.floor(await clock())), nonce, body }) };
}
let nextPeer = 2;
async function http(service = new AppPublicClaimService({ enabled: true })) {
  const app = new Hono().route('/api/public/apps', createAppPublicRoutes(service));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}`, peer: `127.0.0.${nextPeer++}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function totals(f: Fixture) {
  const result: Record<string, number> = {};
  for (const [name, table] of [['nonce', appPublicHmacNonces], ['claim', appCanonicalClaims], ['ingress', appPublicIngress], ['queue', jobQueue]] as const) {
    result[name] = (await db.select({ value: count() }).from(table).where(eq(table.org_id, f.orgId)))[0]!.value;
  }
  return result;
}
async function send(server: Awaited<ReturnType<typeof http>>, f: Fixture, body: Uint8Array, headers: HeadersInit, suffix = '') {
  const exact = new Headers(headers); if (!exact.has('content-type')) exact.set('content-type', 'application/json');
  // Each synthetic fixture uses a real independent loopback socket peer; the
  // production30/min peer and600/min global limiter remains unchanged/active.
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(`${server.base}${publicHmacClaimPath(f.endpoint.slug)}${suffix}`, {
      method: 'POST', localAddress: server.peer, headers: Object.fromEntries(exact),
    }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.once('error', reject); incoming.once('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value != null) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
    });
    request.once('error', reject); request.setTimeout(15_000, () => request.destroy(new Error('Bounded fixture HTTP timeout')));
    request.end(Buffer.from(body));
  });
}

test('signed public claim HTTP authenticates original bytes and exact headers path epoch key while published availability remains public', { skip: !safe, timeout: 45_000 }, async () => {
  const f = await fixture(); const row = await f.record('Signed slot', '2055-01-01T00:00:00Z');
  const body = Buffer.from(`\n  ${f.body(row.id, row.revision).toString()}\n`); const headers = await signed(f, body);
  const server = await http();
  try {
    assert.equal(f.endpoint.authentication_scope, 'claim_ingress_only');
    await assert.rejects(stagePublicEndpoint(f.owner, { ...f.endpointInput,
      authentication_policy: { ...policy, mode: 'custom_verifier' } }));
    const available = await fetch(`${server.base}/api/public/apps/${f.endpoint.slug}/availability`); assert.equal(available.status, 200);
    for (const altered of [{ ...headers, 'x-deft-public-epoch': '999' }, { ...headers, 'x-deft-public-key-id': randomUUID() },
      { ...headers, 'x-deft-public-nonce': 'AB'.repeat(32) }, { ...headers, 'x-deft-public-timestamp': `0${headers['x-deft-public-timestamp']}` },
      { ...headers, 'x-deft-public-signature': `sha256=${'0'.repeat(64)}` }, {}]) assert.equal((await send(server, f, body, altered)).status, 401);
    for (const name of Object.keys(headers).filter(name => name.startsWith('x-deft-public-'))) {
      const duplicate = new Headers(headers); duplicate.append(name, headers[name as keyof typeof headers]!);
      assert.equal((await send(server, f, body, duplicate)).status, 401);
    }
    assert.equal((await send(server, f, Buffer.from(body.toString().trim()), headers)).status, 401);
    assert.equal((await send(server, f, body, headers, '?x=1')).status, 401);
    const encoded = `/api/public/apps/%${f.endpoint.slug.charCodeAt(0).toString(16)}${f.endpoint.slug.slice(1)}/claims`;
    assert.equal((await fetch(`${server.base}${encoded}`, { method: 'POST', headers, body })).status, 401);
    assert.equal((await send(server, f, body, await signed(f, body, Math.floor(await clock()) - 301))).status, 401);
    assert.equal((await send(server, f, body, await signed(f, body, Math.ceil(await clock()) + 301))).status, 401);
    assert.deepEqual(await totals(f), { nonce: 0, claim: 0, ingress: 0, queue: 0 });
    const accepted = await send(server, f, body, { ...headers, Cookie: 'access_token=foreign', Authorization: 'Bearer foreign', 'x-forwarded-host': 'hostile.invalid' });
    assert.equal(accepted.status, 201); assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await totals(f), { nonce: 1, claim: 1, ingress: 1, queue: 1 });
  } finally { await server.close(); }
});

test('signed nonce concurrency and fresh process replay deny while fresh nonce idempotency preserves one governed public Run', { skip: !safe, timeout: 60_000 }, async context => {
  const f = await fixture(); const row = await f.record('Replay', '2055-01-01T00:00:00Z'); const body = f.body(row.id, row.revision);
  const headers = await signed(f, body); const server = await http();
  try {
    const responses = await Promise.all([send(server, f, body, headers), send(server, f, body, headers)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    const accepted = await responses.find(response => response.status === 201)!.json() as { result: { claim_id: string } };
    const restarted = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/public-hmac-restart.ts'], { cwd: process.cwd(), env: process.env, windowsHide: true, signal: context.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; restarted.stdout.on('data', value => { output += value; }); restarted.stderr.on('data', value => { errors += value; });
    const exit = new Promise<number | null>((resolve, reject) => { restarted.once('error', reject); restarted.once('close', resolve); });
    restarted.stdin.end(JSON.stringify({ path: publicHmacClaimPath(f.endpoint.slug), headers, body: body.toString() }));
    assert.equal(await exit, 0, errors); const restartResult = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    assert.deepEqual(restartResult, { status: 409, code: 'PUBLIC_SIGNATURE_REPLAY' });
    const fresh = await send(server, f, body, await signed(f, body)); assert.equal(fresh.status, 200);
    const replay = await fresh.json() as { result: { claim_id: string; replayed: boolean } }; assert.equal(replay.result.claim_id, accepted.result.claim_id); assert.equal(replay.result.replayed, true);
    const job = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId, jobName: 'app-public-ingress' }); assert.ok(job);
    await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, job);
    const after = await send(server, f, body, await signed(f, body)); assert.equal(after.status, 200);
    const linked = await after.json() as { result: { claim_id: string; follow_up_state: string } };
    assert.equal(linked.result.claim_id, accepted.result.claim_id); assert.equal(linked.result.follow_up_state, 'run_created');
    const runs = await db.select().from(appRuns).where(eq(appRuns.org_id, f.orgId)); assert.equal(runs.length, 1);
    assert.equal(runs[0]!.initiating_actor_type, 'app_public'); assert.equal(runs[0]!.execution_actor_id, f.operatorId);
    assert.deepEqual(await totals(f), { nonce: 3, claim: 1, ingress: 1, queue: 1 });
  } finally { await server.close(); }
});

test('signed admission rechecks actual post-record-wait SQL time and rolls invalid body conflict and outbox failure back without nonce', { skip: !safe, timeout: 45_000 }, async () => {
  const f = await fixture(); const row = await f.record('Postwait', '2055-01-01T00:00:00Z'); const body = f.body(row.id, row.revision);
  const server = await http(); const locker = new pg.Client({ connectionString: target }); const observer = new pg.Client({ connectionString: target });
  await locker.connect(); await observer.connect();
  try {
    const invalid = Buffer.from('{"private":"é"}'); assert.equal((await send(server, f, invalid, await signed(f, invalid))).status, 400);
    await locker.query('BEGIN'); await locker.query('SELECT id FROM module_records WHERE id=$1 FOR UPDATE', [row.id]);
    let seconds = await clock(); const started = performance.now();
    while ((seconds % 1 < 0.5 || seconds % 1 > 0.65) && performance.now() - started < 1500) { await delay(10); seconds = await clock(); }
    assert.ok(seconds % 1 >= 0.5 && seconds % 1 <= 0.65);
    const timestamp = Math.ceil(seconds) - 300; const headers = await signed(f, body, timestamp); const pending = send(server, f, body, headers);
    let held = false;
    for (let i = 0; i < 30; i++) { const wait = await observer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%module_records%'");
      if (wait.rows[0].count) { held = true; break; } await delay(5); }
    assert.ok(held); const crossing = performance.now();
    while (await clock() <= timestamp + 300 && performance.now() - crossing < 800) await delay(10);
    assert.ok(await clock() > timestamp + 300); await locker.query('COMMIT'); assert.equal((await pending).status, 401);
    assert.deepEqual(await totals(f), { nonce: 0, claim: 0, ingress: 0, queue: 0 });
    const broken = await http(new AppPublicClaimService({ enabled: true, deliver: async () => { throw new Error('controlled outbox rollback'); } }));
    const retryHeaders = await signed(f, body);
    try { assert.equal((await send(broken, f, body, retryHeaders)).status, 503); } finally { await broken.close(); }
    assert.deepEqual(await totals(f), { nonce: 0, claim: 0, ingress: 0, queue: 0 });
    assert.equal((await send(server, f, body, retryHeaders)).status, 201);
    const conflictBody = f.body(row.id, row.revision); assert.equal((await send(server, f, conflictBody, await signed(f, conflictBody))).status, 409);
    assert.equal((await totals(f)).nonce, 1);
  } finally { await locker.query('ROLLBACK'); await locker.end(); await observer.end(); await server.close(); }
});

test('signed key rotation requires disabled exact review retains immutable sealed identities and never downgrades to anonymous', { skip: !safe, timeout: 45_000 }, async () => {
  const f = await fixture(); const row = await f.record('Rotation', '2055-01-01T00:00:00Z'); const body = f.body(row.id, row.revision); const server = await http();
  try {
    const oldHeaders = await signed(f, body); const active = await current(f);
    await assert.rejects(rotatePublicHmacKey(f.owner, active.id, { expected_review_digest: active.review_digest, expected_endpoint_epoch: active.endpoint_epoch }));
    await disablePublicEndpoint(f.owner, active.id); const disabled = await current(f);
    const rotated = await rotatePublicHmacKey(f.owner, active.id, { expected_review_digest: disabled.review_digest, expected_endpoint_epoch: disabled.endpoint_epoch });
    assert.notEqual(rotated.signing_key.key_id, f.endpoint.signing_key!.key_id); assert.equal(rotated.state, 'disabled');
    await assert.rejects(activatePublicEndpoint(f.owner, active.id, { expected_review_digest: disabled.review_digest, expected_endpoint_epoch: disabled.endpoint_epoch, accept_host_policy: true }));
    const activated = await activatePublicEndpoint(f.owner, active.id, { expected_review_digest: rotated.review_digest, expected_endpoint_epoch: rotated.endpoint_epoch, accept_host_policy: true });
    assert.equal('signing_key' in activated, false); assert.equal(activated.authentication_scope, 'claim_ingress_only');
    assert.equal((await send(server, f, body, oldHeaders)).status, 401); assert.equal((await send(server, f, body, {})).status, 401);
    const newHeaders = { 'content-type': 'application/json', ...await signPublicHmacClaim(Buffer.from(rotated.signing_key.secret, 'base64url'), {
      slug: f.endpoint.slug, endpoint_epoch: activated.endpoint_epoch, key_id: rotated.signing_key.key_id, timestamp: String(Math.floor(await clock())), nonce: randomBytes(32).toString('hex'), body }) };
    assert.equal((await send(server, f, body, newHeaders)).status, 201);
    const keys = await db.select().from(appPublicHmacKeys).where(eq(appPublicHmacKeys.endpoint_id, active.id)); assert.equal(keys.length, 2);
    assert.ok(keys.every(key => !key.sealed_secret.includes(rotated.signing_key.secret)));
    await assert.rejects(db.update(appPublicHmacKeys).set({ sealed_secret: 'altered' }).where(eq(appPublicHmacKeys.id, keys[0]!.id)));
    await assert.rejects(db.delete(appPublicHmacKeys).where(eq(appPublicHmacKeys.id, f.endpoint.signing_key!.key_id)),
      'retired unused key identity cannot be deleted and reused');
    const runtime = await getAppRunRuntime(); const stored = keys.find(key => key.id === rotated.signing_key.key_id)!;
    const document = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    document.run_encryption.keys['enc-v2'] = Buffer.alloc(32, 9).toString('base64'); document.run_encryption.current = 'enc-v2';
    const retained = parseEnvironmentAppRunKeyrings(JSON.stringify(document));
    try { const opened = openPublicHmacSecret(retained, f.orgId, active.id, stored.id, stored.sealed_secret);
      try { assert.equal(opened.toString('base64url'), rotated.signing_key.secret); } finally { opened.fill(0); }
    } finally { retained.destroy(); }
    delete document.run_encryption.keys[Buffer.from(stored.sealed_secret.split('.')[0]!, 'base64url').toString('utf8')];
    const missing = parseEnvironmentAppRunKeyrings(JSON.stringify(document));
    try { assert.throws(() => openPublicHmacSecret(missing, f.orgId, active.id, stored.id, stored.sealed_secret)); } finally { missing.destroy(); }
    assert.throws(() => openPublicHmacSecret(runtime.keys, randomUUID(), active.id, stored.id, stored.sealed_secret));
    assert.throws(() => openPublicHmacSecret(runtime.keys, f.orgId, randomUUID(), stored.id, stored.sealed_secret));
    assert.throws(() => openPublicHmacSecret(runtime.keys, f.orgId, active.id, randomUUID(), stored.sealed_secret));
    const off = await http(new AppPublicClaimService({ enabled: false }));
    try { assert.equal((await send(off, f, body, newHeaders)).status, 404); } finally { await off.close(); }
    const legacy = await publicAvailabilityFixture(); const legacyEndpoint = await current(legacy);
    assert.equal(legacyEndpoint.review_digest, publicEndpointReviewDigest({ ...legacyEndpoint, authentication_policy: undefined, hmac_key_id: undefined }));
    const legacyRecord = await legacy.record('Legacy', '2055-01-01T00:00:00Z'); assert.equal((await send(server, legacy, legacy.body(legacyRecord.id, legacyRecord.revision), { 'content-type': 'application/json' })).status, 201);
  } finally { await server.close(); }
});

test('signed nonce retention includes future timestamps bounds live replay growth and cleans at most100 expired receipts per acceptance', { skip: !safe, timeout: 45_000 }, async () => {
  const f = await fixture(); const row = await f.record('Cap', '2055-01-01T00:00:00Z'); const body = f.body(row.id, row.revision); const server = await http();
  try {
    const seconds = Math.floor(await clock()); const futureHeaders = await signed(f, body, seconds + 290);
    assert.equal((await send(server, f, body, futureHeaders)).status, 201);
    const [first] = await db.select().from(appPublicHmacNonces).where(eq(appPublicHmacNonces.endpoint_id, f.endpoint.endpoint_id)); assert.ok(first);
    assert.equal(first.expires_at.getTime(), (seconds + 590) * 1000); assert.ok(first.expires_at.getTime() > first.accepted_at.getTime() + 580_000);
    // Persisted cap fixture uses valid future-signed receipt windows, not1000 new reservations/effects.
    await db.insert(appPublicHmacNonces).values(Array.from({ length: 999 }, (_, index) => ({ id: randomUUID(), org_id: f.orgId,
      endpoint_id: f.endpoint.endpoint_id, key_id: f.endpoint.signing_key!.key_id,
      nonce_digest: `sha256:${createHash('sha256').update(`cap:${index}`).digest('hex')}`, signed_at: first.signed_at, accepted_at: first.accepted_at, expires_at: first.expires_at })));
    assert.equal((await send(server, f, body, await signed(f, body))).status, 429); assert.equal((await totals(f)).nonce, 1000); assert.equal((await totals(f)).claim, 1);
    const cleaned = await fixture(); const cleanRecord = await cleaned.record('Cleanup', '2055-01-01T00:00:00Z'); const cleanBody = cleaned.body(cleanRecord.id, cleanRecord.revision);
    const old = new Date((seconds - 900) * 1000);
    await db.insert(appPublicHmacNonces).values(Array.from({ length: 101 }, (_, index) => ({ id: randomUUID(), org_id: cleaned.orgId,
      endpoint_id: cleaned.endpoint.endpoint_id, key_id: cleaned.endpoint.signing_key!.key_id,
      nonce_digest: `sha256:${createHash('sha256').update(`expired:${index}`).digest('hex')}`, signed_at: old,
      accepted_at: new Date(old.getTime() + 1000), expires_at: new Date(old.getTime() + 300_000) })));
    assert.equal((await send(server, cleaned, cleanBody, await signed(cleaned, cleanBody))).status, 201);
    assert.equal((await totals(cleaned)).nonce, 2, 'exactly100 expired fixtures removed and one accepted nonce added');
  } finally { await server.close(); }
});
