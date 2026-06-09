import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReasonProvider } from '../src/lib/org-ai-config.js';

test('reason selector preserves Anthropic env fallback when available', () => {
  const selected = selectReasonProvider({
    envApiKeys: { anthropic: 'anthropic-key' },
  });

  assert.equal(selected.ready, true);
  assert.equal(selected.provider, 'anthropic');
  assert.equal(selected.source, 'env_fallback');
});

test('reason selector falls back to OpenAI when it is the only available provider', () => {
  const selected = selectReasonProvider({
    envApiKeys: { openai: 'openai-key' },
  });

  assert.equal(selected.ready, true);
  assert.equal(selected.provider, 'openai');
  assert.equal(selected.source, 'env_fallback');
});

test('reason selector falls back to OpenRouter when it is the only available provider', () => {
  const selected = selectReasonProvider({
    envApiKeys: { openrouter: 'openrouter-key' },
  });

  assert.equal(selected.ready, true);
  assert.equal(selected.provider, 'openrouter');
  assert.equal(selected.source, 'env_fallback');
});

test('reason selector honors explicit route and reports missing key instead of switching vendors', () => {
  const selected = selectReasonProvider({
    route: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    envApiKeys: { openai: 'openai-key' },
  });

  assert.equal(selected.ready, false);
  assert.equal(selected.provider, 'openrouter');
  assert.equal(selected.source, 'org_route');
  assert.match(selected.reason ?? '', /no API key/i);
});

test('reason selector prefers org keys before env fallbacks', () => {
  const selected = selectReasonProvider({
    orgApiKeys: { openrouter: 'org-openrouter-key' },
    envApiKeys: { anthropic: 'env-anthropic-key', openai: 'env-openai-key' },
  });

  assert.equal(selected.ready, true);
  assert.equal(selected.provider, 'openrouter');
  assert.equal(selected.source, 'org_key_fallback');
});

test('reason selector supports explicit Ollama route without API keys', () => {
  const selected = selectReasonProvider({
    route: { provider: 'ollama', model: 'llama3.1' },
    envOllamaUrl: 'http://localhost:11434',
  });

  assert.equal(selected.ready, true);
  assert.equal(selected.provider, 'ollama');
  assert.equal(selected.source, 'org_route');
});

test('reason selector does not claim readiness when no provider is configured', () => {
  const selected = selectReasonProvider({});

  assert.equal(selected.ready, false);
  assert.equal(selected.source, 'none');
});
