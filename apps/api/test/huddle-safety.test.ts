import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpRealtimeAccessGeneration,
  captureRealtimeAccessGeneration,
  isRealtimeAccessGenerationCurrent,
  revokeRealtimeAccess,
  type RealtimeRevocationServer,
} from '../src/socket.js';
import {
  addParticipant,
  createRoom,
  destroyRoom,
  getActiveRoomSnapshots,
  getConflictingRoomId,
  getParticipantList,
  getParticipantSocketId,
  getRoomBySpace,
  getRoomIdsForSocket,
  getRoomIdsForScope,
  isParticipant,
  isParticipantOnDifferentSocket,
  parseCreatePayload,
  parseListPayload,
  parseMutePayload,
  parseRoomPayload,
  parseSignalPayload,
  removeParticipant,
  reserveRoom,
  setMuted,
} from '../src/huddle-rooms.js';

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const ROOM_C = '33333333-3333-4333-8333-333333333333';

test('every access-revocation scope invalidates stale authorization generations', () => {
  let staleGeneration = captureRealtimeAccessGeneration();
  assert.equal(isRealtimeAccessGenerationCurrent(staleGeneration), true);
  bumpRealtimeAccessGeneration({
    orgId: 'org-a',
    spaceId: 'space-a',
    userId: 'user-a',
    reason: 'space_membership_revoked',
  });
  assert.equal(isRealtimeAccessGenerationCurrent(staleGeneration), false);

  staleGeneration = captureRealtimeAccessGeneration();
  bumpRealtimeAccessGeneration({
    orgId: 'org-a',
    userId: 'user-a',
    reason: 'org_membership_revoked',
  });
  assert.equal(isRealtimeAccessGenerationCurrent(staleGeneration), false);

  staleGeneration = captureRealtimeAccessGeneration();
  bumpRealtimeAccessGeneration({
    orgId: 'org-a',
    spaceId: 'space-a',
    reason: 'space_archived',
  });
  assert.equal(isRealtimeAccessGenerationCurrent(staleGeneration), false);
  assert.equal(isRealtimeAccessGenerationCurrent(captureRealtimeAccessGeneration()), true);
});

test('realtime access revocation works without an active huddle room', () => {
  const calls: Array<{ operation: 'leave' | 'disconnect'; selector: string; target?: string; close?: boolean }> = [];
  const server: RealtimeRevocationServer = {
    in(selector) {
      return {
        socketsLeave(target) {
          calls.push({ operation: 'leave', selector, target });
        },
        disconnectSockets(close) {
          calls.push({ operation: 'disconnect', selector, close });
        },
      };
    },
  };

  revokeRealtimeAccess({
    orgId: 'org-a',
    spaceId: 'space-a',
    userId: 'user-a',
    reason: 'space_membership_revoked',
  }, server);
  revokeRealtimeAccess({
    orgId: 'org-a',
    spaceId: 'space-a',
    reason: 'space_archived',
  }, server);
  revokeRealtimeAccess({
    orgId: 'org-a',
    userId: 'user-a',
    reason: 'org_membership_revoked',
  }, server);

  assert.deepEqual(calls, [
    {
      operation: 'leave',
      selector: 'org-user:org-a:user-a',
      target: 'space:space-a',
    },
    {
      operation: 'leave',
      selector: 'space:space-a',
      target: 'space:space-a',
    },
    {
      operation: 'disconnect',
      selector: 'org-user:org-a:user-a',
      close: true,
    },
  ]);
});

test('huddle payload parsers reject malformed and oversized socket input', () => {
  const create = parseCreatePayload({ space_id: '  space-a  ' });
  assert.equal(create.success, true);
  if (create.success) assert.equal(create.data.space_id, 'space-a');
  assert.equal(parseCreatePayload({ space_id: '' }).success, false);
  assert.equal(parseCreatePayload({ space_id: 'space-a', unexpected: true }).success, false);

  assert.equal(parseListPayload(undefined).success, true);
  assert.equal(parseListPayload({}).success, true);
  assert.equal(parseListPayload({ org_id: 'org-b' }).success, false);

  assert.equal(parseRoomPayload({ huddle_id: ROOM_A }).success, true);
  assert.equal(parseRoomPayload({ huddle_id: 'not-a-room-id' }).success, false);
  assert.equal(parseMutePayload({ huddle_id: ROOM_A, muted: true }).success, true);
  assert.equal(parseMutePayload({ huddle_id: ROOM_A, muted: 'true' }).success, false);

  assert.equal(parseSignalPayload({
    huddle_id: ROOM_A,
    target_user_id: 'user-b',
    signal_data: { type: 'offer', sdp: 'small' },
  }).success, true);
  assert.equal(parseSignalPayload({
    huddle_id: ROOM_A,
    target_user_id: 'user-b',
    signal_data: 'not-an-object',
  }).success, false);
  assert.equal(parseSignalPayload({
    huddle_id: ROOM_A,
    target_user_id: 'user-b',
    signal_data: { sdp: 'x'.repeat(65 * 1024) },
  }).success, false);
});

test('conflict detection permits only the requested active room for a user', () => {
  createRoom(ROOM_A, 'space-a', 'org-a', 'user-a');
  createRoom(ROOM_B, 'space-b', 'org-a', 'user-b');
  try {
    addParticipant(ROOM_A, {
      user_id: 'user-a',
      user_name: 'Alice',
      muted: false,
      socket_id: 'socket-a',
    });
    assert.equal(getConflictingRoomId('user-a', 'org-a', ROOM_A), undefined);

    // Simulate pre-existing malformed state from an older server process. The
    // socket handlers use this helper to reject creating/joining another room.
    addParticipant(ROOM_B, {
      user_id: 'user-a',
      user_name: 'Alice',
      muted: false,
      socket_id: 'socket-a-2',
    });
    assert.equal(getConflictingRoomId('user-a', 'org-a', ROOM_A), ROOM_B);
    assert.equal(getConflictingRoomId('user-a', 'org-b', ROOM_A), undefined);
  } finally {
    destroyRoom(ROOM_A);
    destroyRoom(ROOM_B);
  }
});

test('room reservation keeps one active room per org and space', () => {
  const first = reserveRoom(ROOM_A, 'space-a', 'org-a', 'user-a');
  const second = reserveRoom(ROOM_B, 'space-a', 'org-a', 'user-b');
  try {
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.room.id, ROOM_A);
    assert.deepEqual(getRoomIdsForScope('org-a', 'space-a'), [ROOM_A]);
  } finally {
    destroyRoom(ROOM_A);
    destroyRoom(ROOM_B);
  }
});

test('a second socket cannot replace the active socket for the same participant', () => {
  createRoom(ROOM_A, 'space-a', 'org-a', 'user-a');
  try {
    assert.equal(addParticipant(ROOM_A, {
      user_id: 'user-a',
      user_name: 'Alice',
      muted: false,
      socket_id: 'socket-a',
    }), true);
    assert.equal(isParticipantOnDifferentSocket(ROOM_A, 'user-a', 'socket-a'), false);
    assert.equal(isParticipantOnDifferentSocket(ROOM_A, 'user-a', 'socket-b'), true);
    assert.equal(addParticipant(ROOM_A, {
      user_id: 'user-a',
      user_name: 'Alice',
      muted: false,
      socket_id: 'socket-b',
    }), false);
    assert.equal(getParticipantSocketId(ROOM_A, 'user-a'), 'socket-a');
    assert.deepEqual(getRoomIdsForSocket('socket-a'), [ROOM_A]);
    assert.deepEqual(getRoomIdsForSocket('socket-b'), []);
  } finally {
    destroyRoom(ROOM_A);
  }
});

test('room operations enforce socket ownership and never expose socket ids', () => {
  createRoom(ROOM_A, 'space-a', 'org-a', 'user-a');
  try {
    assert.equal(addParticipant(ROOM_A, {
      user_id: 'user-a',
      user_name: 'Alice',
      muted: false,
      socket_id: 'socket-a',
    }), true);
    assert.equal(addParticipant(ROOM_A, {
      user_id: 'user-b',
      user_name: 'Bob',
      muted: false,
      socket_id: 'socket-b',
    }), true);

    assert.equal(isParticipant(ROOM_A, 'user-a', 'socket-a'), true);
    assert.equal(isParticipant(ROOM_A, 'user-a', 'socket-other'), false);
    assert.equal(getParticipantSocketId(ROOM_A, 'user-b'), 'socket-b');
    assert.equal(setMuted(ROOM_A, 'user-a', 'socket-other', true), false);
    assert.equal(setMuted(ROOM_A, 'user-a', 'socket-a', true), true);

    const participants = getParticipantList(ROOM_A);
    assert.deepEqual(participants, [
      { user_id: 'user-a', user_name: 'Alice', muted: true },
      { user_id: 'user-b', user_name: 'Bob', muted: false },
    ]);
    assert.equal(Object.hasOwn(participants[0]!, 'socket_id'), false);

    assert.deepEqual(removeParticipant(ROOM_A, 'user-a', 'socket-other'), {
      removed: false,
      empty: false,
      room: getRoomBySpace('space-a', 'org-a'),
    });
    const removed = removeParticipant(ROOM_A, 'user-a', 'socket-a');
    assert.equal(removed.removed, true);
    assert.equal(removed.empty, false);
    assert.deepEqual(getRoomIdsForSocket('socket-b'), [ROOM_A]);
  } finally {
    destroyRoom(ROOM_A);
  }
});

test('active room snapshots are tenant- and membership-scoped', () => {
  createRoom(ROOM_A, 'space-shared', 'org-a', 'user-a');
  createRoom(ROOM_B, 'space-shared', 'org-b', 'user-b');
  createRoom(ROOM_C, 'space-empty', 'org-a', 'user-a');
  try {
    addParticipant(ROOM_A, {
      user_id: 'user-a',
      user_name: 'Alice',
      muted: false,
      socket_id: 'socket-a',
    });
    addParticipant(ROOM_B, {
      user_id: 'user-b',
      user_name: 'Bob',
      muted: false,
      socket_id: 'socket-b',
    });

    assert.equal(getRoomBySpace('space-shared', 'org-a')?.id, ROOM_A);
    assert.equal(getRoomBySpace('space-shared', 'org-b')?.id, ROOM_B);
    assert.deepEqual(getRoomIdsForScope('org-a', 'space-shared', 'user-a'), [ROOM_A]);
    assert.deepEqual(getRoomIdsForScope('org-a', 'space-shared', 'user-b'), []);
    assert.deepEqual(getActiveRoomSnapshots('org-a', new Set(['space-shared', 'space-empty'])), [{
      huddle_id: ROOM_A,
      space_id: 'space-shared',
      created_by: 'user-a',
      participants: [{ user_id: 'user-a', user_name: 'Alice', muted: false }],
    }]);
    assert.deepEqual(getActiveRoomSnapshots('org-a', new Set(['space-not-joined'])), []);
  } finally {
    destroyRoom(ROOM_A);
    destroyRoom(ROOM_B);
    destroyRoom(ROOM_C);
  }
});
