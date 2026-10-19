import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchingMentionGroups, mentionQueryAtCursor, mentionSelectionContent } from './mention-suggestions';

const group = { id: 'synthetic-reviewers', name: 'Launch reviewers', handle: 'live261019-reviewers', member_count: 2 };

test('configured two-member group is selectable by prefix and exact hyphenated handle', () => {
  for (const query of ['live261019', 'live261019-reviewers']) {
    const active = mentionQueryAtCursor(`Please ask @${query}`);
    assert.equal(active?.query, query);
    assert.equal(active?.length, query.length + 1);
    assert.deepEqual(matchingMentionGroups([group], active!.query), [group]);
  }
});

test('group selection emits server handle text and preserves individual mention nodes', () => {
  assert.deepEqual(mentionSelectionContent({ ...group, type: 'group' }), [{ type: 'text', text: '@live261019-reviewers ' }]);
  assert.deepEqual(mentionSelectionContent({ type: 'person', id: 'noah', name: 'Noah' }), [
    { type: 'mention', attrs: { uuid: 'noah', name: 'Noah' } }, { type: 'text', text: ' ' },
  ]);
});

test('long handles and duplicate at-signs retain the exact replacement range', () => {
  const handle = 'synthetic-reviewers-with-a-long-handle';
  assert.deepEqual(mentionQueryAtCursor(`Hello @@${handle}`), { query: handle, length: handle.length + 2 });
  assert.equal(mentionQueryAtCursor('Hello @reviewers '), null);
  assert.deepEqual(matchingMentionGroups([group, { ...group, id: 'invalid', handle: '<invalid>' }], 'reviewers'), [group]);
});

test('group triggers match server boundaries and preserve a fresh paragraph', () => {
  assert.equal(mentionQueryAtCursor('person@live261019-reviewers'), null);
  assert.equal(mentionQueryAtCursor('word@live261019-reviewers'), null);
  for (const prefix of ['', 'Hello ', 'Hello\n', '(']) {
    assert.deepEqual(mentionQueryAtCursor(`${prefix}@live261019-reviewers`), { query: group.handle, length: group.handle.length + 1 });
  }
});
