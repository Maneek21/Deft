type HistoryMessage = { id: string; created_at: string; is_deleted?: boolean };

function timeOf(message: { created_at: string }): number {
  const value = Date.parse(message.created_at);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Merge a fresh history read into what is on screen, for example after a
 * socket reconnect. Messages already shown keep their position and take the
 * server's fields, unless `keepLocal(id)` says a live socket update for that
 * message arrived after the read started (then the shown version wins). A
 * message shown as deleted stays deleted. Messages the client missed are
 * inserted by `created_at`. Nothing is dropped and no id appears twice.
 */
export function mergeMessagesById<T extends HistoryMessage>(
  current: readonly T[],
  fetched: readonly T[],
  keepLocal: (id: string) => boolean = () => false,
): T[] {
  if (fetched.length === 0) return current as T[];
  const fetchedById = new Map(fetched.map((message) => [message.id, message]));
  const shown = new Set<string>();
  const merged: T[] = current.map((message) => {
    shown.add(message.id);
    const fresh = fetchedById.get(message.id);
    if (!fresh || keepLocal(message.id)) return message;
    const next = { ...message, ...fresh };
    return message.is_deleted === true ? { ...next, is_deleted: true } : next;
  });

  const missing = fetched
    .filter((message, index) => !shown.has(message.id) && fetched.findIndex((m) => m.id === message.id) === index)
    .sort((a, b) => timeOf(a) - timeOf(b));
  for (const message of missing) {
    let at = merged.length;
    while (at > 0 && timeOf(merged[at - 1]!) > timeOf(message)) at--;
    merged.splice(at, 0, message);
  }
  return merged;
}

export type ReadTicket = { generation: number; startSeq: number };

/**
 * Orders the history reads of one conversation. Only the latest read may
 * apply, and a read never overrides a message that a live socket event
 * changed after the read started.
 */
export class ConversationReads {
  private generation = 0;
  private seq = 0;
  private readonly changedAt = new Map<string, number>();
  private disposed = false;

  /** Start a read that supersedes every earlier one. */
  begin(): ReadTicket {
    this.generation += 1;
    return { generation: this.generation, startSeq: this.seq };
  }

  /** A ticket that does not supersede other reads (for example loading older pages). */
  peek(): ReadTicket {
    return { generation: this.generation, startSeq: this.seq };
  }

  isLatest(ticket: ReadTicket): boolean {
    return !this.disposed && ticket.generation === this.generation;
  }

  /** The conversation was closed or changed: no read may apply any more. */
  dispose(): void {
    this.disposed = true;
  }

  /** Record a live socket change to one message. */
  noteChange(id: string): void {
    this.seq += 1;
    this.changedAt.set(id, this.seq);
  }

  changedSince(ticket: ReadTicket, id: string): boolean {
    return (this.changedAt.get(id) ?? 0) > ticket.startSeq;
  }
}

export type HistoryRead<T> = {
  /** Oldest first. */
  messages: T[];
  /** True when the read reached back to the oldest message that was shown (or nothing was shown). */
  coversShown: boolean;
  /** True when the server may hold messages older than the oldest one read. */
  hasEarlier: boolean;
};

type Get = (path: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** The API caps a history page at 100. */
export const HISTORY_PAGE_SIZE = 100;
/** A catch-up reads at most this many pages (500 messages) before it replaces the view. */
export const CATCH_UP_MAX_PAGES = 5;

/**
 * Read one page of top-level history, oldest first: the latest page, or the
 * page before `before` (a created_at). Throws on a failed read.
 */
export async function readHistoryPage<T extends HistoryMessage>(get: Get, basePath: string, before?: string): Promise<T[]> {
  const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (before) query.set('cursor', before);
  const res = await get(`${basePath}?${query.toString()}`);
  if (!res.ok) throw new Error(`History read failed (${res.status})`);
  const data = await res.json() as { messages?: T[] } | T[] | null;
  const list = Array.isArray(data) ? data : data?.messages;
  return Array.isArray(list) ? [...list].sort((a, b) => timeOf(a) - timeOf(b)) : [];
}

/**
 * Read history from the newest message back until the read reaches
 * `oldestShownAt` (the oldest message on screen), for at most `maxPages`
 * pages. Each next page uses the oldest created_at of the previous one as
 * its cursor (the API's own next_cursor is not used). Throws on any failed page.
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
    const pageIds = new Set(page.map((m) => m.id));
    collected = [...page, ...collected.filter((m) => !pageIds.has(m.id))];
    if (page.length < HISTORY_PAGE_SIZE) return { messages: collected, coversShown: true, hasEarlier: false };
    if (Number.isNaN(target) || timeOf(page[0]!) <= target) return { messages: collected, coversShown: true, hasEarlier: true };
    before = page[0]!.created_at;
  }
  return { messages: collected, coversShown: false, hasEarlier: true };
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
  keepLocal: (id: string) => boolean,
): T[] {
  if (read.coversShown || read.messages.length === 0) return mergeMessagesById(current, read.messages, keepLocal);
  const oldest = timeOf(read.messages[0]!);
  return mergeMessagesById(current.filter((m) => timeOf(m) >= oldest), read.messages, keepLocal);
}

/** The oldest created_at in a list, or null when it is empty. */
export function oldestCreatedAt(list: ReadonlyArray<{ created_at: string }>): string | null {
  let oldest: { created_at: string } | null = null;
  for (const message of list) if (!oldest || timeOf(message) < timeOf(oldest)) oldest = message;
  return oldest?.created_at ?? null;
}
