import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_CONFIG_LOAD_ERROR, loadAiConfig } from './ai-config-load';

test('E14 a rejected first load resolves to an error instead of hanging', async () => {
  const result = await loadAiConfig(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.startsWith(AI_CONFIG_LOAD_ERROR));
});

test('E14 an unreadable body resolves to an error', async () => {
  const result = await loadAiConfig(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  }));
  assert.equal(result.ok, false);
});

test('E14 non-2xx and success paths', async () => {
  const denied = await loadAiConfig(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.deepEqual(denied, { ok: false, error: AI_CONFIG_LOAD_ERROR });
  const loaded = await loadAiConfig<{ has_provider: boolean }>(async (path) => {
    assert.equal(path, '/api/org/ai-config');
    return { ok: true, status: 200, json: async () => ({ has_provider: true }) };
  });
  assert.deepEqual(loaded, { ok: true, cfg: { has_provider: true } });
});
