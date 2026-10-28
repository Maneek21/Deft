import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DEFTY_OPENAI_MODEL } from '@deft/shared';
import { env } from '../src/lib/env.js';
import { getModelConfig, llm } from '../src/lib/llm.js';

test('whitespace org credentials do not shadow a valid extraction provider', () => {
  assert.equal(getModelConfig('extract', { api_keys: { anthropic: ' \t ', openai: 'test' } }).provider, 'openai');
});

test('whitespace environment credentials and URLs do not shadow a valid extraction provider', (t) => {
  const saved = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OLLAMA_URL: env.OLLAMA_URL };
  t.after(() => Object.assign(env, saved));
  Object.assign(env, { ANTHROPIC_API_KEY: ' \t ', OPENAI_API_KEY: 'test', OPENROUTER_API_KEY: ' ', OLLAMA_URL: ' ' });
  assert.equal(getModelConfig('extract').provider, 'openai');
});

test('shared LLM resolution trims org keys and falls back past a whitespace org key', async (t) => {
  const originalKey = env.OPENAI_API_KEY;
  t.after(() => { env.OPENAI_API_KEY = originalKey; });
  env.OPENAI_API_KEY = ' env-test ';
  const authorizations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    authorizations.push(new Headers(init.headers).get('authorization')!);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready' }] }],
      usage: { input_tokens: 1, output_tokens: 1 } });
  });
  for (const key of [' org-test ', ' \t ']) {
    await llm({ task: 'extract', orgConfig: { api_keys: { openai: key }, ai_models: {
      extract: { provider: 'openai', model: 'gpt-6.1-sol' },
    } }, messages: [{ role: 'user', content: 'Extract this.' }] });
  }
  assert.deepEqual(authorizations, ['Bearer org-test', 'Bearer env-test']);
});

test('whitespace Anthropic credentials fall through to the org OpenAI key and default model', async (t) => {
  const saved = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY };
  t.after(() => Object.assign(env, saved));
  Object.assign(env, { ANTHROPIC_API_KEY: ' \t ', OPENAI_API_KEY: 'openai-env' });
  const requests: { url: string; authorization: string | null; model: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url: String(url), authorization: new Headers(init.headers).get('authorization'), model: body.model });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready' }] }],
      usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const result = await llm({ task: 'extract', orgConfig: { api_keys: { anthropic: ' ', openai: 'openai-org' } },
    messages: [{ role: 'user', content: 'Extract this.' }] });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/responses$/);
  assert.equal(requests[0]!.authorization, 'Bearer openai-org');
  assert.equal(requests[0]!.model, DEFAULT_DEFTY_OPENAI_MODEL);
  assert.equal(result.model, DEFAULT_DEFTY_OPENAI_MODEL);
  assert.equal(result.text, 'Ready');
});
