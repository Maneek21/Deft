import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  APPROVAL_ATTENTION_EVENTS,
  isApprovalAttentionEvent,
  ROOM_PENDING_APPROVALS_EVENT_DELAY_MS,
  ROOM_PENDING_APPROVALS_REFRESH_MS,
  scheduleRoomPendingApprovalsRefresh,
} from './use-room-pending-approvals-refresh';

test('a room re-reads its approvals on an approval Inbox event, and on nothing else', () => {
  assert.equal(isApprovalAttentionEvent({ id: 'a', source_type: 'agent_action' }), true);
  for (const item of [{ source_type: 'message' }, { source_type: 'task' }, {}, null, undefined, 'agent_action']) {
    assert.equal(isApprovalAttentionEvent(item), false, JSON.stringify(item));
  }
});

/** Let the scheduler's promise chain run (a few microtask turns). */
const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };

test('events that arrive together make one re-read per room, and a later event another', async () => {
  const pending: Array<{ run: () => void; ms: number }> = [];
  const timers = { set: (run: () => void, ms: number) => pending.push({ run, ms }) };
  const reads: string[] = [];
  // An approval raised, seen and decided, heard by the room and by its thread panel.
  for (const view of ['room', 'thread', 'room', 'thread']) scheduleRoomPendingApprovalsRefresh('room-a', () => reads.push(view), timers);
  scheduleRoomPendingApprovalsRefresh('room-b', () => reads.push('b'), timers);
  assert.equal(pending.length, 2, 'one scheduled re-read per room');
  assert.ok(pending.every((entry) => entry.ms === ROOM_PENDING_APPROVALS_EVENT_DELAY_MS));
  for (const entry of pending.splice(0)) entry.run();
  await settle();
  assert.deepEqual(reads, ['thread', 'b'], 'the latest refresh of each room ran once');
  scheduleRoomPendingApprovalsRefresh('room-a', () => reads.push('later'), timers);
  assert.equal(pending.length, 1, 'an event after the re-read schedules another');
  pending[0]!.run();
  await settle();
  assert.deepEqual(reads, ['thread', 'b', 'later']);
});

test('one read at a time per room: events during a read queue one more, which waits for it (astra)', async () => {
  const pending: Array<() => void> = [];
  const timers = { set: (run: () => void) => pending.push(run) };
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
  for (const file of ['../components/space-chat.tsx', '../components/thread-panel.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/pending-by-space[\s\S]{0,1200}refreshInterval: 5000/.test(source), `${file}: no 5-second poll`);
    assert.ok(source.includes('refreshInterval: ROOM_PENDING_APPROVALS_REFRESH_MS'), `${file}: the fallback interval`);
    assert.ok(source.includes('useRoomPendingApprovalsRefresh(pendingBySpaceKey, refreshPendingApprovals)'), `${file}: re-reads on the events`);
  }
});
