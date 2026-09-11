import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { appRoutes } from '../src/routes/apps.js';

test('empty uninstall request returns the standard validation error', async () => {
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('user', {
      id: 'uninstall-route-owner',
      org_id: 'uninstall-route-org',
      email: 'uninstall-route@example.test',
      name: 'Uninstall route owner',
      role: 'owner',
    });
    await next();
  });
  app.route('/api/apps', appRoutes);

  const response = await app.request('/api/apps/fixture-installation/uninstall', { method: 'POST' });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'Invalid App request');
  assert.equal(body.code, 'VALIDATION_ERROR');
});
