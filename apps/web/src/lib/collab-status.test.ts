import assert from 'node:assert/strict';
import test from 'node:test';
import { collabStatusFromClose, createDocumentProvider, type CollabStatus } from './collab-provider';

// The live-editing client (plan Task F12): how each /collab close code
// (F7's COLLAB_CLOSE) turns into what the document page shows, and what the
// provider does next. The provider runs against an in-memory WebSocket, so
// each test can read the token the client sent and close the socket with the
// server's code.

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a lib0 varUint. */
function readVarUint(bytes: Uint8Array, at: { pos: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at.pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return value;
    shift += 7;
  }
}

function readVarString(bytes: Uint8Array, at: { pos: number }): string {
  const length = readVarUint(bytes, at);
  const text = new TextDecoder().decode(bytes.subarray(at.pos, at.pos + length));
  at.pos += length;
  return text;
}

/** The document name and token of a Hocuspocus authentication frame, or null for any other frame. */
function authFrame(bytes: Uint8Array): { name: string; token: string } | null {
  const at = { pos: 0 };
  const name = readVarString(bytes, at);
  if (readVarUint(bytes, at) !== 2) return null; // MessageType.Auth
  if (readVarUint(bytes, at) !== 0) return null; // AuthMessageType.Token
  return { name, token: readVarString(bytes, at) };
}

type Listener = (event: unknown) => void;

class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {}

  addEventListener(name: string, listener: Listener) {
    const bucket = this.listeners.get(name) ?? new Set<Listener>();
    bucket.add(listener);
    this.listeners.set(name, bucket);
  }

  removeEventListener(name: string, listener: Listener) {
    this.listeners.get(name)?.delete(listener);
  }

  send(data: ArrayBufferLike | Uint8Array) {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  /** The client closing: the close event comes later, as in a browser. */
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => this.closed(code, reason), 0);
  }

  /** The server accepting the upgrade. */
  open() {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  /** The server closing the socket with its code. */
  serverClose(code: number, reason: string) {
    this.closed(code, reason);
  }

  async token(): Promise<{ name: string; token: string }> {
    for (let waited = 0; waited < 2000; waited += 2) {
      for (const frame of this.sent) {
        const auth = authFrame(frame);
        if (auth) return auth;
      }
      await delay(2);
    }
    throw new Error('the client sent no token');
  }

  private closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', { code, reason });
  }

  private dispatch(name: string, event: unknown) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }
}

/** Every socket the client opens, in order. */
function fakeServer() {
  const sockets: FakeSocket[] = [];
  class Socket extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return {
    Socket,
    sockets,
    async socket(index: number): Promise<FakeSocket> {
      for (let waited = 0; waited < 2000; waited += 2) {
        if (sockets[index]) return sockets[index]!;
        await delay(2);
      }
      throw new Error(`the client opened no socket #${index + 1}`);
    },
  };
}

function session(
  server: ReturnType<typeof fakeServer>,
  token: { current: string },
  options: { readOnlyRetryMs?: number; refresh?: () => Promise<string | null> } = {},
) {
  const statuses: CollabStatus[] = [];
  const created = createDocumentProvider({
    documentId: 'doc-1',
    onStatus: (status) => statuses.push(status),
    seams: {
      url: 'ws://collab.test/collab',
      WebSocketPolyfill: server.Socket,
      getAccessToken: () => token.current,
      refreshAccessToken: options.refresh ?? (async () => token.current),
      reconnectDelayMs: 5,
      readOnlyRetryMs: options.readOnlyRetryMs ?? 60_000,
    },
  });
  return { statuses, destroy: () => created.destroy() };
}

test('collabStatusFromClose maps 4403→no_access, 4409→connecting, 4413→too_large, 4429→busy, 4430→crowded, 4503→live_off', () => {
  assert.equal(collabStatusFromClose(4403), 'no_access');
  assert.equal(collabStatusFromClose(4409), 'connecting');
  assert.equal(collabStatusFromClose(4413), 'too_large');
  assert.equal(collabStatusFromClose(4429), 'busy');
  assert.equal(collabStatusFromClose(4430), 'crowded');
  assert.equal(collabStatusFromClose(4503), 'live_off');
  assert.equal(collabStatusFromClose(4503, 'live_off'), 'live_off');
  // The server answers an address it won't serve as not found, and the socket
  // itself refuses a frame over 4 MiB with 1009.
  assert.equal(collabStatusFromClose(4404), 'no_access');
  assert.equal(collabStatusFromClose(1009), 'too_large');
  // A dropped network, or a close the server never sends, is just offline.
  assert.equal(collabStatusFromClose(1006), 'offline');
  assert.equal(collabStatusFromClose(1000), 'offline');
});

test('collabStatusFromClose maps 4401 to connecting after a refresh and 4503 paused to read_only', async () => {
  assert.equal(collabStatusFromClose(4401), 'connecting');
  assert.equal(collabStatusFromClose(4503, 'paused'), 'read_only');

  // 4401: the client refreshes its token and reconnects without a word.
  {
    const server = fakeServer();
    const token = { current: 'stale-token' };
    let refreshes = 0;
    const s = session(server, token, { refresh: async () => { refreshes += 1; token.current = 'fresh-token'; return token.current; } });
    try {
      const first = await server.socket(0);
      assert.equal(first.url, 'ws://collab.test/collab');
      first.open();
      assert.deepEqual(await first.token(), { name: 'doc:doc-1', token: 'stale-token' });
      first.serverClose(4401, 'unauthenticated');
      assert.deepEqual(s.statuses, ['connecting']);
      const second = await server.socket(1);
      second.open();
      assert.deepEqual(await second.token(), { name: 'doc:doc-1', token: 'fresh-token' });
      assert.equal(refreshes, 1, 'one refresh for one 4401');
      assert.deepEqual(s.statuses, ['connecting'], 'no offline or error state on the way');
    } finally {
      s.destroy();
    }
  }

  // 4503 paused: read-only, and no reconnect until the page is reloaded.
  {
    const server = fakeServer();
    const s = session(server, { current: 'token' }, { readOnlyRetryMs: 20 });
    try {
      const socket = await server.socket(0);
      socket.open();
      await socket.token();
      socket.serverClose(4503, 'paused');
      assert.deepEqual(s.statuses, ['read_only']);
      await delay(80);
      assert.equal(server.sockets.length, 1, 'a paused workspace is not asked again');
    } finally {
      s.destroy();
    }
  }
});

test('busy, crowded and live_off try again on the read-only interval; no_access and too_large stop', async () => {
  for (const [code, reason, status] of [[4429, 'busy', 'busy'], [4430, 'crowded', 'crowded'], [4503, 'live_off', 'live_off']] as const) {
    const server = fakeServer();
    const s = session(server, { current: 'token' }, { readOnlyRetryMs: 40 });
    try {
      const socket = await server.socket(0);
      socket.open();
      await socket.token();
      socket.serverClose(code, reason);
      assert.deepEqual(s.statuses, [status]);
      await delay(15);
      assert.equal(server.sockets.length, 1, `${status}: no reconnect before the interval`);
      const again = await server.socket(1);
      again.open();
      await again.token();
      assert.deepEqual(s.statuses, [status], `${status}: the read-only copy stays while it tries again`);
    } finally {
      s.destroy();
    }
  }
  for (const [code, status] of [[4403, 'no_access'], [4404, 'no_access'], [4413, 'too_large'], [1009, 'too_large']] as const) {
    const server = fakeServer();
    const s = session(server, { current: 'token' }, { readOnlyRetryMs: 20 });
    try {
      const socket = await server.socket(0);
      socket.open();
      await socket.token();
      socket.serverClose(code, '');
      assert.deepEqual(s.statuses, [status]);
      await delay(80);
      assert.equal(server.sockets.length, 1, `${status}: the client stops`);
    } finally {
      s.destroy();
    }
  }
});
