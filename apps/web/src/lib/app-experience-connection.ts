export type ExperienceAuthorityState = 'available' | 'unavailable' | 'denied';
export class ExperienceAuthorityUnavailable extends Error {
  readonly retryable = true;
  constructor() { super('App connection is temporarily unavailable.'); }
}
export function isExperienceAuthorityUnavailable(error: unknown): boolean {
  return error instanceof ExperienceAuthorityUnavailable || error instanceof TypeError
    || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
}
export function experienceAuthorityResponse(response: Response | null): 'available' | 'unavailable' | 'denied' {
  if (!response || [408, 429].includes(response.status) || response.status >= 500) return 'unavailable';
  return response.ok ? 'available' : 'denied';
}
/** No cached permission: every check reads live authority. Uncertainty never releases a broker call. */
export function createExperienceConnection(input: {
  current: () => boolean; valid: () => boolean;
  read: () => Promise<ExperienceAuthorityState>; change: (state: ExperienceAuthorityState) => void;
}) {
  let state: ExperienceAuthorityState = 'unavailable', pending: Promise<ExperienceAuthorityState> | null = null;
  const waiters = new Set<(valid: boolean) => void>();let disposed = false;
  const release = (valid:boolean) => { for(const finish of [...waiters]) finish(valid); };
  const current = () => !disposed && input.current();
  const settle = (next: ExperienceAuthorityState) => {
    if (!current()) next = 'denied';
    if (state === 'denied') return state;
    state = next; input.change(next);
    if (next !== 'unavailable') { release(next === 'available'); }
    return next;
  };
  const check = async (): Promise<ExperienceAuthorityState> => {
    if (!current()) return settle('denied');
    if (state === 'denied') return state;
    if (!pending) pending = (async () => {
      let result: ExperienceAuthorityState;
      try { result = await input.read(); } catch { result = 'unavailable'; }
      if (result === 'available' && !input.valid()) result = 'denied';
      return settle(result);
    })().finally(() => { pending = null; });
    return pending;
  };
  return {
    get state() { return state; }, check,
    async ensure(signal?:AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      await check();
      signal?.throwIfAborted();
      if (!current() || state === 'denied') return false;
      if (state === 'available') return input.valid();
      const resumed = await new Promise<boolean>(resolve=>{
        const finish=(valid:boolean)=>{waiters.delete(finish);signal?.removeEventListener('abort',aborted);resolve(valid);};
        const aborted=()=>finish(false);waiters.add(finish);signal?.addEventListener('abort',aborted,{once:true});
        if(signal?.aborted)aborted();
      });
      signal?.throwIfAborted();
      return resumed && current() && input.valid() && (state as ExperienceAuthorityState) === 'available';
    },
    dispose() { disposed = true; state = 'denied'; release(false); },
  };
}
