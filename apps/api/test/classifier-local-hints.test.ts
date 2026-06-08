import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageLocally } from '../src/lib/classifier.js';

test('local classifier flags obvious blocked messages without an LLM', () => {
  const result = classifyMessageLocally('I am stuck waiting on the packaging vendor and cannot proceed with TOM-42.');

  assert.equal(result.blocked, true);
  assert.equal(result.intent, 'actionable');
  assert.ok(result.confidence >= 0.8);
  assert.deepEqual(result.task_refs, ['TOM-42']);
});

test('local classifier leaves ordinary discussion unblocked', () => {
  const result = classifyMessageLocally('The tomato harvest update looks good for Thursday.');

  assert.equal(result.blocked, false);
  assert.equal(result.intent, 'none');
  assert.equal(result.confidence, 0);
});
