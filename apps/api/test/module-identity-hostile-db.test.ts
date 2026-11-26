import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import { appInstallations, moduleInstallations, orgMembers, orgs, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import { moduleRoutes } from '../src/routes/modules.js';
import { appRoutes } from '../src/routes/apps.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

function mod(id: string, slug: string) {
  return {
    schema_version: '1', id, slug, version: '1.0.0', name: 'People',
    collections: [{ key: 'people', name: 'People', fields: [{ key: 'name', label: 'Name', type: 'text' }] }],
  };
}

async function seed() {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Tester', slug: `tester-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId, email: `${userId}@example.test`, name: 'Owner', role: 'owner' });
    await next();
  });
  app.route('/api/modules', moduleRoutes);
  app.route('/api/apps', appRoutes);
  return { orgId, actor: humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' }), app };
}

async function sideload(app: Hono, body: string) {
  const r = await app.request('/api/modules/sideload', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return { status: r.status, body: await r.json() as { code?: string; error?: string } };
}

test('hostile input: reserved look-alikes answer 409 or a clean 400, never 201 or 500', { skip: !canRun }, async () => {
  const { orgId, app } = await seed();
  const probes: Array<[string, string]> = [
    ['io.deft.email.x', 'mail-x'], ['io.deft', 'iodeft'], ['com.deft.contacts', 'people-a'],
    ['COM.DEFT.X', 'people-b'], [' com.deft.x', 'people-c'], ['com.deft.x ', 'people-d'],
    ['cоm.deft.x', 'people-e'], ['com.deft\u200b.x', 'people-f'], ['com.example.x', 'Contacts'],
    ['com.example.y', 'contacts '], ['com.example.z', 'con\u200btacts'], ['com.example.w', 'cоntacts'],
  ];
  for (const [id, slug] of probes) {
    const r = await sideload(app, JSON.stringify(mod(id, slug)));
    assert.ok(r.status === 409 || r.status === 400, `${JSON.stringify([id, slug])} → ${r.status} ${JSON.stringify(r.body)}`);
    if (r.status === 409) assert.equal(r.body.code, 'MODULE_IDENTITY_RESERVED');
    assert.doesNotMatch(r.body.error ?? '', /[<>\u200b\u202e]|\[\s*\{|\{\s*"/, r.body.error);
  }
  assert.equal((await db.select().from(moduleInstallations).where(eq(moduleInstallations.org_id, orgId))).length, 0);
});

test('hostile input: an App whose module takes a first-party id (not just the slug) is refused, nothing stored', { skip: !canRun }, async () => {
  const { orgId, app } = await seed();
  for (const m of [mod('io.deft.people', 'people'), mod('com.deft.contacts', 'people2')]) {
    const artifact = await prepareModuleArtifact({ path: `modules/${m.slug}/deft.module.json`, manifest: m });
    const built = await buildDeftAppPackage({
      manifest: {
        schema_version: '0', id: `community.example.${m.slug}`, version: '1.0.0', name: 'People app',
        license: 'AGPL-3.0-only', compatibility: { app_protocol: '0' },
        modules: [{ module_id: m.id, version: m.version, manifest_path: artifact.path, manifest_digest: artifact.digest }],
        navigation: [{ key: 'people', label: 'People', module_id: m.id, collection_key: 'people' }],
      },
      artifacts: [artifact],
    });
    const r = await app.request('/api/apps/stage', { method: 'POST', body: built.json });
    assert.equal(r.status, 409, `${m.id}: ${r.status}`);
    assert.equal((await r.json() as { code?: string }).code, 'MODULE_IDENTITY_RESERVED');
  }
  assert.equal((await db.select().from(appInstallations).where(eq(appInstallations.org_id, orgId))).length, 0);
});

test('hostile input: hostile sideload bodies answer 4xx, never 500', { skip: !canRun }, async () => {
  const { app } = await seed();
  const deep = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
  const bodies = [
    '{"schema_version":"1",', '[1,2]', '"x"', 'null', `{"schema_version":"1","x":${deep(60000)}}`,
    JSON.stringify(mod('com.example.p', 'p')).replace(/^\{/, '{"__proto__":{"polluted":true},'),
    JSON.stringify(mod('com.example.q', 'q')).replace('"fields":[', '"fields":[{"key":"__proto__","label":"<b>\u202e","type":"text"},'),
    `{"__proto__":{"a":1},"constructor":{"prototype":{}},${Array.from({ length: 4000 }, (_, i) => `"k${i}":1`).join(',')}}`,
    ' '.repeat(128 * 1024 + 1),
  ];
  for (const body of bodies) {
    const r = await sideload(app, body);
    assert.ok(r.status >= 400 && r.status < 500, `${body.slice(0, 40)} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const lines = (r.body.error ?? '').split('\n');
    assert.ok(lines.length <= 3 && lines.every((l) => l.length <= 240), r.body.error);
  }
});
