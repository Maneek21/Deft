import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVerifiedResponse } from '../src/lib/agent-response-verification.js';
const original = 'Acme training is 8 October at 13:30 IST. Lina owns it.';
test('review commentary cannot replace the requested answer', () => {
  assert.equal(selectVerifiedResponse(original, 'The reply is accurate and based on verified workspace knowledge. I confirm this reply is valid.'), original);
  assert.equal(selectVerifiedResponse(original, 'VERIFIED\nThe response accurately answers the question.'), original);
});
test('an explicit complete correction is accepted', () => {
  assert.equal(selectVerifiedResponse(original, JSON.stringify({ verdict: 'corrected', response: 'Acme training is 8 October at 13:30 IST. Recording preference and access remain open.' })), 'Acme training is 8 October at 13:30 IST. Recording preference and access remain open.');
});
test('verified, malformed and incomplete reviews preserve the original', () => {
  for (const review of ['{"verdict":"verified"}', '{"verdict":"corrected","response":" "}', '{"verdict":"corrected","response":42}', 'null', '[]', '{"response":"Reviewer comment"}', '']) {
    assert.equal(selectVerifiedResponse(original, review), original);
  }
});
