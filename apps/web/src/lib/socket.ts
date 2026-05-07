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

export function getSocket(token: string): Socket {
  if (socket?.connected) return socket;

  socket = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  socket.on('connect', () => {
    notifyConnectionChange(true);
  });

  socket.on('disconnect', (reason) => {
    notifyConnectionChange(false);
    if (reason === 'io server disconnect') {
      // Server forced disconnect — likely auth failure, don't auto-reconnect
      socket?.connect();
    }
  });

  socket.on('reconnect', () => {
    notifyConnectionChange(true);
  });

  socket.on('connect_error', async (err) => {
    const msg = err?.message ?? '';
    if (/invalid token|expired|unauthori[sz]ed/i.test(msg)) {
      // Auth-shaped error: attempt a silent token refresh and reconnect once.
      // The server key for socket auth is `token` (confirmed via socket.handshake.auth.token).
      const fresh = await refreshAccessToken();
      if (fresh && socket) {
        socket.auth = { token: fresh };
        socket.connect();
        return;
      }
      // Refresh failed — stop reconnect attempts to avoid a login-redirect loop.
      console.warn('[socket] auth refresh failed; stopping reconnect attempts');
      socket?.disconnect();
      return;
    }
    // Non-auth errors fall through and use Socket.io's built-in reconnection backoff.
    console.warn('[socket] Connection error:', msg);
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
