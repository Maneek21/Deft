/** A credential-scoped transport for the host-reviewed App Runtime channel.
 * This module does not mint sessions or retry effects. The host issues a
 * short-lived App Runtime credential to the named operator separately. */
export type AppRuntimeCredential = Readonly<{
  session_id: string;
  session_token: string;
}>;

export type AppRuntimeClaim = Readonly<{
  schema_version: 'deft.app_runtime_channel.v1';
  run_id: string;
  attempt_id: string;
  claim_token: string;
  sequence: number;
  operation_name: string;
  provider_idempotency_key?: string;
  lease_expires_at: string;
}>;

export type AppRuntimeStarted = Readonly<{
  schema_version: 'deft.app_runtime_channel.v1';
  run_id: string;
  attempt_id: string;
  input: unknown;
  provider_idempotency_key?: string;
  lease_expires_at: string;
}>;

export type AppRuntimeResult =
  | Readonly<{ status: 'returned'; provider_succeeded: boolean; output: unknown }>
  | Readonly<{ status: 'not_attempted'; error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' | 'APP_RUN_PROVIDER_TIMEOUT' }>
  | Readonly<{ status: 'indeterminate' }>;

export type AppRuntimeClientOptions = Readonly<{
  /** Full channel route prefix, for example https://host/api/app-runtime/channel. */
  channel_url: string;
  credential: AppRuntimeCredential;
  fetch?: typeof globalThis.fetch;
  timeout_ms?: number;
}>;

const VERSION = 'deft.app_runtime_channel.v1' as const;
const MAX_RESPONSE_BYTES = 1_100_000;

export class AppRuntimeClientError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`App Runtime channel request failed: ${code}`);
    this.name = 'AppRuntimeClientError';
  }
}

export function createAppRuntimeClient(options: AppRuntimeClientOptions) {
  const base = new URL(options.channel_url);
  if (base.username || base.password || base.search || base.hash
    || (base.protocol !== 'https:' && !(base.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new TypeError('Runtime channel URL must be HTTPS or loopback HTTP without credentials');
  }
  if (!options.credential.session_id || !/^[A-Za-z0-9_-]{32,512}$/.test(options.credential.session_token)) {
    throw new TypeError('Invalid App Runtime credential');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeout = options.timeout_ms ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new TypeError('Invalid App Runtime request deadline');
  }

  async function post<T>(operation: 'claim' | 'start' | 'heartbeat' | 'result', body: Record<string, unknown>): Promise<T> {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${operation}`, base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetcher(url, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `AppRuntime ${options.credential.session_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ schema_version: VERSION, session_id: options.credential.session_id, ...body }),
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
        throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_RESPONSE_TOO_LARGE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_EMPTY_RESPONSE');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_INVALID_RESPONSE');
      }
      const result = payload as Record<string, unknown>;
      if (!response.ok) {
        throw new AppRuntimeClientError(response.status,
          typeof result.code === 'string' ? result.code : 'APP_RUNTIME_REQUEST_FAILED');
      }
      return result as T;
    } finally { clearTimeout(timer); }
  }

  function claimFields(claim: AppRuntimeClaim) {
    if (claim.schema_version !== VERSION) throw new TypeError('Unsupported App Runtime claim version');
    return { run_id: claim.run_id, attempt_id: claim.attempt_id,
      claim_token: claim.claim_token, sequence: claim.sequence };
  }

  return Object.freeze({
    async claim(): Promise<AppRuntimeClaim | null> {
      const reply = await post<{ claim: AppRuntimeClaim | null }>('claim', { max_claims: 1 });
      return reply.claim;
    },
    async start(claim: AppRuntimeClaim): Promise<AppRuntimeStarted> {
      const reply = await post<{ started: AppRuntimeStarted }>('start', claimFields(claim));
      return reply.started;
    },
    async heartbeat(claim: AppRuntimeClaim): Promise<boolean> {
      const reply = await post<{ renewed: boolean }>('heartbeat', claimFields(claim));
      return reply.renewed === true;
    },
    async result(claim: AppRuntimeClaim, result: AppRuntimeResult): Promise<unknown> {
      const reply = await post<{ run: unknown }>('result', { ...claimFields(claim), ...result });
      return reply.run;
    },
  });
}
