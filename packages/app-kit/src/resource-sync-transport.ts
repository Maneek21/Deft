import { ResourceSyncSessionCredentialSchema, ResourceSyncErrorSchema } from './resource-sync-transport-contract.js';
import type { ResourceSyncClientOptions, ResourceSyncCallOptions } from './resource-sync-client.js';
const MAX_TRANSPORT_BYTES = 1_100_000;
export type ResourceSyncTransportOptions = ResourceSyncClientOptions & { channel_version: 'deft.app_runtime_channel.v2' | 'deft.app_runtime_channel.v3' };
export class ResourceSyncClientError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Resource sync channel request failed: ${code}`);
    this.name = 'ResourceSyncClientError';
  }
}

export function createResourceSyncTransport(options: ResourceSyncTransportOptions) {
  const url = new URL(options.channel_url);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new TypeError('Resource sync channel URL must be HTTPS or loopback HTTP without credentials');
  }
  const credential = ResourceSyncSessionCredentialSchema.parse(options.credential);
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeout = options.timeout_ms ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new TypeError('Invalid resource sync request deadline');
  }

  async function post(operation: string,
    fields: Record<string, unknown>, callOptions?: ResourceSyncCallOptions, binaryBody?: Uint8Array): Promise<unknown> {
    if (callOptions?.signal?.aborted) {
      throw new ResourceSyncClientError(0, 'APP_RESOURCE_SYNC_ABORTED');
    }
    const body = binaryBody ?? JSON.stringify({ ...fields,
      schema_version: options.channel_version,
      audience: 'app_resource_sync',
      session_id: credential.session_id });
    if ((typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength) > (binaryBody ? 2_097_152 + 8196 : MAX_TRANSPORT_BYTES)) {
      throw new ResourceSyncClientError(0, 'APP_RESOURCE_SYNC_TOO_LARGE');
    }
    const controller = new AbortController();
    const signal = callOptions?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const boundary = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ResourceSyncClientError(0, 'APP_RESOURCE_SYNC_TIMEOUT'));
      }, timeout);
      abortHandler = () => {
        controller.abort();
        reject(new ResourceSyncClientError(0, 'APP_RESOURCE_SYNC_ABORTED'));
      };
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener('abort', abortHandler, { once: true });
    });
    const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, boundary]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const destination = new URL(url);
      destination.pathname = `${url.pathname.replace(/\/$/u, '')}/${operation}`;
      const response = await bounded(fetcher(destination, {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { authorization: `AppRuntime ${credential.session_token}`,
          'content-type': binaryBody ? 'application/vnd.deft.sync-attachment.v1' : 'application/json' }, body: typeof body === 'string' ? body : new Uint8Array(body).buffer,
      }));
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (response.redirected || contentType !== 'application/json') {
        throw new ResourceSyncClientError(response.status, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared)
        || Number(declared) > MAX_TRANSPORT_BYTES)) {
        throw new ResourceSyncClientError(response.status, 'APP_RESOURCE_SYNC_RESPONSE_TOO_LARGE');
      }
      reader = response.body?.getReader();
      if (!reader) throw new ResourceSyncClientError(response.status, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await bounded(reader.read());
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_TRANSPORT_BYTES) {
          throw new ResourceSyncClientError(response.status, 'APP_RESOURCE_SYNC_RESPONSE_TOO_LARGE');
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new ResourceSyncClientError(response.status, 'APP_RESOURCE_SYNC_INVALID_RESPONSE'); }
      if (!response.ok) {
        const failure = ResourceSyncErrorSchema.safeParse(payload);
        throw new ResourceSyncClientError(response.status,
          failure.success ? failure.data.code : 'APP_RESOURCE_SYNC_FAILURE');
      }
      return payload;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      if (reader) void reader.cancel().catch(() => {});
      controller.abort();
    }
  }

  return post;
}
