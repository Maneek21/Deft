/**
 * Live-editing test clients (plan Task F7): the real /collab server
 * (collab/server.ts) on an HTTP server of its own, next to the real
 * Socket.io server, and clients that connect to it:
 * - `connectCollab`: a Hocuspocus provider over the `ws` package, which
 *   records every close code and does not reconnect unless asked;
 * - `rawCollab`: a bare WebSocket, for crafted frames (`collabFrames`).
 * Tokens are real web sessions (createWebSession); `reissueToken` signs
 * another access token for the same session with a chosen lifetime, as a
 * refresh would.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { jsonToText, yDocToJson } from '@deft/doc-schema';
import { getCollabServer, type CollabServer } from '../../src/collab/server.js';
import { env } from '../../src/lib/env.js';
import { createWebSession } from '../../src/lib/web-sessions.js';
import { getIO, setupSocket } from '../../src/socket.js';
import type { DrivesFixture } from './drives-fixture.js';

export type CollabTestServer = {
  url: string;
  port: number;
  /** The collab server attached now. */
  readonly collab: CollabServer;
  /** After a shutdown test destroyed it: a new collab server, attached to the same HTTP server. */
  renew(): CollabServer;
  close(): Promise<void>;
};

/**
 * An HTTP server with Socket.io (setupSocket, real token checks) and the
 * collab server attached, as server.ts wires them. `url` is its /collab URL.
 * `close` destroys the collab server attached last.
 */
export async function startCollabTestServer(_f: DrivesFixture): Promise<CollabTestServer> {
  const server: Server = createServer();
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  setupSocket(server, { recordLastSeen: () => {} });
  let collab = getCollabServer();
  collab.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/collab`,
    port,
    get collab() { return collab; },
    renew() {
      collab = getCollabServer();
      collab.attach(server);
      return collab;
    },
    close: async () => {
      // A shutdown test may have left it rejected on purpose.
      await collab.destroy().catch(() => undefined);
      // Upgraded sockets aren't the HTTP server's to close; a socket still
      // finishing its close handshake would hold server.close() open.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => getIO()?.close(() => resolve()) ?? resolve());
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A web access token for `userId` in `orgId` from a new web session (or with `expiresInSeconds`, a shorter one for it). */
export async function tokenFor(userId: string, orgId: string, opts: { expiresInSeconds?: number } = {}): Promise<string> {
  const pair = await createWebSession({ id: userId, email: `${userId}@collab.test`, org_id: orgId });
  return opts.expiresInSeconds === undefined ? pair.accessToken : reissueToken(pair.accessToken, opts.expiresInSeconds);
}

/** Another access token for the same session as `token`, valid for `expiresInSeconds`. */
export function reissueToken(token: string, expiresInSeconds: number): string {
  const claims = jwt.decode(token) as { id: string; email: string; org_id: string; sid: string };
  return jwt.sign({ id: claims.id, email: claims.email, org_id: claims.org_id, sid: claims.sid, jti: randomUUID(), purpose: 'web-access' },
    env.JWT_SECRET, { algorithm: 'HS256', expiresIn: expiresInSeconds });
}

/** When a token expires, in milliseconds. */
export function tokenExpiry(token: string): number {
  return (jwt.decode(token) as { exp: number }).exp * 1000;
}

export type CloseInfo = { code: number; reason: string };

export type CollabTestClient = {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  ydoc: Y.Doc;
  /** True once authenticated read-only. */
  readonly readOnly: boolean;
  closes: CloseInfo[];
  /** How many times the socket opened. */
  readonly opens: number;
  waitAuthenticated(timeoutMs?: number): Promise<void>;
  waitSynced(timeoutMs?: number): Promise<void>;
  /** The first close at or after this call (or one already seen). */
  waitClosed(timeoutMs?: number): Promise<CloseInfo>;
  /** Appends a paragraph holding `text` (no block id) in one transaction. */
  typeText(text: string): void;
  /** The document as plain text. */
  text(): string;
  /** Drops the socket and stops reconnecting; changes made meanwhile wait in the provider. */
  offline(): void;
  /** Reconnects. */
  online(): void;
  destroy(): void;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

/** The plain text of a document's live state. */
export function ydocText(ydoc: Y.Doc): string {
  return jsonToText(yDocToJson(ydoc));
}

export function connectCollab(i: { url: string; documentId: string; token: string | (() => string); reconnect?: boolean }): CollabTestClient {
  const ydoc = new Y.Doc();
  const closes: CloseInfo[] = [];
  const closeWaiters: Array<(c: CloseInfo) => void> = [];
  let reconnect = i.reconnect ?? false;
  let opens = 0;
  let consumed = 0;
  const socket: HocuspocusProviderWebsocket = new HocuspocusProviderWebsocket({
    url: i.url,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    delay: 100, minDelay: 100, maxDelay: 300, jitter: false,
    onOpen: () => { opens += 1; },
    onClose: ({ event }: { event: { code: number; reason?: unknown } }) => {
      const info = { code: event.code, reason: String(event.reason ?? '') };
      closes.push(info);
      for (const waiter of closeWaiters.splice(0)) waiter(info);
      if (!reconnect) socket.disconnect();
    },
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `doc:${i.documentId}`,
    document: ydoc,
    token: i.token,
  });
  provider.attach();
  const client: CollabTestClient = {
    provider, socket, ydoc, closes,
    get readOnly() { return provider.authorizedScope === 'readonly'; },
    get opens() { return opens; },
    waitAuthenticated(timeoutMs = 5_000) {
      if (provider.isAuthenticated) return Promise.resolve();
      if (closes.length > 0) return Promise.reject(new Error(`closed ${closes[0]!.code} before authenticating`));
      return withTimeout(new Promise<void>((resolve, reject) => {
        provider.on('authenticated', () => resolve());
        closeWaiters.push((c) => reject(new Error(`closed ${c.code} before authenticating`)));
      }), timeoutMs, 'authenticated');
    },
    waitSynced(timeoutMs = 5_000) {
      if (provider.isSynced) return Promise.resolve();
      return withTimeout(new Promise<void>((resolve, reject) => {
        provider.on('synced', () => resolve());
        closeWaiters.push((c) => reject(new Error(`closed ${c.code} before syncing`)));
      }), timeoutMs, 'synced');
    },
    waitClosed(timeoutMs = 5_000) {
      if (closes.length > consumed) return Promise.resolve(closes[consumed++]!);
      return withTimeout(new Promise<CloseInfo>((resolve) => {
        closeWaiters.push((c) => { consumed = Math.max(consumed, closes.indexOf(c) + 1); resolve(c); });
      }), timeoutMs, 'closed');
    },
    typeText(text) {
      ydoc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        ydoc.getXmlFragment('default').push([paragraph]);
      });
    },
    text: () => ydocText(ydoc),
    offline() {
      reconnect = false;
      socket.disconnect();
    },
    online() {
      void socket.connect();
    },
    destroy() {
      reconnect = false;
      try { provider.destroy(); } catch { /* already gone */ }
      try { socket.destroy(); } catch { /* already gone */ }
    },
  };
  return client;
}

/** connectCollab, waiting until it is authenticated or closed: 'ok' or the close code. */
export async function connectOutcome(i: { url: string; documentId: string; token: string }): Promise<{ client: CollabTestClient; outcome: 'ok' | number }> {
  const client = connectCollab(i);
  const outcome = await withTimeout(new Promise<'ok' | number>((resolve) => {
    client.provider.on('authenticated', () => resolve('ok'));
    void client.waitClosed(5_000).then((c) => resolve(c.code), () => undefined);
  }), 5_000, 'authenticated or closed');
  return { client, outcome };
}

// ---------------------------------------------------------------------------
// Crafted frames (lib0's variable-length encoding, as Hocuspocus reads it)

function varUint(n: number): number[] {
  const out: number[] = [];
  let value = n;
  while (value > 0x7f) {
    out.push(0x80 | (value & 0x7f));
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

function concat(...parts: Array<number[] | Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const varBytes = (bytes: Uint8Array) => concat(varUint(bytes.length), bytes);
const varString = (s: string) => varBytes(new TextEncoder().encode(s));

export const collabFrames = {
  auth: (documentName: string, token: string) => concat(varString(documentName), [2], [0], varString(token)),
  update: (documentName: string, update: Uint8Array) => concat(varString(documentName), [0], [2], varBytes(update)),
  syncStep2: (documentName: string, update: Uint8Array) => concat(varString(documentName), [0], [1], varBytes(update)),
  /** An awareness frame (y-protocols' awareness update): each state under its client id and clock. */
  awareness: (documentName: string, states: Array<{ clientId: number; clock: number; state: unknown }>) => concat(varString(documentName), [1],
    varBytes(concat(varUint(states.length), ...states.flatMap((s) => [varUint(s.clientId), varUint(s.clock), varString(JSON.stringify(s.state))])))),
};

/** True when `frame` is Hocuspocus's Authenticated message. */
function isAuthenticated(frame: Uint8Array): boolean {
  let pos = 0;
  const read = () => {
    let num = 0;
    let mult = 1;
    for (;;) {
      const byte = frame[pos++]!;
      num += (byte & 0x7f) * mult;
      if (byte < 0x80) return num;
      mult *= 128;
    }
  };
  try {
    const nameLength = read();
    pos += nameLength;
    return read() === 2 && read() === 2;
  } catch {
    return false;
  }
}

export type RawCollab = {
  ws: WebSocket;
  /** True once the socket opened; false when the upgrade was refused. Fails after `timeoutMs`. */
  opened(timeoutMs?: number): Promise<boolean>;
  /** The close. Fails after `timeoutMs`. */
  closed(timeoutMs?: number): Promise<CloseInfo>;
  messages: Uint8Array[];
  send(bytes: Uint8Array | Buffer): void;
  /** Sends the auth frame and waits for Authenticated. */
  authenticate(documentName: string, token: string, timeoutMs?: number): Promise<void>;
};

export function rawCollab(url: string, opts: { origin?: string } = {}): RawCollab {
  const ws = new WebSocket(url, opts.origin ? { origin: opts.origin } : {});
  const messages: Uint8Array[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data: Buffer) => {
    messages.push(new Uint8Array(data));
    for (const fn of listeners) fn();
  });
  ws.on('error', () => { /* a refused upgrade ends the socket; `closed` reports it */ });
  const opened = new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('close', () => resolve(false));
  });
  const closed = new Promise<CloseInfo>((resolve) => ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
  return {
    ws, messages,
    opened: (timeoutMs = 5_000) => withTimeout(opened, timeoutMs, 'raw opened'),
    closed: (timeoutMs = 5_000) => withTimeout(closed, timeoutMs, 'raw closed'),
    send: (bytes) => ws.send(bytes),
    async authenticate(documentName, token, timeoutMs = 5_000) {
      assert.ok(await withTimeout(opened, timeoutMs, 'raw opened'), 'the socket opened');
      ws.send(collabFrames.auth(documentName, token));
      await withTimeout(new Promise<void>((resolve, reject) => {
        const check = () => { if (messages.some(isAuthenticated)) resolve(); };
        listeners.add(check);
        check();
        void closed.then((c) => reject(new Error(`closed ${c.code} before authenticating`)));
      }), timeoutMs, 'raw authenticated');
    },
  };
}

/** Polls `cond` every 25 ms until it holds, failing with `label` after `timeoutMs`. */
export async function pollUntil(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
