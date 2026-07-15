import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizePlainAgentMentions } from '../src/lib/agent-mention-normalization.js';

test('resolves exact typed agent names and slugs into structured mentions', () => {
  const agents = [{ userId: 'rita-user', name: 'Rita', slug: 'research-agent' }];

  assert.deepEqual(normalizePlainAgentMentions('@Rita review this', agents), {
    content: '<@rita-user|Rita> review this',
    resolvedUserIds: ['rita-user'],
    ambiguousAliases: [],
  });
  assert.equal(
    normalizePlainAgentMentions('<p>Ask @research-agent today.</p>', agents).content,
    '<p>Ask <@rita-user|Rita> today.</p>',
  );
});

test('does not resolve email fragments or fuzzy names', () => {
  const agents = [{ userId: 'rita-user', name: 'Rita', slug: 'rita' }];
  const content = 'Email owner@rita.com or ask @Rit later.';
  assert.equal(normalizePlainAgentMentions(content, agents).content, content);
});

test('flags ambiguous aliases instead of choosing an employee', () => {
  const result = normalizePlainAgentMentions('@Rita take this', [
    { userId: 'rita-one', name: 'Rita Singh', slug: 'rita-ops' },
    { userId: 'rita-two', name: 'Rita Shah', slug: 'rita-sales' },
  ]);

  assert.equal(result.content, '@Rita take this');
  assert.deepEqual(result.resolvedUserIds, []);
  assert.deepEqual(result.ambiguousAliases, ['rita']);
});
