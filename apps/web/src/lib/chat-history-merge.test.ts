import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCH_UP_MAX_PAGES,
  ConversationReads,
  HISTORY_PAGE_SIZE,
  applyHistoryRead,
  mergeMessagesById,
  readHistoryBackTo,
} from './chat-history-merge';

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

const at = (i: number) => new Date(Date.parse('2026-11-10T00:00:00.000Z') + i * 1000).toISOString();
const serverOf = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `s-${i}`, content: `s-${i}`, created_at: at(i) }));
function pagedGet(all: ReturnType<typeof serverOf>, calls: string[]) {
  return async (path: string) => {
    calls.push(path);
    const q = new URL(path, 'http://x').searchParams;
    const limit = Number(q.get('limit'));
    const cursor = q.get('cursor');
    const list = cursor ? all.filter((m) => m.created_at < cursor) : all;
    return { ok: true, status: 200, json: async () => ({ messages: list.slice(-limit) }) } as Response;
  };
}

test('R2-2: catch-up pages back until it reaches the oldest shown message', async () => {
  const all = serverOf(260);
  const calls: string[] = [];
  const read = await readHistoryBackTo(pagedGet(all, calls), '/api/messages/s1', at(30));
  assert.equal(calls.length, 3);
  assert.equal(read.coversShown, true);
  assert.equal(read.messages.length, 260);
  assert.equal(new Set(read.messages.map((m) => m.id)).size, 260);
});

test('R2-2: catch-up stops at the page bound and reports it did not cover the shown range', async () => {
  const all = serverOf(800);
  const calls: string[] = [];
  const read = await readHistoryBackTo<ReturnType<typeof serverOf>[number]>(pagedGet(all, calls), '/api/messages/s1', at(0));
  assert.equal(calls.length, CATCH_UP_MAX_PAGES);
  assert.equal(read.coversShown, false);
  assert.equal(read.hasEarlier, true);
  assert.equal(read.messages.length, CATCH_UP_MAX_PAGES * HISTORY_PAGE_SIZE);
  const shown = [{ id: 's-0', content: 'old', created_at: at(0) }, { id: 'live', content: 'live', created_at: at(900) }];
  const applied = applyHistoryRead(shown, read, () => false);
  assert.equal(applied.some((m) => m.id === 's-0'), false, 'messages older than the read are dropped, not left beside a hole');
  assert.equal(applied.at(-1)!.id, 'live', 'newer live messages stay');
  assert.equal(applied.length, CATCH_UP_MAX_PAGES * HISTORY_PAGE_SIZE + 1);
});

test('R2-2: a failed page fails the whole catch-up', async () => {
  const get = async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
  await assert.rejects(readHistoryBackTo(get, '/api/messages/s1', null));
});
