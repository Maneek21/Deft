// Live-editing limits (spec 5.4; plan Task F7). R1 checks each number with a
// load test. Tests lower them with setCollabLimitsForTest.
import * as Y from 'yjs';

export type CollabLimits = {
  /** Documents loaded (or reserved for loading) in this process at once. */
  maxLoadedDocuments: number;
  /** The memory estimate (encoded bytes × HEAP_FACTOR, summed) above which no new document loads. */
  memoryBudgetBytes: number;
  /** A document's encoded live state at which `deft_meta.size_warning` turns on. */
  docWarnBytes: number;
  /** A document's encoded live state may not grow past this (deletions always pass). */
  docMaxBytes: number;
  /** Live connections (and connections still authenticating) to one document. */
  maxConnectionsPerDocument: number;
  /** How long a document stays loaded after its last connection leaves. */
  unloadAfterMs: number;
};

export const COLLAB_LIMITS: CollabLimits = {
  maxLoadedDocuments: 40,
  memoryBudgetBytes: 104_857_600,
  docWarnBytes: 1_048_576,
  docMaxBytes: 2_097_152,
  maxConnectionsPerDocument: 25,
  unloadAfterMs: 30_000,
};

/**
 * Heap bytes a loaded document costs per byte of its encoded Yjs state.
 * Measured 26 Nov 2026 on Node 24.14 with yjs 13.6.33: the heap growth
 * (process.memoryUsage().heapUsed after two forced collections) of applying
 * an encoded state to a fresh Y.Doc that stays referenced, the median of five
 * loads each:
 * - a document built in one go from JSON (headings and paragraphs):
 *   1.06 MB encoded → 8.66×, 2.12 MB → 8.28×;
 * - a document typed by three people over time (small inserts at scattered
 *   places, some deletions): 1.12 MB → 12.94×, 2.16 MB → 12.65×.
 * The constant takes the edited case, rounded up. R1 checks it under load.
 */
export const HEAP_FACTOR = 13;

/** A WebSocket frame larger than this is refused by the socket itself (close 1009). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** One client's awareness state (cursor, name, colour) larger than this is dropped, not re-broadcast. */
export const AWARENESS_STATE_MAX_BYTES = 16 * 1024;

/**
 * The awareness client ids one connection may hold states for: the first it
 * uses. An editor tab has one; states under any other id are dropped.
 */
export const AWARENESS_CLIENTS_PER_CONNECTION = 2;

/** The awareness states one frame may carry, in total; states past it are dropped. */
export const AWARENESS_FRAME_MAX_BYTES = 16 * 1024;

/** Whether live editing is on: `DEFT_DOCUMENTS_LIVE=off` is the emergency switch. */
export function liveEditingEnabled(): boolean {
  return process.env.DEFT_DOCUMENTS_LIVE !== 'off';
}

/** Lowers (or raises) limits for a test; the returned function restores the previous values. */
export function setCollabLimitsForTest(p: Partial<CollabLimits>): () => void {
  const previous = { ...COLLAB_LIMITS };
  Object.assign(COLLAB_LIMITS, p);
  return () => { Object.assign(COLLAB_LIMITS, previous); };
}

/**
 * Close codes for /collab. A client refused with `busy` or `crowded` shows the
 * read-only view from REST and tries again every 15 s; `liveOff` carries the
 * reason `paused` or `live_off`.
 */
export const COLLAB_CLOSE = {
  unauthenticated: 4401, forbidden: 4403, notFound: 4404, roleChanged: 4409,
  tooLarge: 4413, busy: 4429, crowded: 4430, liveOff: 4503,
} as const;

export type CollabCloseCode = keyof typeof COLLAB_CLOSE;

/** The byte length of a document's encoded Yjs state: the size every cap is measured in. */
export function encodedStateBytes(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

/**
 * The size cap: a change is accepted when the document's encoded state after
 * it is within docMaxBytes, or no larger than before, so a document over the
 * cap can always shrink (deletions, splitting it up).
 */
export function withinSizeCap(beforeBytes: number, afterBytes: number): boolean {
  return afterBytes <= COLLAB_LIMITS.docMaxBytes || afterBytes <= beforeBytes;
}

/**
 * Below this projected size (the current approximate size plus the update's
 * own length) an update is accepted without measuring: 90% of docMaxBytes
 * (1.8 MB of 2 MB), which leaves room for the few bytes merging can add.
 */
export function fastAcceptBelowBytes(): number {
  return Math.floor(COLLAB_LIMITS.docMaxBytes * 0.9);
}
