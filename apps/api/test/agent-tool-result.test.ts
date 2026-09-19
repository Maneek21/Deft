import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { agentToolFailure, agentToolResultContent } from '../src/lib/agent-tool-result.js';
import { isReadOnlyAgentRequest } from '../src/lib/agent-request-policy.js';

test('read-only navigation does not request writes even when it mentions open and completed tasks', () => {
  for (const prompt of [
    'Use module_record_task_links to find open and completed tasks. Read only.',
    'Read-only: open the company record and show its tasks.',
    'Read the deal. Do not create or update any records or actions.',
  ]) assert.equal(isReadOnlyAgentRequest(prompt), true, prompt);
  assert.equal(isReadOnlyAgentRequest('Create a task for the open deal.'), false);
  assert.equal(isReadOnlyAgentRequest('Link this decision to MKT-18.'), false);
});

test('tool results give the model the same canonical sources rendered to the user', () => {
  const sources = [{ type: 'module_record', id: 'record', title: 'Example', url: '/modules/example/items/record' }];
  assert.deepEqual(JSON.parse(agentToolResultContent({ records: [] }, sources)), { result: { records: [] }, sources });
});

test('invalid tool arguments are recoverable without leaking supplied values', () => {
  const parsed = z.object({ module_id: z.string().regex(/^[a-z]+\.[a-z]+$/) }).safeParse({ module_id: 'private-invalid-value' });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const failure = agentToolFailure(parsed.error);
  assert.equal(failure.code, 'VALIDATION_ERROR');
  assert.deepEqual(failure.fields, [{ path: 'module_id', code: 'invalid_format' }]);
  assert.equal(JSON.stringify(failure).includes('private-invalid-value'), false);
});

test('unexpected tool failures are not reported as an empty successful search or leaked exception', () => {
  const failure = agentToolFailure(new Error('secret connection string'));
  assert.equal(failure.code, 'TOOL_FAILED');
  assert.match(failure.error, /do not interpret/);
  assert.equal(JSON.stringify(failure).includes('secret'), false);
});
