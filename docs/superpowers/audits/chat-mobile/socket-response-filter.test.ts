import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isExpectedSocketIoResponse,
  socketHttpOrigin,
} from './socket-response-filter.js';

test('normalizes configured websocket origins to response origins', () => {
  assert.equal(socketHttpOrigin('wss://socket.example.com'), 'https://socket.example.com');
  assert.equal(socketHttpOrigin('ws://socket.example.com:3001'), 'http://socket.example.com:3001');
  assert.equal(socketHttpOrigin('ftp://socket.example.com'), null);
  assert.equal(socketHttpOrigin('not a URL'), null);
});

test('suppresses only the exact Socket.IO path on the configured socket origin', () => {
  const expectedOrigin = socketHttpOrigin('wss://socket.example.com');

  assert.equal(
    isExpectedSocketIoResponse('https://socket.example.com/socket.io/?EIO=4&transport=polling', expectedOrigin),
    true,
  );
  assert.equal(
    isExpectedSocketIoResponse('https://socket.example.com/socket.io?EIO=4', expectedOrigin),
    true,
  );
  assert.equal(
    isExpectedSocketIoResponse('https://api.example.com/socket.io/?EIO=4', expectedOrigin),
    false,
  );
  assert.equal(
    isExpectedSocketIoResponse('https://socket.example.com/socket.io.evil', expectedOrigin),
    false,
  );
  assert.equal(
    isExpectedSocketIoResponse('https://socket.example.com.evil/socket.io/', expectedOrigin),
    false,
  );
});
