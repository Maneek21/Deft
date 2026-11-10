type SpaceSocket = {
  connected: boolean;
  emit: (event: string, ...args: unknown[]) => unknown;
  on: (event: string, listener: () => void) => unknown;
  off: (event: string, listener: () => void) => unknown;
};

/** Keep the active space subscription alive across Socket.IO reconnects. */
export function subscribeToSpace(socket: SpaceSocket, spaceId: string) {
  const join = () => socket.emit('space:join', spaceId);

  if (socket.connected) join();
  socket.on('connect', join);

  return () => {
    socket.off('connect', join);
    if (socket.connected) socket.emit('space:leave', spaceId);
  };
}

export type CatchUpResult = 'ok' | 'failed' | 'superseded';

// Conversations that may have missed socket events and still need a
// successful catch-up read. Module-level so the knowledge survives an effect
// being recreated, or a conversation opened while the socket is down.
const needsCatchUp = new Set<string>();

/**
 * Run `catchUp` on the next connect whenever `key` may have missed events:
 * the socket was down when this started watching, or dropped since. The
 * flag clears only after a catch-up succeeds with no disconnect during it;
 * a failed one keeps it, and `retry()` runs another.
 */
export function watchCatchUp(
  socket: Pick<SpaceSocket, 'connected' | 'on' | 'off'>,
  key: string,
  catchUp: () => Promise<CatchUpResult>,
) {
  if (!socket.connected) needsCatchUp.add(key);
  let drops = 0;
  let disposed = false;
  const run = async (): Promise<CatchUpResult> => {
    const dropsAtStart = drops;
    const result = await catchUp();
    if (!disposed && result === 'ok' && drops === dropsAtStart) needsCatchUp.delete(key);
    return result;
  };
  const onDisconnect = () => {
    drops += 1;
    needsCatchUp.add(key);
  };
  const onConnect = () => {
    if (needsCatchUp.has(key)) void run();
  };
  socket.on('disconnect', onDisconnect);
  socket.on('connect', onConnect);
  return {
    retry: () => {
      needsCatchUp.add(key);
      return run();
    },
    dispose: () => {
      disposed = true;
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    },
  };
}
