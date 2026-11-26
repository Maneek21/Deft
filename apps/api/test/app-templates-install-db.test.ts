import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { moduleInstallations, moduleRecordRelations, moduleRecords, orgMembers, orgs, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { moduleRoutes } from '../src/routes/modules.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
// The browser's own starter logic, driven against the real routes.
import { APP_TEMPLATES, installAppTemplate } from '../../web/src/lib/app-templates.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

async function seedOwner() {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Starter apps', slug: `starters-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('user', { id: userId, org_id: orgId, email: `${userId}@example.test`, name: 'Owner', role: 'owner' });
    await next();
  });
  app.route('/api/modules', moduleRoutes);
  const fetch = async (path: string, init: RequestInit) => app.request(path, init);
  return { orgId, fetch };
}

test('every starter installs as an uploaded app and seeds its samples with links', { skip: !canRun }, async () => {
  const { orgId, fetch } = await seedOwner();
  for (const template of APP_TEMPLATES) {
    const result = await installAppTemplate({ template, name: `Team ${template.name}`, withSamples: true, fetch });
    assert.equal(result.seedError, undefined, `${template.key}: ${result.seedError}`);
    assert.equal(result.seeded, template.samples.length);
    const [installation] = await db.select().from(moduleInstallations).where(and(
      eq(moduleInstallations.org_id, orgId), eq(moduleInstallations.slug, result.slug),
    ));
    // Sideloaded, so the person can keep editing and upgrading it.
    assert.equal(installation?.source, 'sideloaded');
    assert.equal(installation?.module_id, `workspace.${result.slug}`);
    const records = await db.select().from(moduleRecords).where(eq(moduleRecords.installation_id, installation!.id));
    assert.equal(records.length, template.samples.length);
    const links = template.samples.reduce((total, sample) => total + Object.keys(sample.links ?? {}).length, 0);
    const relations = await db.select().from(moduleRecordRelations).where(eq(moduleRecordRelations.org_id, orgId));
    assert.ok(relations.length >= links, `${template.key}: ${relations.length} links stored`);
  }
});

test('installing the same starter twice keeps both, the second under -2', { skip: !canRun }, async () => {
  const { fetch } = await seedOwner();
  const template = APP_TEMPLATES[0]!;
  const first = await installAppTemplate({ template, name: 'Hiring', withSamples: false, fetch });
  const second = await installAppTemplate({ template, name: 'Hiring', withSamples: false, fetch });
  assert.deepEqual([first.slug, second.slug], ['hiring', 'hiring-2']);
});
