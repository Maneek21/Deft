/**
 * Integration test — POST /api/projects/:id/apply-template reads the template
 * from the task_templates table (not skill config), creates tasks, returns
 * the created list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/index.js';

async function authHeaders() {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'diego@testers-tomatoes.com', password: 'tomato123' }),
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json()) as { accessToken: string };
  return {
    authorization: `Bearer ${body.accessToken}`,
    'content-type': 'application/json',
  };
}

test('POST /api/projects/:id/apply-template instantiates launch-campaign tasks', async () => {
  const headers = await authHeaders();
  const ts = Date.now();

  const createRes = await app.request('/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'test-apply-template-' + ts, prefix: 'AF' + ts.toString().slice(-4) }),
  });
  assert.equal(createRes.status, 201);
  const project = (await createRes.json()) as { id: string };

  const applyRes = await app.request(`/api/projects/${project.id}/apply-template`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ template_id: 'template_bundled_launch-campaign' }),
  });
  assert.equal(applyRes.status, 201);
  const body = (await applyRes.json()) as { count: number; tasks: Array<{ title: string }> };
  assert.equal(body.count, 7);
  assert.ok(body.tasks.some((t) => t.title === 'Draft launch brief'));
});

test('POST /api/projects/:id/apply-template with missing template returns 404', async () => {
  const headers = await authHeaders();
  const ts = Date.now();
  const createRes = await app.request('/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'test-apply-template-2-' + ts, prefix: 'AG' + ts.toString().slice(-4) }),
  });
  const project2 = (await createRes.json()) as { id: string };

  const res = await app.request(`/api/projects/${project2.id}/apply-template`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ template_id: 'template_does_not_exist' }),
  });
  assert.equal(res.status, 404);
});
