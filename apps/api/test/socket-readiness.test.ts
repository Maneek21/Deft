import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupSocket, type SocketUser } from '../src/socket.js';

const { io: connect } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');
const user: SocketUser = {
  id: 'socket-ready-user',
  email: 'socket-ready@deft.invalid',
  org_id: 'socket-ready-org',
  sid: 'socket-ready-session',
  exp: Math.floor(Date.now() / 1000) + 300,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function once(socket: any, event: string, timeoutMs = 5_000) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Socket ${event} timed out`)), timeoutMs);
    socket.once(event, (value: unknown) => { clearTimeout(timer); resolve(value); });
  });
}

async function fixture(secondVerification: Promise<void>, thirdVerification: Promise<void> = Promise.resolve()) {
  let verificationCount = 0;
  let spaceAccessChecks = 0;
  const ingress = deferred();
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async () => {
      verificationCount += 1;
      if (verificationCount === 2) await secondVerification;
      if (verificationCount === 3) await thirdVerification;
      return user as any;
    },
    requireMembership: async () => ({ role: 'member' }) as any,
    getSpaceAccess: async (spaceId) => {
      spaceAccessChecks += 1;
      return { space_id: spaceId, space_name: 'Ready room', user_name: 'Ready user' };
    },
    recordLastSeen: () => {},
    onPacketIngress: () => ingress.resolve(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = connect(`http://127.0.0.1:${port}`, {
    auth: { token: 'test-token' }, transports: ['websocket'], reconnection: false,
  });
  return {
    client, sockets,
    spaceAccessChecks: () => spaceAccessChecks,
    ingress: ingress.promise,
    close: async () => {
      client.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

test('space join emitted on connect waits for initialization and receives room traffic', async () => {
  const verification = deferred();
  const run = await fixture(verification.promise);
  try {
    const connected = once(run.client, 'connect');
    run.client.on('connect', () => run.client.emit('space:join', 'early-room'));
    await connected;
    await run.ingress;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.spaceAccessChecks(), 0, 'early packet must wait for the second access verification');
    const serverSocket = [...run.sockets.sockets.sockets.values()][0];
    assert.deepEqual(
      [...serverSocket.rooms].filter((room) => room !== serverSocket.id),
      ['web-session:socket-ready-session'],
      'sensitive rooms must remain unavailable before the second verification',
    );

    verification.resolve();
    const received = once(run.client, 'readiness:probe');
    const deadline = Date.now() + 5_000;
    while ((run.sockets.sockets.adapter.rooms.get('space:early-room')?.size ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(run.spaceAccessChecks(), 1, 'queued join must dispatch after handler registration');
    assert.equal(run.sockets.sockets.adapter.rooms.get('space:early-room')?.size, 1);
    run.sockets.to('space:early-room').emit('readiness:probe', { ok: true });
    assert.deepEqual(await received, { ok: true });
  } finally {
    verification.resolve();
    await run.close();
  }
});

test('failed second verification never dispatches an early space join', async () => {
  const verification = deferred();
  const run = await fixture(verification.promise);
  try {
    const connected = once(run.client, 'connect');
    run.client.on('connect', () => run.client.emit('space:join', 'forbidden-room'));
    await connected;
    await run.ingress;
    await new Promise((resolve) => setImmediate(resolve));
    const serverSocket = [...run.sockets.sockets.sockets.values()][0];
    assert.equal(serverSocket.rooms.has('org:socket-ready-org'), false);
    assert.equal(serverSocket.rooms.has('user:socket-ready-user'), false);
    assert.equal(serverSocket.rooms.has('org-user:socket-ready-org:socket-ready-user'), false);
    const disconnected = once(run.client, 'disconnect');
    verification.reject(new Error('revoked during initialization'));
    assert.equal(await disconnected, 'io server disconnect');
    assert.equal(run.spaceAccessChecks(), 0);
    assert.equal(run.sockets.sockets.adapter.rooms.get('space:forbidden-room')?.size ?? 0, 0);
  } finally {
    verification.resolve();
    await run.close();
  }
});

test('disconnect during per-packet verification prevents space join dispatch', async () => {
  const packetVerification = deferred();
  const run = await fixture(Promise.resolve(), packetVerification.promise);
  try {
    await once(run.client, 'connect');
    run.client.emit('space:join', 'disconnected-room');
    await run.ingress;
    run.client.close();
    const deadline = Date.now() + 5_000;
    while (run.sockets.sockets.sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(run.sockets.sockets.sockets.size, 0, 'server must observe disconnect before verification resumes');
    packetVerification.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.spaceAccessChecks(), 0);
    assert.equal(run.sockets.sockets.adapter.rooms.get('space:disconnected-room')?.size ?? 0, 0);
  } finally {
    packetVerification.resolve();
    await run.close();
  }
});
