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
