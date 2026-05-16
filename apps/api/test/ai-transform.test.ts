/**
 * AI transform endpoint integration test.
 *
 * Stubs the llm() helper via the route module's `_deps` injection seam to
 * assert that the endpoint:
 *   - rejects unknown action types with code: 'UNKNOWN_ACTION'
 *   - passes the correct prompt to the LLM for each action
 *   - returns the LLM output verbatim under { output: string }
 *   - requires the `text` field
 *   - returns 503 when no AI provider is configured
 *
 * No DB access — the route is mounted on a throwaway Hono app with a stub
 * auth middleware that sets a user. All AI calls are intercepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

const AI_TRANSFORM_ACTIONS = [
  'summarize',
  'translate',
  'tone-formal',
  'tone-casual',
  'expand',
] as const;

async function buildApp() {
  const mod = await import('../src/routes/ai-transform.js');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', org_id: 'o1' });
    await next();
  });
  app.route('/api/ai', mod.aiTransformRoutes);
  return { app, mod };
}

test('ai-transform rejects unknown actions', async () => {
  const { app, mod } = await buildApp();

  // Stub provider gate so we don't bail out before validation runs.
  const origHas = mod._deps.hasAnyAIProvider;
  mod._deps.hasAnyAIProvider = async () => true;

  try {
    const res = await app.request('/api/ai/transform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not-a-real-action', text: 'hi' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'UNKNOWN_ACTION');
  } finally {
    mod._deps.hasAnyAIProvider = origHas;
  }
});

test('ai-transform accepts known actions and returns output', async () => {
  const { app, mod } = await buildApp();

  const origLlm = mod._deps.llm;
  const origCfg = mod._deps.getOrgAIConfig;
  const origHas = mod._deps.hasAnyAIProvider;

  let capturedPrompt = '';
  mod._deps.llm = (async (opts: any) => {
    // Record the user-message content so we can assert the prompt includes
    // the input text verbatim.
    capturedPrompt = opts.messages?.[0]?.content ?? '';
    return {
      text: 'mocked output',
      usage: { input: 10, output: 20 },
      model: 'stub-model',
    };
  }) as typeof mod._deps.llm;
  mod._deps.getOrgAIConfig = (async () => ({
    api_keys: { anthropic: 'stub' },
  })) as typeof mod._deps.getOrgAIConfig;
  mod._deps.hasAnyAIProvider = async () => true;

  try {
    for (const action of AI_TRANSFORM_ACTIONS) {
      const res = await app.request('/api/ai/transform', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, text: 'Hello world' }),
      });
      assert.equal(res.status, 200, `action ${action} should succeed`);
      const body = (await res.json()) as { output: string };
      assert.equal(body.output, 'mocked output');
      assert.ok(
        capturedPrompt.includes('Hello world'),
        `prompt for ${action} should include input text`,
      );
    }
  } finally {
    mod._deps.llm = origLlm;
    mod._deps.getOrgAIConfig = origCfg;
    mod._deps.hasAnyAIProvider = origHas;
  }
});

test('ai-transform requires text field', async () => {
  const { app, mod } = await buildApp();

  const origHas = mod._deps.hasAnyAIProvider;
  mod._deps.hasAnyAIProvider = async () => true;

  try {
    const res = await app.request('/api/ai/transform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'summarize' }),
    });
    assert.equal(res.status, 400);
  } finally {
    mod._deps.hasAnyAIProvider = origHas;
  }
});

test('ai-transform returns 503 when no AI provider configured', async () => {
  const { app, mod } = await buildApp();

  const origHas = mod._deps.hasAnyAIProvider;
  mod._deps.hasAnyAIProvider = async () => false;

  try {
    const res = await app.request('/api/ai/transform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'summarize', text: 'hi' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'NO_AI');
  } finally {
    mod._deps.hasAnyAIProvider = origHas;
  }
});
