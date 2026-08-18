'use client';

import { useEffect, useMemo } from 'react';
import useSWR, { mutate as mutateSWR } from 'swr';
import useSWRInfinite from 'swr/infinite';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import {
  normalizeBundledModulesResponse,
  normalizeInstalledModulesResponse,
  normalizeModuleInstallation,
  normalizeModuleRecordPage,
  normalizeModuleRecordResponse,
  type BundledModule,
  type ModuleInstallation,
  type ModuleRecord,
} from '@/lib/modules';

async function fetchModuleJson(path: string): Promise<unknown> {
  const response = await api.get(path);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load module data.');
  }
  return response.json();
}

export function useInstalledModules() {
  const swr = useSWR<unknown>('/api/modules', fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const normalized = useMemo(() => {
    try {
      return { modules: normalizeInstalledModulesResponse(swr.data), error: null as Error | null };
    } catch (error) {
      return { modules: [], error: error instanceof Error ? error : new Error('Invalid module manifest.') };
    }
  }, [swr.data]);
  return { ...swr, modules: normalized.modules, error: swr.error ?? normalized.error };
}

export function useBundledModules() {
  const swr = useSWR<unknown>('/api/modules/bundled', fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const modules: BundledModule[] = useMemo(() => normalizeBundledModulesResponse(swr.data), [swr.data]);
  return { ...swr, modules };
}

export function useModule(slug: string) {
  const key = slug ? `/api/modules/${encodeURIComponent(slug)}` : null;
  const swr = useSWR<unknown>(key, fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const normalized = useMemo<{ module: ModuleInstallation | null; error: Error | null }>(() => {
    if (!swr.data) return { module: null, error: null };
    try {
      const body = swr.data && typeof swr.data === 'object' && !Array.isArray(swr.data)
        ? swr.data as Record<string, unknown>
        : {};
      return { module: normalizeModuleInstallation(body.module ?? swr.data), error: null };
    } catch (error) {
      return { module: null, error: error instanceof Error ? error : new Error('Invalid module manifest.') };
    }
  }, [swr.data]);
  return { ...swr, module: normalized.module, error: swr.error ?? normalized.error };
}

export function useModuleRecords(slug: string, collectionKey: string) {
  const getKey = (pageIndex: number, previous: unknown) => {
    if (!slug || !collectionKey) return null;
    if (pageIndex > 0) {
      const previousPage = normalizeModuleRecordPage(previous);
      if (!previousPage.nextCursor) return null;
      return `/api/modules/${encodeURIComponent(slug)}/records?collection_key=${encodeURIComponent(collectionKey)}&limit=50&cursor=${encodeURIComponent(previousPage.nextCursor)}`;
    }
    return `/api/modules/${encodeURIComponent(slug)}/records?collection_key=${encodeURIComponent(collectionKey)}&limit=50`;
  };
  const swr = useSWRInfinite<unknown>(getKey, fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    revalidateFirstPage: true,
  });
  const pages = useMemo(() => (swr.data ?? []).map(normalizeModuleRecordPage), [swr.data]);
  const records = useMemo<ModuleRecord[]>(() => {
    const seen = new Set<string>();
    return pages.flatMap((page) => page.records).filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    });
  }, [pages]);
  const nextCursor = pages.at(-1)?.nextCursor ?? null;
  return {
    ...swr,
    records,
    nextCursor,
    loadMore: () => swr.setSize((size) => size + 1),
    isLoadingMore: swr.isValidating && (swr.data?.length ?? 0) < swr.size,
  };
}

export function useModuleRecord(slug: string, collectionKey: string, recordId: string) {
  const key = slug && collectionKey && recordId
    ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}?collection_key=${encodeURIComponent(collectionKey)}`
    : null;
  const swr = useSWR<unknown>(key, fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const record = useMemo(() => normalizeModuleRecordResponse(swr.data), [swr.data]);
  return { ...swr, record };
}

function isModuleCacheKey(key: unknown, slug?: string): boolean {
  if (typeof key !== 'string') return false;
  const normalizedKey = key.startsWith('$inf$') ? key.slice('$inf$'.length) : key;
  if (!normalizedKey.startsWith('/api/modules')) return false;
  if (!slug) return true;
  return normalizedKey === '/api/modules'
    || normalizedKey === '/api/modules/bundled'
    || normalizedKey.startsWith(`/api/modules/${encodeURIComponent(slug)}`);
}

export function useModuleRealtime(slug?: string) {
  useEffect(() => {
    const token = window.localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const invalidate = (event?: { slug?: string; module_slug?: string }) => {
      const eventSlug = event?.slug ?? event?.module_slug;
      if (slug && eventSlug && eventSlug !== slug) return;
      void mutateSWR((key) => isModuleCacheKey(key, slug));
    };
    const events = [
      'module:changed',
      'module:record:changed',
      'module:installed',
      'module:updated',
      'module:disabled',
      'module:record_created',
      'module:record_updated',
      'module:record_deleted',
    ] as const;
    events.forEach((event) => socket.on(event, invalidate));
    return () => {
      events.forEach((event) => socket.off(event, invalidate));
    };
  }, [slug]);
}

export function refreshModuleCaches(slug?: string) {
  return mutateSWR((key) => isModuleCacheKey(key, slug));
}
