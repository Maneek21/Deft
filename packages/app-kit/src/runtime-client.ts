/** A credential-scoped transport for the host-reviewed App Runtime channel.
 * This module does not mint sessions or retry effects. The host issues a
 * short-lived App Runtime credential to the named operator separately. */
export type AppRuntimeCredential = Readonly<{
  session_id: string;
  session_token: string;
}>;
export type AppRuntimeRenewal = Readonly<{session_id:string;expires_at:string;renewable_until:string}>;

export type AppRuntimeClaim = Readonly<{
  schema_version: 'deft.app_runtime_channel.v1';
  run_id: string;
  attempt_id: string;
  claim_token: string;
  sequence: number;
  operation_name: string;
  provider_idempotency_key?: string;
  lease_expires_at: string;
  /** Current host-authenticated pins. Older hosts may omit these; consumers
   * that require owner/scoped resource reads must require and validate them. */
  initiating_actor_type?: string;
  initiating_actor_id?: string;
  org_id?: string;
  app_installation_id?: string;
  app_version_id?: string;
  grant_snapshot_id?: string;
  lifecycle_epoch?: number;
  grant_epoch?: number;
  runtime_registration_id?: string;
  runtime_binding_id?: string;
  runtime_epoch?: number;
  session_id?: string;
  session_epoch?: number;
  audience?: 'app_runtime';
}>;

export type AppRuntimeStarted = Readonly<{
  schema_version: 'deft.app_runtime_channel.v1';
  run_id: string;
  attempt_id: string;
  input: unknown;
  snapshot_ref?: AppRuntimePayloadReference;
  provider_idempotency_key?: string;
  lease_expires_at: string;
}>;
export type AppRuntimeAuthority = Readonly<{
  schema_version: 'deft.app_runtime_authority.v1'; run_id: string; attempt_id: string;
  org_id: string; owner_id: string; app_installation_id: string; app_version_id: string;
  grant_snapshot_id: string; lifecycle_epoch: number; grant_epoch: number;
  runtime_registration_id: string; runtime_binding_id: string; runtime_epoch: number;
  session_id: string; session_epoch: number; audience: 'app_runtime';
  operation_name: string; input: unknown; input_digest: string; lease_expires_at: string;
}>;
export type AppRuntimePayloadReference = Readonly<{ snapshot_id: string; digest: string }>;
export type AppRuntimePayloadMetadata = Readonly<{ ref: AppRuntimePayloadReference; binding: Record<string, unknown>;
  metadata: Record<string, unknown>; file_refs: readonly Record<string, unknown>[];
  expires_at: string; byte_count: number; bytes_digest: string }>;
export type AppRuntimeActionResources = Readonly<{ schema_version: 'deft.app_action_resources.v1';
  scope: Readonly<{ org_id: string; owner_id: string; installation_id: string }>;
  resource_binding_id: string; resource_key: string; input_key: string;
  records: readonly Readonly<{ record_id: string; label: string; revision: string; data: Readonly<Record<string, string | number | boolean>>;provider_source?:Readonly<Record<string,unknown>> }>[] }>;

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
  action_payload_version?: 'deft.app_action_payload.v1';
  action_resources_version?: 'deft.app_action_resources.v1';
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
  if (options.action_payload_version !== undefined && options.action_payload_version !== 'deft.app_action_payload.v1') throw new TypeError('Unsupported action payload version');
  if (options.action_resources_version !== undefined && options.action_resources_version !== 'deft.app_action_resources.v1') throw new TypeError('Unsupported action resources version');

  async function post<T>(operation: 'claim' | 'start' | 'heartbeat' | 'authorize' | 'result' | 'payload' | 'resources' | 'renew', body: Record<string, unknown>, binaryLimit?: number, signal?:AbortSignal): Promise<T> {
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/$/, '')}/${operation}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const activeSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try {
      activeSignal.throwIfAborted();
      const response = await fetcher(url, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal: activeSignal,
        headers: {
          authorization: `AppRuntime ${options.credential.session_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ schema_version: VERSION, session_id: options.credential.session_id, ...body }),
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      const limit = operation==='renew'?4096:binaryLimit ?? MAX_RESPONSE_BYTES;
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit) {
        throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_RESPONSE_TOO_LARGE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_EMPTY_RESPONSE');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const aborted=()=>{void reader.cancel(activeSignal.reason).catch(()=>{});};
      if(operation==='renew')activeSignal.addEventListener('abort',aborted,{once:true});
      try {
        while (true) {
          if(operation==='renew')activeSignal.throwIfAborted();
          const next = await reader.read();
          if(operation==='renew')activeSignal.throwIfAborted();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { activeSignal.removeEventListener('abort',aborted);reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (binaryLimit && response.ok) {
        const ref = body.snapshot_ref as AppRuntimePayloadReference;
        const digest = response.headers.get('x-deft-payload-digest');
        if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/octet-stream'
          || response.headers.get('x-deft-snapshot-id') !== ref.snapshot_id
          || response.headers.get('x-deft-snapshot-digest') !== ref.digest || !digest || !/^[0-9a-f]{64}$/.test(digest)
          || (response.headers.has('content-length') && declared !== size)) throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_INVALID_PAYLOAD');
        const observed = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
        if (observed !== digest) throw new AppRuntimeClientError(response.status, 'APP_RUNTIME_PAYLOAD_DIGEST_MISMATCH');
        return bytes as T;
      }
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
  function payloadFields(claim: AppRuntimeClaim, ref: AppRuntimePayloadReference, part: Record<string, unknown>) {
    if (options.action_payload_version !== 'deft.app_action_payload.v1') throw new TypeError('Action payload transport is not enabled');
    if (!/^[0-9a-f-]{36}$/i.test(ref.snapshot_id) || !/^[0-9a-f]{64}$/.test(ref.digest)) throw new TypeError('Invalid action payload reference');
    return { ...claimFields(claim), snapshot_ref: { snapshot_id: ref.snapshot_id, digest: ref.digest }, part };
  }

  return Object.freeze({
    async renew(input:Readonly<{expected_expires_at:string}>,signal?:AbortSignal):Promise<AppRuntimeRenewal>{
      const iso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)&&Number.isFinite(Date.parse(value));
      if(!input||Object.keys(input).length!==1||!iso(input.expected_expires_at))throw new TypeError('Invalid Runtime renewal');
      const reply=await post<{renewed:AppRuntimeRenewal}>('renew',{expected_expires_at:input.expected_expires_at},undefined,signal),value=reply.renewed;
      signal?.throwIfAborted();
      if(Object.keys(reply).length!==1||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expires_at,renewable_until,session_id'
        ||value.session_id!==options.credential.session_id||!iso(value.expires_at)||!iso(value.renewable_until)
        ||Date.parse(value.expires_at)<Date.parse(input.expected_expires_at)||Date.parse(value.expires_at)>Date.parse(value.renewable_until)||Date.parse(value.expires_at)<=Date.now())throw new AppRuntimeClientError(200,'APP_RUNTIME_INVALID_RENEWAL');
      return Object.freeze({...value});
    },
    async claim(): Promise<AppRuntimeClaim | null> {
      const reply = await post<{ claim: AppRuntimeClaim | null }>('claim', { max_claims: 1 });
      return reply.claim;
    },
    async start(claim: AppRuntimeClaim): Promise<AppRuntimeStarted> {
      const reply = await post<{ started: AppRuntimeStarted }>('start', { ...claimFields(claim),
        ...(options.action_payload_version ? { action_payload_version: options.action_payload_version } : {}) });
      return reply.started;
    },
    /** Current host authority for the exact started human attempt. Does not
     * renew its lease. The runtime must compare the input digest and its own
     * immutable prepared payload before performing any effect. */
    async authorize(claim: AppRuntimeClaim): Promise<AppRuntimeAuthority> {
      const reply = await post<{ authorized: AppRuntimeAuthority }>('authorize', claimFields(claim));
      const value = reply.authorized;
      const allowed = ['schema_version','run_id','attempt_id','org_id','owner_id','app_installation_id','app_version_id',
        'grant_snapshot_id','lifecycle_epoch','grant_epoch','runtime_registration_id','runtime_binding_id','runtime_epoch',
        'session_id','session_epoch','audience','operation_name','input','input_digest','lease_expires_at'];
      const identities = ['org_id','owner_id','app_installation_id','app_version_id','grant_snapshot_id',
        'runtime_registration_id','runtime_binding_id','session_id'] as const;
      const epochs = ['lifecycle_epoch','grant_epoch','runtime_epoch','session_epoch'] as const;
      if (!value || value.schema_version !== 'deft.app_runtime_authority.v1' || value.audience !== 'app_runtime'
        || Object.keys(value).some(key => !allowed.includes(key)) || Object.keys(value).length !== allowed.length
        || value.run_id !== claim.run_id || value.attempt_id !== claim.attempt_id
        || value.session_id !== options.credential.session_id || value.operation_name !== claim.operation_name
        || identities.some(key => typeof value[key] !== 'string' || !/^[0-9a-f-]{36}$/i.test(value[key]))
        || epochs.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
        || !/^sha256:[0-9a-f]{64}$/.test(value.input_digest)
        || !Number.isFinite(Date.parse(value.lease_expires_at)) || Date.parse(value.lease_expires_at) <= Date.now()
        || claim.initiating_actor_type !== undefined && claim.initiating_actor_type !== 'human'
        || claim.initiating_actor_id !== undefined && claim.initiating_actor_id !== value.owner_id
        || ['org_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch',
          'runtime_registration_id','runtime_binding_id','runtime_epoch','session_id','session_epoch'].some(
            key => claim[key as keyof AppRuntimeClaim] !== undefined
              && claim[key as keyof AppRuntimeClaim] !== value[key as keyof AppRuntimeAuthority]))
        throw new AppRuntimeClientError(200, 'APP_RUNTIME_INVALID_AUTHORITY');
      const input = value.input as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 32
        || Object.entries(input).some(([key, field]) => !/^[a-z][a-z0-9_]{0,47}$/.test(key)
          || ['constructor', 'prototype', '__proto__'].includes(key)
          || (typeof field === 'string' ? field.length > 16384 : typeof field === 'number'
            ? !Number.isFinite(field) : typeof field !== 'boolean')))
        throw new AppRuntimeClientError(200, 'APP_RUNTIME_INVALID_AUTHORITY');
      const canonical = JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key => [key, input[key]])));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (`sha256:${digest}` !== value.input_digest || Date.parse(value.lease_expires_at) <= Date.now())
        throw new AppRuntimeClientError(200, 'APP_RUNTIME_INVALID_AUTHORITY');
      return value;
    },
    /** Read only the exact owner-private records named by a reviewed source
     * field of this already started human action, never arbitrary locators. */
    async readActionResources(claim: AppRuntimeClaim, input: { input_key: string }): Promise<AppRuntimeActionResources> {
      if (options.action_resources_version !== 'deft.app_action_resources.v1'
        || Object.keys(input).join(',') !== 'input_key' || !/^[a-z][a-z0-9_]{0,47}$/.test(input.input_key))
        throw new TypeError('Action resource transport is not enabled');
      const reply = await post<{ resources: AppRuntimeActionResources }>('resources', { ...claimFields(claim),
        action_resources_version: options.action_resources_version, input_key: input.input_key });
      const value = reply.resources;
      if (!value || value.schema_version !== options.action_resources_version || value.input_key !== input.input_key
        || !value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)
        || Object.keys(value.scope).sort().join(',') !== 'installation_id,org_id,owner_id'
        || Object.values(value.scope).some(field => typeof field !== 'string' || !/^[0-9a-f-]{36}$/i.test(field))
        || Object.keys(value).sort().join(',') !== 'input_key,records,resource_binding_id,resource_key,schema_version,scope'
        || !/^[a-z][a-z0-9_]{0,47}$/.test(value.resource_key)
        || !/^[0-9a-f-]{36}$/i.test(value.resource_binding_id) || !Array.isArray(value.records)
        || value.records.length < 1 || value.records.length > 25
        || value.records.some(row => !row || typeof row !== 'object' || Array.isArray(row)
          || Object.keys(row).sort().join(',') !== (row.provider_source?'data,label,provider_source,record_id,revision':'data,label,record_id,revision')
          || !/^[0-9a-f-]{36}$/i.test(row.record_id) || typeof row.label !== 'string' || row.label.length > 200
          || typeof row.revision !== 'string' || row.revision.length > 2048 || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)
          || Object.keys(row.data).length > 32 || Object.values(row.data).some(field => !['string', 'number', 'boolean'].includes(typeof field))
          || row.provider_source!==undefined&&(!row.provider_source||typeof row.provider_source!=='object'||Array.isArray(row.provider_source)||Object.keys(row.provider_source).length>16||new TextEncoder().encode(JSON.stringify(row.provider_source)).byteLength>8192)))
        throw new AppRuntimeClientError(200, 'APP_RUNTIME_INVALID_RESOURCES');
      if (new Set(value.records.map(row => row.record_id.toLowerCase())).size !== value.records.length)
        throw new AppRuntimeClientError(200, 'APP_RUNTIME_INVALID_RESOURCES');
      return value;
    },
    async payloadMetadata(claim: AppRuntimeClaim, ref: AppRuntimePayloadReference): Promise<AppRuntimePayloadMetadata> {
      const reply = await post<{ payload: AppRuntimePayloadMetadata }>('payload', payloadFields(claim, ref, { kind: 'metadata' }));
      const value = reply.payload;
      if (!value || value.ref?.snapshot_id !== ref.snapshot_id || value.ref.digest !== ref.digest
        || !Number.isInteger(value.byte_count) || value.byte_count < 1 || value.byte_count > 8388608
        || !/^[0-9a-f]{64}$/.test(value.bytes_digest) || !Number.isFinite(Date.parse(value.expires_at))
        || !value.binding || !value.metadata || !Array.isArray(value.file_refs)) throw new AppRuntimeClientError(200, 'APP_RUNTIME_INVALID_PAYLOAD');
      return value;
    },
    payloadBytes(claim: AppRuntimeClaim, ref: AppRuntimePayloadReference): Promise<Uint8Array> {
      return post<Uint8Array>('payload', payloadFields(claim, ref, { kind: 'bytes' }), 8388608);
    },
    fileBytes(claim: AppRuntimeClaim, ref: AppRuntimePayloadReference, fileId: string): Promise<Uint8Array> {
      if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new TypeError('Invalid private file reference');
      return post<Uint8Array>('payload', payloadFields(claim, ref, { kind: 'file', file_id: fileId }), 2097152);
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
