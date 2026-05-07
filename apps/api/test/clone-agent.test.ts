/**
 * Block 3.1 — clone + save-as-template tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/clone-agent.test.ts
 *
 * Exercises POST /api/agent-employees/:id/clone and
 * POST /api/agent-employees/:id/save-as-template by calling the
 * Hono app in-process (no live HTTP server needed).
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray, and } from 'drizzle-orm';
import {
  db, agentEmployees, agentEmployeeSkills, agentEmployeeTemplates, skills,
  orgs, users, orgMembers,
} from '@deft/db';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';
import { Hono } from 'hono';

let testOrgId: string;
let testUserId: string;
let sourceEmployeeId: string;
let skillId: string;
const cloneIds: string[] = [];
const templateIds: string[] = [];

// Mini test harness: mount the routes + a middleware that injects `user`
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: testUserId, org_id: testOrgId, email: 'test@test.local' });
  await next();
});
app.route('/api/agent-employees', agentEmployeeRoutes);

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b31', slug: 'b31' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b31-${Date.now()}@t.local`, name: 'b31' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  // Source employee with one attached skill
  sourceEmployeeId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: sourceEmployeeId, org_id: testOrgId, user_id: testUserId,
    slug: `b31-source-${Date.now()}`, name: 'B31 Source', system_prompt: 'test',
    is_byoa: true, trust_level: 'standard',
    expertise_description: 'Source agent', starter_prompts: ['Say hi'] as any,
    created_by: testUserId, role: 'project_manager',
  });

  skillId = crypto.randomUUID();
  await db.insert(skills).values({
    id: skillId, org_id: testOrgId, name: 'b31-skill',
    slug: `b31-skill-${Date.now()}`, source: 'org', version: '1.0.0',
  });
  await db.insert(agentEmployeeSkills).values({
    agent_employee_id: sourceEmployeeId, skill_id: skillId, installed_version: '1.0.0',
  });
});

afterEach(async () => {
  if (cloneIds.length > 0) {
    await db.delete(agentEmployeeSkills).where(inArray(agentEmployeeSkills.agent_employee_id, cloneIds));
    await db.delete(agentEmployees).where(inArray(agentEmployees.id, cloneIds));
    cloneIds.length = 0;
  }
  if (templateIds.length > 0) {
    await db.delete(agentEmployeeTemplates).where(inArray(agentEmployeeTemplates.id, templateIds));
    templateIds.length = 0;
  }
});

after(async () => {
  await db.delete(agentEmployeeSkills).where(eq(agentEmployeeSkills.agent_employee_id, sourceEmployeeId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, sourceEmployeeId));
  await db.delete(skills).where(eq(skills.id, skillId));
});

async function fetchApp(path: string, init: RequestInit = {}) {
  return app.request(path, init);
}

// ─── Clone ──────────────────────────────────────────────────────────────
test('POST /:id/clone duplicates the employee with a fresh slug + copies skills', async () => {
  const res = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as any;
  assert.equal(body.cloned_from, sourceEmployeeId);
  assert.ok(body.employee.id);
  cloneIds.push(body.employee.id);

  assert.equal(body.employee.name, 'B31 Source (copy)');
  assert.match(body.employee.slug, /-copy$/);

  // Skills copied
  const skillRows = await db
    .select()
    .from(agentEmployeeSkills)
    .where(eq(agentEmployeeSkills.agent_employee_id, body.employee.id));
  assert.equal(skillRows.length, 1);
  assert.equal(skillRows[0]!.skill_id, skillId);
});

test('POST /:id/clone disambiguates slug on repeat', async () => {
  const r1 = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const b1 = await r1.json() as any;
  cloneIds.push(b1.employee.id);
  const r2 = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const b2 = await r2.json() as any;
  cloneIds.push(b2.employee.id);

  assert.notEqual(b1.employee.slug, b2.employee.slug);
  assert.match(b2.employee.slug, /-copy-\d+$/);
});

test('POST /:id/clone accepts a caller-provided name + slug', async () => {
  const res = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nightly cousin', slug: `b31-nightly-${Date.now()}` }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as any;
  cloneIds.push(body.employee.id);
  assert.equal(body.employee.name, 'Nightly cousin');
});

test('POST /:id/clone returns 404 for unknown employee', async () => {
  const res = await fetchApp(`/api/agent-employees/${crypto.randomUUID()}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 404);
});

// ─── Save as template ───────────────────────────────────────────────────
test('POST /:id/save-as-template creates an org-scoped template row', async () => {
  const slug = `b31-tpl-${Date.now()}`;
  const res = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/save-as-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      slug,
      name: 'My team playbook',
      description: 'Reusable PM template',
    }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.ok(body.template.id);
  templateIds.push(body.template.id);

  assert.equal(body.template.org_id, testOrgId);
  assert.equal(body.template.slug, slug);
  assert.equal(body.template.source, 'user');
  assert.equal(body.template.is_public, false);
  assert.equal(body.linked_skill_slugs.length, 1);
});

test('POST /:id/save-as-template returns 409 on slug conflict within the same org', async () => {
  const slug = `b31-tpl-conflict-${Date.now()}`;
  const r1 = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/save-as-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, name: 'First', description: 'first one' }),
  });
  const b1 = await r1.json() as any;
  templateIds.push(b1.template.id);

  const r2 = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/save-as-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, name: 'Second', description: 'second dup' }),
  });
  assert.equal(r2.status, 409);
});

test('POST /:id/save-as-template rejects bad slug format', async () => {
  const res = await fetchApp(`/api/agent-employees/${sourceEmployeeId}/save-as-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'Bad Slug Name!', name: 'x', description: 'x' }),
  });
  assert.equal(res.status, 400);
});
