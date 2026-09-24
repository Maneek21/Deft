import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../src/lib/env.js';
import { transcribe } from '../src/lib/transcription.js';

const TRANSCRIPTION_ENV = [
  'TRANSCRIPTION_PROVIDER',
  'TRANSCRIPTION_OPENAI_BASE_URL',
  'TRANSCRIPTION_OPENAI_MODEL',
  'TRANSCRIPTION_OPENAI_API_KEY',
  'OPENAI_API_KEY',
] as const;

async function withClip(t: import('node:test').TestContext, overrides: Partial<Record<(typeof TRANSCRIPTION_ENV)[number], string>>) {
  const saved = Object.fromEntries(TRANSCRIPTION_ENV.map((key) => [key, env[key]]));
  t.after(() => Object.assign(env, saved));
  Object.assign(env, {
    TRANSCRIPTION_PROVIDER: 'openai',
    TRANSCRIPTION_OPENAI_BASE_URL: '',
    TRANSCRIPTION_OPENAI_MODEL: '',
    TRANSCRIPTION_OPENAI_API_KEY: '',
    OPENAI_API_KEY: '',
    ...overrides,
  });
  const dir = await mkdtemp(join(tmpdir(), 'deft-transcription-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = join(dir, 'clip.webm');
  await writeFile(clip, Buffer.from('fake audio'));
  return clip;
}

function captureFetch(t: import('node:test').TestContext) {
  const calls: { url: string; headers: Headers; form: FormData }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), form: init.body as FormData });
    return Response.json({
      text: ' hello ',
      language: 'english',
      duration: 1.5,
      segments: [{ start: 0.2, end: 1.4, text: ' hello ' }],
    });
  });
  return calls;
}

test('openai transcription keeps api.openai.com, whisper-1 and OPENAI_API_KEY by default', async (t) => {
  const clip = await withClip(t, { OPENAI_API_KEY: 'sk-openai' });
  const calls = captureFetch(t);

  const result = await transcribe(clip);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk-openai');
  assert.equal(calls[0].form.get('model'), 'whisper-1');
  assert.equal(calls[0].form.get('response_format'), 'verbose_json');
  assert.deepEqual(result, {
    text: ' hello ',
    segments: [{ start: 0.2, end: 1.4, text: 'hello' }],
    language: 'english',
    model: 'whisper-1',
    duration_s: 1.5,
  });
});

test('openai transcription targets a configured OpenAI-compatible endpoint, model and key', async (t) => {
  const clip = await withClip(t, {
    OPENAI_API_KEY: 'sk-openai',
    TRANSCRIPTION_OPENAI_BASE_URL: 'https://llm.example.test/v1/',
    TRANSCRIPTION_OPENAI_MODEL: 'whisper-large-v3-turbo',
    TRANSCRIPTION_OPENAI_API_KEY: 'sk-proxy',
  });
  const calls = captureFetch(t);

  const result = await transcribe(clip);

  assert.equal(calls[0].url, 'https://llm.example.test/v1/audio/transcriptions');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk-proxy');
  assert.equal(calls[0].form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(result.model, 'whisper-large-v3-turbo');
});

test('a keyless self-hosted endpoint is called without an Authorization header', async (t) => {
  const clip = await withClip(t, { TRANSCRIPTION_OPENAI_BASE_URL: 'http://whisper.internal:8000/v1' });
  const calls = captureFetch(t);

  await transcribe(clip);

  assert.equal(calls[0].url, 'http://whisper.internal:8000/v1/audio/transcriptions');
  assert.equal(calls[0].headers.has('authorization'), false);
});

test('api.openai.com without any key still fails before sending audio', async (t) => {
  const clip = await withClip(t, {});
  const calls = captureFetch(t);

  await assert.rejects(transcribe(clip), /OPENAI_API_KEY not set for transcription/);
  assert.equal(calls.length, 0);
});
