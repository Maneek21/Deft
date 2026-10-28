import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDeftySystemPrompt, scopeDeftyMessageSearch } from '../src/lib/agent-runner.js';

test('implicit current-room searches use the verified conversation ID instead of a duplicate name', () => {
  const result = scopeDeftyMessageSearch({ query: 'rollback', space_id: 'invented', space_name: 'elsewhere' },
    'What did we decide here?', { type: 'public', name: 'engineering' }, 'verified-room');
  assert.deepEqual(result, { query: 'rollback', space_id: 'verified-room' });
});

test('naming the current room still pins to its verified ID when a duplicate name exists', () => {
  const result = scopeDeftyMessageSearch({ query: 'rollback', space_name: 'engineering' },
    'Summarize #engineering for me', { type: 'public', name: 'engineering' }, 'verified-room');
  assert.deepEqual(result, { query: 'rollback', space_id: 'verified-room' });
});

test('explicitly requested other rooms retain readable name resolution', () => {
  const result = scopeDeftyMessageSearch({ query: 'rollback', space_name: 'launch' },
    'What did they decide in #launch?', { type: 'public', name: 'engineering' }, 'verified-room');
  assert.deepEqual(result, { query: 'rollback', space_name: 'launch' });
});

test('followed turns explicitly allow NO_REPLY when the human is addressing someone else', () => {
  const prompt = buildDeftySystemPrompt({ orgName: 'Deft', spaceType: 'public', followed: true });
  assert.match(prompt, /not explicitly addressed to Defty/i);
  assert.match(prompt, /directed at someone else/i);
  assert.match(prompt, /exactly `?NO_REPLY`?/);
  assert.doesNotMatch(buildDeftySystemPrompt({ orgName: 'Deft', spaceType: 'public' }), /NO_REPLY/);
});
