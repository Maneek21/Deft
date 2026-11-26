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
// Every incoming frame, at the adapter, before Hocuspocus sees it: a closed
// or draining connection's frame is dropped; an expired token closes the
// socket (4401); the frame's document address must be `doc:<id>` and the
// socket's one document (the first address it used), else the socket closes
// (4404, 4403). So nothing a client invents reaches Hocuspocus or its logs.
//
// Connecting (onAuthenticate). Capacity is reserved first, synchronously,
// before anything awaits: a slot for a document not yet loaded (refused with
// 4429 while maxLoadedDocuments are loaded or reserved, or while the memory
// estimate with this document's provisional share would pass the budget) and
// a connection slot (4430 for the one past maxConnectionsPerDocument). Then
// the token, the membership and the role (collab/auth.ts). The connection is
// then registered, so session revocations, access changes and the access
// fence find it; after that the session is verified once more (a revocation
// that landed in between told nobody this connection was there), the realtime
// generation captured before the token check must still hold (socket.ts's
// pattern; else 4401), and a role read before an access loss committed is
// read again. Any refusal releases what was reserved and closes the socket
// with its code. View and comment connect read-only. The socket closes
// exactly when its token expires, unless a token sync (onTokenSync, same
// person, workspace and session) moved the expiry.
//
// Every frame Hocuspocus is about to apply (beforeHandleMessage):
// - the expiry, again;
// - a SyncStep2 or Update from a connection that can write first takes the
//   document's writer lock, so it waits while a non-socket write is in
//   flight and holds the lock until Hocuspocus has applied it
//   (afterHandleMessage): it is measured against, and lands on, the state
//   after the write. Hocuspocus handles one connection's frames strictly in
//   order, awaiting this hook before the next;
// - the access fence (rule C3): each connection keeps the access generation
//   its role was read at. When currentAccessGeneration() has moved, or while
//   an access-loss barrier covers the document and person (between a commit
//   and its finishAccessLoss, lib/document-access-change.ts), the role is read
//   again from the database first: lost closes with 4403, changed with 4409
//   (the client reconnects with its new read-only flag);
// - the size cap on those updates: they pass at once while the estimate plus
//   the update's charge (its size, plus the most normalization can write
//   back for each struct it carries or live struct it deletes) stays below
//   fastAcceptBelowBytes; otherwise the update is applied to a scratch copy
//   of the live state with the server's own normalization (block ids, the
//   size warning), and passes only if the result is within docMaxBytes or no
//   larger than before, so a document over the cap can still shrink (4413).
//   The estimate is an upper bound on the normalized size, kept by one
//   accounting (collab/size-account.ts): the last exact normalized
//   measurement, plus the charge of every change admitted since, charged
//   when admitted (never when Yjs integrates it, which it may hold back). A
//   measurement re-bases only when it is exact (derived, nothing held back),
//   and only by what it covers;
// - last, the expiry once more, after all of that work: a frame that passes
//   it counts as received before the expiry. From the fence on nothing awaits.
// A refused frame closes the socket, detaches the connection and marks it
// read-only, so Hocuspocus applies nothing from it, and nothing more from its
// queue, and logs nothing. Frames over MAX_FRAME_BYTES are refused by the
// socket itself (1009). Awareness: each connection holds states for at most
// AWARENESS_CLIENTS_PER_CONNECTION client ids (the first it uses), and one
// frame carries at most AWARENESS_FRAME_MAX_BYTES of states, none over
// AWARENESS_STATE_MAX_BYTES; anything else is dropped, not applied or
// re-broadcast, and so is a removal of a state the connection doesn't hold.
//
// Access changes (closeForAccessChange, subscribed to onDocumentAccessChanged)
// read the role again for every connection the change can touch: the
// documents it names, or every loaded document of the workspace; only the
// people it names, when it names any. Lost closes with 4403, changed with 4409.
//
// Stores (collab/persistence.ts). Hocuspocus stores 2 s after the last change
// and at least every 10 s while changes keep coming: every store writes the
// live state and bumps the revision; derived copies (content_json,
// content_text, search_vector) are written at most once a minute, and when
// the minute ends with a change still underived (a derive timer is kept
// armed for that moment, and follows it when a write moves it), on unload
// and at shutdown. A document loaded with derived copies behind its live
// state is derived straight away. A failed store keeps the document loaded
// and is retried after 5 s, 30 s and then every 2 minutes; while it waits,
// no derive timer runs. When only the derived copies can't be written (a
// database limit on the text, say), the live state is stored alone, so it
// stays durable, and the derive is retried with the same backoff. A change
// Yjs only holds back (its structs wait for a missing clock) fires no update,
// yet it is marked changed when admitted, so it is stored too. A document
// unloads unloadAfterMs after its last connection leaves, once its live
// state is durably stored; derived copies that couldn't be made (content
// outside the schema) are logged and tried again by the next load.
//
// Writes that don't come from a socket go through writeDocument (rule C2),
// defined here because it is the only way in: the machinery behind it isn't
// exported. A write takes the document's writer lock first, so socket
// updates wait until it has applied. A loaded document is written through
// its live copy: its pending live changes are stored first; then one
// transaction holding the document row FOR UPDATE runs the checks, and only
// then is the change made (mutate) on a scratch copy, normalized, measured
// against the size cap and stored; only after that commits does the live
// copy take the change, so everyone connected sees it and a refused or
// failed write changes nothing. A document nobody has open is written from
// its row the same way, under the load lock a load waits for (so a load
// never reads the row from before a write), with its provisional memory
// reserved against the budget (BUSY when it would pass it). Writes, loads
// and stores of one document never overlap. A write's stored listeners run
// after it has released the writer lock (socket updates aren't held while
// they run, and a listener may write); writeDocument returns once they have
// run, except when called while a listener run it was started from is still
// in progress: that write's listeners run after the run. writeDocument locks only the
// document row (never a drive), so it can't wait in a cycle with a move or a
// delete, which lock the drive and then the document.
//
// Shutdown (destroy): admissions stop (upgrades ended, connecting refused,
// writes refused with BUSY) and incoming frames are dropped. Then passes run
// until one finds nothing loading and nothing changed: loads in flight finish
// and apply the frames buffered behind them, pending stores are flushed, and
// each document on its own has the frames it already took and the writes to
// it in progress finish and is stored durably, retried until the caller's
// deadline. Every wait is bounded by that deadline, so a hung frame, write
// or store holds up only its own document, and the others are still stored.
// Then connections close and documents are dropped. A document that still
// couldn't be stored is logged with its id and makes destroy() reject, so
// the process exits non-zero. Writes and stored-listener runs still running
// at the deadline are logged, abandoned, and make destroy() reject.
//
// Logs are fixed text (document ids only through logId). A named exception
// (the F7 consult): Hocuspocus's own console warnings, which `quiet` doesn't
// silence, print the document name, `doc:<uuid>`, and nothing a person wrote.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crossws from 'crossws/adapters/node';
import type { Peer } from 'crossws';
import { Hocuspocus, type Connection, type Document as HocuspocusDocument } from '@hocuspocus/server';
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { drives } from '@deft/db/documents';
import { users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { documentRoleFor, roleAtLeast, type DocRole } from '../lib/document-access.js';
import { accessLossBarrierCovers, currentAccessGeneration } from '../lib/document-access-change.js';
import { onDocumentAccessChanged, type DocumentAccessChange } from '../lib/document-access-events.js';
import { DEFTY_EMAIL } from '../lib/defty-identity.js';
import { logId } from '../lib/log-metadata.js';
import { isPausedStart } from '../lib/paused-start.js';
import { socketOriginAllowed } from '../lib/web-origins.js';
import { verifyWebAccess, webSessionEvents } from '../lib/web-sessions.js';
import { captureRealtimeAccessGeneration, isRealtimeAccessGenerationCurrent } from '../socket.js';
import { authenticateCollab, canWrite, CollabRefusal, documentIdOf, type CollabContext } from './auth.js';
import {
  AWARENESS_CLIENTS_PER_CONNECTION, AWARENESS_FRAME_MAX_BYTES, AWARENESS_STATE_MAX_BYTES, COLLAB_CLOSE, COLLAB_LIMITS, encodedStateBytes, HEAP_FACTOR,
  liveEditingEnabled,
  MAX_FRAME_BYTES, withinSizeCap, type CollabCloseCode,
} from './limits.js';
import {
  applyRowToDoc, deriveContent, derivedIsBehind, lockDocumentState, markSizeWarning, readDocumentState, runStoredListeners, SYSTEM_ORIGIN,
  WRITER_ORIGIN, writeInitialState, writeStore, type DocumentStateRow, type DocumentStoredEvent, type JSONContent,
} from './persistence.js';
import { boundFor, chargeFor, SizeAccount } from './size-account.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who makes a non-socket write: a person, an agent (Defty carries the person who asked), or the system. */
export type CollabActor = { kind: 'user' | 'agent' | 'system'; userId: string; askerId?: string; actionId?: string };

export type DocumentWriteReason = 'agent_edit' | 'suggestion' | 'restore' | 'import' | 'template' | 'move_fix';
/**
 * BUSY: live editing can't take the write now (its memory budget is spent, the server is shutting down, or a loaded
 * document didn't become live); try again later. INVALID_CONTENT: the
 * document holds content outside the schema, so its text can't be derived.
 */
export type DocumentWriteRefusalCode = 'FORBIDDEN' | 'REVISION_CHANGED' | 'TOO_LARGE' | 'INVALID_CONTENT' | 'BUSY';

const REFUSAL_MESSAGES: Record<DocumentWriteRefusalCode, string> = {
  FORBIDDEN: 'Not allowed to change this document',
  REVISION_CHANGED: 'The document changed since it was read',
  TOO_LARGE: 'The document would be too large',
  INVALID_CONTENT: 'The document holds content the editor does not support',
  BUSY: 'Live editing is busy; try again shortly',
};

export class DocumentWriteRefused extends Error {
  constructor(readonly code: DocumentWriteRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
  }
}

export type CollabServer = {
  attach(server: HttpServer): void;
  connectedUserIds(documentId: string): string[];
  closeForAccessChange(change: DocumentAccessChange): Promise<void>;
  /**
   * Shuts down (header). Stores are retried until `retryUntil` (epoch ms,
   * default 10 s from now); rejects when a changed document couldn't be stored.
   */
  destroy(options?: { retryUntil?: number }): Promise<void>;
};

/** A non-socket write, after writeDocument's argument checks. */
type WriteInput = {
  documentId: string;
  orgId: string;
  actor: CollabActor;
  mutate: (doc: Y.Doc) => void;
  /** Runs in the write's transaction with the document row locked FOR UPDATE; throws DocumentWriteRefused to refuse. */
  check: (tx: Tx, row: DocumentStateRow) => Promise<void>;
  /** Runs in the same transaction after the store, right before it commits; throws DocumentWriteRefused to refuse. */
  beforeCommit: (tx: Tx) => Promise<void>;
};
type WriteResult = { revision: number; sizeBytes: number };
/** A write that has applied, with its listener run (queued in order, awaited once the writer lock is released). */
type Written = { result: WriteResult; listeners: Promise<void> };

/**
 * The stored-listener run a piece of work was started from, if any. Async
 * work a listener starts carries the token after the run has ended, so a
 * write checks whether that run is still in progress: only then does it not
 * wait for its own listeners (they run after the run that is waiting for it).
 */
type ListenerRunToken = { running: boolean };
const listenerRun = new AsyncLocalStorage<ListenerRunToken>();

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
  /** The one document address this socket may use: the first valid one it sent. */
  address: string | null;
  documentId: string | null;
  /** Holds one connection reservation on this document while set. */
  slot: DocSlot | null;
  ctx: CollabContext | null;
  /** The access generation `ctx.role` was read at. */
  accessGeneration: number;
  connected: boolean;
  expiryTimer: NodeJS.Timeout | null;
  /** The awareness client ids this connection holds states for (AWARENESS_CLIENTS_PER_CONNECTION at most). */
  awarenessClients: Set<number>;
};

/**
 * An update frame admitted by the size cap, from its admission until
 * Hocuspocus has applied (or dropped) it: afterHandleMessage settles it, and
 * an exact scratch measurement re-bases the estimate only then.
 */
type Admission = {
  slot: DocSlot;
  account: SizeAccount;
  seq: number;
  measured: { bytes: number; covered: number } | null;
  /** What Yjs held back before the frame applied: a frame it only holds back still changes the state to store. */
  heldBack: readonly [Uint8Array | null, Uint8Array | null];
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
  /** A write's scratch copy of the live state, reserved while the write runs. */
  scratchBytes: number;
  /**
   * The size cap's accounting (collab/size-account.ts): an upper bound on the
   * encoded size the live state has once normalized (block ids written back,
   * as the next derive does). A new one at every load.
   */
  size: SizeAccount;
  revision: number;
  changeCounter: number;
  stateDirty: boolean;
  derivedDirty: boolean;
  /** changeCounter at a derive that failed (content outside the schema): not retried until it moves, except by a final store. */
  deriveFailedAt: number | null;
  lastDerivedAt: number;
  lastDerivedJson: JSONContent | null;
  editors: Map<string, number>;
  lastEdit: { userId: string; at: Date } | null;
  emptySince: number | null;
  unloadTimer: NodeJS.Timeout | null;
  retryAttempt: number;
  retryTimer: NodeJS.Timeout | null;
  deriveTimer: NodeJS.Timeout | null;
};

/**
 * How a store went: `failed`, the database write failed (the live state isn't
 * durable); `underived`, the live state was stored but derived copies that
 * were due couldn't be made (content outside the schema). An underived store
 * is durable: it doesn't block an unload or shutdown, and the next load
 * derives again.
 */
type StoreOutcome = 'ok' | 'failed' | 'underived';
/** `auto`: derived copies when due; `flush` and `final`: derived copies now if they're behind. */
type StoreMode = 'auto' | 'flush' | 'final';

/** Thrown from beforeUnloadDocument to keep a document loaded. No message, so Hocuspocus logs nothing. */
const KEEP_LOADED = Object.freeze({ keep: true });
/** Thrown from onLoadDocument when the document can't be loaded. No message, so Hocuspocus logs nothing. */
const LOAD_REFUSED = Object.freeze({ reason: 'busy' });

/** A per-key async lock: holders of the same key go one at a time, in order. */
class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  /** Waits for the key, then holds it until the returned release is called (once). */
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** A reader for lib0's variable-length encoding over `frame`. */
function frameReader(frame: Uint8Array) {
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
  return {
    readVarUint,
    skip(length: number) {
      pos += length;
      if (pos > frame.length) throw new Error('truncated');
    },
    bytes(length: number): Uint8Array {
      if (pos + length > frame.length) throw new Error('truncated');
      const out = frame.subarray(pos, pos + length);
      pos += length;
      return out;
    },
  };
}

/**
 * Decodes as lib0's readVarString does (lib0/string.js utf8TextDecoder):
 * fatal on bad UTF-8 and keeping a leading byte order mark, so the address
 * checked here is exactly the one Hocuspocus will read.
 */
const addressDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The document address a Hocuspocus frame starts with, or null when it has none (or an implausible one). */
export function frameAddressOf(frame: Uint8Array): string | null {
  try {
    const reader = frameReader(frame);
    const length = reader.readVarUint();
    if (length === 0 || length > 256) return null;
    return addressDecoder.decode(reader.bytes(length));
  } catch {
    return null;
  }
}

/**
 * The SyncStep2 or Update payload of a Hocuspocus frame (a document name,
 * then the message type; Sync and SyncReply carry a sync type and the update),
 * or null for any other frame.
 */
export function syncUpdateOf(frame: Uint8Array): Uint8Array | null {
  try {
    const reader = frameReader(frame);
    reader.skip(reader.readVarUint());
    const type = reader.readVarUint();
    if (type !== 0 && type !== 4) return null;
    const syncType = reader.readVarUint();
    if (syncType !== 1 && syncType !== 2) return null;
    return reader.bytes(reader.readVarUint());
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

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/** True when Yjs holds nothing back in `doc` (no structs or deletions waiting for a missing clock). */
const heldBackNothing = (doc: Y.Doc) => doc.store.pendingStructs === null && doc.store.pendingDs === null;

/**
 * Waits until every one of `work` has settled or the clock reaches `until`,
 * whichever is first. Returns the ones still running.
 */
async function settledBy<T>(work: Iterable<Promise<T>>, until: number): Promise<Set<Promise<T>>> {
  const running = new Set(work);
  const done = Promise.allSettled([...running].map((p) => p.then(() => { running.delete(p); }, () => { running.delete(p); })));
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, until - Date.now())); });
  await Promise.race([done, deadline]);
  clearTimeout(timer);
  return running;
}

/** The unchecked write machinery of each server, reachable only through writeDocument. */
const writers = new WeakMap<CollabServer, (i: WriteInput) => Promise<WriteResult>>();

function createCollabServer(): CollabServer {
  const sockets = new Map<string, SocketEntry>();
  const peers = new WeakMap<Peer, SocketEntry>();
  const bySid = new Map<string, Set<SocketEntry>>();
  const docs = new Map<string, DocSlot>();
  /** Per document: a write in flight, or a socket update being measured and applied. */
  const writerLocks = new KeyedLock();
  const loadLocks = new KeyedLock();
  /** The writer lock an update frame holds, by its connection, until afterHandleMessage. */
  const frameLocks = new WeakMap<Connection, () => void>();
  /** The update frame a connection has admitted, until afterHandleMessage settles it. */
  const admissions = new WeakMap<Connection, Admission>();
  /** Writes in progress (each includes its listener run), by the document they write. */
  const activeWrites = new Map<Promise<unknown>, string>();
  /** Per document: the tail of its stored-listener runs, which go one at a time in the order of their stores. */
  const listenerChains = new Map<string, Promise<void>>();
  const attached: Array<{ server: HttpServer; listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }> = [];
  let nextSocketKey = 0;
  let coldReservedBytes = 0;
  let destroying = false;
  let draining = false;
  let destroyPromise: Promise<void> | null = null;

  // ---------------------------------------------------------------------
  // Capacity

  /**
   * A document's share of the memory estimate. Loaded: its size at the last
   * store or load, or the size accounting's bound when changes applied since
   * have grown it (growth landing during a store isn't lost when that store
   * finishes), times HEAP_FACTOR, plus a write's scratch copy while one runs.
   */
  const slotMemory = (slot: DocSlot) =>
    (slot.loaded ? Math.max(slot.estimateBytes, slot.size.estimate * HEAP_FACTOR) : slot.estimateBytes) + slot.scratchBytes;
  const memoryEstimate = () => {
    let total = coldReservedBytes;
    for (const slot of docs.values()) total += slotMemory(slot);
    return total;
  };
  /** Until a document has loaded its size is unknown, so it counts the largest a document may be. */
  const provisionalEstimate = () => COLLAB_LIMITS.docMaxBytes * HEAP_FACTOR;
  const notePeak = () => {
    testState.peakDocuments = Math.max(testState.peakDocuments, docs.size);
    testState.peakReservedBytes = Math.max(testState.peakReservedBytes, memoryEstimate());
  };

  function newSlot(documentId: string): DocSlot {
    return {
      documentId, name: `doc:${documentId}`, orgId: null, loaded: false, loading: null, unloading: false,
      connections: 0, writers: 0, estimateBytes: provisionalEstimate(), scratchBytes: 0, size: new SizeAccount(0), revision: 0,
      changeCounter: 0, stateDirty: false, derivedDirty: false, deriveFailedAt: null, lastDerivedAt: 0, lastDerivedJson: null,
      editors: new Map(), lastEdit: null, emptySince: null, unloadTimer: null, retryAttempt: 0, retryTimer: null, deriveTimer: null,
    };
  }

  /** Synchronously reserves a connection to `documentId` (and its document slot), or says which limit refuses it. */
  function reserveConnection(entry: SocketEntry, documentId: string): CollabCloseCode | null {
    let slot = docs.get(documentId);
    if (!slot) {
      if (docs.size >= COLLAB_LIMITS.maxLoadedDocuments) return 'busy';
      if (memoryEstimate() + provisionalEstimate() > COLLAB_LIMITS.memoryBudgetBytes) return 'busy';
      slot = newSlot(documentId);
      docs.set(documentId, slot);
    } else if (slot.connections >= COLLAB_LIMITS.maxConnectionsPerDocument) {
      return 'crowded';
    }
    slot.connections += 1;
    cancelUnload(slot);
    entry.slot = slot;
    entry.documentId = documentId;
    notePeak();
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
    slot.emptySince ??= Date.now();
    slot.unloadTimer = setTimeout(() => {
      slot.unloadTimer = null;
      void tryUnload(slot);
    }, Math.max(0, slot.emptySince + COLLAB_LIMITS.unloadAfterMs - Date.now()));
    slot.unloadTimer.unref();
  }

  function cancelUnload(slot: DocSlot): void {
    if (slot.unloadTimer) clearTimeout(slot.unloadTimer);
    slot.unloadTimer = null;
    slot.emptySince = null;
  }

  function clearSlotTimers(slot: DocSlot): void {
    cancelUnload(slot);
    if (slot.retryTimer) clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
    if (slot.deriveTimer) clearTimeout(slot.deriveTimer);
    slot.deriveTimer = null;
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
    // Detaches the document connection at once, so nothing more is sent to it.
    entry.client.handleClose({ code: closeCode, reason });
  }

  /**
   * Refuses the frame in hand: closes the socket and marks its (now detached)
   * connection read-only, so Hocuspocus applies nothing from this frame or the
   * rest of its queue, and has nothing to log.
   */
  function dropFrame(entry: SocketEntry, connection: Connection, code: CollabCloseCode): false {
    closeEntry(entry, code);
    connection.readOnly = true;
    return false;
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

  /** Closes the socket exactly when its token expires (a token sync moves it). */
  function scheduleExpiry(entry: SocketEntry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    if (!entry.ctx) return;
    entry.expiryTimer = setTimeout(() => closeEntry(entry, 'unauthenticated'), Math.max(0, entry.ctx.tokenExpiresAt - Date.now()));
    entry.expiryTimer.unref();
  }

  const expired = (entry: SocketEntry) => entry.ctx !== null && Date.now() >= entry.ctx.tokenExpiresAt;

  /**
   * Reads the role again while the access generation has moved since it was
   * last read, or while an access-loss barrier covers it, until it holds still.
   * Returns the current role, or null when it's gone; throws when it can't be read.
   */
  async function currentRole(entry: SocketEntry): Promise<{ role: DocRole | null; generation: number } | 'unchanged'> {
    const ctx = entry.ctx!;
    const documentId = entry.documentId!;
    if (entry.accessGeneration === currentAccessGeneration() && !accessLossBarrierCovers(ctx.orgId, documentId, ctx.userId)) return 'unchanged';
    for (let attempt = 0; attempt < FENCE_ATTEMPTS; attempt += 1) {
      const generation = currentAccessGeneration();
      const role = await documentRoleFor(ctx.userId, ctx.orgId, documentId);
      if (generation === currentAccessGeneration()) return { role, generation };
    }
    throw new Error('access kept changing');
  }

  /** The access fence for a frame (rule C3): false (refused, 4403 or 4409) when the role is no longer what the connection holds. */
  async function fence(entry: SocketEntry, connection: Connection): Promise<boolean> {
    let read: Awaited<ReturnType<typeof currentRole>>;
    try {
      read = await currentRole(entry);
    } catch {
      return dropFrame(entry, connection, 'unauthenticated');
    }
    if (entry.closed) return dropFrame(entry, connection, 'unauthenticated');
    if (read === 'unchanged') return true;
    if (!read.role) return dropFrame(entry, connection, 'forbidden');
    if (read.role !== entry.ctx!.role) return dropFrame(entry, connection, 'roleChanged');
    entry.accessGeneration = Math.max(entry.accessGeneration, read.generation);
    return true;
  }

  /**
   * The encoded size `scratch` has once the server has normalized it (block
   * ids, the size warning). Exact only when it could be normalized: it
   * derived (no content outside the schema) and Yjs holds nothing back.
   * `bound` is an upper bound on its normalized size either way: the size
   * itself when exact, else boundFor (blocks still needing an id, structs
   * held back), so even a document that is never exact re-bases.
   */
  function normalizedBytes(scratch: Y.Doc): { bytes: number; exact: boolean; bound: number } {
    let derived = true;
    try {
      deriveContent(scratch);
    } catch {
      derived = false;
    }
    markSizeWarning(scratch, encodedStateBytes(scratch));
    const bytes = encodedStateBytes(scratch);
    const exact = derived && heldBackNothing(scratch);
    return { bytes, exact, bound: exact ? bytes : boundFor(scratch, bytes) };
  }

  /**
   * A scratch copy of `document`. It takes the live client id, so the
   * server's normalization of it encodes exactly as the live document's own
   * would (the same client, the same next clocks). Taken after the state is
   * applied: Yjs gives a document a new client id when an update it didn't
   * make carries structs under its own.
   */
  function scratchCopy(document: Y.Doc): Y.Doc {
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document));
    scratch.clientID = document.clientID;
    return scratch;
  }

  /** normalizedBytes of a scratch copy of `document` (the document is left as it is). */
  function normalizedCopyBytes(document: Y.Doc): { bytes: number; exact: boolean; bound: number } {
    const scratch = scratchCopy(document);
    try {
      return normalizedBytes(scratch);
    } finally {
      scratch.destroy();
    }
  }

  /**
   * The estimate a load starts from. A state stored by a derived store
   * (`mayHoldBlocksWithoutIds` false) with nothing held back is normalized:
   * its size is exact. Otherwise (built from the stored JSON, or stored
   * without a derive) it is measured normalized on a scratch copy, and starts
   * from that measurement's bound (exact, or boundFor when content outside
   * the schema or held-back structs keep it from being exact).
   */
  function loadedSize(document: Y.Doc, bytes: number, mayHoldBlocksWithoutIds: boolean): number {
    if (!mayHoldBlocksWithoutIds && heldBackNothing(document)) return bytes;
    return normalizedCopyBytes(document).bound;
  }

  /** What Yjs holds back in `doc` now: an admission compares it before and after its frame applies. */
  const heldBackOf = (doc: Y.Doc) => [doc.store.pendingStructs?.update ?? null, doc.store.pendingDs] as const;

  /**
   * The size cap for a SyncStep2 or Update frame from a connection that can
   * write: false when refused (4413). The caller holds the document's writer
   * lock, so the live state is the whole truth: no write is half done, and
   * every update admitted before has been applied. An admitted frame is
   * charged now (collab/size-account.ts) and settled by afterHandleMessage.
   */
  function checkSize(entry: SocketEntry, connection: Connection, document: Y.Doc, update: Uint8Array): boolean {
    const slot = entry.slot;
    if (!slot) return dropFrame(entry, connection, 'unauthenticated');
    const account = slot.size;
    // Its size, plus the most normalization can write back for each struct
    // it carries and each live struct it deletes. Decoded, not applied; a
    // frame that doesn't decode is refused as one that wouldn't apply.
    let charge: number;
    try {
      charge = chargeFor(update, document);
    } catch {
      return dropFrame(entry, connection, 'tooLarge');
    }
    const heldBack = heldBackOf(document);
    if (account.fitsFast(charge)) {
      admissions.set(connection, { slot, account, seq: account.admit(charge), measured: null, heldBack });
      return true;
    }
    let after: { bytes: number; exact: boolean; bound: number };
    let before = Infinity;
    let withUpdate: Y.Doc | null = null;
    try {
      // The copy carries what Yjs holds back too (encodeStateAsUpdate includes it).
      withUpdate = scratchCopy(document);
      Y.applyUpdate(withUpdate, update);
      after = normalizedBytes(withUpdate);
      // Over the cap, it may still pass by being no larger than before,
      // measured the same way.
      if (after.bytes > COLLAB_LIMITS.docMaxBytes) before = normalizedCopyBytes(document).bytes;
    } catch {
      return dropFrame(entry, connection, 'tooLarge');
    } finally {
      withUpdate?.destroy();
    }
    if (!withinSizeCap(before, after.bytes)) return dropFrame(entry, connection, 'tooLarge');
    const seq = account.admit(charge);
    // The measurement covers this frame and everything applied before it; its
    // bound (exact, or boundFor) re-bases the estimate once the frame has been applied.
    admissions.set(connection, { slot, account, seq, measured: { bytes: after.bound, covered: account.covered(seq) }, heldBack });
    return true;
  }

  // ---------------------------------------------------------------------
  // Stores

  /**
   * Who changed what, from the document's own `update` event. Not the size:
   * a change is charged when it is admitted (checkSize, a write's
   * reservation), because Yjs fires no event for structs it holds back.
   */
  function trackUpdate(slot: DocSlot, origin: unknown): void {
    // Server-made changes (block ids, the size warning, writes) are stored by whoever made them.
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

  /**
   * Queues the listener run for a document's stored event. Runs for one
   * document go one at a time, in the order they were queued; every caller
   * queues while it still holds what orders its stores (the save mutex, the
   * writer lock), so that is the order of the stores. Never rejects.
   */
  function queueListeners(documentId: string, event: DocumentStoredEvent): Promise<void> {
    const run = (listenerChains.get(documentId) ?? Promise.resolve()).then(async () => {
      const token: ListenerRunToken = { running: true };
      try {
        await listenerRun.run(token, () => runStoredListeners(event));
      } finally {
        token.running = false;
      }
    });
    listenerChains.set(documentId, run);
    void run.then(() => { if (listenerChains.get(documentId) === run) listenerChains.delete(documentId); });
    return run;
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
        const outcome = await storeExclusive(slot, document, 'auto');
        if (outcome === 'ok' && emptyLongEnough(slot)) await tryUnload(slot);
      })();
    }, delay);
    slot.retryTimer.unref();
  }

  /**
   * Keeps a derive timer armed for `lastDerivedAt + window` while derived
   * copies are behind: (re)armed after every store, a writer's included, so a
   * window that moved later is followed. The timer re-arms itself while work
   * is pending. Not while a failed store waits for its retry: the retry
   * keeps the 5 s / 30 s / 2 min backoff, and re-arms this once it succeeds.
   */
  function scheduleDerive(slot: DocSlot): void {
    if (slot.deriveTimer) clearTimeout(slot.deriveTimer);
    slot.deriveTimer = null;
    if (slot.retryTimer) return;
    if (destroying || !slot.loaded || !slot.derivedDirty || slot.deriveFailedAt === slot.changeCounter) return;
    slot.deriveTimer = setTimeout(() => {
      slot.deriveTimer = null;
      void (async () => {
        const document = hocuspocus.documents.get(slot.name);
        if (!document || !slot.loaded) return;
        await storeExclusive(slot, document, 'auto');
        scheduleDerive(slot);
      })();
    }, Math.max(0, slot.lastDerivedAt + collabTestSeams.derivedEveryMs - Date.now()));
    slot.deriveTimer.unref();
  }

  /**
   * Stores a loaded document while its saveMutex is held: the live state when
   * it changed, with derived copies as `mode` says. A failed write schedules a
   * retry. Never throws.
   */
  async function storeLocked(slot: DocSlot, document: Y.Doc, mode: StoreMode): Promise<StoreOutcome> {
    const windowPassed = Date.now() - slot.lastDerivedAt >= collabTestSeams.derivedEveryMs;
    // A derive that failed for this content isn't tried again until it changes.
    const deriveDue = slot.derivedDirty && slot.deriveFailedAt !== slot.changeCounter && (mode !== 'auto' || windowPassed);
    if (!slot.stateDirty && !deriveDue) {
      if (mode !== 'final' || !slot.derivedDirty) return 'ok';
      testState.underivedFinals += 1;
      return 'underived';
    }
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
    // A measurement of the admissions applied so far. A derived store wrote
    // every block id back, so, unless Yjs holds something back, it encodes
    // the normalized state: exact. Any other store (the state alone, a derive
    // that failed, structs held back) re-bases with boundFor. Frames admitted
    // while the row is written stay on top of it; a frame measured meanwhile
    // bounds the size more tightly, and that bound stands.
    const account = slot.size;
    const measured = {
      bytes: derived && heldBackNothing(document) ? state.byteLength : boundFor(document, state.byteLength),
      covered: account.covered(),
    };
    const edit = slot.lastEdit;
    const editors = derived ? takeEditors(slot) : null;
    const write = (withDerived: boolean) => writeStore(db, {
      documentId: slot.documentId, orgId: slot.orgId!, state, derived: withDerived ? derived : null,
      editedBy: edit?.userId ?? null, editedAt: edit?.at ?? null,
    });
    let revision: number | null;
    let derivedStored = derived !== null;
    try {
      try {
        revision = await write(derivedStored);
      } catch (error) {
        if (!derivedStored) throw error;
        // The derived copies couldn't be written (a database limit on the
        // text, say): the live state is stored alone so it stays durable, and
        // the derive is retried with the store backoff.
        revision = await write(false);
        derivedStored = false;
        console.error('[collab] storing the derived copies of a live document failed; its live state was stored alone and the derive is retried');
        testState.derivedFallbacks += 1;
      }
    } catch {
      console.error('[collab] storing a live document failed; it stays loaded and the store is retried');
      testState.storeFailures += 1;
      if (editors) putEditorsBack(slot, editors);
      scheduleRetry(slot);
      return 'failed';
    }
    if (revision === null) {
      // The row is gone: nothing can be stored, so nothing is kept back.
      slot.stateDirty = false;
      slot.derivedDirty = false;
      return 'ok';
    }
    slot.revision = revision;
    account.rebase(measured.bytes, measured.covered);
    slot.estimateBytes = state.byteLength * HEAP_FACTOR;
    if (slot.lastEdit === edit) slot.lastEdit = null;
    if (slot.changeCounter === counter) slot.stateDirty = false;
    if (derived && !derivedStored) {
      // Durable, but its derived copies are still behind: retried with the backoff.
      putEditorsBack(slot, editors!);
      scheduleRetry(slot);
    } else {
      if (slot.retryTimer) clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
      slot.retryAttempt = 0;
    }
    if (derived && derivedStored) {
      const previousJson = slot.lastDerivedJson ?? derived.json;
      slot.lastDerivedJson = derived.json;
      slot.lastDerivedAt = Date.now();
      if (slot.changeCounter === counter) slot.derivedDirty = false;
      void queueListeners(slot.documentId, {
        orgId: slot.orgId!, documentId: slot.documentId, editorIds: byCount(editors!), agentUserIds: [], actionIds: [],
        previousJson, json: derived.json, sizeBytes: state.byteLength, at: new Date(),
      });
    }
    scheduleDerive(slot);
    if (mode === 'final' && slot.derivedDirty && !derivedStored) {
      testState.underivedFinals += 1;
      return 'underived';
    }
    return 'ok';
  }

  function storeExclusive(slot: DocSlot, document: HocuspocusDocument, mode: StoreMode): Promise<StoreOutcome> {
    return document.saveMutex.runExclusive(() => storeLocked(slot, document, mode));
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
    // One document per socket (the adapter also refuses any other address).
    maxPendingDocuments: 1,

    async onAuthenticate(payload) {
      const entry = entryOf(payload.context);
      if (!entry || entry.closed) throw new CollabRefusal('unauthenticated');
      // A socket carries one document; asking for it again on it is refused alone.
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
        if (destroying) throw new CollabRefusal('busy');
        if (entry.closed || expired(entry)) throw new CollabRefusal('unauthenticated');
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
      const { connection } = payload;
      const entry = entryOf(payload.context);
      if (!entry || entry.closed || !entry.ctx) {
        if (entry) closeEntry(entry, 'unauthenticated');
        connection.readOnly = true;
        return;
      }
      try {
        if (expired(entry)) return void dropFrame(entry, connection, 'unauthenticated');
        // An update waits while a write to the document is in flight (the
        // writer lock, taken before the writer stores pending changes), and
        // holds the lock until Hocuspocus has applied it (afterHandleMessage),
        // so it is measured against, and lands on, the state after the write.
        // Hocuspocus handles one connection's frames strictly in order
        // (Connection.processMessages awaits this hook before the next).
        const update = connection.readOnly ? null : syncUpdateOf(payload.update);
        if (update) frameLocks.set(connection, await writerLocks.acquire(entry.documentId!));
        if (!(await fence(entry, connection))) return;
        // From here to Hocuspocus applying the frame, nothing awaits.
        if (update && !connection.readOnly) {
          if (!checkSize(entry, connection, payload.document, update)) return;
          collabTestSeams.afterSizeCheck?.();
        }
        // Last: a frame that passes this counts as received before the expiry.
        if (expired(entry)) return void dropFrame(entry, connection, 'unauthenticated');
      } catch {
        // Never leave the frame applicable after a failure here (afterHandleMessage
        // releases the lock and gives back any admission: the connection is read-only).
        dropFrame(entry, connection, 'unauthenticated');
      }
    },

    async afterHandleMessage(payload) {
      // Runs after every frame beforeHandleMessage let through or dropped,
      // after Hocuspocus applied it (or didn't: a dropped frame's connection
      // is read-only, and Hocuspocus applies nothing from it).
      const { connection } = payload;
      const admitted = admissions.get(connection);
      admissions.delete(connection);
      if (admitted) {
        // Settled before the writer lock is let go, so the next frame's measurement sees it applied.
        const applied = !connection.readOnly;
        admitted.account.settle(admitted.seq, applied);
        // The reconcile: the frame was measured with the state it landed on
        // (nothing else applied in between: it held the writer lock).
        if (applied && admitted.measured) admitted.account.rebase(admitted.measured.bytes, admitted.measured.covered);
        // A frame Yjs only holds back fires no `update` event, yet it changed
        // the state to store (encodeStateAsUpdate includes what is held back),
        // and Hocuspocus acknowledged it: mark it, so a store doesn't skip it.
        const [structs, deletions] = heldBackOf(payload.document);
        if (applied && admitted.slot.loaded && (structs !== admitted.heldBack[0] || deletions !== admitted.heldBack[1])) {
          admitted.slot.changeCounter += 1;
          admitted.slot.stateDirty = true;
        }
      }
      frameLocks.get(connection)?.();
      frameLocks.delete(connection);
    },

    async beforeHandleAwareness(payload) {
      // Each connection may hold awareness states for AWARENESS_CLIENTS_PER_CONNECTION
      // client ids, the first it uses, and send at most AWARENESS_FRAME_MAX_BYTES of
      // states in one frame; every other state, and every removal of a state it
      // doesn't hold, is dropped (not applied, not re-broadcast).
      const entry = entryOf(payload.context);
      if (!entry || entry.closed) {
        payload.states.clear();
        payload.removedClients.clear();
        return;
      }
      let frameBytes = 0;
      for (const [clientId, state] of payload.states) {
        const bytes = Buffer.byteLength(JSON.stringify(state ?? null));
        const owned = entry.awarenessClients.has(clientId)
          || (entry.awarenessClients.size < AWARENESS_CLIENTS_PER_CONNECTION && Boolean(entry.awarenessClients.add(clientId)));
        if (!owned || bytes > AWARENESS_STATE_MAX_BYTES || frameBytes + bytes > AWARENESS_FRAME_MAX_BYTES) {
          payload.states.delete(clientId);
          continue;
        }
        frameBytes += bytes;
      }
      for (const clientId of payload.removedClients) if (!entry.awarenessClients.has(clientId)) payload.removedClients.delete(clientId);
    },

    async onLoadDocument(payload) {
      const documentId = documentIdOf(payload.documentName);
      const orgId = payload.context.orgId;
      const slot = documentId ? docs.get(documentId) : undefined;
      // A load always has a connection's reservation behind it.
      if (!documentId || !orgId || !slot || slot.connections === 0 || slot.loaded || slot.loading) {
        if (slot) for (const entry of sockets.values()) if (entry.slot === slot && !entry.connected) closeEntry(entry, 'busy');
        throw LOAD_REFUSED;
      }
      Object.assign(slot, {
        orgId, unloading: false, size: new SizeAccount(0), changeCounter: 0, stateDirty: false, derivedDirty: false, deriveFailedAt: null,
        lastDerivedAt: 0, lastDerivedJson: null, editors: new Map(), lastEdit: null, estimateBytes: provisionalEstimate(), retryAttempt: 0,
      });
      let finish!: () => void;
      slot.loading = new Promise<void>((resolve) => { finish = resolve; });
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
        // Stored by a store of ydoc_state alone: derived straight away.
        const derivedDirty = row.state !== null && derivedIsBehind(document, row.json);
        Object.assign(slot, {
          loaded: true, revision: row.revision, estimateBytes: bytes * HEAP_FACTOR, lastDerivedJson: row.json, derivedDirty,
          size: new SizeAccount(loadedSize(document, bytes, row.state === null || derivedDirty)),
        });
        document.on('update', (_update: Uint8Array, origin: unknown) => trackUpdate(slot, origin));
      } catch {
        slot.loading = null;
        finish();
        for (const entry of sockets.values()) if (entry.slot === slot) closeEntry(entry, 'busy');
        settleSlot(slot);
        throw LOAD_REFUSED;
      }
      slot.loading = null;
      finish();
      scheduleDerive(slot);
      settleSlot(slot);
    },

    async onStoreDocument(payload) {
      const documentId = documentIdOf(payload.documentName);
      const slot = documentId ? docs.get(documentId) : undefined;
      if (!slot?.loaded) return;
      await storeLocked(slot, payload.document, 'auto');
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
      const outcome = await storeExclusive(slot, payload.document, 'final');
      // Durable is enough: derived copies that couldn't be made are retried by
      // the next load (it finds them behind), so they don't hold the slot.
      if (outcome === 'failed' || slot.stateDirty || !emptyLongEnough(slot) || payload.document.getConnectionsCount() > 0) {
        throw KEEP_LOADED;
      }
      if (outcome === 'underived') console.error('[collab] unloaded a document whose text could not be updated; the next load tries again');
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
      clearSlotTimers(slot);
      // Someone reserved it while it unloaded: it loads again for them.
      if (slot.connections > 0 || slot.writers > 0) slot.estimateBytes = provisionalEstimate();
      else if (docs.get(slot.documentId) === slot) docs.delete(slot.documentId);
    },
  });

  // ---------------------------------------------------------------------
  // Sockets

  /** Every frame, before Hocuspocus: false when it was dropped (and the socket closed where the frame was wrong). */
  function admitFrame(entry: SocketEntry, frame: Uint8Array): boolean {
    if (entry.closed || draining) return false;
    if (expired(entry)) {
      closeEntry(entry, 'unauthenticated');
      return false;
    }
    const address = frameAddressOf(frame);
    if (!address || !documentIdOf(address)) {
      closeEntry(entry, 'notFound');
      return false;
    }
    if (entry.address === null) entry.address = address;
    else if (address !== entry.address) {
      closeEntry(entry, 'forbidden');
      return false;
    }
    return true;
  }

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
          key, peer, client, closed: false, address: null, documentId: null, slot: null, ctx: null, accessGeneration: 0, connected: false,
          expiryTimer: null, awarenessClients: new Set(),
        };
        sockets.set(key, entry);
        peers.set(peer, entry);
        (peer.websocket as { on?: (event: string, fn: () => void) => void }).on?.('pong', () => client.touch());
      },
      message(peer, message) {
        const entry = peers.get(peer);
        if (!entry) return;
        const frame = message.uint8Array();
        if (admitFrame(entry, frame)) entry.client.handleMessage(frame);
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
      let role: DocRole | null;
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
  // Non-socket writes (only through writeDocument)

  /**
   * A write's listener event (the onDocumentStored contract): everyone
   * accumulated since the previous run, taken together with the derived
   * state, plus the writer.
   */
  function storedEventOf(i: WriteInput, accumulated: Map<string, number>, previousJson: JSONContent, json: JSONContent,
    sizeBytes: number): DocumentStoredEvent {
    const editors = new Map(accumulated);
    if (i.actor.kind === 'user') editors.set(i.actor.userId, (editors.get(i.actor.userId) ?? 0) + 1);
    return {
      orgId: i.orgId, documentId: i.documentId,
      editorIds: byCount(editors),
      agentUserIds: i.actor.kind === 'agent' ? [i.actor.userId] : [],
      actionIds: i.actor.actionId ? [i.actor.actionId] : [],
      previousJson, json, sizeBytes, at: new Date(),
    };
  }

  const editorOf = (actor: CollabActor) => (actor.kind === 'system' ? null : actor.userId);

  /**
   * In `tx`: locks the row and runs the checks first; only then makes the
   * change on `working` (mutate), normalizes and measures it, and stores it,
   * then runs the pre-commit check. The size cap compares with the copy as
   * it was, measured normalized too (normalizedBytes); the delta to apply
   * live starts before that measurement, so it carries the ids it wrote.
   * `reserve` runs right after the measurement, with nothing awaited since
   * the copy was taken, and before the store. Content outside the schema is
   * refused INVALID_CONTENT. Returns what to apply live, and `bound`, an
   * upper bound on the result's normalized size (its size when exact).
   */
  async function changeInTx(tx: Tx, i: WriteInput, working: Y.Doc | ((row: DocumentStateRow) => Y.Doc),
    reserve?: (delta: Uint8Array) => void) {
    const row = await lockDocumentState(tx, i.documentId, i.orgId);
    if (!row || row.isDeleted) throw new DocumentWriteRefused('FORBIDDEN');
    await i.check(tx, row);
    const doc = typeof working === 'function' ? working(row) : working;
    const vector = Y.encodeStateVector(doc);
    const beforeBytes = normalizedBytes(doc).bytes;
    i.mutate(doc);
    let derived: ReturnType<typeof deriveContent>;
    try {
      derived = deriveContent(doc);
    } catch {
      throw new DocumentWriteRefused('INVALID_CONTENT');
    }
    markSizeWarning(doc, encodedStateBytes(doc));
    const state = Y.encodeStateAsUpdate(doc);
    if (!withinSizeCap(beforeBytes, state.byteLength)) throw new DocumentWriteRefused('TOO_LARGE');
    const delta = Y.encodeStateAsUpdate(doc, vector);
    const bound = heldBackNothing(doc) ? state.byteLength : boundFor(doc, state.byteLength);
    reserve?.(delta);
    const revision = await writeStore(tx, {
      documentId: i.documentId, orgId: i.orgId, state, derived, editedBy: editorOf(i.actor), editedAt: new Date(),
    });
    if (revision === null) throw new DocumentWriteRefused('FORBIDDEN');
    await i.beforeCommit(tx);
    return { row, derived, state, revision, delta, bound };
  }

  /**
   * A loaded document. The caller holds the document's writer lock, so socket
   * updates wait (beforeHandleMessage) until this has applied: the live state
   * holds still from the flush to the apply. Stores pending live changes,
   * then checks, changes a scratch copy, stores it, and applies it live
   * after the commit. Queues its listener run, which the caller awaits once
   * the writer lock is released.
   */
  async function liveWrite(slot: DocSlot, document: HocuspocusDocument, i: WriteInput): Promise<Written> {
    slot.writers += 1;
    cancelUnload(slot);
    try {
      const result = await document.saveMutex.runExclusive(async () => {
        if ((await storeLocked(slot, document, 'flush')) === 'failed') throw new Error('the live changes could not be stored');
        const previousJson = slot.lastDerivedJson;
        const counter = slot.changeCounter;
        const account = slot.size;
        const scratch = new Y.Doc();
        // The scratch copy is a second copy of the document in memory while the write runs.
        slot.scratchBytes = account.estimate * HEAP_FACTOR;
        // The reservation: the write's change is admitted (charged as its
        // delta against the live document) as soon as it is measured, before
        // its store is awaited; a write that then fails gives it back.
        // Sequence numbers start at 1, so 0 is none yet.
        const reservation = { seq: 0, covered: 0 };
        try {
          let written: Awaited<ReturnType<typeof changeInTx>>;
          try {
            written = await db.transaction((tx) => changeInTx(tx, i, () => {
              Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document));
              return scratch;
            }, (delta) => {
              reservation.seq = account.admit(chargeFor(delta, document));
              reservation.covered = account.covered(reservation.seq);
            }));
          } catch (error) {
            if (reservation.seq > 0) account.settle(reservation.seq, false);
            throw error;
          }
          document.transact(() => Y.applyUpdate(document, written.delta), WRITER_ORIGIN);
          // The reconcile: the write normalized the whole copy it applied
          // (block ids written back), so its size, exact unless Yjs holds
          // something back (then boundFor), bounds the state covering the reservation.
          account.settle(reservation.seq);
          account.rebase(written.bound, reservation.covered);
          slot.revision = written.revision;
          slot.lastDerivedJson = written.derived.json;
          slot.lastDerivedAt = Date.now();
          if (slot.changeCounter === counter) {
            slot.stateDirty = false;
            slot.derivedDirty = false;
            slot.estimateBytes = written.state.byteLength * HEAP_FACTOR;
          }
          return { written, accumulated: takeEditors(slot), previousJson: previousJson ?? written.row.json };
        } finally {
          scratch.destroy();
          slot.scratchBytes = 0;
        }
      });
      const { written } = result;
      scheduleDerive(slot);
      return {
        result: { revision: written.revision, sizeBytes: written.state.byteLength },
        listeners: queueListeners(i.documentId, storedEventOf(i, result.accumulated, result.previousJson, written.derived.json, written.state.byteLength)),
      };
    } finally {
      slot.writers -= 1;
      settleSlot(slot);
    }
  }

  /** A document nobody has open: from its row, in one transaction, under the load lock. Queues its listener run. */
  async function rowWrite(i: WriteInput): Promise<Written> {
    const working = new Y.Doc();
    try {
      const written = await db.transaction((tx) => changeInTx(tx, i, (row) => {
        applyRowToDoc(working, row);
        return working;
      }));
      return {
        result: { revision: written.revision, sizeBytes: written.state.byteLength },
        listeners: queueListeners(i.documentId, storedEventOf(i, new Map(), written.row.json, written.derived.json, written.state.byteLength)),
      };
    } finally {
      working.destroy();
    }
  }

  /** A write, under the document's writer lock. */
  async function writeLocked(i: WriteInput): Promise<Written> {
    let liveBy: number | null = null;
    for (;;) {
      if (destroying) throw new DocumentWriteRefused('BUSY');
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
        // Loaded a moment ago; Hocuspocus is still putting it in its map. A
        // document that never gets there fails the write (and frees the lock).
        liveBy ??= Date.now() + collabTestSeams.liveDocumentWaitMs;
        if (Date.now() >= liveBy) {
          console.error('[collab] a loaded document never became live; the write was refused');
          throw new DocumentWriteRefused('BUSY');
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      // A cold write holds a document's worth of memory while it runs.
      const reserved = provisionalEstimate();
      if (memoryEstimate() + reserved > COLLAB_LIMITS.memoryBudgetBytes) throw new DocumentWriteRefused('BUSY');
      coldReservedBytes += reserved;
      notePeak();
      let outcome: Written | null;
      try {
        outcome = await loadLocks.run(i.documentId, async () => {
          // A load that started meanwhile wins; write through it instead.
          const current = docs.get(i.documentId);
          if (current?.loading || current?.loaded) return null;
          return rowWrite(i);
        });
      } finally {
        coldReservedBytes -= reserved;
      }
      if (outcome) return outcome;
    }
  }

  async function write(i: WriteInput): Promise<WriteResult> {
    if (destroying) throw new DocumentWriteRefused('BUSY');
    const run = (async () => {
      const { result, listeners } = await writerLocks.run(i.documentId, () => writeLocked(i));
      // The writer lock is released before the listeners run, so socket
      // updates aren't held while they do and a listener may write. From
      // inside a listener run still in progress, a write doesn't wait for its
      // own listeners: they run after the run that may be waiting for this
      // write. Work a listener started that writes after its run has ended
      // waits as any write does.
      if (!listenerRun.getStore()?.running) await listeners;
      return result;
    })();
    activeWrites.set(run, i.documentId);
    try {
      return await run;
    } finally {
      activeWrites.delete(run);
    }
  }

  // ---------------------------------------------------------------------
  // Shutdown

  /**
   * Stores a changed document durably, retrying until `retryUntil`. False
   * when it couldn't. Each attempt is waited for only until the deadline (a
   * store can wait on the save mutex a hung write holds, or on the
   * database); one left behind counts as stored only if nothing was changed.
   */
  async function storeDurably(slot: DocSlot, document: HocuspocusDocument, retryUntil: number): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      const done: { outcome?: StoreOutcome } = {};
      await settledBy([storeExclusive(slot, document, 'final').then((outcome) => { done.outcome = outcome; })], retryUntil);
      const outcome = done.outcome;
      if (outcome === undefined) return !slot.stateDirty;
      const durable = outcome !== 'failed' && !slot.stateDirty;
      // Derived copies the database refused (not content outside the schema,
      // which no retry fixes) are tried again while time remains.
      const derivable = outcome === 'underived' && slot.deriveFailedAt !== slot.changeCounter;
      const delay = Math.min(1_000, 200 * 2 ** attempt);
      if (durable && (!derivable || Date.now() + delay > retryUntil)) {
        if (outcome === 'underived') console.error('[collab] shutdown stored a document whose text could not be updated', logId(slot.documentId));
        return true;
      }
      if (Date.now() + delay > retryUntil) return false;
      await sleep(delay);
    }
  }

  /** A load still running, or a connection authenticated and not yet connected (its buffered frames not yet handed over). */
  const loadsInFlight = () => [...docs.values()].some((slot) => slot.loading !== null)
    || [...sockets.values()].some((entry) => entry.ctx !== null && !entry.connected && !entry.closed);

  /** Waits until no load is in flight (their buffered frames handed to their connections), or `until`. */
  async function settleLoads(until: number): Promise<void> {
    while (loadsInFlight() && Date.now() < until) {
      const loading = [...docs.values()].flatMap((slot) => (slot.loading ? [slot.loading] : []));
      await Promise.race([...loading, sleep(25)]);
    }
  }

  async function shutDown(retryUntil: number): Promise<void> {
    // No new connections, frames or writes from here.
    destroying = true;
    draining = true;
    const unstored = new Set<string>();
    // Work still running at the deadline is abandoned (and reported).
    let hungWrites = 0;
    const hungListeners = new Set<string>();
    // Passes until one finds nothing loading and nothing changed: a load in
    // flight finishes and applies the frames buffered behind it, frames already
    // taken and writes already running finish, and every changed document is
    // stored, retried until the deadline.
    for (;;) {
      await settleLoads(retryUntil);
      hocuspocus.flushPendingStores();
      // Each document on its own: the frames it already took and the writes
      // to it in progress finish, waited for only until the deadline, and
      // then it is stored. A hung frame or write holds up its own document,
      // never the others.
      await Promise.all([...docs.values()].map(async (slot) => {
        const document = hocuspocus.documents.get(slot.name);
        if (!slot.loaded || !document || unstored.has(slot.documentId)) return;
        const own = [...activeWrites].filter(([, documentId]) => documentId === slot.documentId).map(([write]) => write);
        await settledBy([...document.getConnections().map((connection) => connection.waitForPendingMessages()), ...own], retryUntil);
        if (!(await storeDurably(slot, document, retryUntil))) unstored.add(slot.documentId);
      }));
      // Every write, those to documents not loaded too. A write includes its
      // listeners; one that hangs is left behind at the deadline.
      hungWrites = (await settledBy(activeWrites.keys(), retryUntil)).size;
      const chains = new Map([...listenerChains].map(([documentId, chain]) => [chain, documentId] as const));
      for (const chain of await settledBy(chains.keys(), retryUntil)) hungListeners.add(chains.get(chain)!);
      const changed = [...docs.values()].filter((slot) => slot.loaded && slot.stateDirty && !unstored.has(slot.documentId));
      if (!loadsInFlight() && changed.length === 0) break;
      if (Date.now() >= retryUntil) {
        for (const slot of changed) unstored.add(slot.documentId);
        break;
      }
    }
    // Nothing awaits from the last check to here, so nothing more is applied.
    for (const entry of [...sockets.values()]) closeEntry(entry, null);
    for (const slot of docs.values()) clearSlotTimers(slot);
    for (const { server: httpServer, listener } of attached) httpServer.off('upgrade', listener);
    unsubscribeAccess();
    webSessionEvents.off('revoked', onRevoked);
    for (const document of hocuspocus.documents.values()) document.destroy();
    hocuspocus.documents.clear();
    docs.clear();
    if (instance === server) instance = null;
    for (const documentId of hungListeners) console.error('[collab] shutdown abandoned a stored listener that did not finish', logId(documentId));
    if (hungWrites > 0) console.error('[collab] shutdown abandoned a write that did not finish');
    if (unstored.size > 0) {
      for (const documentId of unstored) console.error('[collab] shutdown could not store a document; its latest changes are lost', logId(documentId));
      throw new Error('Live editing shut down with documents it could not store');
    }
    if (hungListeners.size > 0 || hungWrites > 0) throw new Error('Live editing shut down with stored listeners or writes that did not finish');
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

    connectedUserIds(documentId) {
      const ids = new Set<string>();
      for (const entry of sockets.values()) {
        if (entry.connected && !entry.closed && entry.ctx && entry.documentId === documentId) ids.add(entry.ctx.userId);
      }
      return [...ids];
    },

    closeForAccessChange,

    destroy(options = {}) {
      destroyPromise ??= shutDown(options.retryUntil ?? Date.now() + 10_000);
      return destroyPromise;
    },
  };

  writers.set(server, write);
  testHandles = {
    docs,
    approxBytes: (documentId) => docs.get(documentId)?.size.estimate ?? null,
    accountRetained: (documentId) => docs.get(documentId)?.size.retained ?? null,
    encodedBytes: (documentId) => {
      const document = hocuspocus.documents.get(`doc:${documentId}`);
      return document ? encodedStateBytes(document) : null;
    },
    reservedBytes: memoryEstimate,
    hideLiveDocument: (documentId) => {
      const name = `doc:${documentId}`;
      const document = hocuspocus.documents.get(name);
      if (!document) throw new Error('the document is not loaded');
      hocuspocus.documents.delete(name);
      return () => { if (!hocuspocus.documents.has(name)) hocuspocus.documents.set(name, document); };
    },
    unloadIdle: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idle = [...docs.values()].filter((slot) => slot.connections === 0 && slot.writers === 0);
        if (idle.length === docs.size && idle.every((slot) => !slot.loaded && !slot.loading)) return;
        for (const slot of idle) {
          if (slot.loading) await slot.loading;
          const document = hocuspocus.documents.get(slot.name);
          if (!slot.loaded || !document) continue;
          slot.emptySince = Date.now() - COLLAB_LIMITS.unloadAfterMs;
          if (slot.unloadTimer) clearTimeout(slot.unloadTimer);
          slot.unloadTimer = null;
          // Hocuspocus won't unload while a store is pending, running or holding the save mutex.
          const storeKey = `onStoreDocument-${slot.name}`;
          if (hocuspocus.debouncer.isDebounced(storeKey)) await hocuspocus.debouncer.executeNow(storeKey);
          await document.saveMutex.waitForUnlock();
          if (hocuspocus.debouncer.isCurrentlyExecuting(storeKey)) continue;
          await hocuspocus.unloadDocument(document);
        }
        if (Date.now() > deadline) throw new Error(`documents would not unload: ${describeSlots(docs)}`);
        await sleep(25);
      }
    },
  };
  return server;
}

let instance: CollabServer | null = null;

/** The process's live-editing server, created on first use. After destroy() the next call makes a new one. */
export function getCollabServer(): CollabServer {
  instance ??= createCollabServer();
  return instance;
}

/**
 * The one writer of document content outside live sockets (consult rule C2).
 * In one transaction holding the document row FOR UPDATE (never a drive): the
 * actor's role re-checked at write time (a person and a BYOA agent as
 * themselves; Defty, the only actor whose `askerId` may name someone else,
 * as the person who asked), and again right before commit when an access
 * loss may have committed meanwhile (the socket fence's guarantee); a
 * system actor passes `requiredRole: null` and its reason, and only a system
 * actor may; an agent's `agent_edit` refused on a drive set to suggestions
 * only; `expectedRevision` checked when given (every store bumps the
 * revision, and pending live changes are stored first). The 2 MB cap the
 * sockets apply. Throws DocumentWriteRefused: FORBIDDEN, REVISION_CHANGED,
 * TOO_LARGE, INVALID_CONTENT (the document holds content outside the
 * schema), or BUSY (live editing's memory budget is spent, it is shutting
 * down, or a loaded document didn't become live; try again later). Runs the
 * stored listeners before it returns, after releasing the document's writer
 * lock; called from inside a stored listener while its run is in progress,
 * it returns once the write has applied and its listeners run after that run.
 */
export async function writeDocument(i: {
  orgId: string;
  documentId: string;
  actor: CollabActor;
  expectedRevision?: number;
  /** Default `edit`; a system actor passes null, with its reason. */
  requiredRole?: DocRole | null;
  mutate: (doc: Y.Doc) => void;
  reason: DocumentWriteReason;
}): Promise<{ revision: number; sizeBytes: number }> {
  const requiredRole = i.requiredRole === undefined ? 'edit' : i.requiredRole;
  if (requiredRole === null && i.actor.kind !== 'system') throw new DocumentWriteRefused('FORBIDDEN');
  // Another person as the asker is honoured only for Defty (checked in the
  // transaction); anyone else naming someone else is refused.
  const askedBy = i.actor.askerId !== undefined && i.actor.askerId !== i.actor.userId ? i.actor.askerId : null;
  if (askedBy !== null && i.actor.kind !== 'agent') throw new DocumentWriteRefused('FORBIDDEN');
  const checkedAs = askedBy ?? i.actor.userId;
  // The access generation the role is read at, for the pre-commit fence.
  let generation = 0;
  const write = writers.get(getCollabServer())!;
  return write({
    documentId: i.documentId,
    orgId: i.orgId,
    actor: i.actor,
    mutate: i.mutate,
    check: async (tx, row) => {
      if (askedBy !== null) {
        const [defty] = await tx.select({ id: users.id }).from(users)
          .where(and(eq(users.id, i.actor.userId), eq(users.email, DEFTY_EMAIL), eq(users.kind, 'agent'))).limit(1);
        if (!defty) throw new DocumentWriteRefused('FORBIDDEN');
      }
      generation = currentAccessGeneration();
      if (requiredRole !== null && !roleAtLeast(await documentRoleFor(checkedAs, i.orgId, i.documentId, tx), requiredRole)) {
        throw new DocumentWriteRefused('FORBIDDEN');
      }
      if (i.actor.kind === 'agent' && i.reason === 'agent_edit') {
        const [drive] = await tx.select({ suggestOnly: drives.agent_suggest_only }).from(drives)
          .where(and(eq(drives.id, row.driveId), eq(drives.org_id, i.orgId))).limit(1);
        if (!drive || drive.suggestOnly) throw new DocumentWriteRefused('FORBIDDEN');
      }
      if (i.expectedRevision !== undefined && row.revision !== i.expectedRevision) throw new DocumentWriteRefused('REVISION_CHANGED');
    },
    // The access fence a socket frame passes (rule C3), right before commit:
    // only the document row is locked, so a drive or share loss can commit
    // after the role was read. While an access-loss barrier covers the
    // document and actor (between a loss's commit and finishAccessLoss), or
    // once the generation has moved, the role is read again in this
    // transaction, which sees a committed loss: a lost role is refused
    // FORBIDDEN. A loss not yet committed, or rolled back (its barrier stays
    // until the timeout), serializes as the write, then the loss, the same
    // as a socket frame passing the fence, so it refuses nothing.
    beforeCommit: async (tx) => {
      await collabTestSeams.beforeWriteCommit?.(i.documentId);
      if (requiredRole === null) return;
      const covered = [...new Set([checkedAs, i.actor.userId])].some((userId) => accessLossBarrierCovers(i.orgId, i.documentId, userId));
      if ((covered || currentAccessGeneration() !== generation)
        && !roleAtLeast(await documentRoleFor(checkedAs, i.orgId, i.documentId, tx), requiredRole)) {
        throw new DocumentWriteRefused('FORBIDDEN');
      }
    },
  });
}

/**
 * Test seams: `afterAuthenticate` runs after a connection's role is read and
 * before it is registered; `derivedEveryMs` is the derived-copy window (60 s);
 * `afterSizeCheck` runs (synchronously) after an update frame's size work,
 * just before the last expiry check; `liveDocumentWaitMs` is how long a write
 * waits for a document that has loaded to reach Hocuspocus's map (5 s; the
 * gap is normally a few ticks) before it is refused BUSY;
 * `beforeWriteCommit` runs in a write's transaction after its store, just
 * before the pre-commit access fence.
 */
export const collabTestSeams: {
  afterAuthenticate: ((documentId: string) => Promise<void>) | null;
  derivedEveryMs: number;
  afterSizeCheck: (() => void) | null;
  liveDocumentWaitMs: number;
  beforeWriteCommit: ((documentId: string) => Promise<void>) | null;
} = {
  afterAuthenticate: null,
  derivedEveryMs: 60_000,
  afterSizeCheck: null,
  liveDocumentWaitMs: 5_000,
  beforeWriteCommit: null,
};

/** How each document held stands (no ids). */
function describeSlots(docs: Map<string, DocSlot>): string {
  return JSON.stringify([...docs.values()].map((slot) => ({
    loaded: slot.loaded, loading: Boolean(slot.loading), unloading: slot.unloading, connections: slot.connections, writers: slot.writers,
    stateDirty: slot.stateDirty, derivedDirty: slot.derivedDirty, retryAttempt: slot.retryAttempt, emptySince: slot.emptySince !== null,
  })));
}

const testState = { peakDocuments: 0, peakReservedBytes: 0, storeFailures: 0, underivedFinals: 0, derivedFallbacks: 0 };
let testHandles: {
  docs: Map<string, DocSlot>;
  approxBytes(documentId: string): number | null;
  accountRetained(documentId: string): number | null;
  encodedBytes(documentId: string): number | null;
  reservedBytes(): number;
  hideLiveDocument(documentId: string): () => void;
  unloadIdle(timeoutMs: number): Promise<void>;
} | null = null;

/** What the current server holds, for tests. */
export function collabStateForTest() {
  const handles = testHandles;
  const docs = handles?.docs ?? new Map<string, DocSlot>();
  return {
    loadedDocumentIds: [...docs.values()].filter((slot) => slot.loaded).map((slot) => slot.documentId),
    reservedDocuments: docs.size,
    /** Documents a connection or a write still holds. */
    heldDocuments: [...docs.values()].filter((slot) => slot.connections > 0 || slot.writers > 0).length,
    reservedBytes: handles?.reservedBytes() ?? 0,
    peakDocuments: testState.peakDocuments,
    peakReservedBytes: testState.peakReservedBytes,
    storeFailures: testState.storeFailures,
    underivedFinals: testState.underivedFinals,
    derivedFallbacks: testState.derivedFallbacks,
    approxBytes: (documentId: string) => handles?.approxBytes(documentId) ?? null,
    /** How many entries the document's size accounting keeps (collab/size-account.ts), or null when it isn't loaded. */
    accountRetained: (documentId: string) => handles?.accountRetained(documentId) ?? null,
    encodedBytes: (documentId: string) => handles?.encodedBytes(documentId) ?? null,
    /**
     * Takes a loaded document out of Hocuspocus's map while our slot still
     * says loaded (the state a write sees when Hocuspocus never registers a
     * document it loaded); returns the restore.
     */
    hideLiveDocument: (documentId: string) => {
      if (!handles) throw new Error('no live-editing server');
      return handles.hideLiveDocument(documentId);
    },
    /** How each document still held stands (no ids), for a failing assertion's message. */
    describe: () => describeSlots(docs),
    /**
     * Unloads every document nobody holds, without waiting for its timer:
     * awaits pending and running stores and the save mutex, then unloads,
     * again until nothing is loaded; fails with each document's state after `timeoutMs`.
     */
    unloadIdle: (timeoutMs = 10_000) => handles?.unloadIdle(timeoutMs) ?? Promise.resolve(),
    resetPeak: () => {
      testState.peakDocuments = docs.size;
      testState.peakReservedBytes = handles?.reservedBytes() ?? 0;
    },
  };
}
