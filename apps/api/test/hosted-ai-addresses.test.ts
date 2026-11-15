import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiProviderAddress,
  AiAddressRefusedError,
  environmentAiAddress,
  HOSTED_AI_ADDRESS_REFUSED,
} from '../src/lib/ai-provider-address.js';
import { createAgentMessage } from '../src/lib/agent-llm.js';
import { getModelConfig, llm } from '../src/lib/llm.js';
import { resolveReasonProviderFromConfig, selectReasonProvider } from '../src/lib/org-ai-config.js';
import { privateDeftyEndpoint } from '../src/lib/app-private-defty-model.js';
import { answerImageAttachmentQuestion } from '../src/lib/attachment-vision.js';
import { effectiveTranscriptionProvider, transcribe } from '../src/lib/transcription.js';
import { env } from '../src/lib/env.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withEnv(t: test.TestContext, values: Record<string, string | undefined>) {
  const old: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    old[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

const hosted = (t: test.TestContext) => withEnv(t, { DEFT_HOSTED: 'true' });
const selfHosted = (t: test.TestContext) => withEnv(t, { DEFT_HOSTED: undefined });

function recordFetch(t: test.TestContext, reply: () => Response) {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return reply();
  });
  return urls;
}

const chatReply = () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const agentParams = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxTokens: 64 };

test('address rule: self-hosted passes any address through unchanged', (t) => {
  selfHosted(t);
  assert.deepEqual(aiProviderAddress('ollama', 'http://10.0.0.5:11434'), { allowed: true, baseUrl: 'http://10.0.0.5:11434' });
  assert.deepEqual(aiProviderAddress('openai', 'http://gateway.lan/v1'), { allowed: true, baseUrl: 'http://gateway.lan/v1' });
  assert.deepEqual(aiProviderAddress('anthropic'), { allowed: true, baseUrl: undefined });
  assert.equal(environmentAiAddress('http://ollama:11434'), 'http://ollama:11434');
});

test('address rule: hosted allows only named providers at their standard addresses', (t) => {
  hosted(t);
  assert.equal(aiProviderAddress('ollama').allowed, false);
  assert.equal(aiProviderAddress('ollama', 'http://10.0.0.5:11434').allowed, false);
  assert.equal(aiProviderAddress('openai', 'http://169.254.169.254/latest').allowed, false);
  assert.equal(aiProviderAddress('openrouter', 'https://api.openai.com/v1').allowed, false);
  assert.deepEqual(aiProviderAddress('openai', 'https://API.openai.com/v1/'), { allowed: true, baseUrl: 'https://api.openai.com/v1' });
  assert.deepEqual(aiProviderAddress('openai'), { allowed: true, baseUrl: 'https://api.openai.com/v1' });
  assert.deepEqual(aiProviderAddress('anthropic', ''), { allowed: true, baseUrl: 'https://api.anthropic.com' });
  assert.deepEqual(aiProviderAddress('openrouter'), { allowed: true, baseUrl: 'https://openrouter.ai/api/v1' });
  assert.equal(environmentAiAddress('http://ollama:11434'), '');
  // Only exactly "true" turns hosted mode on.
  process.env.DEFT_HOSTED = 'TRUE';
  assert.equal(aiProviderAddress('ollama').allowed, true);
});

test('reason resolution: hosted never uses a stored custom or Ollama address', (t) => {
  hosted(t);
  for (const route of [
    { provider: 'openai' as const, model: 'gpt-4o', baseUrl: 'http://internal.example/v1' },
    { provider: 'ollama' as const, model: 'llama3.1' },
  ]) {
    const cfg = { api_keys: { openai: 'org-key' }, ai_models: { reason: route }, ollama_url: 'http://10.0.0.5:11434' };
    const resolved = resolveReasonProviderFromConfig(cfg);
    assert.equal(resolved.apiKey, '', 'refused route resolves as no provider');
    assert.equal(resolved.provider, 'anthropic');
    assert.equal(resolved.baseUrl, undefined);
    const readiness = selectReasonProvider({ route, orgApiKeys: cfg.api_keys, orgOllamaUrl: cfg.ollama_url });
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason ?? '', /hosted Deft/);
  }
  // Ollama as an unrouted fallback (org URL or environment) is skipped.
  assert.equal(selectReasonProvider({ orgOllamaUrl: 'http://10.0.0.5:11434', envOllamaUrl: 'http://ollama:11434' }).ready, false);
});

test('reason resolution: hosted standard providers still work', (t) => {
  hosted(t);
  const openai = resolveReasonProviderFromConfig({ api_keys: { openai: 'org-key' }, ai_models: { reason: { provider: 'openai', model: 'gpt-4o' } } });
  assert.deepEqual([openai.provider, openai.apiKey, openai.baseUrl], ['openai', 'org-key', 'https://api.openai.com/v1']);
  const anthropic = resolveReasonProviderFromConfig({ api_keys: { anthropic: 'a-key' }, ai_models: { reason: { provider: 'anthropic', model: 'claude-x' } } });
  assert.deepEqual([anthropic.provider, anthropic.apiKey, anthropic.baseUrl], ['anthropic', 'a-key', 'https://api.anthropic.com']);
  const router = resolveReasonProviderFromConfig({ api_keys: { openrouter: 'r-key' } });
  assert.deepEqual([router.provider, router.baseUrl], ['openrouter', 'https://openrouter.ai/api/v1']);
  assert.equal(privateDeftyEndpoint(anthropic), 'https://api.anthropic.com');
});

test('reason resolution: self-hosted keeps custom and Ollama addresses', (t) => {
  selfHosted(t);
  const custom = resolveReasonProviderFromConfig({ api_keys: { openai: 'k' }, ai_models: { reason: { provider: 'openai', model: 'm', baseUrl: 'http://gateway.lan/v1' } } });
  assert.equal(custom.baseUrl, 'http://gateway.lan/v1');
  const ollama = resolveReasonProviderFromConfig({ ai_models: { reason: { provider: 'ollama', model: 'llama3.1' } }, ollama_url: 'http://10.0.0.5:11434' });
  assert.deepEqual([ollama.provider, ollama.baseUrl], ['ollama', 'http://10.0.0.5:11434']);
  assert.equal(selectReasonProvider({ orgOllamaUrl: 'http://10.0.0.5:11434' }).ready, true);
  assert.equal(privateDeftyEndpoint(ollama), 'http://10.0.0.5:11434');
});

test('llm(): hosted refuses a stored custom route and skips Ollama, without fetching', async (t) => {
  hosted(t);
  const urls = recordFetch(t, chatReply);
  const messages = [{ role: 'user' as const, content: 'hi' }];
  await assert.rejects(
    llm({ task: 'extract', messages, orgConfig: { api_keys: { openai: 'k' }, ai_models: { extract: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'http://10.0.0.5/v1' } } } }),
    (error: unknown) => error instanceof AiAddressRefusedError && error.code === HOSTED_AI_ADDRESS_REFUSED,
  );
  await assert.rejects(llm({ task: 'extract', messages, orgConfig: { ai_models: { extract: { provider: 'ollama', model: 'llama3.1' } }, ollama_url: 'http://10.0.0.5:11434' } }), AiAddressRefusedError);
  assert.notEqual(getModelConfig('extract', { ollama_url: 'http://10.0.0.5:11434' }).provider, 'ollama');
  assert.deepEqual(urls, []);
});

test('llm(): hosted standard provider goes to its standard address', async (t) => {
  hosted(t);
  const urls = recordFetch(t, chatReply);
  const result = await llm({ task: 'extract', messages: [{ role: 'user', content: 'hi' }], orgConfig: { api_keys: { openai: 'k' }, ai_models: { extract: { provider: 'openai', model: 'gpt-4o-mini' } } } });
  assert.equal(result.text, 'ok');
  assert.deepEqual(urls, ['https://api.openai.com/v1/chat/completions']);
});

test('llm(): self-hosted still sends to the custom address and to Ollama', async (t) => {
  selfHosted(t);
  const urls = recordFetch(t, chatReply);
  await llm({ task: 'extract', messages: [{ role: 'user', content: 'hi' }], orgConfig: { api_keys: { openai: 'k' }, ai_models: { extract: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'http://gateway.lan/v1' } } } });
  assert.equal(getModelConfig('extract', { ollama_url: 'http://10.0.0.5:11434' }).provider, 'ollama');
  assert.deepEqual(urls, ['http://gateway.lan/v1/chat/completions']);
});

test('agent loop: hosted refuses Ollama and custom addresses and pins Anthropic past ANTHROPIC_BASE_URL', async (t) => {
  hosted(t);
  withEnv(t, { ANTHROPIC_BASE_URL: 'http://10.0.0.9:8080' });
  const urls = recordFetch(t, () => Response.json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-x',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  await assert.rejects(createAgentMessage({ ...agentParams, resolved: { provider: 'ollama', model: 'llama3.1', apiKey: '' } }), AiAddressRefusedError);
  await assert.rejects(createAgentMessage({ ...agentParams, resolved: { provider: 'openai', model: 'gpt-4o', apiKey: 'k', baseUrl: 'http://10.0.0.5/v1' } }), AiAddressRefusedError);
  assert.deepEqual(urls, []);
  await createAgentMessage({ ...agentParams, resolved: { provider: 'anthropic', model: 'claude-x', apiKey: 'k' } });
  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.startsWith('https://api.anthropic.com/'), urls[0]);
});

test('agent loop: self-hosted keeps a custom address', async (t) => {
  selfHosted(t);
  const urls = recordFetch(t, chatReply);
  await createAgentMessage({ ...agentParams, resolved: { provider: 'openai', model: 'gpt-4o', apiKey: 'k', baseUrl: 'http://gateway.lan/v1' } });
  assert.deepEqual(urls, ['http://gateway.lan/v1/chat/completions']);
});

test('vision: hosted refuses a custom address passed in; self-hosted uses it', async (t) => {
  const png = new Uint8Array([1, 2, 3]);
  const provider = { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'k', baseUrl: 'http://10.0.0.5/v1', ready: true };
  const reply = () => Response.json({ choices: [{ message: { content: 'a cat' } }] });
  const seen: string[] = [];
  const fetchImpl = (async (input: unknown) => { seen.push(String(input)); return reply(); }) as typeof fetch;
  process.env.DEFT_HOSTED = 'true';
  t.after(() => { delete process.env.DEFT_HOSTED; });
  await assert.rejects(answerImageAttachmentQuestion({ orgId: 'o', bytes: png, mimeType: 'image/png', provider, fetchImpl }), AiAddressRefusedError);
  assert.deepEqual(seen, []);
  delete process.env.DEFT_HOSTED;
  const answer = await answerImageAttachmentQuestion({ orgId: 'o', bytes: png, mimeType: 'image/png', provider, fetchImpl });
  assert.equal(answer.answer, 'a cat');
  assert.deepEqual(seen, ['http://10.0.0.5/v1/chat/completions']);
});

test('unknown stored provider: hosted refuses it as no provider, without throwing', (t) => {
  hosted(t);
  const route = { provider: 'azure', model: 'gpt', baseUrl: 'http://10.0.0.5/v1' } as any;
  assert.equal(aiProviderAddress('azure' as any, 'http://10.0.0.5/v1').allowed, false);
  assert.equal(aiProviderAddress('azure' as any).allowed, false);
  assert.equal(selectReasonProvider({ route }).ready, false);
  const resolved = resolveReasonProviderFromConfig({ ai_models: { reason: route } });
  assert.deepEqual([resolved.provider, resolved.apiKey, resolved.baseUrl], ['anthropic', '', undefined]);
});

test('private Defty endpoint: hosted refuses a custom address; self-hosted keeps it', (t) => {
  const resolved = { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'k', baseUrl: 'http://10.0.0.5/v1' };
  process.env.DEFT_HOSTED = 'true';
  t.after(() => { delete process.env.DEFT_HOSTED; });
  assert.throws(() => privateDeftyEndpoint(resolved), /Private model endpoint unavailable/);
  assert.throws(() => privateDeftyEndpoint({ ...resolved, provider: 'ollama', baseUrl: undefined }), /Private model endpoint unavailable/);
  assert.equal(privateDeftyEndpoint({ ...resolved, baseUrl: undefined }), 'https://api.openai.com/v1');
  delete process.env.DEFT_HOSTED;
  assert.equal(privateDeftyEndpoint(resolved), 'http://10.0.0.5/v1');
});

function withEnvModule(t: test.TestContext, values: Record<string, string>) {
  const target = env as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    const old = target[key];
    target[key] = value;
    t.after(() => { target[key] = old; });
  }
}

async function audioFile(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'deft-transcribe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'clip.webm');
  await writeFile(file, new Uint8Array([1, 2, 3]));
  return file;
}

const whisperReply = () => Response.json({ text: 'hello', segments: [], duration: 1 });

test('transcription: hosted never uses local Whisper, stored or default', (t) => {
  hosted(t);
  withEnvModule(t, { TRANSCRIPTION_PROVIDER: 'local' });
  assert.equal(effectiveTranscriptionProvider(undefined), 'none');
  assert.equal(effectiveTranscriptionProvider('local'), 'none');
  assert.equal(effectiveTranscriptionProvider('openai'), 'openai');
  assert.equal(effectiveTranscriptionProvider('deepgram'), 'deepgram');
  withEnvModule(t, { TRANSCRIPTION_PROVIDER: 'openai' });
  assert.equal(effectiveTranscriptionProvider('local'), 'openai', 'a stored local choice is passed over');
});

test('transcription: hosted posts nothing to WHISPER_URL and ignores TRANSCRIPTION_OPENAI_BASE_URL', async (t) => {
  hosted(t);
  const file = await audioFile(t);
  const urls = recordFetch(t, whisperReply);
  withEnvModule(t, { TRANSCRIPTION_PROVIDER: 'local', WHISPER_URL: 'http://localhost:9000' });
  await assert.rejects(transcribe(file, null), /No transcription provider/);
  assert.deepEqual(urls, []);
  withEnvModule(t, { TRANSCRIPTION_PROVIDER: 'openai', TRANSCRIPTION_OPENAI_API_KEY: 'k', TRANSCRIPTION_OPENAI_BASE_URL: 'http://10.0.0.5/v1' });
  await transcribe(file, null);
  assert.deepEqual(urls, ['https://api.openai.com/v1/audio/transcriptions']);
});

test('transcription: self-hosted keeps local Whisper and the custom OpenAI-compatible address', async (t) => {
  selfHosted(t);
  const file = await audioFile(t);
  const urls = recordFetch(t, whisperReply);
  withEnvModule(t, { TRANSCRIPTION_PROVIDER: 'local', WHISPER_URL: 'http://localhost:9000' });
  assert.equal(effectiveTranscriptionProvider('local'), 'local');
  await transcribe(file, null);
  withEnvModule(t, { TRANSCRIPTION_PROVIDER: 'openai', TRANSCRIPTION_OPENAI_API_KEY: 'k', TRANSCRIPTION_OPENAI_BASE_URL: 'http://10.0.0.5/v1' });
  await transcribe(file, null);
  assert.deepEqual(urls, ['http://localhost:9000/v1/audio/transcriptions', 'http://10.0.0.5/v1/audio/transcriptions']);
});
