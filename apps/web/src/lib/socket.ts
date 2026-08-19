import { io, Socket } from 'socket.io-client';
import { refreshAccessToken } from './api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

let socket: Socket | null = null;
let connectionListeners: Array<(connected: boolean) => void> = [];

export function onConnectionChange(listener: (connected: boolean) => void) {
  connectionListeners.push(listener);
  return () => {
    connectionListeners = connectionListeners.filter(l => l !== listener);
  };
}

function notifyConnectionChange(connected: boolean) {
  connectionListeners.forEach(l => l(connected));
}

/** Update a shared socket without interrupting an in-progress reconnect cycle. */
export function prepareSocketForUse(existing: Socket, token: string): Socket {
  // Socket.IO reads `auth` for every new connection attempt, so keep it current
  // even when the singleton was created with an older access token.
  existing.auth = { token };

  // `active` means Socket.IO is connected or will reconnect automatically.
  // An inactive socket (for example after a denied namespace connection) needs
  // an explicit connect, while calling connect during backoff would race it.
  if (!existing.active) existing.connect();

  return existing;
}

export function getSocket(token: string): Socket {
  // Reuse a disconnected socket while Socket.IO performs its configured
  // reconnect cycle. Replacing it would strand listeners on the old instance.
  if (socket) return prepareSocketForUse(socket, token);

  const createdSocket = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  socket = createdSocket;

  createdSocket.on('connect', () => {
    if (socket !== createdSocket) return;
    notifyConnectionChange(true);
  });

  createdSocket.on('disconnect', (reason) => {
    if (socket !== createdSocket) return;
    notifyConnectionChange(false);
    if (reason === 'io server disconnect') {
      // Server forced disconnect — likely auth failure, don't auto-reconnect
      createdSocket.connect();
    }
  });

  createdSocket.on('reconnect', () => {
    if (socket !== createdSocket) return;
    notifyConnectionChange(true);
  });

  createdSocket.on('connect_error', async (err) => {
    const msg = err?.message ?? '';
    if (/invalid token|expired|unauthori[sz]ed/i.test(msg)) {
      // Auth-shaped error: attempt a silent token refresh and reconnect once.
      // The server key for socket auth is `token` (confirmed via socket.handshake.auth.token).
      const fresh = await refreshAccessToken();
      // A logout/login may have replaced the singleton while refresh was in
      // flight. Never mutate or disconnect that newer socket from this handler.
      if (socket !== createdSocket) return;
      if (fresh) {
        createdSocket.auth = { token: fresh };
        createdSocket.connect();
        return;
      }
      // Refresh failed — stop reconnect attempts to avoid a login-redirect loop.
      console.warn('[socket] auth refresh failed; stopping reconnect attempts');
      createdSocket.disconnect();
      return;
    }
    // Non-auth errors fall through and use Socket.io's built-in reconnection backoff.
    console.warn('[socket] Connection error:', msg);
  });

  return createdSocket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
