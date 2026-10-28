/**
 * Minimal App Router boundary for the mounted chat tests. It mirrors the
 * production contract the chat surfaces rely on: a stable router object,
 * `useSearchParams` that re-renders after push/replace/popstate, and a URL that
 * always reflects the last navigation (never rewritten by the harness).
 */
'use client';

import { useMemo, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function navigateClient(url: string, mode: 'push' | 'replace') {
  // Next's App Router commits the new URL after the navigation transition, not
  // inside the click handler. Deferring one tick reproduces that window so the
  // tests can catch state that races the URL update.
  const next = new URL(url, window.location.href);
  setTimeout(() => {
    if (mode === 'replace') window.history.replaceState(window.history.state, '', next);
    else window.history.pushState(window.history.state, '', next);
    notify();
  }, 0);
}

const router = {
  push: (url: string) => navigateClient(url, 'push'),
  replace: (url: string) => navigateClient(url, 'replace'),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => notify(),
  prefetch: () => {},
};

export function useRouter() {
  return router;
}

export function useSearchParams() {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => '');
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname, () => '/');
}

export function useParams() {
  return {};
}

declare global {
  interface Window {
    __deftRouter?: typeof router;
  }
}

if (typeof window !== 'undefined') {
  window.__deftRouter = router;
  window.addEventListener('popstate', notify);
}
