import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { ExperienceExposureError } from '../src/lib/app-experience-exposure-contract.js';
import { appHttpFailure } from '../src/routes/app-http-errors.js';
import { ExperienceExposureBusyError } from '../src/lib/app-experience-exposure-db-error.js';

for (const reason of ['acquisition', 'deadline'] as const) {
  test(`App action exposes ${reason} saturation as a retryable 503`, async () => {
    const app = new Hono();
    app.post('/prepare', c => appHttpFailure(c,
      new ExperienceExposureBusyError(reason, { cause: new Error('private SQL diagnostic') }), 'App action', 'app-actions'));
    const response = await app.request('/prepare', { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), { error: 'App access is busy. Please try again.', code: 'APP_EXPERIENCE_BUSY', retryable: true });
  });
}

for (const [code, status] of [
  ['APP_EXPERIENCE_RESOURCE_UNAVAILABLE', 404],
  ['APP_EXPERIENCE_EXPOSURE_STALE', 409],
  ['RESOURCE_PAYLOAD_TOO_LARGE', 413],
  ['APP_EXPERIENCE_EXPOSURE_DISABLED', 503],
] as const) {
  test(`App action preserves declared exposure denial ${code}`, async () => {
    const app = new Hono();
    app.post('/prepare', c => appHttpFailure(c, new ExperienceExposureError(code, status), 'App action', 'app-actions'));
    const response = await app.request('/prepare', { method: 'POST' });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  });
}

test('ordinary exceptions cannot masquerade as an exposure denial', async () => {
  const app = new Hono();
  const error = Object.assign(new Error('private diagnostic'), { code: 'APP_EXPERIENCE_RESOURCE_UNAVAILABLE', status: 404 });
  app.post('/prepare', c => appHttpFailure(c, error, 'App action', 'app-actions'));
  const original = console.error;
  console.error = () => {};
  try {
    const response = await app.request('/prepare', { method: 'POST' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'App action request failed', code: 'INTERNAL_ERROR' });
  } finally { console.error = original; }
});
