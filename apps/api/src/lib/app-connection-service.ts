import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './app-errors.js';
import { AppConnectionCallbackSchema, AppConnectionManageSchema, type AppConnectionPins, type AppConnectionProjection, type AppConnectionPurpose } from './app-connection-contract.js';
import { AppConnectionRegistry } from './app-connection-registry.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { completeNativeEmailConnection, type EmailConnectionCompletion } from './email-mailbox-connection-completion.js';

export interface AppConnectionAuthority {
  connectionSetup(caller: ExperienceCaller, sessionId: string, pins: AppConnectionPins, signal?: AbortSignal, purpose?: AppConnectionPurpose): Promise<AppConnectionProjection>;
  connectionCleanup?(caller:ExperienceCaller,pins:AppConnectionPins,signal?:AbortSignal,purpose?:'status'|'disconnect'):Promise<AppConnectionProjection>;
}
const sameProjection = (left: AppConnectionProjection, right: AppConnectionProjection) => {
  const keys = (projection: AppConnectionProjection) => Object.keys(projection)
    .filter(key => key !== 'checked_at' && key !== 'expires_at').sort();
  return isDeepStrictEqual(keys(left), keys(right)) && Object.entries(left).every(([key, value]) => {
    if (key === 'checked_at' || key === 'expires_at') return true;
    const current = right[key as keyof AppConnectionProjection];
    // Each authority check derives a new policy object. Equal reviewed values
    // remain current; any nested disclosure or policy-presence change does not.
    if (key === 'content_policy') return isDeepStrictEqual(value, current);
    return Array.isArray(value) && Array.isArray(current)
      ? [...value].sort().join(',') === [...current].sort().join(',') : value === current;
  });
};

const MAX_CONNECTION_IO_MS = 30_000;
const accessEnded = () => new AppError('Account connection access ended', 'APP_ACCESS_DENIED', 403);
const responseUnavailable = () => new AppError('Account connection response is unavailable', 'APP_PROVIDER_UNAVAILABLE', 503);

/** Bound completion even when module work ignores its request signal. Late work
 * retains the aborted signal and may never disclose its result. */
async function boundedConnectionIo<T>(remaining: number, deadlineError: AppError, caller: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  caller?.throwIfAborted();
  if (remaining <= 0) throw deadlineError;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(caller?.reason);
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  caller?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(deadlineError), Math.max(1, Math.min(remaining, MAX_CONNECTION_IO_MS)));
  try {
    if (caller?.aborted) forwardAbort();
    const work = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); });
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

async function responseJson(response: Response, signal: AbortSignal) {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => undefined);
    throw responseUnavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw responseUnavailable();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > 65_536) {
        throw responseUnavailable();
      }
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    cancel();
    signal.throwIfAborted();
    throw responseUnavailable();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
export class AppConnectionService {
  constructor(private readonly registry: AppConnectionRegistry, private readonly authority: AppConnectionAuthority,
    private readonly now = () => Date.now(), private readonly monotonic = () => performance.now(),
    private readonly complete: EmailConnectionCompletion = completeNativeEmailConnection) {}
  async retainedTargets(caller:ExperienceCaller,installationId:string,signal?:AbortSignal){
    z.string().uuid().parse(installationId);if(!this.authority.connectionCleanup)throw accessEnded();
    const targets:{key:string}[]=[];
    for(const entry of this.registry.retainedOwnerEntries({org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:installationId})){
      await this.authority.connectionCleanup(caller,entry.pins,signal,'status');
      if(targets.some(target=>target.key===entry.pins.target_key))throw accessEnded();
      targets.push({key:entry.pins.target_key});
    }
    return{targets};
  }
  /** Session-free owner cleanup; the JSON body admits only status/disconnect. */
  async invokeRetained(caller:ExperienceCaller,nomination:{installation_id:string;target_key:string},raw:unknown,origin:string|undefined,signal?:AbortSignal){
    AppConnectionManageSchema.parse(raw);
    if(!this.authority.connectionCleanup)throw accessEnded();
    const authority=this.authority;
    return new AppConnectionService(this.registry,{connectionSetup:(_caller,_session,pins,activeSignal,purpose)=>{
      if(purpose!=='status'&&purpose!=='disconnect')throw accessEnded();
      return authority.connectionCleanup!(caller,pins,activeSignal,purpose);
    }},this.now,this.monotonic,this.complete).invoke(caller,caller.sid,nomination,'manage',raw,origin,signal);
  }
  async invoke(caller: ExperienceCaller, sessionId: string, nomination: { installation_id: string; target_key: string },
    operation: 'begin' | 'callback' | 'manage', raw: unknown, origin: string | undefined, signal?: AbortSignal) {
    const entry = this.registry.select({ org_id: caller.org_id, owner_user_id: caller.user_id, ...nomination });
    const management = operation === 'manage' ? AppConnectionManageSchema.parse(raw) : undefined;
    const body = operation === 'begin' ? z.strictObject({}).parse(raw)
      : operation === 'callback' ? AppConnectionCallbackSchema.parse(raw) : management!;
    const purpose: AppConnectionPurpose = management ? management.operation ?? 'status' : 'connect';
    const projection = await this.authority.connectionSetup(caller, sessionId, entry.pins, signal, purpose);
    if (projection.purpose !== purpose) throw new AppError('Account connection access changed', 'APP_ACCESS_DENIED', 403);
    const receivedAt = this.monotonic();
    const remaining = () => projection.expires_at - Math.max(this.now(), projection.checked_at + Math.max(0, this.monotonic() - receivedAt));
    const stillCurrent = (activeSignal = signal) => {
      activeSignal?.throwIfAborted();
      if (projection.expires_at <= Math.max(this.now(), projection.checked_at + Math.max(0, this.monotonic() - receivedAt))) {
        throw accessEnded();
      }
    };
    stillCurrent();
    const duration = remaining();
    return boundedConnectionIo(duration, duration <= MAX_CONNECTION_IO_MS ? accessEnded() : responseUnavailable(), signal, async activeSignal => {
      const recheck = async () => {
        const current = await this.authority.connectionSetup(caller, sessionId, entry.pins, activeSignal, purpose);
        if (!sameProjection(projection, current)) throw new AppError('Account connection access changed', 'APP_ACCESS_DENIED', 403);
        stillCurrent(activeSignal);
        return current;
      };
      const url = new URL(`/connections/${operation}`, 'https://deft-connection.invalid');
      if (operation === 'callback') for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
      const headers = new Headers({ 'content-type': 'application/json' });
      if (origin) headers.set('origin', origin);
      // Never forward the web bearer or cookies to adapter code.
      const request = new Request(url, { method: operation === 'callback' ? 'GET' : 'POST', headers,
        ...(operation === 'callback' ? {} : { body: JSON.stringify(body) }), signal: activeSignal });
      const response = await entry.adapter.handle(request, Object.freeze({ projection, recheck }));
      const result: unknown = await responseJson(response, activeSignal);
      await recheck();
      stillCurrent(activeSignal);
      if (!response.ok) {
        const parsed = z.strictObject({ error: z.string().max(200), code: z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/) }).safeParse(result);
        const status = response.status === 400 ? 400 : response.status === 403 ? 403 : 503;
        throw new AppError('Account connection needs attention', status === 400 ? 'APP_ACTION_INVALID' : status === 403 ? 'APP_ACCESS_DENIED' : 'APP_PROVIDER_UNAVAILABLE', status,
          parsed.success ? { connection_code: parsed.data.code } : undefined);
      }
      const completed = await this.complete({ caller, entry, operation, purpose, result, signal: activeSignal });
      if (completed !== result) await recheck();
      stillCurrent(activeSignal);
      return completed;
    });
  }
}
