import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeFactsAgainstDecision } from '../src/workers/handlers/memory-extract.js';

describe('dedupeFactsAgainstDecision', () => {
  test('drops a memorable_fact whose content matches the decision', () => {
    const decision = 'Move deployments to Cloudflare Workers for edge execution';
    const facts = [
      'Team decided to move deployments to Cloudflare Workers for edge execution',
      'Priya will draft the migration plan by Friday',
    ];
    const result = dedupeFactsAgainstDecision(facts, decision);
    assert.deepStrictEqual(result, ['Priya will draft the migration plan by Friday']);
  });

  test('keeps facts unrelated to the decision', () => {
    const decision = 'Standardize on Redis Streams for the event bus';
    const facts = ['Sprint retros move to Fridays', 'Office coffee machine is a Breville'];
    const result = dedupeFactsAgainstDecision(facts, decision);
    assert.deepStrictEqual(result, facts);
  });

  test('returns facts unchanged when decision is null', () => {
    const facts = ['a', 'b'];
    assert.deepStrictEqual(dedupeFactsAgainstDecision(facts, null), facts);
  });

  test('is case- and punctuation-insensitive', () => {
    const decision = 'Use DynamoDB for the session store';
    const facts = ['team chose DynamoDB for session store!'];
    const result = dedupeFactsAgainstDecision(facts, decision);
    assert.deepStrictEqual(result, []);
  });
});
