export type PresenceStatus = 'online' | 'idle' | 'offline';
export type PresenceMap = Map<string, PresenceStatus>;

/**
 * Apply the server's `presence:init` list. The server sends it on every
 * (re)connect with every other user currently connected to this org, so it
 * replaces what we had: anyone missing from it is offline now. The current
 * user is not in the list, so their own entry is carried over.
 */
export function applyPresenceSnapshot(
  previous: PresenceMap,
  list: ReadonlyArray<{ user_id: string; status: 'online' | 'idle' }>,
  selfId: string | null | undefined,
): PresenceMap {
  const next: PresenceMap = new Map();
  const self = selfId ? previous.get(selfId) : undefined;
  if (selfId && self) next.set(selfId, self);
  for (const entry of list) next.set(entry.user_id, entry.status);
  return next;
}

/** Apply one live `presence:update` event. */
export function applyPresenceUpdate(
  previous: PresenceMap,
  data: { user_id: string; status: PresenceStatus },
): PresenceMap {
  const next = new Map(previous);
  if (data.status === 'offline') next.delete(data.user_id);
  else next.set(data.user_id, data.status);
  return next;
}
