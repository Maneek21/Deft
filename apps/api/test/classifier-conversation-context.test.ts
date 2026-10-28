import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as classifier from '../src/lib/classifier.js';
import { extractExplicitDecision } from '../src/workers/handlers/observe-chat-message.js';
const deps = (classifier as any)._deps;
const original = deps && { ...deps };
afterEach(() => { if (deps && original) Object.assign(deps, original); });
function model(result: Record<string, unknown>, capture?: (input: any) => void) {
  assert.ok(deps, 'classifier exposes injectable dependencies');
  deps.hasAnyAIProvider = async () => true;
  deps.getOrgAIConfig = async () => ({});
  deps.llm = async (input: any) => { capture?.(input); return { text: JSON.stringify(result) }; };
}
test('classifier prompt includes up to 6 preceding messages from the same thread/channel', async () => {
  let prompt: any;
  model({ intent: 'discussion' }, (input) => { prompt = input; });
  const context = Array.from({ length: 8 }, (_, i) => ({ author: `Person ${i}`, content: i === 7 ? `<p>${'x'.repeat(320)}TRUNCATED</p>` : `earlier ${i}` }));
  await (classifier.classifyMessage as any)('Schema review will be done Wednesday EOD', 'org-context', context);
  const content = prompt.messages[0].content;
  assert.match(content, /<workspace_context>/);
  assert.match(content, /Preceding conversation context/);
  assert.match(content, /Message to classify:\nSchema review will be done Wednesday EOD/);
  assert.doesNotMatch(content, /earlier [01]|TRUNCATED|<p>/);
  for (let i = 2; i < 7; i++) assert.ok(content.includes(`Person ${i}: earlier ${i}`));
  assert.ok(content.includes(`Person 7: ${'x'.repeat(300)}`));
  assert.ok(content.indexOf('Person 2:') < content.indexOf('Person 6:'));
  assert.doesNotMatch(prompt.system, /earlier|Schema review will be done Wednesday EOD|Person 2/);
  assert.match(prompt.system, /untrusted data/i);
  assert.match(prompt.system, /classify only the message/i);
});
test('Schema review will be done Wednesday EOD is not blocked locally', () => {
  assert.equal(classifier.classifyMessageLocally('Schema review will be done Wednesday EOD').blocked, false);
});
test('Schema review will be done Wednesday EOD is not blocked on the model path', async () => {
  model({ intent: 'actionable', confidence: 0.95, blocked: true });
  const result = await classifier.classifyMessage('Schema review will be done Wednesday EOD', 'org-context');
  assert.equal(result.blocked, false);
  assert.equal(result.intent, 'discussion');
});
test('dated commitments preserve explicit active blockers', async () => {
  const content = 'Schema review will be done Wednesday EOD, but I am blocked on deployment approval.';
  model({ intent: 'actionable', blocked: true });
  assert.equal(classifier.classifyMessageLocally(content).blocked, true);
  assert.equal((await classifier.classifyMessage(content, 'org-context')).blocked, true);
});
test('a referent-less instruction (give it to Arjun) is not stored as a decision', async () => {
  for (const content of ['give it to Arjun', 'actually give it to Arjun instead', 'Decision: give it to Arjun', 'Agreed, give it to Arjun', 'Decision: Actually, give it to Arjun', 'Decision: That is final', 'Decision: it', 'Agreed, that']) {
    model({ decision: 'Assign schema review to Arjun instead of Rahul' });
    assert.equal(classifier.classifyMessageLocally(content).decision, null, content);
    assert.equal((await classifier.classifyMessage(content, 'org-context')).decision, null, content);
    assert.equal(extractExplicitDecision(content), null, content);
  }
});
test('ephemeral logistics are not memorable facts', async () => {
  for (const content of ['Lunch is at 1pm', 'CI builds take ~12 min', 'On it']) {
    model({ memorable_facts: [content] });
    assert.deepEqual((await classifier.classifyMessage(content, 'org-context')).memorable_facts, [], content);
  }
});

test('named demonstrative subjects remain self-contained decisions', async () => {
  for (const [content, decision] of [
    ['Decision: This project uses PostgreSQL', 'This project uses PostgreSQL'],
    ['We agreed this release ships on Friday', 'this release ships on Friday'],
  ]) {
    model({ decision });
    assert.equal(classifier.classifyMessageLocally(content).decision, decision);
    assert.equal((await classifier.classifyMessage(content, 'org-context')).decision, decision);
    assert.equal(extractExplicitDecision(content), decision);
  }
});
