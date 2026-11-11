import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCH_UP_MAX_PAGES,
  ConversationReads,
  HISTORY_PAGE_SIZE,
  applyHistoryRead,
  historyCursorOf,
  mergeMessagesById,
  readHistoryBackTo,
  readHistoryPage,
} from './chat-history-merge';
import { replayMessageEvents, type ChatReaction, type MessageEvent } from './chat-message-events';

type Row = { id: string; content: string; created_at: string; edited_at?: string | null; is_deleted?: boolean; reactions?: ChatReaction[]; reply_count?: number };

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
  const reads = new ConversationReads<MessageEvent<Row>>();
  const ticket = reads.begin();
  reads.record({ type: 'edited', id: 'a', content: 'edited live', edited_at: '2026-11-10T11:00:00.000Z' });
  const shown: Row[] = [{ ...msg('a', 1, 'edited live'), is_deleted: false }, { ...msg('b', 2), is_deleted: true }];
  const stale: Row[] = [{ ...msg('a', 1, 'old'), is_deleted: false }, { ...msg('b', 2), is_deleted: false }];
  const merged = replayMessageEvents(mergeMessagesById(shown, stale), reads.settle(ticket));
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
    // Like the API: `<created_at>|<id>` pages before that row in (created_at, id) order.
    const [time, id] = (cursor ?? '').split('|');
    const list = cursor ? all.filter((m) => m.created_at < time! || (m.created_at === time && id !== undefined && m.id < id)) : all;
    const page = list.slice(-limit);
    // Like the API: a full page names its oldest row as the next cursor.
    const next_cursor = page.length === limit ? `${page[0]!.created_at}|${page[0]!.id}` : null;
    return { ok: true, status: 200, json: async () => ({ messages: page, next_cursor }) } as Response;
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
  const applied = applyHistoryRead(shown, read);
  assert.equal(applied.some((m) => m.id === 's-0'), false, 'messages older than the read are dropped, not left beside a hole');
  assert.equal(applied.at(-1)!.id, 'live', 'newer live messages stay');
  assert.equal(applied.length, CATCH_UP_MAX_PAGES * HISTORY_PAGE_SIZE + 1);
});

test('W2-1: messages sharing one timestamp across page boundaries are each read once', async () => {
  const same = at(5);
  const all = Array.from({ length: 250 }, (_, i) => ({ id: `t-${String(i).padStart(3, '0')}`, content: `t-${i}`, created_at: same }));
  const calls: string[] = [];
  const read = await readHistoryBackTo(pagedGet(all, calls), '/api/messages/s1', at(0));
  assert.equal(calls.length, 3);
  assert.equal(read.messages.length, 250);
  assert.equal(new Set(read.messages.map((m) => m.id)).size, 250);
  assert.match(calls[1]!, /cursor=/);
  assert.equal(new URL(calls[1]!, 'http://x').searchParams.get('cursor'), historyCursorOf(all[150]!));
});

test('W2R2-1: an earlier page that shares the boundary timestamp lands before what is shown, in server order', () => {
  const same = at(5);
  const row = (i: number) => ({ id: `t-${String(i).padStart(3, '0')}`, content: `t-${i}`, created_at: same });
  const shown = Array.from({ length: 3 }, (_, i) => row(i + 3));
  const earlier = Array.from({ length: 3 }, (_, i) => row(i));
  assert.deepEqual(mergeMessagesById(shown, earlier).map((m) => m.id), ['t-000', 't-001', 't-002', 't-003', 't-004', 't-005']);
});

test('W2R2-1: Load earlier follows the server cursor across three pages that share one timestamp, then stops', async () => {
  const same = at(5);
  const all = Array.from({ length: 250 }, (_, i) => ({ id: `t-${String(i).padStart(3, '0')}`, content: `t-${i}`, created_at: same }));
  const calls: string[] = [];
  const get = pagedGet(all, calls);
  let shown: typeof all = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const page = await readHistoryPage<(typeof all)[number]>(get, '/api/messages/s1', cursor);
    shown = mergeMessagesById(shown, page.messages);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(calls.length, 3, 'three requests, then stop');
  assert.deepEqual(shown.map((m) => m.id), all.map((m) => m.id), 'each message once, in server order');
});

test('R2-2: a failed page fails the whole catch-up', async () => {
  const get = async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
  await assert.rejects(readHistoryBackTo(get, '/api/messages/s1', null));
});

test('R3-2: a live reaction is replayed onto the fetched row, so the fetched edit and other fields still apply', () => {
  const reads = new ConversationReads<MessageEvent<Row>>();
  const ticket = reads.begin();
  reads.record({ type: 'reaction_added', message_id: 'a', emoji: '🎉', user_id: 'bob' });
  const shown: Row[] = [{ ...msg('a', 1, 'old text'), reactions: [{ emoji: '🎉', count: 1, users: ['bob'] }], reply_count: 0 }];
  const fetched: Row[] = [{ ...msg('a', 1, 'edited offline'), reactions: [], reply_count: 3 }];
  const [merged] = replayMessageEvents(mergeMessagesById(shown, fetched), reads.settle(ticket));
  assert.equal(merged!.content, 'edited offline');
  assert.equal(merged!.reply_count, 3);
  assert.deepEqual(merged!.reactions, [{ emoji: '🎉', count: 1, users: ['bob'] }]);
});

test('R3-2: a live edit is replayed onto a fetched deletion: the text updates and it stays deleted', () => {
  const reads = new ConversationReads<MessageEvent<Row>>();
  const ticket = reads.begin();
  reads.record({ type: 'edited', id: 'a', content: 'live edit', edited_at: '2026-11-10T11:00:00.000Z' });
  const [merged] = replayMessageEvents(
    mergeMessagesById<Row>([{ ...msg('a', 1, 'live edit'), is_deleted: false }], [{ ...msg('a', 1, 'stale'), is_deleted: true }]),
    reads.settle(ticket),
  );
  assert.equal(merged!.content, 'live edit');
  assert.equal(merged!.is_deleted, true);
});

test('R3-a: the event buffer is empty when no read is in flight and is pruned on settle', () => {
  const reads = new ConversationReads<string>();
  reads.record('before any read');
  assert.equal(reads.bufferedEvents, 0);
  const a = reads.begin();
  reads.record('e1');
  const b = reads.begin();
  reads.record('e2');
  // B settles first: it gets only what arrived after B itself started.
  assert.deepEqual(reads.settle(b), ['e2']);
  assert.equal(reads.bufferedEvents, 2, 'A is still in flight');
  assert.deepEqual(reads.settle(a), ['e1', 'e2']);
  assert.equal(reads.bufferedEvents, 0);
});

test('R4: an event after a read started is replayed even when an older read settles first', () => {
  const reads = new ConversationReads<string>();
  const older = reads.begin();
  const newer = reads.begin();
  reads.record('after both started');
  reads.settle(older);
  assert.deepEqual(reads.settle(newer), ['after both started']);
});

test('R4: a side read (Load earlier) does not supersede, but a later read supersedes it', () => {
  const reads = new ConversationReads<string>();
  const main = reads.begin();
  reads.settle(main);
  const side = reads.begin({ supersede: false });
  assert.equal(reads.isLatest(side), true);
  const catchUp = reads.begin();
  assert.equal(reads.isLatest(side), false);
  assert.equal(reads.isLatest(catchUp), true);
});

test('R5-1: an event from before a read started is not replayed onto that read', () => {
  const reads = new ConversationReads<string>();
  const first = reads.begin();
  reads.record('reaction added, later removed on the server');
  const catchUp = reads.begin();
  reads.record('after catch-up started');
  // Whichever settles first, the catch-up never replays the older event.
  assert.deepEqual(reads.settle(catchUp), ['after catch-up started']);
  reads.settle(first);
  const again = new ConversationReads<string>();
  const a = again.begin();
  again.record('old');
  const b = again.begin();
  again.record('new');
  again.settle(a);
  assert.deepEqual(again.settle(b), ['new']);
});

test('R5-2: a side read may not start while a load, retry or catch-up is in flight', () => {
  const reads = new ConversationReads<string>();
  assert.equal(reads.replacingReadInFlight, false);
  const catchUp = reads.begin();
  assert.equal(reads.replacingReadInFlight, true);
  reads.settle(catchUp);
  assert.equal(reads.replacingReadInFlight, false);
  const side = reads.begin({ supersede: false });
  assert.equal(reads.replacingReadInFlight, false, 'a side read does not block another');
  reads.settle(side);
  const later = reads.begin();
  reads.dispose();
  assert.equal(reads.replacingReadInFlight, false);
  void later;
});
