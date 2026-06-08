import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageLocally } from '../src/lib/classifier.js';

test('local classifier extracts explicit Decision: memory without an AI provider', () => {
  const result = classifyMessageLocally('Decision: For wholesale buyers, quote shelf life as 5 days.');

  assert.equal(result.intent, 'discussion');
  assert.equal(result.decision, 'For wholesale buyers, quote shelf life as 5 days');
  assert.deepEqual(result.memorable_facts, []);
  assert.ok(result.confidence >= 0.78);
});

test('local classifier extracts explicit preference/fact memory without an AI provider', () => {
  const result = classifyMessageLocally('Preference: Use concise buyer updates. Policy: Never promise same-day delivery after 2pm.');

  assert.equal(result.intent, 'discussion');
  assert.deepEqual(new Set(result.memorable_facts), new Set([
    'Use concise buyer updates',
    'Never promise same-day delivery after 2pm',
  ]));
  assert.equal(result.decision, null);
});

test('local classifier strips chat HTML before extracting decisions', () => {
  const result = classifyMessageLocally('<p>We decided to use cold room target 52 F for packed tomatoes.</p>');

  assert.equal(result.decision, 'use cold room target 52 F for packed tomatoes');
});

test('local classifier does not manufacture memory from ordinary chatter', () => {
  const result = classifyMessageLocally('I think the tomatoes look nice today.');

  assert.equal(result.decision, null);
  assert.deepEqual(result.memorable_facts, []);
});
