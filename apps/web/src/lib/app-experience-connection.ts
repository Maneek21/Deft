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
  let recovery: Promise<boolean> | null = null, release: ((valid: boolean) => void) | null = null, disposed = false;
  const current = () => !disposed && input.current();
  const settle = (next: ExperienceAuthorityState) => {
    if (!current()) next = 'denied';
    if (state === 'denied') return state;
    state = next; input.change(next);
    if (next !== 'unavailable') { release?.(next === 'available'); recovery = null; release = null; }
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
    async ensure(): Promise<boolean> {
      await check();
      if (!current() || state === 'denied') return false;
      if (state === 'available') return input.valid();
      if (!recovery) recovery = new Promise(resolve => { release = resolve; });
      const resumed = await recovery;
      return resumed && current() && input.valid() && (state as ExperienceAuthorityState) === 'available';
    },
    dispose() { disposed = true; state = 'denied'; release?.(false); recovery = null; release = null; },
  };
}
