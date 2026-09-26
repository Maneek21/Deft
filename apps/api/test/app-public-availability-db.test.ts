import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, count } from 'drizzle-orm';
import pg from 'pg';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { appPublicEndpoints, appModuleBindings, moduleRecords, appCanonicalClaims, appPublicIngress, jobQueue } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { AppPublicClaimService, publicEndpointReviewDigest } from '../src/lib/app-public-service.js';
import { createAppPublicRoutes } from '../src/routes/app-public.js';
import { disablePublicEndpoint } from '../src/lib/app-public-management.js';
import { shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { canClaimPublicAvailability, openPublicAvailabilityCursor, sealPublicAvailabilityCursor } from '../src/lib/app-public-availability.js';
import { publicAvailabilityFixture } from './fixtures/public-availability.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c11_public_availability_test(?:_v[0-9]+)?$/.test(target);
before(() => { if (safe) process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true'; });
after(async () => { if (safe) { await shutdownAppRunRuntime(); await closeDb(); } });
const conflict = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PUBLIC_CLAIM_CONFLICT';

async function publicHttp(service: AppPublicClaimService) {
  const app = new Hono().route('/api/app-public', createAppPublicRoutes(service));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}/api/app-public`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('reviewed public availability exposes only authored scalars with bounded opaque pagination and canonical claim omission', { skip: !safe }, async () => {
  const f = await publicAvailabilityFixture();
  const service = new AppPublicClaimService({ enabled: true });
  const secondService = new AppPublicClaimService({ enabled: true });
  const future = '2055-11-07T01:30:00-04:00';
  for (let i = 0; i < 12; i++) await f.record(`<b>Slot ${i}</b>`, '2055-11-06T23:00:00-04:00', future);
  await f.record('Expired', '2000-01-01T00:00:00Z');
  const http = await publicHttp(service);
  try {
  const response = await fetch(`${http.base}/${f.endpoint.slug}/availability`, { headers: {
    Cookie: 'access_token=forged', Authorization: 'Bearer foreign-workspace-session' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { result } = await response.json() as { result: Awaited<ReturnType<typeof service.availability>> };
  assert.equal(result.items.length, 10); assert.ok(result.next_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify({ result })) <= 32_768);
  assert.equal(JSON.stringify(result).includes('NEVER PUBLIC'), false);
  assert.equal(JSON.stringify(result).includes('private_note'), false);
  assert.deepEqual(Object.keys(result.items[0]!.fields).sort(), ['starts_at', 'timezone', 'title']);
  assert.equal(result.items[0]!.fields.starts_at, future);
  assert.equal(result.items[0]!.claim_deadline_utc, '2055-11-07T03:00:00.000Z');
  const opaque = Buffer.from(result.next_cursor.split('.')[1]!, 'base64url').toString('utf8');
  assert.equal(opaque.includes(f.endpoint.endpoint_id), false); assert.equal(opaque.includes(f.module.id), false);
  const next = await secondService.availability(f.endpoint.slug, result.next_cursor);
  assert.equal(next.items.length, 2); assert.equal(next.next_cursor, null);
  assert.equal(new Set([...result.items, ...next.items].map(row => row.resource_ref.resource_id)).size, 12);
  const selected = result.items[0]!;
  const claimed = await fetch(`${http.base}/${f.endpoint.slug}/claims`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'access_token=foreign', Authorization: 'Bearer forged' },
    body: f.body(selected.resource_ref.resource_id, selected.revision).toString('utf8') });
  assert.equal(claimed.status, 201);
  const { result: claim } = await claimed.json() as { result: Awaited<ReturnType<typeof service.claim>> };
  assert.equal(claim.claim_state, 'confirmed'); assert.equal(claim.follow_up_state, 'pending');
  const after = await service.availability(f.endpoint.slug);
  assert.ok(after.items.every(row => row.resource_ref.resource_id !== selected.resource_ref.resource_id));
  // All first100 candidates are expired; scan continuation must still reach
  // the healthy tail, even when the first page emits no items.
  const scanned = await publicAvailabilityFixture();
  for (let i = 0; i < 101; i++) await scanned.record(`Old ${i}`, '2000-01-01T00:00:00Z');
  const records = await db.select({ id: moduleRecords.id }).from(moduleRecords).where(eq(moduleRecords.installation_id, scanned.module.id)).orderBy(moduleRecords.id);
  await db.update(moduleRecords).set({ data: { title: 'Tail', starts_at: future, timezone: 'America/New_York',
    claim_by: '2055-11-06T23:00:00-04:00', private_note: 'NEVER PUBLIC' } }).where(eq(moduleRecords.id, records.at(-1)!.id));
  const empty = await service.availability(scanned.endpoint.slug);
  assert.equal(empty.items.length, 0); assert.ok(empty.next_cursor);
  const tail = await secondService.availability(scanned.endpoint.slug, empty.next_cursor);
  assert.equal(tail.items.length, 1); assert.equal(tail.next_cursor, null);
  } finally { await http.close(); }
});

test('public availability preserves claim-only endpoints and rejects field, version, ownership and cursor substitutions', { skip: !safe }, async () => {
  const service = new AppPublicClaimService({ enabled: true });
  const legacy = await publicAvailabilityFixture({ availability: false });
  const oldRecord = await legacy.record('Legacy past deadline', '2000-01-01T00:00:00Z');
  await assert.rejects(service.availability(legacy.endpoint.slug), error => error instanceof Error && 'code' in error && error.code === 'PUBLIC_NOT_FOUND');
  assert.equal((await service.claim(legacy.endpoint.slug, legacy.body(oldRecord.id, oldRecord.revision))).claim_state, 'confirmed');
  await assert.rejects(publicAvailabilityFixture({ deadlineField: 'title' }), /datetime claim deadline/);
  const f = await publicAvailabilityFixture();
  for (let i = 0; i < 11; i++) await f.record(`Slot ${i}`);
  const first = await service.availability(f.endpoint.slug); assert.ok(first.next_cursor);
  const foreign = await publicAvailabilityFixture();
  await assert.rejects(service.availability(foreign.endpoint.slug, first.next_cursor), error => error instanceof Error && 'code' in error && error.code === 'PUBLIC_INVALID_INPUT');
  await assert.rejects(service.availability(f.endpoint.slug, `${first.next_cursor}x`));
  const route = createAppPublicRoutes(service);
  for (const query of ['fields=private_note', 'cursor=a&cursor=b']) {
    const denied = await route.request(`/${f.endpoint.slug}/availability?${query}`);
    assert.equal(denied.status, 400); assert.equal(denied.headers.get('cache-control'), 'no-store');
  }
  const [endpoint] = await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id, f.endpoint.endpoint_id)); assert.ok(endpoint?.availability_policy);
  for (const policy of [{ ...endpoint.availability_policy, fields: ['missing'] },
    { ...endpoint.availability_policy, module_version_id: randomUUID() },
    { ...endpoint.availability_policy, fields: ['private_note'] }]) {
    await db.update(appPublicEndpoints).set({ availability_policy: policy,
      review_digest: publicEndpointReviewDigest({ ...endpoint, availability_policy: policy }) }).where(eq(appPublicEndpoints.id, endpoint.id));
    await assert.rejects(service.availability(f.endpoint.slug));
  }
  await db.update(appPublicEndpoints).set({ availability_policy: endpoint.availability_policy,
    review_digest: endpoint.review_digest }).where(eq(appPublicEndpoints.id, endpoint.id));
  const [ownedBinding] = await db.select().from(appModuleBindings).where(and(eq(appModuleBindings.app_installation_id, endpoint.app_installation_id), eq(appModuleBindings.module_installation_id, f.module.id))); assert.ok(ownedBinding);
  await assert.rejects(db.delete(appModuleBindings).where(eq(appModuleBindings.id, ownedBinding.id)),
    error => error instanceof Error && String(error.cause).includes('APP_MODULE_BINDING_APPEND_ONLY'));
  await assert.rejects(db.update(appModuleBindings).set({ ownership: 'preexisting' as 'app' }).where(eq(appModuleBindings.id, ownedBinding.id)));
  assert.equal((await service.availability(f.endpoint.slug)).items.length, 10);
  await disablePublicEndpoint(f.owner, endpoint.id);
  await assert.rejects(service.availability(f.endpoint.slug, first.next_cursor));
});

test('public claim deadlines reject actual post-lock expiry while confirmed replay and rollback identities remain honest', { skip: !safe, timeout: 30_000 }, async () => {
  const f = await publicAvailabilityFixture();
  const service = new AppPublicClaimService({ enabled: true });
  const stale = await f.record('Stale revision');
  const listed = (await service.availability(f.endpoint.slug)).items.find(row => row.resource_ref.resource_id === stale.id); assert.ok(listed);
  await db.update(moduleRecords).set({ revision: stale.revision + 1 }).where(eq(moduleRecords.id, stale.id));
  await assert.rejects(service.claim(f.endpoint.slug, f.body(stale.id, listed.revision)), conflict);
  const record = await f.record('Cross deadline');
  const locker = new pg.Client({ connectionString: target }); await locker.connect();
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await locker.query('BEGIN');
    // Admission uses PostgreSQL time: derive and observe its deadline on that
    // same clock rather than assuming the Windows and WSL wall clocks agree.
    const updated = await locker.query(`UPDATE module_records SET data=jsonb_set(data,$2,
      to_jsonb(to_char((clock_timestamp()+interval '500 milliseconds') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id=$1 RETURNING data->>'claim_by' AS deadline`,
      [record.id, '{claim_by}']);
    const deadline = updated.rows[0].deadline as string;
    const pending = service.claim(f.endpoint.slug, f.body(record.id, record.revision));
    const rejected = assert.rejects(pending, conflict);
    const waitStarted = performance.now();
    let held = false;
    for (let i = 0; i < 30; i++) {
      const waiting = await observer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%module_records%'");
      if (waiting.rows[0].count > 0) { held = true; break; }
      await delay(10);
    }
    assert.ok(held, 'actual canonical record lock waiter must be observed before release');
    let crossed = false;
    while (performance.now() - waitStarted < 850) {
      const clock = await observer.query('SELECT clock_timestamp() >= $1::timestamptz AS crossed', [deadline]);
      if (clock.rows[0].crossed) { crossed = true; break; }
      await delay(10);
    }
    assert.ok(crossed, 'actual PostgreSQL clock must cross the deadline before release');
    await locker.query('COMMIT'); await rejected;
    assert.equal((await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.resource_id, record.id)))[0]!.value, 0);
  } finally { await locker.query('ROLLBACK'); await locker.end(); await observer.end(); }
  const replayRecord = await f.record('Replay'); const body = f.body(replayRecord.id, replayRecord.revision);
  const original = await service.claim(f.endpoint.slug, body);
  await db.update(moduleRecords).set({ data: { ...replayRecord.data, claim_by: '2000-01-01T00:00:00Z' } }).where(eq(moduleRecords.id, replayRecord.id));
  const replay = await service.claim(f.endpoint.slug, body); assert.equal(replay.claim_id, original.claim_id); assert.equal(replay.replayed, true);
  const rollbackRecord = await f.record('Rollback');
  const broken = new AppPublicClaimService({ enabled: true, deliver: async () => { throw new Error('before outbox commit'); } });
  await assert.rejects(broken.claim(f.endpoint.slug, f.body(rollbackRecord.id, rollbackRecord.revision)));
  assert.equal((await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.resource_id, rollbackRecord.id)))[0]!.value, 0);
  const repaired = await service.claim(f.endpoint.slug, f.body(rollbackRecord.id, rollbackRecord.revision)); assert.equal(repaired.claim_state, 'confirmed');
  const [claims] = await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.org_id, f.orgId));
  const [outbox] = await db.select({ value: count() }).from(jobQueue).where(eq(jobQueue.org_id, f.orgId));
  const [confirmed] = await db.select({ value: count() }).from(appPublicIngress).where(and(eq(appPublicIngress.org_id, f.orgId), eq(appPublicIngress.state, 'confirmed')));
  assert.equal(claims!.value, 2); assert.equal(outbox!.value, 2); assert.equal(confirmed!.value, 2);
});

test('public availability cursor survives another keyring instance and retained-key rotation while exact UTC deadline edges remain closed', { skip: !safe }, () => {
  const initial = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
  const original = parseEnvironmentAppRunKeyrings(JSON.stringify(initial));
  const next = structuredClone(initial);
  next.run_encryption.keys['enc-v2'] = Buffer.alloc(32, 9).toString('base64'); next.run_encryption.current = 'enc-v2';
  const rotated = parseEnvironmentAppRunKeyrings(JSON.stringify(next));
  const cursor = { schema_version: 'deft.app_public_availability_cursor.v1' as const, endpoint_id: randomUUID(),
    endpoint_epoch: 2, review_digest: `sha256:${'a'.repeat(64)}`, module_version_id: randomUUID(), after: randomUUID(), expires_at: Date.now() + 300_000 };
  try {
    const token = sealPublicAvailabilityCursor(original, cursor);
    assert.deepEqual(openPublicAvailabilityCursor(rotated, token), cursor);
    delete next.run_encryption.keys['enc-v1'];
    const missing = parseEnvironmentAppRunKeyrings(JSON.stringify(next));
    try { assert.throws(() => openPublicAvailabilityCursor(missing, token)); } finally { missing.destroy(); }
    const policy = { schema_version: 'deft.app_public_availability.v1' as const, fields: ['title'], claim_deadline_field: 'until', page_size: 10, module_version_id: randomUUID() };
    const value = { until: '2055-11-07T01:30:00-04:00' };
    const at = Date.parse('2055-11-07T05:30:00Z');
    assert.equal(canClaimPublicAvailability(policy, value, new Date(at - 1)), true);
    assert.equal(canClaimPublicAvailability(policy, value, new Date(at)), false);
    assert.equal(canClaimPublicAvailability(policy, value, new Date(at + 1)), false);
    assert.equal(canClaimPublicAvailability(policy, { until: '2055-11-07T01:30:00' }, new Date(at - 1)), false);
  } finally { original.destroy(); rotated.destroy(); }
});
