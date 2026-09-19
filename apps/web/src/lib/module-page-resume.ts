import { getActiveSessionCacheScope } from './session-cache';

/** Resume refreshes use the infinite controller so every loaded page is refreshed. */
export function subscribeModulePageResume(
  session: string | null,
  revalidate: () => Promise<unknown>,
  browser: EventTarget,
  page: EventTarget & { visibilityState: string },
  now: () => number = Date.now,
): () => void {
  let lastRefresh = -Infinity;
  const refresh = () => {
    if (!session || getActiveSessionCacheScope() !== session || page.visibilityState !== 'visible') return;
    const timestamp = now();
    if (timestamp - lastRefresh < 5_000) return;
    lastRefresh = timestamp;
    void revalidate().catch(() => undefined); // SWR retains the error for the caller.
  };
  browser.addEventListener('focus', refresh);
  browser.addEventListener('online', refresh);
  page.addEventListener('visibilitychange', refresh);
  return () => {
    browser.removeEventListener('focus', refresh);
    browser.removeEventListener('online', refresh);
    page.removeEventListener('visibilitychange', refresh);
  };
}
