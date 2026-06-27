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

test('local classifier suppresses negated blocker language', () => {
  const samples = [
    'No blockers today; the packaging pass is moving.',
    'The vendor blocker is resolved now.',
    'I am not blocked on TOM-42 anymore.',
    'Nothing is stuck for the launch checklist.',
  ];

  for (const sample of samples) {
    const result = classifyMessageLocally(sample);
    assert.equal(result.blocked, false, sample);
  }
});

test('local classifier keeps explicit task intent when blocker language is negated', () => {
  const result = classifyMessageLocally(
    'No blockers today. Please create a task to update the buyer label copy.',
  );

  assert.equal(result.blocked, false);
  assert.equal(result.intent, 'task_create');
});

test('local classifier preserves separate active blockers in mixed resolved messages', () => {
  const result = classifyMessageLocally(
    'The label copy issue is resolved, but I am blocked on final packaging approval.',
  );

  assert.equal(result.blocked, true);
  assert.equal(result.intent, 'actionable');
});
