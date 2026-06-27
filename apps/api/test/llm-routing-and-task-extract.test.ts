import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelConfig } from '../src/lib/llm.ts';
import { buildDeterministicTaskTitle } from '../src/workers/handlers/task-extract.ts';

test('llm defaults extract to OpenAI when only an org OpenAI key is configured', () => {
  const config = getModelConfig('extract', {
    api_keys: { openai: 'sk-test' },
  });

  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'gpt-4o-mini');
});

test('llm defaults extract to Ollama when only an org Ollama URL is configured', () => {
  const config = getModelConfig('extract', {
    ollama_url: 'http://localhost:11434',
  });

  assert.equal(config.provider, 'ollama');
  assert.equal(config.model, 'llama3.1');
  assert.equal(config.baseUrl, 'http://localhost:11434');
});

test('llm keeps explicit org task routes authoritative', () => {
  const config = getModelConfig('extract', {
    api_keys: { openai: 'sk-test' },
    ai_models: {
      extract: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    },
  });

  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-haiku-4-5-20251001');
});

test('deterministic task fallback builds a concise title from chat wording', () => {
  assert.equal(
    buildDeterministicTaskTitle('Please create a task: ask Priya to prep tasting table signage before Friday.'),
    'ask Priya to prep tasting table signage before Friday',
  );

  assert.equal(
    buildDeterministicTaskTitle('Track this as a ticket: move crates from the north dock.'),
    'move crates from the north dock',
  );
});
