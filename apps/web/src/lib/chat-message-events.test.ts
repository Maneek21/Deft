import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMessageEvent, replayMessageEvents, type EventMessage, type MessageEvent } from './chat-message-events';
import { ConversationReads, mergeMessagesById } from './chat-history-merge';

const row = (id: string, minute: number, extra: Partial<EventMessage> = {}): EventMessage => ({
  id,
  created_at: `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
  content: id,
  reactions: [],
  ...extra,
});

test('R4: every event is idempotent on replay', () => {
  const events: MessageEvent[] = [
    { type: 'new', message: row('n', 5) },
    { type: 'edited', id: 'a', content: 'edited', edited_at: '2026-11-10T11:00:00.000Z' },
    { type: 'deleted', id: 'b' },
    { type: 'reaction_added', message_id: 'a', emoji: '👍', user_id: 'bob' },
    { type: 'reaction_removed', message_id: 'a', emoji: '🎉', user_id: 'alice' },
    { type: 'pinned', message_id: 'a' },
    { type: 'thread_updated', parent_id: 'a', reply_count: 2, latest_reply_at: '2026-11-10T11:30:00.000Z' },
  ];
  const start = [row('a', 1, { reactions: [{ emoji: '🎉', count: 1, users: ['alice'] }] }), row('b', 2)];
  const once = replayMessageEvents(start, events);
  const twice = replayMessageEvents(once, events);
  assert.deepEqual(twice, once);
  assert.deepEqual(once.map((m) => m.id), ['a', 'b', 'n']);
  assert.equal(once[0]!.content, 'edited');
  assert.deepEqual(once[0]!.reactions, [{ emoji: '👍', count: 1, users: ['bob'] }]);
  assert.equal(once[0]!.is_pinned, true);
  assert.equal(once[0]!.reply_count, 2);
  assert.equal(once[1]!.is_deleted, true);
});

test('R4: reactions reconcile by emoji and user', () => {
  const base = [row('a', 1, { reactions: [{ emoji: '🎉', count: 1, users: ['alice'] }] })];
  const added = applyMessageEvent(base, { type: 'reaction_added', message_id: 'a', emoji: '🎉', user_id: 'bob' });
  assert.deepEqual(added[0]!.reactions, [{ emoji: '🎉', count: 2, users: ['alice', 'bob'] }]);
  assert.equal(applyMessageEvent(added, { type: 'reaction_added', message_id: 'a', emoji: '🎉', user_id: 'bob' }), added, 'present: no change');
  const removedAbsent = applyMessageEvent(added, { type: 'reaction_removed', message_id: 'a', emoji: '🎉', user_id: 'carol' });
  assert.equal(removedAbsent, added, 'absent: no change');
  const removed = applyMessageEvent(added, { type: 'reaction_removed', message_id: 'a', emoji: '🎉', user_id: 'alice' });
  assert.deepEqual(removed[0]!.reactions, [{ emoji: '🎉', count: 1, users: ['bob'] }]);
  assert.deepEqual(base[0]!.reactions, [{ emoji: '🎉', count: 1, users: ['alice'] }], 'input is not mutated');
});

test('R4: an edit older than the shown row is ignored; a count older than the shown one too', () => {
  const base = [row('a', 1, { content: 'newer', edited_at: '2026-11-10T12:00:00.000Z', reply_count: 5, latest_reply_at: '2026-11-10T12:00:00.000Z' })];
  assert.equal(applyMessageEvent(base, { type: 'edited', id: 'a', content: 'older', edited_at: '2026-11-10T11:00:00.000Z' }), base);
  assert.equal(applyMessageEvent(base, { type: 'thread_updated', parent_id: 'a', reply_count: 4, latest_reply_at: '2026-11-10T11:00:00.000Z' }), base);
});

test('R4 finding 2: Alice reacted during the outage (fetched), Bob reacts live during the read: both stay', () => {
  const reads = new ConversationReads<MessageEvent>();
  const ticket = reads.begin();
  const bob: MessageEvent = { type: 'reaction_added', message_id: 'a', emoji: '🎉', user_id: 'bob' };
  reads.record(bob);
  let shown = applyMessageEvent([row('a', 1)], bob); // live path
  const fetched = [row('a', 1, { reactions: [{ emoji: '🎉', count: 1, users: ['alice'] }] })];
  shown = replayMessageEvents(mergeMessagesById(shown, fetched), reads.settle(ticket));
  assert.deepEqual(shown[0]!.reactions, [{ emoji: '🎉', count: 2, users: ['alice', 'bob'] }]);
});

test('R4 finding 2: a live removal during the read removes from the fetched membership', () => {
  const reads = new ConversationReads<MessageEvent>();
  const ticket = reads.begin();
  reads.record({ type: 'reaction_removed', message_id: 'a', emoji: '🎉', user_id: 'alice' });
  const fetched = [row('a', 1, { reactions: [{ emoji: '🎉', count: 2, users: ['alice', 'bob'] }] })];
  const [merged] = replayMessageEvents(mergeMessagesById([row('a', 1)], fetched), reads.settle(ticket));
  assert.deepEqual(merged!.reactions, [{ emoji: '🎉', count: 1, users: ['bob'] }]);
});

test('R4 finding 3: a live change to a row first introduced by the read is applied when it is inserted', () => {
  const reads = new ConversationReads<MessageEvent>();
  const ticket = reads.begin({ supersede: false }); // Load earlier
  const del: MessageEvent = { type: 'deleted', id: 'm' };
  const react: MessageEvent = { type: 'reaction_added', message_id: 'm', emoji: '👍', user_id: 'bob' };
  reads.record(del);
  reads.record(react);
  let shown = replayMessageEvents([row('z', 30)], [del, react]); // live: m not shown, no effect
  shown = replayMessageEvents(mergeMessagesById(shown, [row('m', 1)]), reads.settle(ticket));
  assert.deepEqual(shown.map((m) => m.id), ['m', 'z']);
  assert.equal(shown[0]!.is_deleted, true);
  assert.deepEqual(shown[0]!.reactions, [{ emoji: '👍', count: 1, users: ['bob'] }]);
});
