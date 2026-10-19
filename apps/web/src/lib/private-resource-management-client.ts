import { api } from './api';

// This screen mounts three independent readers, while management permits two
// concurrent requests from a socket peer. Keep this browser's reads ordered.
let reads: Promise<void> = Promise.resolve();

export function readPrivateResourceManagement(path: string): Promise<Response> {
  const response = reads.then(() => api.fetch(path, { signal: AbortSignal.timeout(15_000) }));
  reads = response.then(() => undefined, () => undefined);
  return response;
}
