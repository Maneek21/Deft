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
