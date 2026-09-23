import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMessage } from '../src/lib/agent-llm.js';

const params = {
  resolved: { provider: 'openai' as const, model: 'gpt-5.6-sol', apiKey: 'test-key', reasoningEffort: 'medium' },
  system: 'Read the requested record.', messages: [{ role: 'user' as const, content: 'Read record 1' }],
  tools: [{ name: 'module_record_get', input_schema: { type: 'object' as const, properties: { record_id: { type: 'string' }, data: { type: 'object', additionalProperties: true } }, required: ['record_id'] } }],
  maxTokens: 4096,
};

test('Responses adapter preserves optional and open-ended tool contracts with explicit non-strict mode', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.tools[0].strict, false);
    assert.deepEqual(body.tools[0].parameters, params.tools[0].input_schema);
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    return Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'module_record_get', call_id: 'call_1', arguments: '{"record_id":"1"}' }] });
  });
  const result = await createAgentMessage(params);
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content, [{ type: 'tool_use', id: 'call_1', name: 'module_record_get', input: { record_id: '1' } }]);
});

test('Responses adapter rejects incomplete output instead of reporting an empty successful turn', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 0, output_tokens: 0 } }));
  await assert.rejects(createAgentMessage(params), /incomplete/);
});

test('Responses adapter does not execute partial tool arguments from an incomplete response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'incomplete', output: [{ type: 'function_call', name: 'module_record_get', call_id: 'partial', arguments: '{"record_id":' }] }));
  await assert.rejects(createAgentMessage(params), /incomplete/);
});

test('Responses adapter rejects a completed response without usable text or tool calls', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'completed', output: [] }));
  await assert.rejects(createAgentMessage(params), /empty/);
});
