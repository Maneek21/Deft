import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationReads, mergeMessagesById } from './chat-history-merge';

const msg = (id: string, minute: number, content = id) => ({
  id,
  content,
  created_at: `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

test('E15: a reply that finished during the disconnect is added after the messages already shown', () => {
  const shown = [msg('a', 1), msg('b', 2)];
  const fetched = [msg('a', 1), msg('b', 2), msg('defty-reply', 3)];
  assert.deepEqual(mergeMessagesById(shown, fetched).map((m) => m.id), ['a', 'b', 'defty-reply']);
});

test('E15: merging does not duplicate or reorder what is shown, and keeps local-only messages', () => {
  // `local` arrived over the socket and is not in the fetched page.
  const shown = [msg('a', 1), msg('b', 2), msg('local', 5)];
  const fetched = [msg('b', 2), msg('a', 1), msg('missed', 3), msg('missed', 3)];
  const merged = mergeMessagesById(shown, fetched);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'missed', 'local']);
  assert.equal(new Set(merged.map((m) => m.id)).size, merged.length);
});

test('E15: the server version of a shown message replaces stale fields', () => {
  const merged = mergeMessagesById([msg('a', 1, 'old')], [msg('a', 1, 'edited while offline')]);
  assert.equal(merged[0]!.content, 'edited while offline');
});

test('E15: an empty fetch leaves the list unchanged', () => {
  const shown = [msg('a', 1)];
  assert.equal(mergeMessagesById(shown, []), shown);
});

test('R2-1: a read never undoes a live change made after it started, and never resurrects a deletion', () => {
  const reads = new ConversationReads();
  const ticket = reads.begin();
  reads.noteChange('a'); // live edit after the read started
  const shown = [{ ...msg('a', 1, 'edited live'), is_deleted: false }, { ...msg('b', 2), is_deleted: true }];
  const stale = [{ ...msg('a', 1, 'old'), is_deleted: false }, { ...msg('b', 2), is_deleted: false }];
  const merged = mergeMessagesById(shown, stale, (id) => reads.changedSince(ticket, id));
  assert.equal(merged[0]!.content, 'edited live');
  assert.equal(merged[1]!.is_deleted, true);
});

test('R2-1: only the latest read applies, and none after dispose', () => {
  const reads = new ConversationReads();
  const first = reads.begin();
  const second = reads.begin();
  assert.equal(reads.isLatest(first), false);
  assert.equal(reads.isLatest(second), true);
  reads.dispose();
  assert.equal(reads.isLatest(second), false);
});
