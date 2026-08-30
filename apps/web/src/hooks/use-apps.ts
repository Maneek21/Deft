'use client';

import { useEffect, useMemo } from 'react';
import useSWR, { mutate as mutateSWR } from 'swr';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { normalizeAppsResponse } from '@/lib/apps';
import { APPS_ENABLED } from '@/lib/feature-flags';
import type { AppNavigationResponseItem } from '@/lib/app-navigation';

async function fetchJson(path: string): Promise<unknown> {
  const response = await api.get(path);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load Apps.');
  }
  return response.json();
}

export function useApps(enabled = true) {
  const swr = useSWR<unknown>(APPS_ENABLED && enabled ? '/api/apps' : null, fetchJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const apps = useMemo(() => normalizeAppsResponse(swr.data ?? { apps: [] }), [swr.data]);
  return { ...swr, apps };
}

export function useAppNavigation(enabled = true) {
  const swr = useSWR<unknown>(APPS_ENABLED && enabled ? '/api/apps/navigation' : null, fetchJson);
  const navigation = useMemo(() => {
    const value = swr.data as { navigation?: unknown } | undefined;
    return Array.isArray(value?.navigation) ? value.navigation as AppNavigationResponseItem[] : [];
  }, [swr.data]);
  return { ...swr, navigation };
}

export async function refreshApps(): Promise<void> {
  await mutateSWR((key) => typeof key === 'string' && key.startsWith('/api/apps'));
}

export function useAppRealtime() {
  useEffect(() => {
    if (!APPS_ENABLED) return;
    const token = window.localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const refresh = () => void refreshApps();
    socket.on('app:changed', refresh);
    return () => { socket.off('app:changed', refresh); };
  }, []);
}
