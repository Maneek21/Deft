import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { normalizeAgentToolHistory } from '../src/lib/agent-tool-history.js';
const call = (id: string): Anthropic.ToolUseBlock => ({ type: 'tool_use', id, name: 'create_task', input: {} });
test('mixed reviewed actions have adjacent results before the next user turn', () => {
  const messages: Anthropic.MessageParam[] = [
    { role: 'assistant', content: [call('rejected'), call('approved')] },
    { role: 'assistant', content: 'Queued two actions for review.' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'approved', content: '{"task_id":"CRM-3"}' }] },
    { role: 'user', content: 'Correct the rejected draft and link the task.' },
  ];
  const before = structuredClone(messages);
  const result = normalizeAgentToolHistory(messages);
  assert.equal(result[1]?.role, 'user');
  const blocks = result[1]?.content as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(blocks.map(b => b.tool_use_id), ['rejected', 'approved']);
  assert.equal(blocks[0]?.is_error, true);
  assert.match(String(blocks[0]?.content), /not.*recorded/i);
  assert.equal(blocks[1]?.content, '{"task_id":"CRM-3"}');
  assert.equal(result.at(-1)?.content, 'Correct the rejected draft and link the task.');
  assert.deepEqual(messages, before);
  assert.deepEqual(normalizeAgentToolHistory(result), result);
});
test('preserves ordinary conversation and valid tool errors without duplicate results', () => {
  const valid: Anthropic.MessageParam[] = [{role:'user',content:'hello'}, {role:'assistant',content:[call('read')]}, {role:'user',content:[{type:'tool_result',tool_use_id:'read',content:'denied',is_error:true},{type:'text',text:'Please explain.'}]}];
  const output=normalizeAgentToolHistory(valid);
  assert.equal(output[0]?.content,'hello');
  assert.deepEqual(output[2]?.content,[{type:'tool_result',tool_use_id:'read',content:'denied',is_error:true}]);
  assert.deepEqual(output[3]?.content,[{type:'text',text:'Please explain.'}]);
});
