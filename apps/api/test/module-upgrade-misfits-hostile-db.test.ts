import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { moduleInstallations, moduleRecords, moduleRecordRelations, moduleVersions, orgMembers, orgs, users } from '@deft/db/schema';
import { digestModuleManifest } from '@deft/shared/modules';
import { db, closeDb } from '../src/lib/db.js';
import { humanModuleActor, installModuleFromManifest, upgradeModuleInstallationToManifest } from '../src/lib/module-service.js';
import { ModuleError } from '../src/lib/module-errors.js';
import { moduleRoutes } from '../src/routes/modules.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const target = safeTestDatabaseUrl();
const opts = { skip: !target };
const client = new pg.Client({ connectionString: target });
let connected = false;
after(async () => { if (connected) await client.end(); await closeDb(); });
const fields = [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'email', label: 'Email', type: 'email' }];
function manifest(version = '1.0.0', more: object[] = []) {
  return { schema_version: '1', id: 'com.example.testerfour', slug: 'testerfour', version, name: 'Tester Four', collections: [{ key: 'items', name: 'Items', fields: [...fields, ...more], search: { title_field: 'name', fields: ['name'] } }] };
}
async function seed(previous: unknown = manifest()) {
  const orgId = randomUUID(), userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Tester Four', slug: `testerfour-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const installed = await installModuleFromManifest(actor, previous, { source: 'sideloaded' });
  return { orgId, userId, actor, installed };
}
type Seed = Awaited<ReturnType<typeof seed>>;
async function records(s: Seed, data: Record<string, unknown>[], collection = 'items') {
  const rows = data.map((value) => ({ id: randomUUID(), org_id: s.orgId, installation_id: s.installed.id, collection_key: collection, validated_version_id: s.installed.active_version_id, data: value, search_title: String(value.name ?? ''), search_text: '', created_by_actor_type: 'human', created_by_actor_id: s.userId, updated_by_actor_type: 'human', updated_by_actor_id: s.userId }));
  if (rows.length) await db.insert(moduleRecords).values(rows);
  return rows;
}
function upgrade(s: Seed, next: unknown) {
  return upgradeModuleInstallationToManifest(s.actor, 'testerfour', next, { source: 'sideloaded', expected_active_manifest_digest: s.installed.manifest_digest });
}
async function refused(p: Promise<unknown>) {
  try { await p; } catch (e) { assert.ok(e instanceof ModuleError, String(e)); assert.equal(e.status, 400); assert.equal(e.code, 'MODULE_VALIDATION_ERROR'); return e; }
  assert.fail('expected refusal');
}
function required(version = '1.1.0') {
  const next = manifest(version); next.collections[0]!.fields[1] = { ...fields[1]!, required: true } as typeof fields[number]; return next;
}

test('hostile input: all title fallback shapes and many problems preserve bounded nested details', opts, async () => {
  const s = await seed();
  const names = [undefined, 123, '', '<b>"Eve"</b>[]{}' + String.fromCodePoint(0x202e, 0x200b, 0xfeff, 0xe0001)];
  await records(s, Array.from({ length: 30 }, (_, i) => ({ ...(names[i % 4] === undefined ? {} : { name: names[i % 4] }) })));
  const next = required();
  next.collections[0]!.fields.push(...Array.from({ length: 15 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: 'text', required: true })));
  const e = await refused(upgrade(s, next));
  assert.equal(e.details?.record_count, 30);
  const details = e.details?.records as Array<{ title: string; problems: unknown[] }>;
  assert.equal(details.length, 20);
  assert.ok(details.every((r) => r.problems.length >= 16));
  assert.ok(e.message.split('\n').length <= 3);
  assert.ok(details.every((r) => !/[<>"`{}\[\]\u202e\u200b\ufeff]/.test(r.title)));
  assert.ok((e.message.match(/"[^"]*"/g) ?? []).length <= 5);
});

test('hostile input: a member problem in an earlier record never hides a later data misfit', opts, async () => {
  const s = await seed(manifest('1.0.0', [{ key: 'owner', label: 'Owner', type: 'member' }]));
  const missing = randomUUID();
  await records(s, [{ name: 'Inactive owner', email: 'ok@example.test', owner: missing }, { name: 'Missing email' }]);
  const next = required(); next.collections[0]!.fields.push({ key: 'owner', label: 'Owner', type: 'member' });
  const e = await refused(upgrade(s, next));
  // Data misfits are listed first; a member problem cannot hide them.
  assert.equal(e.details?.record_count, 1);
  assert.match(e.message, /Missing email/);
});

test('hostile input: removed record types name every rejected record', opts, async () => {
  const old = manifest(); old.collections.push({ ...old.collections[0]!, key: 'legacy', name: 'Legacy' });
  const s = await seed(old); await records(s, [{ name: 'Gone one' }, { name: 'Gone two' }], 'legacy');
  const e = await refused(upgrade(s, manifest('1.1.0')));
  assert.equal(e.details?.record_count, 2);
  assert.match(e.message, /Legacy/); assert.match(e.message, /Gone one/); assert.match(e.message, /Gone two/);
});

test('hostile input: 20,000 records are all scanned with bounded response and practical runtime', opts, async (t) => {
  const s = await seed();
  if (!connected) { await client.connect(); connected = true; }
  await client.query(`INSERT INTO module_records (id, org_id, installation_id, collection_key, validated_version_id, data, search_title, search_text, created_by_actor_type, created_by_actor_id, updated_by_actor_type, updated_by_actor_id) SELECT $1 || '-' || i, $2, $3, 'items', $4, jsonb_build_object('name', 'Person ' || i), 'Person ' || i, '', 'human', $5, 'human', $5 FROM generate_series(1,20000) i`, [randomUUID(), s.orgId, s.installed.id, s.installed.active_version_id, s.userId]);
  const start = performance.now();
  const e = await refused(upgrade(s, required()));
  const elapsed = performance.now() - start;
  t.diagnostic(`20,000 records: ${elapsed.toFixed(0)} ms; error payload ${JSON.stringify(e.details).length} chars`);
  assert.equal(e.details?.record_count, 20000);
  assert.equal((e.details?.records as unknown[]).length, 20);
  assert.ok(e.message.split('\n').length <= 3);
  assert.ok(JSON.stringify(e.details).length < 20000);
  assert.ok(elapsed < 30000, `refusal took ${elapsed} ms`);
});

test('hostile input: real sideload and upgrade routes store and digest identically with or without $schema', opts, async () => {
  const a = await seed(), b = await seed();
  async function app(s: Seed) {
    const h = new Hono();
    h.use('*', async (c, next) => { c.set('user', { id: s.userId, org_id: s.orgId, email: `${s.userId}@example.test`, name: 'Owner', role: 'owner' }); await next(); });
    h.route('/api/modules', moduleRoutes); return h;
  }
  const ha = await app(a), hb = await app(b);
  const m = { ...manifest(), id: 'com.example.schemafour', slug: 'schemafour' };
  const request = (h: Hono, path: string, value: unknown, digest?: string) => h.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(digest ? { 'If-Match': digest } : {}) }, body: JSON.stringify(value) });
  const ra = await request(ha, '/api/modules/sideload', m), rb = await request(hb, '/api/modules/sideload', { ...m, $schema: 's'.repeat(2048) });
  assert.equal(ra.status, 201, await ra.clone().text()); assert.equal(rb.status, 201, await rb.clone().text());
  const ma = (await ra.json() as any).module, mb = (await rb.json() as any).module;
  assert.equal(ma.manifest_digest, mb.manifest_digest);
  const next = { ...m, version: '1.1.0' };
  const ua = await request(ha, '/api/modules/schemafour/upgrade', next, ma.manifest_digest);
  const ub = await request(hb, '/api/modules/schemafour/upgrade', { ...next, $schema: './schema.json' }, mb.manifest_digest);
  assert.equal(ua.status, 200, await ua.clone().text()); assert.equal(ub.status, 200, await ub.clone().text());
  const va = (await ua.json() as any).module, vb = (await ub.json() as any).module;
  assert.equal(va.manifest_digest, vb.manifest_digest);
  assert.equal(va.manifest_digest, await digestModuleManifest(next));
  const stored = await db.select().from(moduleVersions).where(eq(moduleVersions.installation_id, mb.id));
  assert.equal(stored.length, 2); assert.ok(stored.every((v) => !('$schema' in v.manifest)));
});
