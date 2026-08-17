import test from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io-client';
import { prepareSocketForUse } from './socket';

function socketHarness(active: boolean, token = 'old-token') {
  let connectCalls = 0;
  const socket = {
    active,
    auth: { token },
    connect() {
      connectCalls += 1;
      return socket;
    },
  } as unknown as Socket;

  return {
    socket,
    get connectCalls() {
      return connectCalls;
    },
  };
}

test('updates auth without interrupting an active reconnect cycle', () => {
  const harness = socketHarness(true);

  const result = prepareSocketForUse(harness.socket, 'fresh-token');

  assert.equal(result, harness.socket);
  assert.deepEqual(harness.socket.auth, { token: 'fresh-token' });
  assert.equal(harness.connectCalls, 0);
});

test('restarts an inactive socket with the latest token', () => {
  const harness = socketHarness(false);

  prepareSocketForUse(harness.socket, 'replacement-token');

  assert.deepEqual(harness.socket.auth, { token: 'replacement-token' });
  assert.equal(harness.connectCalls, 1);
});
