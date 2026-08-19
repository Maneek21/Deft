import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { moduleRoutes } from '../src/routes/modules.js';
import { MODULE_MANIFEST_REQUEST_MAX_BYTES } from '../src/lib/module-manifest-upload.js';

const manifest = {
  schema_version: '1',
  id: 'com.example.route-test',
  slug: 'route-test',
  version: '1.0.0',
  name: 'Route test',
  collections: [{
    key: 'entries',
    name: 'Entries',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  }],
};

function appFor(role: 'owner' | 'admin' | 'member') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: `route-${role}`,
      org_id: 'route-org',
      email: `${role}@example.test`,
      name: role,
      role,
    });
    await next();
  });
  app.route('/api/modules', moduleRoutes);
  return app;
}

test('sideload rejects non-admin roles before reading the manifest', async () => {
  const response = await appFor('member').request('/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { code: string }).code, 'MODULE_ACCESS_DENIED');
});

test('sideload route returns stable 400, 413, and 415 policy errors without touching storage', async () => {
  const malformed = await appFor('owner').request('/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { code: string }).code, 'MODULE_MANIFEST_INVALID');

  const oversize = await appFor('admin').request('/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(MODULE_MANIFEST_REQUEST_MAX_BYTES + 1),
  });
  assert.equal(oversize.status, 413);
  assert.equal((await oversize.json() as { code: string }).code, 'MODULE_MANIFEST_TOO_LARGE');

  const remote = await appFor('owner').request('/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'text/uri-list' },
    body: 'https://example.test/deft.module.json',
  });
  assert.equal(remote.status, 415);
  assert.equal((await remote.json() as { code: string }).code, 'MODULE_MEDIA_TYPE_UNSUPPORTED');
});

test('upgrade requires the active manifest digest before storage access', async () => {
  const response = await appFor('owner').request('/api/modules/route-test/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...manifest, version: '1.1.0' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, 'MODULE_MANIFEST_INVALID');
});

test('record query validates bounded search and rejects caller-supplied module identity before storage access', async () => {
  const overlong = await appFor('member').request('/api/modules/route-test/records/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collection_key: 'entries', search: 'x'.repeat(501) }),
  });
  assert.equal(overlong.status, 400);
  assert.equal((await overlong.json() as { code: string }).code, 'VALIDATION_ERROR');

  const injectedIdentity = await appFor('member').request('/api/modules/route-test/records/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      module_id: 'attacker.controlled',
      collection_key: 'entries',
      filters: [],
    }),
  });
  assert.equal(injectedIdentity.status, 400);
  assert.equal((await injectedIdentity.json() as { code: string }).code, 'VALIDATION_ERROR');
});
