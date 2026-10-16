/** Coalesce only in-flight reads; every later call reads fresh authority. */
export function createExperienceLiveCheck(input: { current: () => boolean; valid: () => boolean; check: () => Promise<boolean> }) {
  let pending: Promise<boolean> | null = null;
  return async (): Promise<boolean> => {
    if (!input.current()) return false;
    if (!pending) pending = Promise.resolve().then(input.check).catch(() => false).finally(() => { pending = null; });
    const result = await pending;
    return input.current() && input.valid() && result;
  };
}
