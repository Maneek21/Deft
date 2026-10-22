import assert from 'node:assert/strict';
import test from 'node:test';
import { _deps, classifyMessage, classifyMessageLocally, isSelfContainedDecision } from '../src/lib/classifier.js';

test('named actors and auxiliaries do not resolve a decision object', () => {
  for (const content of [
    'We agreed Arjun should take it',
    'Decision: Arjun will handle it',
    'We agreed Priya must send that to Arjun',
    'We agreed Arjun has to handle this by Friday',
    'We agreed Arjun owns it',
    'We agreed Priya handles it',
    'We agreed Arjun takes that on',
    'Decision: Priya assigned it to Arjun',
    'We agreed Priya sent that to Arjun',
    'We agreed Arjun is taking it',
  ]) {
    assert.equal(classifyMessageLocally(content).decision, null, content);
    assert.equal(isSelfContainedDecision(content), false, content);
  }
  assert.equal(classifyMessageLocally('We agreed Arjun should take the schema review').decision,
    'Arjun should take the schema review');
  assert.equal(isSelfContainedDecision('Arjun should take this schema review'), true);
  assert.equal(isSelfContainedDecision('Arjun owns this schema review'), true);
  assert.equal(isSelfContainedDecision('Priya handles the schema review'), true);
  assert.equal(isSelfContainedDecision('Arjun is taking this schema review'), true);
});

test('model decisions cannot resolve pronoun objects from a named actor', async () => {
  const originals = { ..._deps };
  try {
    _deps.hasAnyAIProvider = async () => true;
    _deps.getOrgAIConfig = async () => undefined;
    _deps.llm = (async () => ({ text: JSON.stringify({ decision: 'Arjun should take the schema review' }) })) as typeof _deps.llm;
    assert.equal((await classifyMessage('We agreed Arjun should take it', 'org')).decision, null);
    _deps.llm = (async () => ({ text: JSON.stringify({ decision: 'Arjun should take it' }) })) as typeof _deps.llm;
    assert.equal((await classifyMessage('We agreed Arjun should take the schema review', 'org')).decision, null);
  } finally {
    Object.assign(_deps, originals);
  }
});

test('meal vocabulary preserves durable workflow conventions', () => {
  assert.deepEqual(classifyMessageLocally('Always keep customer lunch preferences in the booking notes').memorable_facts,
    ['Always keep customer lunch preferences in the booking notes']);
  assert.deepEqual(classifyMessageLocally('Policy: Lunch breaks last thirty minutes. Lunch is at noon today.').memorable_facts,
    ['Lunch breaks last thirty minutes']);
});

test('model facts suppress temporary logistics individually', async () => {
  const originals = { ..._deps };
  try {
    _deps.hasAnyAIProvider = async () => true;
    _deps.getOrgAIConfig = async () => undefined;
    _deps.llm = (async () => ({ text: JSON.stringify({ memorable_facts: [
      'Lunch is at noon today',
      'We agreed lunch is at noon tomorrow',
      'We decided dinner is at 8pm tonight',
      'Always keep customer lunch preferences in the booking notes',
      'Team uses Postgres for the workspace database',
    ] }) })) as typeof _deps.llm;
    const result = await classifyMessage('Lunch is at noon today. We agreed lunch is at noon tomorrow. We decided dinner is at 8pm tonight. Always keep customer lunch preferences in the booking notes. Team uses Postgres for the workspace database.', 'org');
    assert.deepEqual(result.memorable_facts, [
      'Always keep customer lunch preferences in the booking notes',
      'Team uses Postgres for the workspace database',
    ]);
  } finally {
    Object.assign(_deps, originals);
  }
});
