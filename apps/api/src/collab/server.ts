// The live-editing server (plan Task F7): Hocuspocus 4.9 at /collab inside
// the API process, on crossws's Node adapter (the one Hocuspocus's own Server
// uses). One WebSocket carries one document, `doc:<documentId>`.
//
// Upgrades. The HTTP server's `upgrade` listener leaves /socket.io/ to
// engine.io (socket.ts sets destroyUpgrade: false) and ends every other path
// but /collab. A /collab upgrade from a browser origin socketOriginAllowed
// refuses is ended too. A paused install (rule C6) or live editing turned off
// (DEFT_DOCUMENTS_LIVE=off) completes the handshake and closes with 4503,
// reason `paused` or `live_off`, so the editor can say why and read through
// REST instead.
//
// Connecting (onAuthenticate). Capacity is reserved first, synchronously,
// before anything awaits: a slot for a document not yet loaded (refused with
// 4429 while maxLoadedDocuments are loaded or reserved, or while the memory
// estimate is over the budget) and a connection slot (4430 for the one past
// maxConnectionsPerDocument). Then the token, the membership and the role
// (collab/auth.ts). The connection is then registered, so session
// revocations, access changes and the access fence find it; after that the
// session is verified once more (a revocation that landed in between told
// nobody this connection was there), the realtime generation captured before
// the token check must still hold (socket.ts's pattern; else 4401), and a
// role read before an access loss committed is read again. Any refusal
// releases what was reserved and closes the socket with its code. View and
// comment connect read-only.
//
// Every frame (beforeHandleMessage), before Hocuspocus applies it:
// - a token past its expiry closes the connection (4401). The client sends a
//   fresh token every 10 minutes (token sync, onTokenSync), which moves the
//   expiry; a connection that sends nothing is closed TOKEN_EXPIRY_GRACE_MS
//   after it. A revoked web session closes its connections (webSessionEvents);
// - the access fence (rule C3): each connection keeps the access generation
//   its role was read at. When currentAccessGeneration() has moved (an access
//   loss committed somewhere), the role is read again first: lost closes with
//   4403, changed with 4409 (the client reconnects with its new read-only
//   flag). The frame is never applied until the role is current;
// - the size cap on SyncStep2 and Update messages: below fastAcceptBelowBytes
//   (the approximate size plus the update) they pass; otherwise the update is
//   applied to a scratch copy and passes only if the result is within
//   docMaxBytes or no larger than before, so a document over the cap can
//   still shrink. A refusal closes with 4413 and the update is never applied.
// Frames over MAX_FRAME_BYTES are refused by the socket itself (1009), and an
// awareness state over AWARENESS_STATE_MAX_BYTES is dropped, not re-broadcast.
// A refusal here throws after closing, which is how Hocuspocus stops a frame
// (it logs one line with the connection and document ids).
//
// Access changes (closeForAccessChange, subscribed to onDocumentAccessChanged)
// read the role again for every connection the change can touch: the
// documents it names, or every loaded document of the workspace; only the
// people it names, when it names any. Lost closes with 4403, changed with 4409.
//
// Stores (collab/persistence.ts). Hocuspocus stores 2 s after the last change
// and at least every 10 s while changes keep coming: every store writes the
// live state and bumps the revision; derived copies (content_json,
// content_text, search_vector) are written at most once a minute, on unload
// and on shutdown. A failed store keeps the document loaded and is retried
// after 5 s, 30 s and then every 2 minutes. A document unloads
// unloadAfterMs after its last connection leaves, and only after a store
// that holds everything has succeeded.
//
// Writes that don't come from a socket go through writeDocument
// (lib/document-writer.ts, rule C2), which calls `write` here. A loaded
// document is written through its live copy: its pending live changes are
// stored first, then, in one transaction holding the document row FOR
// UPDATE, the caller's checks run, the change is made on a scratch copy and
// measured against the size cap, and the result is stored; the live copy
// takes the change only after that commits, so everyone connected sees it
// and a refused or failed write changes nothing. A document nobody has open
// is written from its row in the same way, under the load lock that a load
// waits for, so a load never reads the row from before a write. `write`
// locks only the document row (never a drive), so it can't wait in a cycle
// with a move or a delete, which lock the drive and then the document.
//
// Shutdown (destroy): new connections are refused and open ones closed (their
// clients keep any change not yet acknowledged and send it again when they
// reconnect), then flushPendingStores() and every remaining store is awaited.
//
// Logs are fixed text.
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crossws from 'crossws/adapters/node';
import type { Peer } from 'crossws';
import { Hocuspocus, type Document as HocuspocusDocument } from '@hocuspocus/server';
import * as Y from 'yjs';
import { db } from '../lib/db.js';
import { documentRoleFor } from '../lib/document-access.js';
import { currentAccessGeneration } from '../lib/document-access-change.js';
import { onDocumentAccessChanged, type DocumentAccessChange } from '../lib/document-access-events.js';
import { isPausedStart } from '../lib/paused-start.js';
import { socketOriginAllowed } from '../lib/web-origins.js';
import { verifyWebAccess, webSessionEvents } from '../lib/web-sessions.js';
import { captureRealtimeAccessGeneration, isRealtimeAccessGenerationCurrent } from '../socket.js';
import { authenticateCollab, canWrite, CollabRefusal, documentIdOf, type CollabContext } from './auth.js';
import {
  AWARENESS_STATE_MAX_BYTES, COLLAB_CLOSE, COLLAB_LIMITS, encodedStateBytes, fastAcceptBelowBytes, HEAP_FACTOR, liveEditingEnabled,
  MAX_FRAME_BYTES, TOKEN_EXPIRY_GRACE_MS, withinSizeCap, type CollabCloseCode,
} from './limits.js';
import {
  applyRowToDoc, deriveContent, lockDocumentState, markSizeWarning, readDocumentState, runStoredListeners, SYSTEM_ORIGIN, WRITER_ORIGIN,
  writeInitialState, writeStore, type DocumentStateRow, type DocumentStoredEvent, type JSONContent,
} from './persistence.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who makes a non-socket write: a person, an agent (Defty carries the person who asked), or the system. */
export type CollabActor = { kind: 'user' | 'agent' | 'system'; userId: string; askerId?: string; actionId?: string };

/** A non-socket write (collab/server.ts `write`; lib/document-writer.ts wraps it). */
export type CollabWriteInput<T> = {
  documentId: string;
  orgId: string;
  actor: CollabActor;
  mutate: (doc: Y.Doc) => T;
  /** Runs in the write's transaction with the document row locked FOR UPDATE; throw to refuse. */
  check?: (tx: Tx, row: DocumentStateRow) => Promise<void>;
};

/** Why `write` refused on its own account: the size cap, or no live document row. */
export class CollabWriteRefused extends Error {
  constructor(readonly reason: 'too_large' | 'missing') {
    super();
  }
}

export type CollabServer = {
  attach(server: HttpServer): void;
  /** writeDocument's helper (rule C2): checks no access. Everything else calls writeDocument. */
  withDocument<T>(documentId: string, orgId: string, actor: CollabActor, fn: (doc: Y.Doc) => T): Promise<T>;
  /** writeDocument's helper, with the caller's checks and the stored revision and size. */
  write<T>(i: CollabWriteInput<T>): Promise<{ value: T; revision: number; sizeBytes: number }>;
  connectedUserIds(documentId: string): string[];
  closeForAccessChange(change: DocumentAccessChange): Promise<void>;
  destroy(): Promise<void>;
};

/** Derived copies of a live document are written at most this often (and on unload and shutdown). */
const DERIVED_EVERY_MS = 60_000;
/** A failed store is retried after these delays, the last one repeating. */
const STORE_RETRY_MS = [5_000, 30_000, 120_000] as const;
/** The fence reads a role at most this many times for one frame before failing closed. */
const FENCE_ATTEMPTS = 5;

/** Context Hocuspocus carries for a connection: the socket's key, then the CollabContext from onAuthenticate. */
type HookContext = { socketKey: string } & Partial<CollabContext>;

type SocketEntry = {
  key: string;
  peer: Peer;
  client: ReturnType<Hocuspocus<HookContext>['handleConnection']>;
  closed: boolean;
  documentId: string | null;
  /** Holds one connection reservation on this document while set. */
  slot: DocSlot | null;
  ctx: CollabContext | null;
  /** The access generation `ctx.role` was read at. */
  accessGeneration: number;
  connected: boolean;
  expiryTimer: NodeJS.Timeout | null;
};

type DocSlot = {
  documentId: string;
  name: string;
  orgId: string | null;
  loaded: boolean;
  loading: Promise<void> | null;
  unloading: boolean;
  /** Sockets holding a connection reservation (authenticating or connected). */
  connections: number;
  /** Non-socket writes in progress. */
  writers: number;
  estimateBytes: number;
  approxBytes: number;
  revision: number;
  storedBytes: number;
  changeCounter: number;
  stateDirty: boolean;
  derivedDirty: boolean;
  /** changeCounter at a derive that failed (content outside the schema): not tried again until it moves. */
  deriveFailedAt: number | null;
  lastDerivedAt: number;
  lastDerivedJson: JSONContent | null;
  editors: Map<string, number>;
  lastEdit: { userId: string; at: Date } | null;
  emptySince: number | null;
  unloadTimer: NodeJS.Timeout | null;
  retryAttempt: number;
  retryTimer: NodeJS.Timeout | null;
  listenerChain: Promise<void>;
};

/** Thrown from beforeUnloadDocument to keep a document loaded. No message, so Hocuspocus logs nothing. */
const KEEP_LOADED = Object.freeze({ keep: true });
/** Thrown from onLoadDocument when the document can't be loaded. No message, so Hocuspocus logs nothing. */
const LOAD_REFUSED = Object.freeze({ reason: 'busy' });

/** A per-key async lock: callers with the same key run one at a time, in order. */
class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * The SyncStep2 or Update payload of a Hocuspocus frame (a document name,
 * then the message type; Sync and SyncReply carry a sync type and the update),
 * or null for any other frame. lib0's variable-length encoding.
 */
export function syncUpdateOf(frame: Uint8Array): Uint8Array | null {
  let pos = 0;
  const readVarUint = (): number => {
    let num = 0;
    let mult = 1;
    for (;;) {
      if (pos >= frame.length) throw new Error('truncated');
      const byte = frame[pos++]!;
      num += (byte & 0x7f) * mult;
      if (byte < 0x80) return num;
      mult *= 128;
      if (mult > 2 ** 53) throw new Error('too long');
    }
  };
  try {
    const nameLength = readVarUint();
    pos += nameLength;
    const type = readVarUint();
    if (type !== 0 && type !== 4) return null;
    const syncType = readVarUint();
    if (syncType !== 1 && syncType !== 2) return null;
    const length = readVarUint();
    if (pos + length > frame.length) return null;
    return frame.subarray(pos, pos + length);
  } catch {
    return null;
  }
}

function isOwnOrigin(origin: unknown): boolean {
  return origin === SYSTEM_ORIGIN || origin === WRITER_ORIGIN;
}

function socketKeyOfOrigin(origin: unknown): string | null {
  if (typeof origin !== 'object' || origin === null) return null;
  const o = origin as { source?: unknown; connection?: { context?: { socketKey?: unknown } } };
  if (o.source !== 'connection') return null;
  const key = o.connection?.context?.socketKey;
  return typeof key === 'string' ? key : null;
}

function pathOf(url: string | undefined): string {
  const raw = url ?? '/';
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
}

function createCollabServer(): CollabServer {
  const sockets = new Map<string, SocketEntry>();
  const peers = new WeakMap<Peer, SocketEntry>();
  const bySid = new Map<string, Set<SocketEntry>>();
  const docs = new Map<string, DocSlot>();
  const writerLocks = new KeyedLock();
  const loadLocks = new KeyedLock();
  const attached: Array<{ server: HttpServer; listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }> = [];
  let nextSocketKey = 0;
  let destroying = false;
  let destroyPromise: Promise<void> | null = null;

  // ---------------------------------------------------------------------
  // Capacity

  const memoryEstimate = () => {
    let total = 0;
    for (const slot of docs.values()) total += slot.estimateBytes;
    return total;
  };
  /** Until a document has loaded its size is unknown, so its slot counts the largest a document may be. */
  const provisionalEstimate = () => COLLAB_LIMITS.docMaxBytes * HEAP_FACTOR;

  function newSlot(documentId: string): DocSlot {
    return {
      documentId, name: `doc:${documentId}`, orgId: null, loaded: false, loading: null, unloading: false,
      connections: 0, writers: 0, estimateBytes: provisionalEstimate(), approxBytes: 0, revision: 0, storedBytes: 0,
      changeCounter: 0, stateDirty: false, derivedDirty: false, deriveFailedAt: null, lastDerivedAt: 0, lastDerivedJson: null,
      editors: new Map(), lastEdit: null, emptySince: null, unloadTimer: null, retryAttempt: 0, retryTimer: null,
      listenerChain: Promise.resolve(),
    };
  }

  /** Synchronously reserves a connection to `documentId` (and its document slot), or says which limit refuses it. */
  function reserveConnection(entry: SocketEntry, documentId: string): CollabCloseCode | null {
    let slot = docs.get(documentId);
    if (!slot) {
      if (docs.size >= COLLAB_LIMITS.maxLoadedDocuments || memoryEstimate() > COLLAB_LIMITS.memoryBudgetBytes) return 'busy';
      slot = newSlot(documentId);
      docs.set(documentId, slot);
      testState.peakDocuments = Math.max(testState.peakDocuments, docs.size);
    } else if (slot.connections >= COLLAB_LIMITS.maxConnectionsPerDocument) {
      return 'crowded';
    }
    slot.connections += 1;
    cancelUnload(slot);
    entry.slot = slot;
    entry.documentId = documentId;
    return null;
  }

  function releaseConnection(entry: SocketEntry): void {
    const slot = entry.slot;
    if (!slot) return;
    entry.slot = null;
    slot.connections -= 1;
    settleSlot(slot);
  }

  /** After a reservation or a writer leaves: free a slot that never loaded, or start the unload clock. */
  function settleSlot(slot: DocSlot): void {
    if (slot.connections > 0 || slot.writers > 0 || slot.loading) return;
    if (!slot.loaded) {
      if (docs.get(slot.documentId) === slot) docs.delete(slot.documentId);
      return;
    }
    scheduleUnload(slot);
  }

  function scheduleUnload(slot: DocSlot): void {
    if (slot.unloadTimer || destroying) return;
    slot.emptySince = Date.now();
    slot.unloadTimer = setTimeout(() => {
      slot.unloadTimer = null;
      void tryUnload(slot);
    }, COLLAB_LIMITS.unloadAfterMs);
    slot.unloadTimer.unref();
  }

  function cancelUnload(slot: DocSlot): void {
    if (slot.unloadTimer) clearTimeout(slot.unloadTimer);
    slot.unloadTimer = null;
    slot.emptySince = null;
  }

  async function tryUnload(slot: DocSlot): Promise<void> {
    const document = hocuspocus.documents.get(slot.name);
    if (!document || !slot.loaded) return;
    try {
      await hocuspocus.unloadDocument(document);
    } catch {
      console.error('[collab] unloading a document failed');
    }
  }

  const emptyLongEnough = (slot: DocSlot) => slot.connections === 0 && slot.writers === 0 && slot.emptySince !== null
    && Date.now() - slot.emptySince >= COLLAB_LIMITS.unloadAfterMs;

  // ---------------------------------------------------------------------
  // Connections

  /** Marks a connection closed and gives back what it held: its timer, its session entry, its reservation. */
  function retire(entry: SocketEntry): void {
    entry.closed = true;
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    if (entry.ctx) {
      const set = bySid.get(entry.ctx.sid);
      set?.delete(entry);
      if (set?.size === 0) bySid.delete(entry.ctx.sid);
    }
    releaseConnection(entry);
  }

  function closeEntry(entry: SocketEntry, code: CollabCloseCode | null): void {
    if (entry.closed) return;
    retire(entry);
    const closeCode = code ? COLLAB_CLOSE[code] : 1000;
    const reason = code === 'liveOff' ? 'live_off' : (code ?? 'closed');
    try {
      entry.peer.close(closeCode, reason);
    } catch {
      // The socket is already gone.
    }
    // Detaches the document connection at once, so nothing more is sent to
    // it or applied from it while the close handshake finishes.
    entry.client.handleClose({ code: closeCode, reason });
  }

  /** Closes the connection and throws what stops Hocuspocus applying the frame in hand. */
  function refuseFrame(entry: SocketEntry, code: CollabCloseCode): never {
    closeEntry(entry, code);
    throw Object.freeze({ code: COLLAB_CLOSE[code], reason: code });
  }

  function register(entry: SocketEntry, ctx: CollabContext, accessGeneration: number): void {
    entry.ctx = ctx;
    entry.accessGeneration = accessGeneration;
    let set = bySid.get(ctx.sid);
    if (!set) {
      set = new Set();
      bySid.set(ctx.sid, set);
    }
    set.add(entry);
  }

  function scheduleExpiry(entry: SocketEntry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    if (!entry.ctx) return;
    const delay = Math.max(0, entry.ctx.tokenExpiresAt + TOKEN_EXPIRY_GRACE_MS - Date.now());
    entry.expiryTimer = setTimeout(() => closeEntry(entry, 'unauthenticated'), delay);
    entry.expiryTimer.unref();
  }

  /**
   * Reads the role again while the access generation has moved since it was
   * last read, until it holds still. Returns the current role, or null when
   * it's gone; throws when it can't be read.
   */
  async function currentRole(entry: SocketEntry): Promise<{ role: CollabContext['role'] | null; generation: number } | 'unchanged'> {
    const ctx = entry.ctx!;
    if (entry.accessGeneration === currentAccessGeneration()) return 'unchanged';
    for (let attempt = 0; attempt < FENCE_ATTEMPTS; attempt += 1) {
      const generation = currentAccessGeneration();
      const role = await documentRoleFor(ctx.userId, ctx.orgId, entry.documentId!);
      if (generation === currentAccessGeneration()) return { role, generation };
    }
    throw new Error('access kept changing');
  }

  /** The access fence for a frame (rule C3): closes with 4403 or 4409 and throws when the role is no longer current. */
  async function fence(entry: SocketEntry): Promise<void> {
    let read: Awaited<ReturnType<typeof currentRole>>;
    try {
      read = await currentRole(entry);
    } catch {
      refuseFrame(entry, 'unauthenticated');
    }
    if (entry.closed) refuseFrame(entry, 'unauthenticated');
    if (read === 'unchanged') return;
    if (!read.role) refuseFrame(entry, 'forbidden');
    if (read.role !== entry.ctx!.role) refuseFrame(entry, 'roleChanged');
    entry.accessGeneration = Math.max(entry.accessGeneration, read.generation);
  }

  /** The size cap for a SyncStep2 or Update frame from a connection that can write. */
  function checkSize(entry: SocketEntry, document: Y.Doc, update: Uint8Array): void {
    const slot = entry.slot;
    if (!slot) refuseFrame(entry, 'unauthenticated');
    if (slot.approxBytes + update.byteLength < fastAcceptBelowBytes()) return;
    const before = Y.encodeStateAsUpdate(document);
    const scratch = new Y.Doc();
    let after: number;
    try {
      Y.applyUpdate(scratch, before);
      Y.applyUpdate(scratch, update);
      after = encodedStateBytes(scratch);
    } catch {
      refuseFrame(entry, 'tooLarge');
    } finally {
      scratch.destroy();
    }
    if (!withinSizeCap(before.byteLength, after)) refuseFrame(entry, 'tooLarge');
    // Hocuspocus is about to apply it; the update listener adds its length.
    slot.approxBytes = Math.max(0, after - update.byteLength);
  }

  // ---------------------------------------------------------------------
  // Stores

  function trackUpdate(slot: DocSlot, update: Uint8Array, origin: unknown): void {
    slot.approxBytes += update.byteLength;
    if (isOwnOrigin(origin)) return;
    slot.changeCounter += 1;
    slot.stateDirty = true;
    slot.derivedDirty = true;
    const key = socketKeyOfOrigin(origin);
    const entry = key ? sockets.get(key) : undefined;
    if (entry?.ctx) {
      slot.editors.set(entry.ctx.userId, (slot.editors.get(entry.ctx.userId) ?? 0) + 1);
      slot.lastEdit = { userId: entry.ctx.userId, at: new Date() };
    }
  }

  function takeEditors(slot: DocSlot): Map<string, number> {
    const editors = slot.editors;
    slot.editors = new Map();
    return editors;
  }

  function putEditorsBack(slot: DocSlot, editors: Map<string, number>): void {
    for (const [userId, count] of editors) slot.editors.set(userId, (slot.editors.get(userId) ?? 0) + count);
  }

  const byCount = (editors: Map<string, number>) => [...editors.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);

  function queueListeners(slot: DocSlot, event: DocumentStoredEvent): Promise<void> {
    slot.listenerChain = slot.listenerChain.then(() => runStoredListeners(event));
    return slot.listenerChain;
  }

  function scheduleRetry(slot: DocSlot): void {
    if (slot.retryTimer || destroying) return;
    const delay = STORE_RETRY_MS[Math.min(slot.retryAttempt, STORE_RETRY_MS.length - 1)]!;
    slot.retryAttempt += 1;
    slot.retryTimer = setTimeout(() => {
      slot.retryTimer = null;
      void (async () => {
        const document = hocuspocus.documents.get(slot.name);
        if (!document || !slot.loaded) return;
        const stored = await storeExclusive(slot, document, false);
        if (stored && emptyLongEnough(slot)) await tryUnload(slot);
      })();
    }, delay);
    slot.retryTimer.unref();
  }

  /**
   * Stores a loaded document while its saveMutex is held: the live state when
   * it changed, with derived copies when they are due (`forceDerived`: now,
   * if they're behind). Returns false when the write failed (a retry is
   * scheduled). Never throws.
   */
  async function storeLocked(slot: DocSlot, document: Y.Doc, forceDerived: boolean): Promise<boolean> {
    const deriveDue = slot.derivedDirty && slot.deriveFailedAt !== slot.changeCounter
      && (forceDerived || Date.now() - slot.lastDerivedAt >= DERIVED_EVERY_MS);
    if (!slot.stateDirty && !deriveDue) return true;
    const counter = slot.changeCounter;
    let derived: ReturnType<typeof deriveContent> | null = null;
    if (deriveDue) {
      try {
        derived = deriveContent(document);
      } catch {
        slot.deriveFailedAt = counter;
        console.error('[collab] a live document holds content outside the schema; its stored text was not updated');
      }
    }
    markSizeWarning(document, encodedStateBytes(document));
    const state = Y.encodeStateAsUpdate(document);
    const approxAtEncode = slot.approxBytes;
    const edit = slot.lastEdit;
    const editors = derived ? takeEditors(slot) : null;
    try {
      const revision = await writeStore(db, {
        documentId: slot.documentId, orgId: slot.orgId!, state, derived, editedBy: edit?.userId ?? null, editedAt: edit?.at ?? null,
      });
      if (revision === null) {
        // The row is gone: nothing can be stored, so nothing is kept back.
        slot.stateDirty = false;
        slot.derivedDirty = false;
        return true;
      }
      slot.revision = revision;
      slot.storedBytes = state.byteLength;
      slot.approxBytes = state.byteLength + Math.max(0, slot.approxBytes - approxAtEncode);
      slot.estimateBytes = state.byteLength * HEAP_FACTOR;
      if (slot.lastEdit === edit) slot.lastEdit = null;
      if (slot.changeCounter === counter) slot.stateDirty = false;
      if (slot.retryTimer) clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
      slot.retryAttempt = 0;
      if (derived) {
        const previousJson = slot.lastDerivedJson ?? derived.json;
        slot.lastDerivedJson = derived.json;
        slot.lastDerivedAt = Date.now();
        if (slot.changeCounter === counter) slot.derivedDirty = false;
        void queueListeners(slot, {
          orgId: slot.orgId!, documentId: slot.documentId, editorIds: byCount(editors!), agentUserIds: [], actionIds: [],
          previousJson, json: derived.json, sizeBytes: state.byteLength, at: new Date(),
        });
      }
      return true;
    } catch {
      console.error('[collab] storing a live document failed; it stays loaded and the store is retried');
      testState.storeFailures += 1;
      if (editors) putEditorsBack(slot, editors);
      scheduleRetry(slot);
      return false;
    }
  }

  function storeExclusive(slot: DocSlot, document: HocuspocusDocument, forceDerived: boolean): Promise<boolean> {
    return document.saveMutex.runExclusive(() => storeLocked(slot, document, forceDerived));
  }

  // ---------------------------------------------------------------------
  // Hocuspocus

  const entryOf = (context: { socketKey?: unknown } | undefined): SocketEntry | undefined =>
    typeof context?.socketKey === 'string' ? sockets.get(context.socketKey) : undefined;

  const hocuspocus = new Hocuspocus<HookContext>({
    name: 'deft-collab',
    quiet: true,
    debounce: 2000,
    maxDebounce: 10000,
    unloadImmediately: false,
    // One document per socket: a second pending document resets the socket.
    maxPendingDocuments: 1,

    async onAuthenticate(payload) {
      const entry = entryOf(payload.context);
      if (!entry || entry.closed) throw new CollabRefusal('unauthenticated');
      // A socket carries one document; another one on it is refused alone.
      if (entry.documentId !== null) throw new CollabRefusal('forbidden');
      const documentId = documentIdOf(payload.documentName);
      if (!documentId) {
        closeEntry(entry, 'notFound');
        throw new CollabRefusal('notFound');
      }
      const full = destroying ? 'busy' : reserveConnection(entry, documentId);
      if (full) {
        closeEntry(entry, full);
        throw new CollabRefusal(full);
      }
      const realtimeGeneration = captureRealtimeAccessGeneration();
      const accessGeneration = currentAccessGeneration();
      try {
        const ctx = await authenticateCollab({ token: payload.token, documentName: payload.documentName });
        await collabTestSeams.afterAuthenticate?.(documentId);
        if (entry.closed) throw new CollabRefusal('unauthenticated');
        register(entry, ctx, accessGeneration);
        try {
          await verifyWebAccess(payload.token);
        } catch {
          throw new CollabRefusal('unauthenticated');
        }
        if (!isRealtimeAccessGenerationCurrent(realtimeGeneration)) throw new CollabRefusal('unauthenticated');
        // Nothing is sent yet, so a role that changed meanwhile is simply taken.
        const read = await currentRole(entry);
        if (read !== 'unchanged') {
          if (!read.role) throw new CollabRefusal('forbidden');
          ctx.role = read.role;
          ctx.readOnly = !canWrite(read.role);
          entry.accessGeneration = read.generation;
        }
        if (entry.closed) throw new CollabRefusal('unauthenticated');
        payload.connectionConfig.readOnly = ctx.readOnly;
        scheduleExpiry(entry);
        return ctx;
      } catch (error) {
        const code: CollabCloseCode = error instanceof CollabRefusal ? error.code : 'busy';
        closeEntry(entry, code);
        throw new CollabRefusal(code);
      }
    },

    async connected(payload) {
      const entry = entryOf(payload.context);
      if (entry && !entry.closed) entry.connected = true;
    },

    async onTokenSync(payload) {
      const entry = entryOf(payload.context);
      const ctx = entry?.ctx;
      if (!entry || !ctx || entry.closed) return;
      try {
        const verified = await verifyWebAccess(payload.token);
        if (entry.closed) return;
        if (verified.id !== ctx.userId || verified.org_id !== ctx.orgId || verified.sid !== ctx.sid) {
          closeEntry(entry, 'unauthenticated');
          return;
        }
        ctx.tokenExpiresAt = verified.exp * 1000;
        scheduleExpiry(entry);
      } catch {
        closeEntry(entry, 'unauthenticated');
      }
    },

    async beforeHandleMessage(payload) {
      const entry = entryOf(payload.context);
      if (!entry || entry.closed || !entry.ctx) {
        if (entry) refuseFrame(entry, 'unauthenticated');
        throw Object.freeze({ code: COLLAB_CLOSE.unauthenticated, reason: 'unauthenticated' });
      }
      if (Date.now() >= entry.ctx.tokenExpiresAt) refuseFrame(entry, 'unauthenticated');
      await fence(entry);
      if (Date.now() >= entry.ctx.tokenExpiresAt) refuseFrame(entry, 'unauthenticated');
      if (payload.connection.readOnly) return;
      const update = syncUpdateOf(payload.update);
      if (update) checkSize(entry, payload.document, update);
    },

    async beforeHandleAwareness(payload) {
      for (const [clientId, state] of payload.states) {
        if (Buffer.byteLength(JSON.stringify(state ?? null)) > AWARENESS_STATE_MAX_BYTES) payload.states.delete(clientId);
      }
    },

    async onLoadDocument(payload) {
      const documentId = documentIdOf(payload.documentName);
      const orgId = payload.context.orgId;
      if (!documentId || !orgId) throw LOAD_REFUSED;
      let slot = docs.get(documentId);
      if (!slot) {
        slot = newSlot(documentId);
        docs.set(documentId, slot);
      }
      const loadingSlot = slot;
      Object.assign(loadingSlot, {
        orgId, loaded: false, unloading: false, approxBytes: 0, changeCounter: 0, stateDirty: false, derivedDirty: false,
        deriveFailedAt: null, lastDerivedAt: 0, lastDerivedJson: null, editors: new Map(), lastEdit: null,
        estimateBytes: provisionalEstimate(), retryAttempt: 0,
      });
      let finish!: () => void;
      loadingSlot.loading = new Promise<void>((resolve) => { finish = resolve; });
      const document = payload.document;
      try {
        const row = await loadLocks.run(documentId, async () => {
          const found = await readDocumentState(documentId, orgId);
          if (!found) return null;
          applyRowToDoc(document, found);
          if (!found.state) await writeInitialState(documentId, orgId, Y.encodeStateAsUpdate(document));
          return found;
        });
        if (!row) throw LOAD_REFUSED;
        markSizeWarning(document, encodedStateBytes(document));
        const bytes = encodedStateBytes(document);
        Object.assign(loadingSlot, {
          loaded: true, revision: row.revision, storedBytes: bytes, approxBytes: bytes, estimateBytes: bytes * HEAP_FACTOR,
          lastDerivedJson: row.json,
        });
        document.on('update', (update: Uint8Array, origin: unknown) => trackUpdate(loadingSlot, update, origin));
      } catch {
        loadingSlot.loading = null;
        finish();
        for (const entry of sockets.values()) if (entry.slot === loadingSlot) closeEntry(entry, 'busy');
        settleSlot(loadingSlot);
        throw LOAD_REFUSED;
      }
      loadingSlot.loading = null;
      finish();
      settleSlot(loadingSlot);
    },

    async onStoreDocument(payload) {
      const documentId = documentIdOf(payload.documentName);
      const slot = documentId ? docs.get(documentId) : undefined;
      if (!slot?.loaded) return;
      await storeLocked(slot, payload.document, false);
    },

    async onDisconnect(payload) {
      // The provider let go of its document but kept the socket: a socket
      // carries one document, so it closes too.
      const entry = entryOf(payload.context);
      if (entry && !entry.closed) closeEntry(entry, null);
    },

    async beforeUnloadDocument(payload) {
      const documentId = documentIdOf(payload.documentName);
      const slot = documentId ? docs.get(documentId) : undefined;
      if (!slot) return;
      if (destroying || !emptyLongEnough(slot)) throw KEEP_LOADED;
      const stored = await storeExclusive(slot, payload.document, true);
      if (!stored || slot.stateDirty || !emptyLongEnough(slot) || payload.document.getConnectionsCount() > 0) throw KEEP_LOADED;
      slot.unloading = true;
      // Hocuspocus can still keep it (a store scheduled meanwhile); then it stays loaded.
      setImmediate(() => {
        if (slot.unloading && hocuspocus.documents.get(slot.name) === payload.document) {
          slot.unloading = false;
          scheduleUnload(slot);
        }
      });
    },

    async afterUnloadDocument(payload) {
      const documentId = documentIdOf(payload.documentName);
      const slot = documentId ? docs.get(documentId) : undefined;
      if (!slot) return;
      slot.loaded = false;
      slot.unloading = false;
      cancelUnload(slot);
      if (slot.retryTimer) clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
      // Someone reserved it while it unloaded: it loads again for them.
      if (slot.connections > 0 || slot.writers > 0) slot.estimateBytes = provisionalEstimate();
      else if (docs.get(slot.documentId) === slot) docs.delete(slot.documentId);
    },
  });

  // ---------------------------------------------------------------------
  // Sockets

  const adapter = crossws({
    serverOptions: { maxPayload: MAX_FRAME_BYTES },
    hooks: {
      upgrade: () => ({ context: { refusal: isPausedStart() ? 'paused' : liveEditingEnabled() ? null : 'live_off' } }),
      open(peer) {
        const refusal = (peer.context as { refusal?: unknown }).refusal;
        if (typeof refusal === 'string') {
          peer.close(COLLAB_CLOSE.liveOff, refusal);
          return;
        }
        nextSocketKey += 1;
        const key = String(nextSocketKey);
        const client = hocuspocus.handleConnection(peer.websocket as WebSocket, peer.request as Request, { socketKey: key });
        const entry: SocketEntry = {
          key, peer, client, closed: false, documentId: null, slot: null, ctx: null, accessGeneration: 0, connected: false, expiryTimer: null,
        };
        sockets.set(key, entry);
        peers.set(peer, entry);
        (peer.websocket as { on?: (event: string, fn: () => void) => void }).on?.('pong', () => client.touch());
      },
      message(peer, message) {
        const entry = peers.get(peer);
        if (entry) entry.client.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        const entry = peers.get(peer);
        if (!entry) return;
        peers.delete(peer);
        entry.client.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' });
        if (!entry.closed) retire(entry);
        sockets.delete(entry.key);
      },
      error() {
        // The socket closes after an error (a frame over MAX_FRAME_BYTES
        // closes it with 1009); `close` cleans up.
      },
    },
  });

  // ---------------------------------------------------------------------
  // Access changes and revoked sessions

  async function closeForAccessChange(change: DocumentAccessChange): Promise<void> {
    const documentIds = change.documentIds ? new Set(change.documentIds) : null;
    const userIds = change.userIds ? new Set(change.userIds) : null;
    const groups = new Map<string, SocketEntry[]>();
    for (const entry of sockets.values()) {
      const ctx = entry.ctx;
      if (!ctx || entry.closed || ctx.orgId !== change.orgId) continue;
      if (documentIds && !documentIds.has(entry.documentId!)) continue;
      if (userIds && !userIds.has(ctx.userId)) continue;
      const key = `${ctx.userId}\u0000${entry.documentId}`;
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    for (const group of groups.values()) {
      const { userId, orgId } = group[0]!.ctx!;
      const generation = currentAccessGeneration();
      let role: CollabContext['role'] | null;
      try {
        role = await documentRoleFor(userId, orgId, group[0]!.documentId!);
      } catch {
        // Couldn't check: they reconnect, which checks again.
        for (const entry of group) closeEntry(entry, 'unauthenticated');
        continue;
      }
      const settled = generation === currentAccessGeneration();
      for (const entry of group) {
        if (entry.closed || !entry.ctx) continue;
        if (!role) closeEntry(entry, 'forbidden');
        else if (role !== entry.ctx.role) closeEntry(entry, 'roleChanged');
        else if (settled) entry.accessGeneration = Math.max(entry.accessGeneration, generation);
      }
    }
  }

  const unsubscribeAccess = onDocumentAccessChanged((change) => {
    void closeForAccessChange(change).catch(() => console.error('[collab] closing connections after an access change failed'));
  });
  const onRevoked = (sid: string) => {
    for (const entry of [...(bySid.get(sid) ?? [])]) closeEntry(entry, 'unauthenticated');
  };
  webSessionEvents.on('revoked', onRevoked);

  // ---------------------------------------------------------------------
  // Non-socket writes

  function storedEventOf(slot: { orgId: string; documentId: string }, actor: CollabActor, previousJson: JSONContent, json: JSONContent,
    sizeBytes: number): DocumentStoredEvent {
    return {
      orgId: slot.orgId, documentId: slot.documentId,
      editorIds: actor.kind === 'user' ? [actor.userId] : [],
      agentUserIds: actor.kind === 'agent' ? [actor.userId] : [],
      actionIds: actor.actionId ? [actor.actionId] : [],
      previousJson, json, sizeBytes, at: new Date(),
    };
  }

  const editorOf = (actor: CollabActor) => (actor.kind === 'system' ? null : actor.userId);

  /**
   * Inside the write's transaction: lock the row, run the caller's checks,
   * make the change on `doc` (a private copy), measure it and store it.
   */
  async function writeInTx<T>(tx: Tx, i: CollabWriteInput<T>, doc: Y.Doc | ((row: DocumentStateRow) => Y.Doc)) {
    const row = await lockDocumentState(tx, i.documentId, i.orgId);
    if (!row || row.isDeleted) throw new CollabWriteRefused('missing');
    await i.check?.(tx, row);
    const working = typeof doc === 'function' ? doc(row) : doc;
    const before = encodedStateBytes(working);
    const vector = Y.encodeStateVector(working);
    const value = i.mutate(working);
    const derived = deriveContent(working);
    const state = Y.encodeStateAsUpdate(working);
    if (!withinSizeCap(before, state.byteLength)) throw new CollabWriteRefused('too_large');
    const revision = await writeStore(tx, {
      documentId: i.documentId, orgId: i.orgId, state, derived, editedBy: editorOf(i.actor), editedAt: new Date(),
    });
    if (revision === null) throw new CollabWriteRefused('missing');
    return { row, value, derived, state, revision, delta: Y.encodeStateAsUpdate(working, vector) };
  }

  /** A loaded document: store its live changes, write through a scratch copy, then let the live copy take the change. */
  async function liveWrite<T>(slot: DocSlot, document: HocuspocusDocument, i: CollabWriteInput<T>) {
    slot.writers += 1;
    cancelUnload(slot);
    try {
      const result = await document.saveMutex.runExclusive(async () => {
        if (!(await storeLocked(slot, document, true))) throw new Error('the live changes could not be stored');
        const counter = slot.changeCounter;
        const previousJson = slot.lastDerivedJson;
        const scratch = new Y.Doc();
        try {
          Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document));
          const written = await db.transaction((tx) => writeInTx(tx, i, scratch));
          document.transact(() => Y.applyUpdate(document, written.delta), WRITER_ORIGIN);
          slot.revision = written.revision;
          slot.lastDerivedJson = written.derived.json;
          slot.lastDerivedAt = Date.now();
          if (slot.changeCounter === counter) {
            slot.stateDirty = false;
            slot.derivedDirty = false;
            slot.storedBytes = written.state.byteLength;
            slot.approxBytes = written.state.byteLength;
            slot.estimateBytes = written.state.byteLength * HEAP_FACTOR;
          }
          markSizeWarning(document, written.state.byteLength);
          return { written, previousJson: previousJson ?? written.row.json };
        } finally {
          scratch.destroy();
        }
      });
      const { written } = result;
      await queueListeners(slot, storedEventOf({ orgId: i.orgId, documentId: i.documentId }, i.actor, result.previousJson, written.derived.json,
        written.state.byteLength));
      return { value: written.value, revision: written.revision, sizeBytes: written.state.byteLength };
    } finally {
      slot.writers -= 1;
      settleSlot(slot);
    }
  }

  /** A document nobody has open: under the load lock, from its row, in one transaction. */
  async function rowWrite<T>(i: CollabWriteInput<T>) {
    let working: Y.Doc | null = null;
    try {
      const written = await db.transaction((tx) => writeInTx(tx, i, (row) => {
        working = new Y.Doc();
        applyRowToDoc(working, row);
        return working;
      }));
      await runStoredListeners(storedEventOf({ orgId: i.orgId, documentId: i.documentId }, i.actor, written.row.json, written.derived.json,
        written.state.byteLength));
      return { value: written.value, revision: written.revision, sizeBytes: written.state.byteLength };
    } finally {
      (working as Y.Doc | null)?.destroy();
    }
  }

  async function write<T>(i: CollabWriteInput<T>): Promise<{ value: T; revision: number; sizeBytes: number }> {
    return writerLocks.run(i.documentId, async () => {
      for (;;) {
        const slot = docs.get(i.documentId);
        if (slot?.unloading) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        if (slot?.loading) {
          await slot.loading;
          continue;
        }
        const document = slot?.loaded ? hocuspocus.documents.get(slot.name) : undefined;
        if (slot && document) return liveWrite(slot, document, i);
        if (slot?.loaded) {
          // Loaded a moment ago; Hocuspocus is still putting it in its map.
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        const outcome = await loadLocks.run(i.documentId, async () => {
          // A load that started meanwhile wins; write through it instead.
          const current = docs.get(i.documentId);
          if (current?.loading || current?.loaded) return null;
          return rowWrite(i);
        });
        if (outcome) return outcome;
      }
    });
  }

  // ---------------------------------------------------------------------

  const server: CollabServer = {
    attach(httpServer) {
      const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = pathOf(req.url);
        if (path.startsWith('/socket.io/')) return;
        if (path !== '/collab' || destroying || !socketOriginAllowed(req.headers.origin)) {
          socket.destroy();
          return;
        }
        adapter.handleUpgrade(req, socket, head).catch(() => socket.destroy());
      };
      httpServer.on('upgrade', listener);
      attached.push({ server: httpServer, listener });
    },

    async withDocument(documentId, orgId, actor, fn) {
      return (await write({ documentId, orgId, actor, mutate: fn })).value;
    },

    write,

    connectedUserIds(documentId) {
      const ids = new Set<string>();
      for (const entry of sockets.values()) {
        if (entry.connected && !entry.closed && entry.ctx && entry.documentId === documentId) ids.add(entry.ctx.userId);
      }
      return [...ids];
    },

    closeForAccessChange,

    destroy() {
      destroyPromise ??= (async () => {
        // From here the upgrade listener ends every /collab upgrade.
        destroying = true;
        for (const entry of [...sockets.values()]) closeEntry(entry, null);
        hocuspocus.flushPendingStores();
        await Promise.all([...docs.values()].map(async (slot) => {
          const document = hocuspocus.documents.get(slot.name);
          if (slot.loaded && document) await storeExclusive(slot, document, true);
          await slot.listenerChain;
        }));
        for (const slot of docs.values()) {
          cancelUnload(slot);
          if (slot.retryTimer) clearTimeout(slot.retryTimer);
          slot.retryTimer = null;
        }
        for (const { server: httpServer, listener } of attached) httpServer.off('upgrade', listener);
        unsubscribeAccess();
        webSessionEvents.off('revoked', onRevoked);
        for (const document of hocuspocus.documents.values()) document.destroy();
        hocuspocus.documents.clear();
        docs.clear();
        if (instance === server) instance = null;
      })();
      return destroyPromise;
    },
  };
  testHandles = { docs };
  return server;
}

let instance: CollabServer | null = null;

/** The process's live-editing server, created on first use. After destroy() the next call makes a new one. */
export function getCollabServer(): CollabServer {
  instance ??= createCollabServer();
  return instance;
}

/** Test seams: `afterAuthenticate` runs after a connection's role is read and before it is registered. */
export const collabTestSeams: { afterAuthenticate: ((documentId: string) => Promise<void>) | null } = { afterAuthenticate: null };

const testState = { peakDocuments: 0, storeFailures: 0 };
let testHandles: { docs: Map<string, DocSlot> } | null = null;

/** What the current server holds, for tests. */
export function collabStateForTest(): {
  loadedDocumentIds: string[]; reservedDocuments: number; peakDocuments: number; storeFailures: number; resetPeak(): void;
} {
  const docs = testHandles?.docs ?? new Map<string, DocSlot>();
  return {
    loadedDocumentIds: [...docs.values()].filter((slot) => slot.loaded).map((slot) => slot.documentId),
    reservedDocuments: docs.size,
    peakDocuments: testState.peakDocuments,
    storeFailures: testState.storeFailures,
    resetPeak: () => { testState.peakDocuments = docs.size; },
  };
}
