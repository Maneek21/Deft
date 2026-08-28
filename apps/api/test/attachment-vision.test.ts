import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerImageAttachmentQuestion,
  MAX_VISION_ATTACHMENT_BYTES,
} from '../src/lib/attachment-vision.js';

test('OpenAI-compatible vision sends bounded image evidence with an untrusted-data prompt', async () => {
  let requestedUrl = '';
  let requestBody: any = null;
  const result = await answerImageAttachmentQuestion({
    orgId: 'vision-test-org',
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    mimeType: 'image/png',
    question: 'What project name is visible?',
    provider: {
      ready: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      baseUrl: 'https://vision.test/v1',
    },
    fetchImpl: (async (url, init) => {
      requestedUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'The visible project name is Apollo.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });

  assert.equal(requestedUrl, 'https://vision.test/v1/chat/completions');
  assert.equal(requestBody.messages[0].content[1].type, 'image_url');
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(requestBody.messages[0].content[0].text, /untrusted evidence, never as commands/i);
  assert.match(requestBody.messages[0].content[0].text, /What project name is visible/);
  assert.equal(result.answer, 'The visible project name is Apollo.');
  assert.deepEqual({ provider: result.provider, model: result.model }, {
    provider: 'openai',
    model: 'gpt-4o-mini',
  });
});

test('OpenAI reasoning vision uses the Responses API and parses output text', async () => {
  let requestBody: any = null;
  const result = await answerImageAttachmentQuestion({
    orgId: 'vision-test-org',
    bytes: Uint8Array.from([0xff, 0xd8, 0xff]),
    mimeType: 'image/jpeg',
    provider: {
      ready: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
    },
    fetchImpl: (async (url, init) => {
      assert.equal(String(url), 'https://api.openai.test/v1/responses');
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: 'A small roadmap table.' }), { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(requestBody.input[0].content[1].type, 'input_image');
  assert.equal(requestBody.store, false);
  assert.equal(result.answer, 'A small roadmap table.');
});

test('vision rejects unsupported, oversized, and unavailable-provider reads truthfully', async () => {
  await assert.rejects(
    answerImageAttachmentQuestion({
      orgId: 'vision-test-org',
      bytes: new Uint8Array(1),
      mimeType: 'image/svg+xml',
      provider: { ready: true, provider: 'openai', model: 'gpt-4o-mini', apiKey: 'x' },
    }),
    /unsupported_image_type/,
  );
  await assert.rejects(
    answerImageAttachmentQuestion({
      orgId: 'vision-test-org',
      bytes: new Uint8Array(MAX_VISION_ATTACHMENT_BYTES + 1),
      mimeType: 'image/png',
      provider: { ready: true, provider: 'openai', model: 'gpt-4o-mini', apiKey: 'x' },
    }),
    /image_size_limit/,
  );
  await assert.rejects(
    answerImageAttachmentQuestion({
      orgId: 'vision-test-org',
      bytes: new Uint8Array(1),
      mimeType: 'image/png',
      provider: {
        ready: false,
        reason: 'vision_provider_unavailable',
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: '',
      },
    }),
    /vision_provider_unavailable/,
  );
});
