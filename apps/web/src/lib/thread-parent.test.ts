import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptFetchedThreadParent, applyThreadParentEvent, eventTargetsThreadParent } from './thread-parent';

const SPACE = 'space-1';
const parent = {
  id: 'parent-1', space_id: SPACE, content: 'original parent', edited_at: null as string | null,
  is_deleted: false, created_at: '2026-11-13T10:00:00.000Z', reactions: [] as { emoji: string; count: number; users: string[] }[],
};

test('a live edit of the open thread parent replaces its text', () => {
  const event = { type: 'edited' as const, id: 'parent-1', content: 'edited parent', edited_at: '2026-11-13T10:05:00.000Z', space_id: SPACE };
  const next = applyThreadParentEvent(parent, event, SPACE);
  assert.equal(next.content, 'edited parent');
  assert.equal(next.edited_at, '2026-11-13T10:05:00.000Z');
});

test('events for other messages or other spaces leave the parent unchanged', () => {
  const otherId = { type: 'edited' as const, id: 'reply-1', content: 'x', edited_at: '2026-11-13T10:05:00.000Z', space_id: SPACE };
  const otherSpace = { type: 'edited' as const, id: 'parent-1', content: 'x', edited_at: '2026-11-13T10:05:00.000Z', space_id: 'space-2' };
  assert.equal(applyThreadParentEvent(parent, otherId, SPACE), parent);
  assert.equal(applyThreadParentEvent(parent, otherSpace, SPACE), parent);
  assert.equal(eventTargetsThreadParent({ type: 'new', message: parent }, 'parent-1', SPACE), false);
  assert.equal(eventTargetsThreadParent({ type: 'pinned', message_id: 'parent-1' }, 'parent-1', SPACE), false);
});

test('an edit without a space id applies by message id', () => {
  const event = { type: 'edited' as const, id: 'parent-1', content: 'processed', edited_at: null };
  assert.equal(applyThreadParentEvent(parent, event, SPACE).content, 'processed');
});

test('a live delete marks the parent deleted; an older edit does not overwrite a newer one', () => {
  assert.equal(applyThreadParentEvent(parent, { type: 'deleted', id: 'parent-1', space_id: SPACE }, SPACE).is_deleted, true);
  const edited = { ...parent, content: 'newer', edited_at: '2026-11-13T10:10:00.000Z' };
  const stale = { type: 'edited' as const, id: 'parent-1', content: 'older', edited_at: '2026-11-13T10:05:00.000Z' };
  assert.equal(applyThreadParentEvent(edited, stale, SPACE), edited);
});

test('reactions on the parent apply live', () => {
  const next = applyThreadParentEvent(parent, { type: 'reaction_added', message_id: 'parent-1', emoji: '👍', user_id: 'u1' }, SPACE);
  assert.deepEqual(next.reactions, [{ emoji: '👍', count: 1, users: ['u1'] }]);
});

test('a fetched parent is adopted and live events from during the read are replayed on it', () => {
  const fetched = { ...parent, content: 'fetched', edited_at: '2026-11-13T10:01:00.000Z' };
  const during = [{ type: 'edited' as const, id: 'parent-1', content: 'edited during read', edited_at: '2026-11-13T10:02:00.000Z' }];
  assert.equal(adoptFetchedThreadParent(parent, fetched, [], SPACE).content, 'fetched');
  assert.equal(adoptFetchedThreadParent(parent, fetched, during, SPACE).content, 'edited during read');
  assert.equal(adoptFetchedThreadParent(parent, { ...fetched, id: 'other' }, [], SPACE), parent);
  assert.equal(adoptFetchedThreadParent(parent, undefined, [], SPACE), parent);
});
