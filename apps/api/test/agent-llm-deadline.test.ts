import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMessage } from '../src/lib/agent-llm.js';

const base = {
  system: 'Answer.', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [], maxTokens: 256,
};
const providers = [
  { label: 'OpenAI-compatible chat completions', resolved: { provider: 'openrouter' as const, model: 'any/model', apiKey: 'k' },
    reply: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
  { label: 'OpenAI Responses', resolved: { provider: 'openai' as const, model: 'gpt-5.6-sol', apiKey: 'k' },
    reply: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } },
  { label: 'Ollama', resolved: { provider: 'ollama' as const, model: 'llama', apiKey: null },
    reply: { message: { content: 'ok' }, done_reason: 'stop' } },
];

for (const provider of providers) {
  test(`A10: ${provider.label} keeps its provider deadline when the caller passes a signal`, async (t) => {
    // Make the provider deadline fire immediately; the caller's own signal never aborts.
    t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new Error('provider deadline')));
    let seen: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return Response.json(provider.reply);
    });
    const caller = new AbortController();
    await createAgentMessage({ ...base, resolved: provider.resolved as any, abortSignal: caller.signal }).catch(() => undefined);
    assert.ok(seen, 'fetch received a signal');
    assert.equal(seen!.aborted, true, 'the provider deadline must still apply');
  });

  test(`A10: ${provider.label} still honours the caller's abort`, async (t) => {
    t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
    let seen: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return Response.json(provider.reply);
    });
    const caller = new AbortController();
    await createAgentMessage({ ...base, resolved: provider.resolved as any, abortSignal: caller.signal }).catch(() => undefined);
    assert.equal(seen!.aborted, false);
    caller.abort(new Error('client disconnected'));
    assert.equal(seen!.aborted, true, 'a caller disconnect must still abort the request');
  });
}
