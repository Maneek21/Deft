type HistoryMessage = { id: string; created_at: string; is_deleted?: boolean };

function timeOf(message: { created_at: string }): number {
  const value = Date.parse(message.created_at);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Merge a fresh history read into what is on screen. Fetched rows are
 * authoritative for every field; the caller then replays the live events
 * buffered during the read (see ConversationReads). Messages already shown
 * keep their position, and a message shown as deleted stays deleted (the
 * API has no undelete). Nothing is dropped and no id appears twice.
 *
 * Messages the client missed are inserted by `created_at`, after shown
 * messages with the same timestamp, except that two messages of the same
 * read with the same (millisecond) timestamp keep the read's order: the
 * server orders by its stored, finer timestamp, which the client cannot see.
 * With `{ earlier: true }` (a page from before everything shown) a missed
 * message goes before shown messages with the same timestamp.
 */
export function mergeMessagesById<T extends HistoryMessage>(
  current: readonly T[],
  fetched: readonly T[],
  options: { earlier?: boolean } = {},
): T[] {
  if (fetched.length === 0) return current as T[];
  const readIndex = new Map<string, number>();
  fetched.forEach((message, index) => { if (!readIndex.has(message.id)) readIndex.set(message.id, index); });
  const fetchedById = new Map(fetched.map((message) => [message.id, message]));
  const shown = new Set<string>();
  const merged: T[] = current.map((message) => {
    shown.add(message.id);
    const fresh = fetchedById.get(message.id);
    if (!fresh) return message;
    const next = { ...message, ...fresh };
    return message.is_deleted === true ? { ...next, is_deleted: true } : next;
  });

  const missing = fetched
    .filter((message, index) => !shown.has(message.id) && readIndex.get(message.id) === index)
    .sort((a, b) => timeOf(a) - timeOf(b));
  for (const message of missing) {
    const time = timeOf(message);
    const index = readIndex.get(message.id)!;
    // Whether a row already in the list belongs after this message.
    const follows = (row: T) => {
      const rowTime = timeOf(row);
      if (rowTime !== time) return rowTime > time;
      const rowIndex = readIndex.get(row.id);
      return rowIndex !== undefined ? rowIndex > index : options.earlier === true;
    };
    let at = merged.length;
    while (at > 0 && follows(merged[at - 1]!)) at--;
    merged.splice(at, 0, message);
  }
  return merged;
}

export type ReadTicket = { id: number; generation: number; startSeq: number };

/**
 * Orders the history reads of one conversation and buffers live events for
 * replay.
 *
 * - Only the latest read (by generation) may apply. `begin({ supersede:
 *   false })` starts a side read (Load earlier) that must still be latest
 *   when it resolves, but does not supersede the others.
 * - While any read is in flight, every live event is recorded, in arrival
 *   order. The buffer always starts at the start of the OLDEST read still in
 *   flight; nothing is recorded while no read is in flight.
 * - `settle(ticket)` must be called for every outcome of every read. It
 *   returns only the events that arrived after THAT read started (not the
 *   whole buffer, which may reach back to an older read's start), then drops
 *   events no remaining in-flight read could need.
 *
 * Overlap guarantee: an event received after read R started is in the buffer
 * when R settles, because R is in flight from its start until it settles and
 * the buffer only ever drops events older than the oldest in-flight start. So
 * every event R's response might not reflect is replayed onto R's result.
 * Events from before R started are NOT replayed onto R: the server answered
 * R after them, and replaying one could undo a later change R already holds.
 */
export class ConversationReads<E = unknown> {
  private generation = 0;
  private seq = 0;
  private nextId = 0;
  private readonly inFlight = new Map<number, number>();
  private readonly superseding = new Set<number>();
  private buffer: Array<{ seq: number; event: E }> = [];
  private disposed = false;

  begin(options: { supersede?: boolean } = {}): ReadTicket {
    if (options.supersede !== false) this.generation += 1;
    this.nextId += 1;
    if (!this.disposed) {
      this.inFlight.set(this.nextId, this.seq);
      if (options.supersede !== false) this.superseding.add(this.nextId);
    }
    return { id: this.nextId, generation: this.generation, startSeq: this.seq };
  }

  isLatest(ticket: ReadTicket): boolean {
    return !this.disposed && ticket.generation === this.generation;
  }

  /**
   * True while a read that may replace the history window (initial load,
   * retry, catch-up) is in flight. A side read must not start then: its page
   * would be cut from the window that read is about to replace.
   */
  get replacingReadInFlight(): boolean {
    return this.superseding.size > 0;
  }

  /** Record one live event if a read is in flight. */
  record(event: E): void {
    if (this.disposed || this.inFlight.size === 0) return;
    this.seq += 1;
    this.buffer.push({ seq: this.seq, event });
  }

  /** End a read (any outcome). Returns the events to replay onto its result. */
  settle(ticket: ReadTicket): E[] {
    // Only events that arrived after this read started: an older event may
    // already have been reversed on the server, and the fetched rows say so.
    const replay = this.buffer.filter((entry) => entry.seq > ticket.startSeq).map((entry) => entry.event);
    this.inFlight.delete(ticket.id);
    this.superseding.delete(ticket.id);
    if (this.inFlight.size === 0) {
      this.buffer = [];
    } else {
      const oldestStart = Math.min(...this.inFlight.values());
      this.buffer = this.buffer.filter((entry) => entry.seq > oldestStart);
    }
    return replay;
  }

  /** How many events are buffered (for tests). */
  get bufferedEvents(): number {
    return this.buffer.length;
  }

  /** The conversation was closed or changed: no read may apply any more. */
  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
    this.superseding.clear();
    this.buffer = [];
  }
}

export type HistoryRead<T> = {
  /** Oldest first. */
  messages: T[];
  /** True when the read reached back to the oldest message that was shown (or nothing was shown). */
  coversShown: boolean;
  /** True when the server may hold messages older than the oldest one read. */
  hasEarlier: boolean;
  /** The server's cursor for the page before the oldest one read; null when there is none. */
  nextCursor: string | null;
};

export type HistoryPage<T> = {
  /** Oldest first. */
  messages: T[];
  /** The server's cursor for the page before this one; null (or absent) means no older history. */
  nextCursor: string | null;
};

type Get = (path: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** The API caps a history page at 100. */
export const HISTORY_PAGE_SIZE = 100;
/** A catch-up reads at most this many pages (500 messages) before it replaces the view. */
export const CATCH_UP_MAX_PAGES = 5;

/**
 * The history cursor for a message: the page before it, in the API's
 * (created_at, id) order, so messages sharing a timestamp are neither skipped
 * nor repeated across pages.
 */
export function historyCursorOf(message: { id: string; created_at: string }): string {
  return `${message.created_at}|${message.id}`;
}

/**
 * Read one page of top-level history, oldest first: the latest page, or the
 * page before `before` (a history cursor, normally the server's next_cursor).
 * Throws on a failed read.
 */
export async function readHistoryPage<T extends HistoryMessage>(get: Get, basePath: string, before?: string): Promise<HistoryPage<T>> {
  const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (before) query.set('cursor', before);
  const res = await get(`${basePath}?${query.toString()}`);
  if (!res.ok) throw new Error(`History read failed (${res.status})`);
  const data = await res.json() as { messages?: T[]; next_cursor?: unknown } | T[] | null;
  const list = Array.isArray(data) ? data : data?.messages;
  const nextCursor = !Array.isArray(data) && typeof data?.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
  return { messages: Array.isArray(list) ? [...list] : [], nextCursor };
}

/**
 * Read history from the newest message back until the read reaches
 * `oldestShownAt` (the oldest message on screen), for at most `maxPages`
 * pages. Each next page follows the server's next_cursor; a page without one
 * is the oldest. Throws on any failed page.
 */
export async function readHistoryBackTo<T extends HistoryMessage>(
  get: Get,
  basePath: string,
  oldestShownAt: string | null,
  maxPages = CATCH_UP_MAX_PAGES,
): Promise<HistoryRead<T>> {
  const target = oldestShownAt === null ? Number.NaN : Date.parse(oldestShownAt);
  let collected: T[] = [];
  let before: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await readHistoryPage<T>(get, basePath, before);
    const pageIds = new Set(page.messages.map((m) => m.id));
    collected = [...page.messages, ...collected.filter((m) => !pageIds.has(m.id))];
    if (!page.nextCursor) return { messages: collected, coversShown: true, hasEarlier: false, nextCursor: null };
    if (Number.isNaN(target) || timeOf(page.messages[0]!) <= target) {
      return { messages: collected, coversShown: true, hasEarlier: true, nextCursor: page.nextCursor };
    }
    before = page.nextCursor;
  }
  return { messages: collected, coversShown: false, hasEarlier: true, nextCursor: before ?? null };
}

/**
 * Apply a history read to the shown list. A read that reached back to what
 * was shown merges into it. One that stopped at the page bound replaces the
 * view from its oldest message on (keeping newer live messages), so the
 * screen never shows a hole; the caller then offers "Load earlier".
 */
export function applyHistoryRead<T extends HistoryMessage>(
  current: readonly T[],
  read: HistoryRead<T>,
): T[] {
  if (read.coversShown || read.messages.length === 0) return mergeMessagesById(current, read.messages);
  const oldest = timeOf(read.messages[0]!);
  return mergeMessagesById(current.filter((m) => timeOf(m) >= oldest), read.messages);
}

function oldestOf<T extends { created_at: string }>(list: ReadonlyArray<T>): T | null {
  let oldest: T | null = null;
  for (const message of list) if (!oldest || timeOf(message) < timeOf(oldest)) oldest = message;
  return oldest;
}

/** The oldest created_at in a list, or null when it is empty. */
export function oldestCreatedAt(list: ReadonlyArray<{ created_at: string }>): string | null {
  return oldestOf(list)?.created_at ?? null;
}

/**
 * The history cursor of the oldest message in a list, or null when it is
 * empty. Only a fallback: prefer the server's next_cursor, since the list
 * holds millisecond timestamps and the server orders by its full precision.
 */
export function oldestHistoryCursor(list: ReadonlyArray<{ id: string; created_at: string }>): string | null {
  const oldest = oldestOf(list);
  return oldest ? historyCursorOf(oldest) : null;
}

