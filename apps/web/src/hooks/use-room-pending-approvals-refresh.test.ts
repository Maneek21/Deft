import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  APPROVAL_ATTENTION_EVENTS,
  isApprovalAttentionEvent,
  ROOM_PENDING_APPROVALS_EVENT_DELAY_MS,
  ROOM_PENDING_APPROVALS_READ_TIMEOUT_MS,
  ROOM_PENDING_APPROVALS_REFRESH_MS,
  ROOM_PENDING_APPROVALS_REQUEST_TIMEOUT_MS,
  roomPendingApprovalsRequest,
  scheduleRoomPendingApprovalsRefresh,
} from './use-room-pending-approvals-refresh';
import { api } from '../lib/api';

test('a room re-reads its approvals on an approval Inbox event, and on nothing else', () => {
  assert.equal(isApprovalAttentionEvent({ id: 'a', source_type: 'agent_action' }), true);
  for (const item of [{ source_type: 'message' }, { source_type: 'task' }, {}, null, undefined, 'agent_action']) {
    assert.equal(isApprovalAttentionEvent(item), false, JSON.stringify(item));
  }
});

/** Let the scheduler's promise chain run (a few microtask turns). */
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };

/** Injected timers: the ¾ s delays before reads, and the timeouts that bound a read. */
function fakeTimers() {
  const delays: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  return {
    delays, timeouts,
    timers: { set: (run: () => void, ms: number) => (ms === ROOM_PENDING_APPROVALS_READ_TIMEOUT_MS ? timeouts : delays).push(run) },
  };
}

test('events that arrive together make one re-read per room, and a later event another', async () => {
  const { delays, timers } = fakeTimers();
  const reads: string[] = [];
  // An approval raised, seen and decided, heard by the room and by its thread panel.
  for (const view of ['room', 'thread', 'room', 'thread']) scheduleRoomPendingApprovalsRefresh('room-a', () => reads.push(view), timers);
  scheduleRoomPendingApprovalsRefresh('room-b', () => reads.push('b'), timers);
  assert.equal(delays.length, 2, 'one scheduled re-read per room');
  for (const run of delays.splice(0)) run();
  await settle();
  assert.deepEqual(reads, ['thread', 'b'], 'the latest refresh of each room ran once');
  scheduleRoomPendingApprovalsRefresh('room-a', () => reads.push('later'), timers);
  assert.equal(delays.length, 1, 'an event after the re-read schedules another');
  delays.shift()!();
  await settle();
  assert.deepEqual(reads, ['thread', 'b', 'later']);
});

test('one read at a time per room: events during a read queue one more, which waits for it (astra)', async () => {
  const { delays: pending, timers } = fakeTimers();
  let running = 0;
  let overlapped = false;
  const finishes: Array<() => void> = [];
  const refresh = () => {
    running += 1;
    if (running > 1) overlapped = true;
    return new Promise<void>((resolve) => finishes.push(() => { running -= 1; resolve(); }));
  };
  scheduleRoomPendingApprovalsRefresh('room-slow', refresh, timers);
  pending.shift()!();
  await settle();
  assert.equal(finishes.length, 1, 'the first read is running');
  // Events every 2 s while reads take 3 s: none starts a second read alongside the first.
  for (let event = 0; event < 5; event += 1) scheduleRoomPendingApprovalsRefresh('room-slow', refresh, timers);
  assert.equal(pending.length, 0, 'no read scheduled while one runs');
  finishes.shift()!();
  await settle();
  assert.equal(pending.length, 1, 'one more read after it, for the events it may have missed');
  pending.shift()!();
  await settle();
  assert.equal(finishes.length, 1, 'the second read is running');
  finishes.shift()!();
  await settle();
  assert.equal(pending.length, 0, 'nothing more without new events');
  assert.equal(overlapped, false, 'reads never overlapped, so none was dropped');
  // The room is free again: the next event schedules a fresh read.
  scheduleRoomPendingApprovalsRefresh('room-slow', () => undefined, timers);
  assert.equal(pending.length, 1);
  pending.shift()!();
  await settle();
});

test('a read that never settles releases its room after the timeout, and the queued read runs (astra)', async () => {
  const { delays, timeouts, timers } = fakeTimers();
  const calls: string[] = [];
  let finishFirst: () => void = () => undefined;
  scheduleRoomPendingApprovalsRefresh('room-stalled', () => { calls.push('stalled'); return new Promise<void>((resolve) => { finishFirst = resolve; }); }, timers);
  delays.shift()!();
  await settle();
  assert.deepEqual(calls, ['stalled']);
  for (let event = 0; event < 100; event += 1) scheduleRoomPendingApprovalsRefresh('room-stalled', () => { calls.push('next'); }, timers);
  assert.equal(delays.length, 0, 'no read starts beside the stalled one');
  assert.equal(timeouts.length, 1, 'the stalled read has a deadline');
  timeouts.shift()!();
  assert.equal(delays.length, 1, 'at the deadline the room is released and the queued read is scheduled');
  delays.shift()!();
  await settle();
  assert.deepEqual(calls, ['stalled', 'next'], 'the queued read ran');
  // The stalled request settling late changes nothing: the room was already released.
  finishFirst();
  await settle();
  assert.equal(delays.length, 0, 'a late settle schedules nothing');
  for (const run of timeouts.splice(0)) run();
  await settle();
  scheduleRoomPendingApprovalsRefresh('room-stalled', () => undefined, timers);
  assert.equal(delays.length, 1, 'the room is free again');
  delays.shift()!();
  await settle();
});

test('a room read is given up after its timeout, and the scheduler never cuts a read short (astra)', async () => {
  assert.ok(ROOM_PENDING_APPROVALS_READ_TIMEOUT_MS > ROOM_PENDING_APPROVALS_REQUEST_TIMEOUT_MS,
    'a read settles before the scheduler would start another beside it');
  assert.ok(ROOM_PENDING_APPROVALS_REQUEST_TIMEOUT_MS < ROOM_PENDING_APPROVALS_REFRESH_MS, 'a stalled read ends before the next poll is due');
  const original = globalThis.fetch;
  let seenSignal: AbortSignal | undefined;
  // A server that never answers: the request settles only when its signal aborts.
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    seenSignal = init?.signal ?? undefined;
    seenSignal?.addEventListener('abort', () => reject(seenSignal!.reason));
  })) as typeof fetch;
  try {
    const started = Date.now();
    await assert.rejects(roomPendingApprovalsRequest('/api/agent/actions/pending-by-space?space_id=s', 40), (error: Error) => error.name === 'TimeoutError');
    assert.ok(seenSignal, 'the request carries a signal');
    assert.ok(Date.now() - started < 2_000, 'given up at its timeout');
  } finally {
    globalThis.fetch = original;
  }
  // A wait inside the client that never sees the signal (a session refresh queued behind another tab's lock).
  const clientFetch = api.fetch;
  api.fetch = (() => new Promise<Response>(() => undefined)) as typeof api.fetch;
  try {
    const started = Date.now();
    await assert.rejects(roomPendingApprovalsRequest('/api/agent/actions/pending-by-space?space_id=s', 40), (error: Error) => error.name === 'TimeoutError');
    assert.ok(Date.now() - started < 2_000, 'given up at its timeout even so');
  } finally {
    api.fetch = clientFetch;
  }
  // A request that answers in time is that answer.
  api.fetch = (async () => new Response('[]', { status: 200 })) as typeof api.fetch;
  try {
    assert.equal((await roomPendingApprovalsRequest('/api/agent/actions/pending-by-space?space_id=s', 1_000)).status, 200);
  } finally {
    api.fetch = clientFetch;
  }
});

test('the hook listens to the events the server sends an approval\'s reviewers, with the type it gives them', () => {
  const attention = readFileSync(new URL('../../../api/src/lib/attention.ts', import.meta.url), 'utf8');
  const emitted = attention.match(/async function emitAttention\(event: ([^,]+),/)?.[1];
  assert.ok(emitted, 'lib/attention.ts emitAttention');
  assert.deepEqual([...emitted.matchAll(/'([a-z:]+)'/g)].map((match) => match[1]).sort(), [...APPROVAL_ATTENTION_EVENTS].sort());
  assert.match(attention, /emitToUser\(current\.org_id, current\.user_id, event, projectAttentionItem\(current\)\)/, 'the item itself is the payload');
  assert.match(attention, /export function approvalToAttentionDraft[\s\S]*?sourceType: 'agent_action'/, 'an approval\'s item has source_type agent_action');
});

test('the rooms poll their approvals only as a fallback, every 30 seconds, and both re-read on the events', () => {
  assert.equal(ROOM_PENDING_APPROVALS_REFRESH_MS, 30_000);
  // The hook re-reads the room it was scheduled for (SWR's global mutate on that key), not a component's current key.
  const hook = readFileSync(new URL('./use-room-pending-approvals-refresh.ts', import.meta.url), 'utf8');
  assert.ok(hook.includes('scheduleRoomPendingApprovalsRefresh(key, () => mutate(key))'), 're-reads its own key');
  assert.ok(hook.includes('const { mutate } = useSWRConfig();'), 'with the global mutate');
  for (const file of ['../components/space-chat.tsx', '../components/thread-panel.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/pending-by-space[\s\S]{0,1200}refreshInterval: 5000/.test(source), `${file}: no 5-second poll`);
    assert.ok(source.includes('refreshInterval: ROOM_PENDING_APPROVALS_REFRESH_MS'), `${file}: the fallback interval`);
    assert.ok(source.includes('useRoomPendingApprovalsRefresh(pendingBySpaceKey)'), `${file}: re-reads on the events`);
    assert.ok(source.includes('const res = await roomPendingApprovalsRequest(url);'), `${file}: reads with the bounded request`);
  }
});
