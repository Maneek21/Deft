import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageLocally } from '../src/lib/classifier.js';

test('local classifier flags obvious blocked messages without an LLM', () => {
  const result = classifyMessageLocally('I am stuck waiting on the packaging vendor and cannot proceed with TOM-42.');

  assert.equal(result.blocked, true);
  assert.equal(result.intent, 'actionable');
  assert.ok(result.confidence >= 0.8);
  assert.deepEqual(result.task_refs, ['TOM-42']);
  assert.equal(result.is_request, false, 'provider-free heuristics never invent named recipients');
  assert.deepEqual(result.requested_people, []);
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

test('local classifier does not turn tentative planning chatter into durable memory', () => {
  const result = classifyMessageLocally(
    'Maybe we should discuss whether the chef sample crates need new labels next week.',
  );

  assert.equal(result.decision, null);
  assert.deepEqual(result.memorable_facts, []);
});

test('local classifier extracts explicit decisions and preferences separately', () => {
  const result = classifyMessageLocally(
    'Decision: use blue crates for chef samples. Preference: keep buyer updates under three bullets.',
  );

  assert.equal(result.decision, 'use blue crates for chef samples');
  assert.deepEqual(result.memorable_facts, ['keep buyer updates under three bullets']);
});
