'use client';

import { useEffect, useMemo } from 'react';
import useSWR, { mutate as mutateSWR } from 'swr';
import useSWRInfinite from 'swr/infinite';
import { ModuleRelatedLatestResponseSchema } from '@deft/shared/modules';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-context';
import {
  getActiveSessionCacheScope,
  isActiveSessionCacheKey,
  sessionSWRKey,
  sessionSWRPath,
} from '@/lib/session-cache';
import { moduleSessionRequestPath } from '@/lib/module-session-cache';
import { subscribeModulePageResume } from '@/lib/module-page-resume';
import {
  normalizeBundledModulesResponse,
  normalizeInstalledModulesResponse,
  normalizeModuleInstallation,
  normalizeModuleActivityResponse,
  normalizeModuleMembersResponse,
  normalizeModuleRecordPage,
  normalizeModuleRecordResponse,
  normalizeModuleRelationsResponse,
  normalizeResourceOptionsResponse,
  normalizeResourceRelationResponse,
  type BundledModule,
  type ModuleInstallation,
  type ModuleRecord,
  type ResourceProjection,
  type ResourceRelation,
} from '@/lib/modules';
import {
  normalizeModuleSavedViewsResponse,
  type ModuleQueryFilter,
  type ModuleQuerySort,
  type ModuleSavedView,
} from '@/lib/module-saved-views';

async function fetchModuleJson(path: string): Promise<unknown> {
  path = sessionSWRPath(path);
  const response = await api.get(path);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load module data.');
  }
  return response.json();
}

export function useInstalledModules(enabled = true) {
  const { sessionCacheScope } = useAuth();
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, enabled ? '/api/modules' : null), fetchModuleJson, {
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
  const { sessionCacheScope } = useAuth();
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, '/api/modules/bundled'), fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const modules: BundledModule[] = useMemo(() => normalizeBundledModulesResponse(swr.data), [swr.data]);
  return { ...swr, modules };
}

export function useModule(slug: string) {
  const { sessionCacheScope } = useAuth();
  const key = slug ? `/api/modules/${encodeURIComponent(slug)}` : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
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

export type ModuleRecordQueryOptions = {
  today?: string;
  search?: string;
  filters?: ModuleQueryFilter[];
  sort?: ModuleQuerySort;
};

const MODULE_QUERY_KEY_SEPARATOR = '::module-query::';

async function fetchModuleQuery(key: string): Promise<unknown> {
  key = sessionSWRPath(key);
  const separator = key.indexOf(MODULE_QUERY_KEY_SEPARATOR);
  if (separator < 0) throw new Error('Invalid module query cache key.');
  const path = key.slice(0, separator);
  const body = JSON.parse(decodeURIComponent(key.slice(separator + MODULE_QUERY_KEY_SEPARATOR.length))) as unknown;
  const response = await api.post(path, body);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof payload.error === 'string' ? payload.error : 'Unable to query module records.');
  }
  return response.json();
}

export function useModuleRecords(
  slug: string,
  collectionKey: string,
  query?: ModuleRecordQueryOptions,
) {
  const { sessionCacheScope } = useAuth();
  const queryJson = query === undefined ? null : JSON.stringify({
    ...(query.search?.trim() ? { search: query.search.trim() } : {}),
    filters: query.filters ?? [],
    ...(query.today ? { today: query.today } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  });
  const getKey = (pageIndex: number, previous: unknown) => {
    if (!slug || !collectionKey) return null;
    const previousPage = pageIndex > 0 ? normalizeModuleRecordPage(previous) : null;
    if (pageIndex > 0 && !previousPage?.nextCursor) return null;
    if (queryJson !== null) {
      const input = {
        collection_key: collectionKey,
        ...JSON.parse(queryJson) as Record<string, unknown>,
        limit: 50,
        ...(previousPage?.nextCursor ? { cursor: previousPage.nextCursor } : {}),
      };
      const path = `/api/modules/${encodeURIComponent(slug)}/records/query`;
      return sessionSWRKey(sessionCacheScope, `${path}${MODULE_QUERY_KEY_SEPARATOR}${encodeURIComponent(JSON.stringify(input))}`);
    }
    if (pageIndex > 0) {
      return sessionSWRKey(sessionCacheScope, `/api/modules/${encodeURIComponent(slug)}/records?collection_key=${encodeURIComponent(collectionKey)}&limit=50&cursor=${encodeURIComponent(previousPage!.nextCursor!)}`);
    }
    return sessionSWRKey(sessionCacheScope, `/api/modules/${encodeURIComponent(slug)}/records?collection_key=${encodeURIComponent(collectionKey)}&limit=50`);
  };
  const swr = useSWRInfinite<unknown>(getKey, queryJson === null ? fetchModuleJson : fetchModuleQuery, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateOnMount: true,
    revalidateFirstPage: false,
  });
  useEffect(
    () => subscribeModulePageResume(sessionCacheScope, () => swr.mutate(), window, document),
    [sessionCacheScope, swr.mutate],
  );
  useEffect(
    () => registerModuleInfiniteCacheRevalidator(sessionCacheScope, slug, () => swr.mutate()),
    [sessionCacheScope, slug, swr.mutate],
  );
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

export function useModuleSavedViews(slug: string, collectionKey: string, enabled = true) {
  const { sessionCacheScope } = useAuth();
  const key = slug && collectionKey && enabled
    ? `/api/modules/${encodeURIComponent(slug)}/saved-views?collection_key=${encodeURIComponent(collectionKey)}`
    : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const views = useMemo<ModuleSavedView[]>(
    () => normalizeModuleSavedViewsResponse(swr.data),
    [swr.data],
  );
  return { ...swr, views };
}

export function useIncomingModuleRecords(slug: string, recordId: string, collectionKey: string, fieldKey: string, dateField?: string) {
  const { sessionCacheScope } = useAuth();
  const swr = useSWRInfinite<unknown>((pageIndex, previous) => {
    if (!slug || !recordId) return null;
    const cursor = pageIndex > 0 ? normalizeModuleRecordPage(previous).nextCursor : null;
    if (pageIndex > 0 && !cursor) return null;
    const query = new URLSearchParams({ collection_key: collectionKey, field_key: fieldKey, limit: '10' });
    if (dateField) query.set('date_field', dateField);
    if (cursor) query.set('cursor', cursor);
    return sessionSWRKey(sessionCacheScope, `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/incoming-relations?${query}`);
  }, fetchModuleJson, { revalidateOnFocus: true, revalidateOnReconnect: true });
  useEffect(
    () => registerModuleInfiniteCacheRevalidator(sessionCacheScope, slug, () => swr.mutate()),
    [sessionCacheScope, slug, swr.mutate],
  );
  const pages = (swr.data ?? []).map(normalizeModuleRecordPage);
  const records = [...new Map(pages.flatMap((page) => page.records).map((record) => [record.id, record])).values()];
  return {
    ...swr,
    records,
    nextCursor: pages.at(-1)?.nextCursor ?? null,
    loadMore: () => swr.setSize((size) => size + 1),
    isLoadingMore: swr.isValidating && (swr.data?.length ?? 0) < swr.size,
  };
}

export function useModuleRecord(slug: string, collectionKey: string, recordId: string) {
  const { sessionCacheScope } = useAuth();
  const key = slug && collectionKey && recordId
    ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}?collection_key=${encodeURIComponent(collectionKey)}`
    : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const record = useMemo(() => normalizeModuleRecordResponse(swr.data), [swr.data]);
  return { ...swr, record };
}

export function useModuleRelations(slug: string, recordId: string, enabled = true) {
  const { sessionCacheScope } = useAuth();
  const key = slug && recordId && enabled
    ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/relations`
    : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const relations = useMemo(() => normalizeModuleRelationsResponse(swr.data), [swr.data]);
  return { ...swr, relations };
}

export function useResourceRelation(
  slug: string,
  recordId: string,
  fieldKey: string,
  enabled = true,
) {
  const { sessionCacheScope } = useAuth();
  const key = slug && recordId && fieldKey && enabled
    ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/resource-relations/${encodeURIComponent(fieldKey)}`
    : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const relation = useMemo<ResourceRelation>(
    () => normalizeResourceRelationResponse(swr.data),
    [swr.data],
  );
  return { ...swr, relation };
}

export function useResourceRelationOptions(
  slug: string,
  recordId: string,
  fieldKey: string,
  query: string,
  enabled = true,
) {
  const { sessionCacheScope } = useAuth();
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  const key = slug && recordId && fieldKey && enabled
    ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/resource-relations/${encodeURIComponent(fieldKey)}/options${suffix}`
    : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
  });
  const options = useMemo<ResourceProjection[]>(
    () => normalizeResourceOptionsResponse(swr.data),
    [swr.data],
  );
  return { ...swr, options };
}

export function useModuleRecordActivity(recordId: string, enabled = true) {
  const { sessionCacheScope } = useAuth();
  const key = recordId && enabled
    ? `/api/audit?entity_type=module_record&entity_id=${encodeURIComponent(recordId)}&limit=30`
    : null;
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, key), fetchModuleJson, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  const activity = useMemo(() => normalizeModuleActivityResponse(swr.data), [swr.data]);
  return { ...swr, activity };
}

export function useModuleMembers(enabled = true) {
  const { sessionCacheScope } = useAuth();
  const swr = useSWR<unknown>(sessionSWRKey(sessionCacheScope, enabled ? '/api/members' : null), fetchModuleJson, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
  });
  const members = useMemo(() => normalizeModuleMembersResponse(swr.data), [swr.data]);
  return { ...swr, members };
}

export function moduleRelatedLatestCacheKey(
  sessionCacheScope: string | null,
  slug: string,
  recordId: string,
): string | null {
  const path = slug && recordId
    ? `/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(recordId)}/latest-related`
    : null;
  return sessionSWRKey(sessionCacheScope, path);
}

export function useModuleRelatedLatest(slug: string, recordId: string) {
  const { sessionCacheScope } = useAuth();
  return useSWR(moduleRelatedLatestCacheKey(sessionCacheScope, slug, recordId), async (key) => {
    const response = await api.get(sessionSWRPath(key));
    if (!response.ok) throw new Error('Unable to load related summaries.');
    return ModuleRelatedLatestResponseSchema.parse(await response.json());
  }, { refreshInterval: 30000, revalidateOnFocus: true, revalidateOnReconnect: true });
}

export function isModuleCacheKey(key: unknown, slug?: string): boolean {
  if (!isActiveSessionCacheKey(key) || typeof key !== 'string') return false;
  const normalizedKey = moduleSessionRequestPath(key);
  if (!normalizedKey.startsWith('/api/modules')) return false;
  if (!slug) return true;
  return normalizedKey === '/api/modules'
    || normalizedKey === '/api/modules/bundled'
    || normalizedKey.startsWith(`/api/modules/${encodeURIComponent(slug)}`);
}

export function isModuleTaskCacheKey(key: unknown, slug?: string): boolean {
  return isModuleCacheKey(key, slug) && typeof key === 'string'
    && /\/(?:task-queue|records\/next-tasks)(?:\?|$)|\/records\/[^/?]+\/tasks(?:\?|$)/u.test(moduleSessionRequestPath(key));
}

type ModuleInfiniteCacheRevalidator = Readonly<{
  sessionCacheScope: string;
  slug: string;
  taskCache: boolean;
  revalidate: () => Promise<unknown>;
}>;

const moduleInfiniteCacheRevalidators = new Set<ModuleInfiniteCacheRevalidator>();

export function registerModuleInfiniteCacheRevalidator(
  sessionCacheScope: string | null,
  slug: string,
  revalidate: () => Promise<unknown>,
  options: { taskCache?: boolean } = {},
): () => void {
  if (!sessionCacheScope || !slug) return () => undefined;
  const entry = { sessionCacheScope, slug, taskCache: options.taskCache === true, revalidate };
  moduleInfiniteCacheRevalidators.add(entry);
  return () => moduleInfiniteCacheRevalidators.delete(entry);
}

function refreshModuleInfiniteCaches(slug?: string, taskCachesOnly = false): Promise<unknown[]> {
  const sessionCacheScope = getActiveSessionCacheScope();
  if (!sessionCacheScope) return Promise.resolve([]);
  return Promise.all([...moduleInfiniteCacheRevalidators]
    .filter((entry) => entry.sessionCacheScope === sessionCacheScope
      && (!slug || entry.slug === slug)
      && (!taskCachesOnly || entry.taskCache))
    .map((entry) => entry.revalidate()));
}

export function invalidateModuleTaskRealtimeCaches(
  sessionCacheScope: string,
  slug?: string,
): Promise<unknown> {
  if (getActiveSessionCacheScope() !== sessionCacheScope) return Promise.resolve();
  return Promise.all([
    mutateSWR((key) => isModuleTaskCacheKey(key, slug)),
    refreshModuleInfiniteCaches(slug, true),
  ]);
}

export function invalidateModuleRealtimeCaches(
  sessionCacheScope: string,
  slug: string | undefined,
  event?: { slug?: string; module_slug?: string },
): Promise<unknown> {
  if (getActiveSessionCacheScope() !== sessionCacheScope) return Promise.resolve();
  const eventSlug = event?.slug ?? event?.module_slug;
  if (slug && eventSlug && eventSlug !== slug) return Promise.resolve();
  return refreshModuleCaches(slug);
}

export function useModuleRealtime(slug?: string) {
  const { sessionCacheScope } = useAuth();
  useEffect(() => {
    if (!sessionCacheScope || getActiveSessionCacheScope() !== sessionCacheScope) return;
    const token = window.localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const invalidate = (event?: { slug?: string; module_slug?: string }) => {
      void invalidateModuleRealtimeCaches(sessionCacheScope, slug, event);
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
    const invalidateTasks = () => {
      void invalidateModuleTaskRealtimeCaches(sessionCacheScope, slug);
    };
    const taskEvents = ['task:created', 'task:updated', 'task:bulk_updated', 'task:deleted'] as const;
    taskEvents.forEach((event) => socket.on(event, invalidateTasks));
    events.forEach((event) => socket.on(event, invalidate));
    return () => {
      events.forEach((event) => socket.off(event, invalidate));
      taskEvents.forEach((event) => socket.off(event, invalidateTasks));
    };
  }, [sessionCacheScope, slug]);
}

export function refreshModuleCaches(slug?: string) {
  return Promise.all([
    mutateSWR((key) => isModuleCacheKey(key, slug)),
    refreshModuleInfiniteCaches(slug),
  ]);
}
