'use client';

import { useDeferredValue, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Loader2,
  Plus,
  Settings2,
  TableProperties,
} from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { useSetPageContext } from '@/components/app-header-context';
import { ModuleCollectionNav } from '@/components/modules/module-collection-nav';
import { ModuleRecordExplorer } from '@/components/modules/module-record-explorer';
import { ModuleRecordFormDialog } from '@/components/modules/module-record-form';
import { ModuleSavedViews } from '@/components/modules/module-saved-views';
import {
  ModuleErrorState,
  ModuleIcon,
  ModuleLoadingState,
  ModuleStatusBadge,
} from '@/components/modules/module-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  getDefaultModuleCollection,
  getModuleCollectionViews,
  moduleApiError,
  moduleCollectionHref,
  resolveModuleView,
} from '@/lib/modules';
import {
  moduleFieldFilterToQuery,
  modulePersonalViewHref,
  moduleQueryFilterToFieldFilter,
  moduleSavedViewSortToRecordSort,
  moduleSavedViewToView,
  type ModuleQueryFilter,
  type ModuleQuerySort,
  type ModuleSavedView,
} from '@/lib/module-saved-views';
import {
  refreshModuleCaches,
  useModule,
  useModuleRealtime,
  useModuleRecords,
  useModuleSavedViews,
} from '@/hooks/use-modules';

export function ModuleWorkspace() {
  const params = useParams<{ slug: string; collectionKey?: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const slug = params?.slug ?? '';
  const moduleState = useModule(slug);
  const installedModule = moduleState.module;
  const compatibilityCollection = searchParams.get('collection');
  const requestedCollection = params?.collectionKey ?? compatibilityCollection;
  const matchedCollection = installedModule
    ? installedModule.manifest.collections.find((candidate) => candidate.key === requestedCollection)
    : null;
  const collection = installedModule
    ? matchedCollection ?? getDefaultModuleCollection(installedModule.manifest)
    : null;
  const requestedView = searchParams.get('view');
  const manifestView = installedModule && collection
    ? resolveModuleView(installedModule.manifest, collection, requestedView)
    : null;
  const resolvedViewKey = manifestView?.key ?? null;
  const requestedSavedViewId = searchParams.get('saved');
  const savedViewsState = useModuleSavedViews(
    slug,
    collection?.key ?? '',
    Boolean(installedModule?.enabled && collection && user?.role !== 'guest'),
  );
  const activeSavedView = savedViewsState.views.find((candidate) => candidate.id === requestedSavedViewId) ?? null;
  const view = activeSavedView ? moduleSavedViewToView(activeSavedView) : manifestView;
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [filters, setFilters] = useState<ModuleQueryFilter[]>([]);
  const [sort, setSort] = useState<ModuleQuerySort | undefined>();
  const [appliedSavedViewId, setAppliedSavedViewId] = useState<string | null>(null);
  const fieldFilter = collection ? moduleQueryFilterToFieldFilter(collection, filters) : null;
  const recordSort = moduleSavedViewSortToRecordSort(sort);
  const recordsState = useModuleRecords(
    slug,
    installedModule?.enabled ? collection?.key ?? '' : '',
    { search: deferredSearch, filters, ...(sort ? { sort } : {}) },
  );
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useModuleRealtime(slug);
  useSetPageContext(
    <span className="max-w-[55vw] truncate text-[0.875rem] font-semibold">{installedModule?.manifest.name ?? 'Module'}</span>,
    [installedModule?.manifest.name],
  );

  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const canWrite = Boolean(installedModule?.enabled && user && user.role !== 'guest');
  const hasActiveQuery = Boolean(search.trim() || filters.length > 0 || sort || activeSavedView);

  useEffect(() => {
    if (!installedModule || !collection || !resolvedViewKey) return;
    const invalidCollection = Boolean(params?.collectionKey && !matchedCollection);
    const invalidView = Boolean(!requestedSavedViewId && requestedView && requestedView !== resolvedViewKey);
    const compatibilityUrl = !params?.collectionKey;
    const conflictingView = Boolean(requestedSavedViewId && requestedView);
    if (!invalidCollection && !invalidView && !compatibilityUrl && !conflictingView) return;
    router.replace(
      requestedSavedViewId
        ? modulePersonalViewHref(installedModule.slug, collection.key, requestedSavedViewId)
        : moduleCollectionHref(installedModule.slug, collection.key, resolvedViewKey),
      { scroll: false },
    );
  }, [collection, installedModule, matchedCollection, params?.collectionKey, requestedSavedViewId, requestedView, resolvedViewKey, router]);

  useEffect(() => {
    setSearch('');
    setFilters([]);
    setSort(undefined);
    setAppliedSavedViewId(null);
  }, [collection?.key]);

  useEffect(() => {
    if (!activeSavedView || activeSavedView.id === appliedSavedViewId) return;
    setFilters(activeSavedView.config.filters);
    setSort(activeSavedView.config.sort);
    setAppliedSavedViewId(activeSavedView.id);
  }, [activeSavedView, appliedSavedViewId]);

  useEffect(() => {
    if (
      !requestedSavedViewId
      || savedViewsState.data === undefined
      || activeSavedView
      || !installedModule
      || !collection
      || !resolvedViewKey
    ) return;
    setAppliedSavedViewId(null);
    setFilters([]);
    setSort(undefined);
    router.replace(moduleCollectionHref(installedModule.slug, collection.key, resolvedViewKey), { scroll: false });
  }, [activeSavedView, collection, installedModule, requestedSavedViewId, resolvedViewKey, router, savedViewsState.data]);

  const handleCreate = async (data: Record<string, unknown>, idempotencyKey: string) => {
    if (!installedModule?.manifestDigest || !collection) throw new Error('The active module schema is unavailable.');
    const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/records`, {
      collection_key: collection.key,
      data,
      expected_manifest_digest: installedModule.manifestDigest,
      idempotency_key: idempotencyKey,
    });
    if (!response.ok) throw new Error(await moduleApiError(response, `Unable to create ${collection.singularName.toLowerCase()}.`));
    await recordsState.mutate();
    await refreshModuleCaches(installedModule.slug);
    setNotice(`${collection.singularName} created.`);
  };

  const chooseCollection = (collectionKey: string) => {
    const nextCollection = installedModule?.manifest.collections.find((candidate) => candidate.key === collectionKey);
    if (!installedModule || !nextCollection) return;
    const nextView = resolveModuleView(installedModule.manifest, nextCollection);
    router.replace(moduleCollectionHref(installedModule.slug, nextCollection.key, nextView.key), { scroll: false });
  };

  const chooseView = (viewKey: string) => {
    if (!installedModule || !collection) return;
    setAppliedSavedViewId(null);
    setFilters([]);
    setSort(undefined);
    router.replace(moduleCollectionHref(installedModule.slug, collection.key, viewKey), { scroll: false });
  };

  const chooseSavedView = (savedView: ModuleSavedView | null) => {
    if (!installedModule || !collection || !manifestView) return;
    if (!savedView) {
      setAppliedSavedViewId(null);
      setFilters([]);
      setSort(undefined);
      router.replace(moduleCollectionHref(installedModule.slug, collection.key, manifestView.key), { scroll: false });
      return;
    }
    setFilters(savedView.config.filters);
    setSort(savedView.config.sort);
    setAppliedSavedViewId(savedView.id);
    router.replace(modulePersonalViewHref(installedModule.slug, collection.key, savedView.id), { scroll: false });
  };

  if (moduleState.isLoading) return <ModuleLoadingState label="Loading module…" />;
  if (moduleState.error || !installedModule) {
    return (
      <ModuleErrorState
        message={moduleState.error instanceof Error ? moduleState.error.message : 'This module was not found.'}
        onRetry={() => void moduleState.mutate()}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header
        className="flex flex-shrink-0 items-start gap-3 px-4 py-3 md:items-center md:px-6 md:py-4"
        style={{ borderBottom: '1px solid var(--ghost-border)' }}
      >
        <span
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
        >
          <ModuleIcon token={installedModule.manifest.icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[1rem] font-semibold md:text-[1.0625rem]" style={{ color: 'var(--on-surface)' }}>
              {installedModule.manifest.name}
            </h1>
            <ModuleStatusBadge enabled={installedModule.enabled} />
          </div>
          <p className="mt-0.5 line-clamp-1 max-w-2xl text-[0.6875rem] md:text-[0.75rem]" style={{ color: 'var(--outline)' }}>
            {installedModule.manifest.description ?? 'A schema-driven workspace module.'}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {canManage && (
            <Link
              href="/settings/modules"
              className="flex min-h-10 items-center justify-center gap-2 rounded-lg px-2.5 text-[0.75rem] font-medium md:px-3"
              style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)' }}
              aria-label="Manage module settings"
            >
              <Settings2 size={14} /> <span className="hidden sm:inline">Manage</span>
            </Link>
          )}
          {canWrite && collection && (
            <button
              type="button"
              onClick={() => { setActionError(null); setNotice(null); setCreating(true); }}
              className="flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-[0.75rem] font-medium text-white"
              style={{ background: 'var(--primary-container)' }}
            >
              <Plus size={14} /> <span className="hidden sm:inline">New {collection.singularName.toLowerCase()}</span><span className="sm:hidden">New</span>
            </button>
          )}
        </div>
      </header>

      <ModuleCollectionNav
        moduleName={installedModule.manifest.name}
        collections={installedModule.manifest.collections}
        activeKey={collection?.key ?? null}
        onSelect={chooseCollection}
      />

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 md:px-6 md:pt-5">
          {(actionError || notice) && (
            <div
              role={actionError ? 'alert' : 'status'}
              className="mb-4 rounded-lg px-3 py-2 text-[0.8125rem]"
              style={{ color: actionError ? 'var(--error)' : 'var(--status-green)', background: actionError ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)' }}
            >
              {actionError ?? notice}
            </div>
          )}

          {!installedModule.enabled ? (
            <EmptyState
              icon={<Settings2 size={20} style={{ color: 'var(--outline)' }} />}
              title="Module disabled"
              description="Its records are preserved. A workspace owner or admin can enable it from Settings."
              action={canManage ? { label: 'Open module settings', href: '/settings/modules' } : undefined}
            />
          ) : !collection || !view ? (
            <EmptyState
              icon={<TableProperties size={20} style={{ color: 'var(--outline)' }} />}
              title="No collections"
              description="This module manifest does not expose a record collection."
            />
          ) : (
            <div className="space-y-4">
              <ModuleSavedViews
                slug={installedModule.slug}
                collection={collection}
                currentView={view}
                filters={filters}
                sort={sort}
                views={savedViewsState.views}
                activeView={activeSavedView}
                disabled={!canWrite || savedViewsState.isLoading}
                onSelect={chooseSavedView}
                onViewsChanged={() => savedViewsState.mutate()}
              />

              {recordsState.isLoading ? (
                <ModuleLoadingState label={`Loading ${collection.name.toLowerCase()}…`} />
              ) : recordsState.error ? (
                <ModuleErrorState
                  message={recordsState.error instanceof Error ? recordsState.error.message : 'Records could not be loaded.'}
                  onRetry={() => void recordsState.mutate()}
                />
              ) : recordsState.records.length === 0 && !hasActiveQuery ? (
                <EmptyState
                  icon={<TableProperties size={20} style={{ color: 'var(--primary)' }} />}
                  title={`No ${collection.name.toLowerCase()} yet`}
                  description={`Create the first ${collection.singularName.toLowerCase()} to start using this collection.`}
                  action={canWrite ? { label: `New ${collection.singularName.toLowerCase()}`, onClick: () => setCreating(true) } : undefined}
                />
              ) : (
                <>
                  <ModuleRecordExplorer
                    key={`${collection.key}:${activeSavedView?.id ?? 'manifest'}`}
                    slug={installedModule.slug}
                    collection={collection}
                    view={view}
                    records={recordsState.records}
                    search={search}
                    sort={recordSort}
                    filter={fieldFilter}
                    hasMore={Boolean(recordsState.nextCursor)}
                    isQuerying={recordsState.isValidating || search !== deferredSearch}
                    onViewChange={chooseView}
                    onSearchChange={setSearch}
                    onSortChange={(nextSort) => setSort(nextSort
                      ? { field: nextSort.fieldKey, direction: nextSort.direction }
                      : undefined)}
                    onFilterChange={(nextFilter) => setFilters(moduleFieldFilterToQuery(collection, nextFilter))}
                  />
                  {recordsState.nextCursor && (
                    <div className="flex justify-center py-5">
                      <button
                        type="button"
                        onClick={() => void recordsState.loadMore()}
                        disabled={recordsState.isLoadingMore}
                        className="flex min-h-11 items-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium disabled:opacity-60"
                        style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
                      >
                        {recordsState.isLoadingMore && <Loader2 size={14} className="animate-spin" />}
                        Load more
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
      </main>

      {collection && (
        <ModuleRecordFormDialog
          open={creating}
          collection={collection}
          onClose={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  );
}
