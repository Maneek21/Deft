'use client';

/**
 * useLayoutStorage — per-user persistent layout state.
 *
 * Layout is stored in localStorage under `dashboard4:layout:${userId}`.
 * If no saved layout exists (or parsing fails), we fall back to the default
 * layout for the user's role.
 *
 * We hydrate after mount to avoid SSR/CSR mismatch, then emit the loaded
 * layout. Until then, callers render the default layout.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DashboardLayout } from './widget-types';
import { buildDefaultLayout } from '../grid/default-layout';

const storageKey = (userId: string) => `dashboard4:layout:${userId}`;

function safeParse(raw: string | null): DashboardLayout | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DashboardLayout;
    if (parsed?.version !== 1 || !Array.isArray(parsed.placements)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function useLayoutStorage(userId: string | undefined, isManager: boolean) {
  const [layout, setLayout] = useState<DashboardLayout>(() => buildDefaultLayout(isManager));
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const saved = safeParse(localStorage.getItem(storageKey(userId)));
    if (saved) setLayout(saved);
    setHydrated(true);
  }, [userId]);

  const persist = useCallback((next: DashboardLayout) => {
    setLayout(next);
    if (userId) {
      try { localStorage.setItem(storageKey(userId), JSON.stringify(next)); } catch {}
    }
  }, [userId]);

  const reset = useCallback(() => {
    const fresh = buildDefaultLayout(isManager);
    setLayout(fresh);
    if (userId) {
      try { localStorage.removeItem(storageKey(userId)); } catch {}
    }
  }, [userId, isManager]);

  return { layout, setLayout: persist, reset, hydrated };
}
