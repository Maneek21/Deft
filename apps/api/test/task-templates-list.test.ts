/**
 * Shape test for the new list/get endpoints. Exercises route wiring
 * against an in-process Hono app. Uses the seeded pilot user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/index.js';

async function authHeaders(): Promise<Record<string, string>> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'diego@testers-tomatoes.com', password: 'tomato123' }),
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

test('GET /api/task-templates returns bundled + org templates', async () => {
  const headers = await authHeaders();
  const res = await app.request('/api/task-templates', { headers });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { templates: Array<{ slug: string; source: string }> };
  assert.ok(Array.isArray(body.templates));
  const slugs = body.templates.map((t) => t.slug).sort();
  assert.ok(slugs.includes('launch-campaign'));
  assert.ok(slugs.includes('re-engage-sequence'));
});

test('GET /api/task-templates/:id returns one template', async () => {
  const headers = await authHeaders();
  const listRes = await app.request('/api/task-templates', { headers });
  const { templates } = (await listRes.json()) as { templates: Array<{ id: string; slug: string }> };
  const launch = templates.find((t) => t.slug === 'launch-campaign');
  assert.ok(launch, 'launch-campaign should exist');

  const getRes = await app.request(`/api/task-templates/${launch.id}`, { headers });
  assert.equal(getRes.status, 200);
  const body = (await getRes.json()) as { template: { slug: string; tasks: unknown[] } };
  assert.equal(body.template.slug, 'launch-campaign');
  assert.equal(body.template.tasks.length, 7);
});

test('GET /api/task-templates/:id with unknown id returns 404', async () => {
  const headers = await authHeaders();
  const res = await app.request('/api/task-templates/template_does_not_exist', { headers });
  assert.equal(res.status, 404);
});
