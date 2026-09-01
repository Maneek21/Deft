'use client';

import { useEffect, useMemo } from 'react';
import useSWR, { mutate as mutateSWR } from 'swr';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import {
  normalizeAppConnectors,
  normalizeAppGrantManagement,
  normalizeAppsResponse,
  type AppConnector,
  type AppGrantManagement,
} from '@/lib/apps';
import { APPS_ENABLED } from '@/lib/feature-flags';
import type { AppNavigationResponseItem } from '@/lib/app-navigation';
import { normalizeAppAutomationManagement } from '@/lib/app-automations';

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

export function useAppGrantManagement(installationId: string, enabled = true) {
  const key = APPS_ENABLED && enabled && installationId
    ? `/api/apps/${encodeURIComponent(installationId)}/grants`
    : null;
  const swr = useSWR<unknown>(key, fetchJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: 10_000,
  });
  const normalized = useMemo<{ grants: AppGrantManagement | null; error: Error | null }>(() => {
    if (!swr.data) return { grants: null, error: null };
    try {
      return { grants: normalizeAppGrantManagement(swr.data), error: null };
    } catch (error) {
      return { grants: null, error: error instanceof Error ? error : new Error('Invalid App grant response.') };
    }
  }, [swr.data]);
  return { ...swr, grants: normalized.grants, error: swr.error ?? normalized.error };
}

export function useAppConnectors(enabled = true) {
  const swr = useSWR<unknown>(APPS_ENABLED && enabled ? '/api/mcp-connections' : null, fetchJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const normalized = useMemo<{ connectors: AppConnector[]; error: Error | null }>(() => {
    if (!swr.data) return { connectors: [], error: null };
    try {
      return { connectors: normalizeAppConnectors(swr.data), error: null };
    } catch (error) {
      return { connectors: [], error: error instanceof Error ? error : new Error('Invalid connector response.') };
    }
  }, [swr.data]);
  return { ...swr, connectors: normalized.connectors, error: swr.error ?? normalized.error };
}

export function useAppAutomations(installationId: string, enabled = true) {
  const key = APPS_ENABLED && enabled && installationId
    ? `/api/apps/${encodeURIComponent(installationId)}/automations`
    : null;
  const swr = useSWR<unknown>(key, fetchJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: 10_000,
  });
  const normalized = useMemo(() => {
    if (!swr.data) return { automations: null, error: null };
    try {
      return { automations: normalizeAppAutomationManagement(swr.data), error: null };
    } catch (error) {
      return {
        automations: null,
        error: error instanceof Error ? error : new Error('Invalid App automation response.'),
      };
    }
  }, [swr.data]);
  return { ...swr, automations: normalized.automations, error: swr.error ?? normalized.error };
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
