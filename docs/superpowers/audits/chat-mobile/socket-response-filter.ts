export function socketHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isExpectedSocketIoResponse(
  value: string,
  expectedOrigin: string | null,
): boolean {
  if (!expectedOrigin) return false;

  try {
    const url = new URL(value);
    const isSocketPath = url.pathname === '/socket.io' || url.pathname === '/socket.io/';
    return isSocketPath && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}
