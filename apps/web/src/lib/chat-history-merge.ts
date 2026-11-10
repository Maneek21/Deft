type HistoryMessage = { id: string; created_at: string };

function timeOf(message: HistoryMessage): number {
  const value = Date.parse(message.created_at);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Merge a fresh history read into what is on screen, for example after a
 * socket reconnect. Messages already shown keep their position and take the
 * server's newer fields; messages the client missed are inserted by
 * `created_at`. Nothing is dropped and no id appears twice.
 */
export function mergeMessagesById<T extends HistoryMessage>(current: readonly T[], fetched: readonly T[]): T[] {
  if (fetched.length === 0) return current as T[];
  const fetchedById = new Map(fetched.map((message) => [message.id, message]));
  const shown = new Set<string>();
  const merged: T[] = current.map((message) => {
    shown.add(message.id);
    const fresh = fetchedById.get(message.id);
    return fresh ? { ...message, ...fresh } : message;
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
