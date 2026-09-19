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
import { ModuleRecordSummary } from '@/components/modules/module-record-summary';
import { ModuleSelectionCreate } from '@/components/modules/module-selection-create';
import { ModuleImportDialog } from '@/components/modules/module-import-dialog';
import { ModuleDuplicateReview } from '@/components/modules/module-duplicate-review';
import { ModuleArchiveDialog } from '@/components/modules/module-archive-dialog';
import { ModuleRecordFormDialog } from '@/components/modules/module-record-form';
import { ModuleSavedViews } from '@/components/modules/module-saved-views';
import { ModuleFollowUpQueue } from '@/components/modules/module-followup-queue';
import { moduleBoardMovePayload, type ModuleBoardMove } from '@/lib/module-board';
import {
  ModuleErrorState,
  ModuleIcon,
  ModuleLoadingState,
} from '@/components/modules/module-primitives';
import { api } from '@/lib/api';
import { getAppNavigationItems, getAppNavigationModuleOwner } from '@/lib/app-navigation';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { moduleTaskCalendarDay } from '@/lib/module-task-links';
import {
  moduleCollectionListHref,
  moduleRecordHrefWithListContext,
  parseModuleListContext,
  type ModuleListContext,
} from '@/lib/module-list-context';
import { useAuth } from '@/lib/auth-context';
import {
  getDefaultModuleCollection,
  moduleApiError,
  moduleCollectionHref,
  resolveModuleView,
} from '@/lib/modules';
import {
  moduleFieldFilterToQuery,
  moduleQueryFilterToFieldFilter,
  moduleSavedViewSortToRecordSort,
  moduleSavedViewToView,
  type ModuleSavedView,
} from '@/lib/module-saved-views';
import {
  refreshModuleCaches,
  useModule,
  useModuleRealtime,
  useModuleRecords,
  useModuleSavedViews,
} from '@/hooks/use-modules';
import { useAppNavigation } from '@/hooks/use-apps';

export function ModuleWorkspace() {
  const params = useParams<{ slug: string; collectionKey?: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const showFollowUps = searchParams.get('workspace') === 'follow-ups';
  const { user } = useAuth();
  const slug = params?.slug ?? '';
  const appNavigationState = useAppNavigation(Boolean(user && user.role !== 'guest'));
  const appNavigationGroups = APPS_ENABLED ? getAppNavigationItems(appNavigationState.navigation) : [];
  const appOwner = getAppNavigationModuleOwner(slug, appNavigationGroups);
  const hasAuthoritativeAppNavigation = APPS_ENABLED
    && !appNavigationState.isLoading
    && !appNavigationState.error
    && Boolean(appOwner);
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
  const parsedListContext = parseModuleListContext(searchParams);
  const useSavedViewDefaults = Boolean(activeSavedView && !parsedListContext.filtersExplicit);
  const search = parsedListContext.search;
  const filters = useSavedViewDefaults ? activeSavedView!.config.filters : parsedListContext.filters;
  const sort = useSavedViewDefaults ? activeSavedView!.config.sort : parsedListContext.sort;
  const [today, setToday] = useState(moduleTaskCalendarDay);
  useEffect(() => {
    const update = () => setToday(moduleTaskCalendarDay());
    const timer = window.setInterval(update, 30000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);
  const deferredSearch = useDeferredValue(search);
  const fieldFilter = collection ? moduleQueryFilterToFieldFilter(collection, filters) : null;
  const recordSort = moduleSavedViewSortToRecordSort(sort);
  const recordsState = useModuleRecords(
    slug,
    installedModule?.enabled && !showFollowUps ? collection?.key ?? '' : '',
    { search: deferredSearch, filters, today, ...(sort ? { sort } : {}) },
  );
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useModuleRealtime(slug);
  useSetPageContext(
    <span className="max-w-[55vw] truncate text-[0.875rem] font-semibold">{appOwner?.name ?? installedModule?.manifest.name ?? 'Module'}</span>,
    [appOwner?.name, installedModule?.manifest.name],
  );

  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const canWrite = Boolean(installedModule?.enabled && user && user.role !== 'guest');
  const hasActiveQuery = Boolean(search.trim() || filters.length > 0 || sort || activeSavedView);

  useEffect(() => {
    if (showFollowUps || !installedModule || !collection || !resolvedViewKey) return;
    const invalidCollection = Boolean(params?.collectionKey && !matchedCollection);
    const invalidView = Boolean(!requestedSavedViewId && requestedView && requestedView !== resolvedViewKey);
    const compatibilityUrl = !params?.collectionKey;
    const conflictingView = Boolean(requestedSavedViewId && requestedView);
    if (!invalidCollection && !invalidView && !compatibilityUrl && !conflictingView) return;
    router.replace(
      moduleCollectionListHref(installedModule.slug, collection.key, {
        viewKey: requestedSavedViewId ? null : resolvedViewKey,
        savedViewId: requestedSavedViewId,
        search,
        filters,
        sort,
        filtersExplicit: Boolean(requestedSavedViewId) || filters.length > 0,
      }),
      { scroll: false },
    );
  }, [collection, filters, installedModule, matchedCollection, params?.collectionKey, requestedSavedViewId, requestedView, resolvedViewKey, router, search, showFollowUps, sort]);

  useEffect(() => {
    if (
      !requestedSavedViewId
      || savedViewsState.data === undefined
      || activeSavedView
      || !installedModule
      || !collection
      || !resolvedViewKey
    ) return;
    router.replace(moduleCollectionHref(installedModule.slug, collection.key, resolvedViewKey), { scroll: false });
  }, [activeSavedView, collection, installedModule, requestedSavedViewId, resolvedViewKey, router, savedViewsState.data]);

  const handleCreate = async (data: Record<string, unknown>, idempotencyKey: string, _unsetFields: string[], relations: Record<string, string[]>) => {
    if (!installedModule?.manifestDigest || !collection) throw new Error('The active module schema is unavailable.');
    const response = await api.post(`/api/modules/${encodeURIComponent(installedModule.slug)}/records`, {
      collection_key: collection.key,
      data,
      relations,
      expected_manifest_digest: installedModule.manifestDigest,
      idempotency_key: idempotencyKey,
    });
    if (!response.ok) throw new Error(await moduleApiError(response, `Unable to create ${collection.singularName.toLowerCase()}.`));
    await recordsState.mutate();
    await refreshModuleCaches(installedModule.slug);
    setNotice(`${collection.singularName} created.`);
  };

  const handleBoardMove: ModuleBoardMove = async (record, field, value, manifestDigest, idempotencyKey) => {
    const response = await api.patch(`/api/modules/${encodeURIComponent(slug)}/records/${encodeURIComponent(record.id)}`, moduleBoardMovePayload(record, field, value, manifestDigest, idempotencyKey));
    if (!response.ok) {
      if (response.status === 409) {
        setActionError('This record or its module changed. Reopen the record to review its latest values.');
        await recordsState.mutate().catch(() => undefined);
        await refreshModuleCaches(slug).catch(() => undefined);
        throw new Error('This record or its module changed. Close this dialog and reopen it to use the latest values.');
      }
      throw new Error(await moduleApiError(response, 'Unable to change this record.'));
    }
    await recordsState.mutate();
    await refreshModuleCaches(slug);
    setActionError(null);
  };

  const listContext: ModuleListContext = {
    viewKey: activeSavedView ? null : resolvedViewKey,
    savedViewId: activeSavedView?.id ?? null,
    search,
    filters,
    sort,
    filtersExplicit: Boolean(activeSavedView) || filters.length > 0,
  };
  const quickFilterOptions = view
    ? [{ key: 'all', name: 'All records', filters: [] }, ...(view.quickFilters ?? manifestView?.quickFilters ?? [])]
    : [];

  const replaceListContext = (next: Partial<Pick<ModuleListContext, 'search' | 'filters' | 'sort'>>) => {
    if (!installedModule || !collection) return;
    const context = { ...listContext, ...next };
    context.filtersExplicit = Boolean(context.savedViewId) || context.filters.length > 0;
    router.replace(moduleCollectionListHref(installedModule.slug, collection.key, context), { scroll: false });
  };

  const chooseCollection = (collectionKey: string) => {
    const nextCollection = installedModule?.manifest.collections.find((candidate) => candidate.key === collectionKey);
    if (!installedModule || !nextCollection) return;
    const nextView = resolveModuleView(installedModule.manifest, nextCollection);
    router.push(moduleCollectionHref(installedModule.slug, nextCollection.key, nextView.key), { scroll: false });
  };

  const chooseView = (viewKey: string) => {
    if (!installedModule || !collection) return;
    router.push(moduleCollectionListHref(installedModule.slug, collection.key, {
      viewKey,
      savedViewId: null,
      search,
      filters: [],
      sort: undefined,
      filtersExplicit: false,
    }), { scroll: false });
  };

  const chooseSavedView = (savedView: ModuleSavedView | null) => {
    if (!installedModule || !collection || !manifestView) return;
    if (!savedView) {
      router.replace(moduleCollectionListHref(installedModule.slug, collection.key, {
        viewKey: manifestView.key,
        savedViewId: null,
        search,
        filters: [],
        sort: undefined,
        filtersExplicit: false,
      }), { scroll: false });
      return;
    }
    router.replace(moduleCollectionListHref(installedModule.slug, collection.key, {
      viewKey: null,
      savedViewId: savedView.id,
      search,
      filters: savedView.config.filters,
      sort: savedView.config.sort,
      filtersExplicit: true,
    }), { scroll: false });
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
              {showFollowUps ? 'Linked tasks' : collection?.name ?? installedModule.manifest.name}
            </h1>
          </div>
          <p className="mt-0.5 hidden sm:block line-clamp-1 max-w-2xl text-[0.6875rem] md:text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>
            {installedModule.manifest.description ?? 'A schema-driven workspace module.'}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {!hasAuthoritativeAppNavigation && <Link href={`/modules/${encodeURIComponent(slug)}?workspace=follow-ups`} aria-current={showFollowUps ? 'page' : undefined} className="flex min-h-10 items-center rounded-full px-4 text-xs font-medium" style={{ background: showFollowUps ? 'var(--bg-active)' : 'var(--surface-container-low)', color: 'var(--primary)' }}>Linked tasks</Link>}
          {canManage && (
            <Link
              href="/settings/modules"
              className="hidden min-h-10 items-center justify-center gap-2 rounded-full px-3 text-[0.75rem] font-medium sm:flex"
              style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)' }}
              aria-label="Manage module settings"
            >
              <Settings2 size={14} /> <span className="hidden sm:inline">Manage</span>
            </Link>
          )}
          {canWrite && collection && !showFollowUps && (
            <button
              type="button"
              onClick={() => { setActionError(null); setNotice(null); setCreating(true); }}
              className="flex min-h-10 items-center justify-center gap-2 rounded-full px-4 text-[0.75rem] font-medium text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--primary-container)' }}
            >
              <Plus size={14} /> <span>New {collection.singularName.toLowerCase()}</span>
            </button>
          )}
        </div>
      </header>

      {!hasAuthoritativeAppNavigation && <ModuleCollectionNav
        moduleName={installedModule.manifest.name}
        collections={installedModule.manifest.collections}
        activeKey={showFollowUps ? null : collection?.key ?? null}
        onSelect={chooseCollection}
      />}

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
          ) : showFollowUps ? <ModuleFollowUpQueue key={slug} slug={slug} /> : !collection || !view ? (
            <EmptyState
              icon={<TableProperties size={20} style={{ color: 'var(--outline)' }} />}
              title="No collections"
              description="This module manifest does not expose a record collection."
            />
          ) : (
            <div className="space-y-3">
              <details>
                <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[var(--ghost-border)] px-3 text-xs font-medium transition-colors hover:bg-[var(--surface-container-high)]" style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)' }}>
                  Tools & saved views{activeSavedView ? ` · ${activeSavedView.name}` : ''}
                </summary>
                <div className="mt-2 space-y-3 px-1 py-2">
                <div className="flex flex-wrap gap-2">
              {canWrite && <ModuleDuplicateReview key={`duplicates:${collection.key}`} installedModule={installedModule} collection={collection} />}
              {canWrite && <ModuleArchiveDialog key={`archive:${collection.key}`} installedModule={installedModule} collection={collection} />}
              {canWrite && <ModuleImportDialog key={`import:${collection.key}`} installedModule={installedModule} collection={collection} />}
              {canWrite && <ModuleSelectionCreate key={collection.key} installedModule={installedModule} collection={collection} records={recordsState.records}
                hasMore={Boolean(recordsState.nextCursor)} loading={recordsState.isLoading || recordsState.isLoadingMore}
                error={recordsState.error instanceof Error ? recordsState.error.message : undefined} loadMore={() => void recordsState.loadMore()} />}
              </div>
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
                </div>
              </details>

              {quickFilterOptions.length > 1 ? <div>
                <label className="block sm:hidden">
                  <span className="sr-only">Quick filter</span>
                  <select
                    aria-label="Quick filter"
                    value={quickFilterOptions.find((preset) => JSON.stringify(filters) === JSON.stringify(preset.filters))?.key ?? 'custom'}
                    onChange={(event) => {
                      const preset = quickFilterOptions.find((candidate) => candidate.key === event.target.value);
                      if (preset) replaceListContext({ filters: preset.filters });
                    }}
                  className="min-h-10 w-full rounded-full border border-[var(--ghost-border)] bg-[var(--surface-container-low)] px-4 text-xs outline-none"
                  >
                    {!quickFilterOptions.some((preset) => JSON.stringify(filters) === JSON.stringify(preset.filters)) && <option value="custom">Custom filter</option>}
                    {quickFilterOptions.map((preset) => <option key={preset.key} value={preset.key}>{preset.name}</option>)}
                  </select>
                </label>
                <div className="hidden gap-2 overflow-x-auto pb-1 sm:flex" role="group" aria-label="Quick filters">
                {quickFilterOptions.map((preset) => <button
                  key={preset.key} type="button" aria-pressed={JSON.stringify(filters) === JSON.stringify(preset.filters)}
                  onClick={() => replaceListContext({ filters: preset.filters })}
                  className="min-h-9 shrink-0 rounded-full border px-3 text-xs transition-colors hover:bg-[var(--surface-container-high)] aria-pressed:bg-[var(--bg-active)] aria-pressed:text-[var(--primary)]"
                  style={{ borderColor: 'var(--ghost-border)' }}
                >{preset.name}</button>)}
                </div>
              </div> : null}
              {filters.some((filter) => filter.operator === 'date_relative') && <p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Calendar day: {today} · Your local date. Next 7 days includes today.</p>}
              {!recordsState.isLoading && !recordsState.error && recordsState.records.length === 0 && !hasActiveQuery ? (
                <EmptyState
                  icon={<TableProperties size={20} style={{ color: 'var(--primary)' }} />}
                  title={`No ${collection.name.toLowerCase()} yet`}
                  description={`Create the first ${collection.singularName.toLowerCase()} to start using this collection.`}
                  action={canWrite ? { label: `New ${collection.singularName.toLowerCase()}`, onClick: () => setCreating(true) } : undefined}
                />
              ) : (
                <>
                  {view.summary && <ModuleRecordSummary slug={slug} collection={collection} view={view} search={deferredSearch} filters={filters} today={today} pending={search !== deferredSearch} />}
                  <ModuleRecordExplorer
                    key={`${collection.key}:${activeSavedView?.id ?? 'manifest'}`}
                    slug={installedModule.slug}
                    collection={collection}
                    view={view}
                    records={recordsState.records}
                    providerInstanceId={installedModule.id}
                    loading={recordsState.isLoading}
                    error={recordsState.error ? recordsState.error instanceof Error ? recordsState.error.message : 'Records could not be loaded.' : undefined}
                    onRetry={() => void recordsState.mutate()}
                    onMove={canWrite ? handleBoardMove : undefined}
                    manifestDigest={installedModule.manifestDigest ?? undefined}
                    search={search}
                    sort={recordSort}
                    filter={fieldFilter}
                    hasMore={Boolean(recordsState.nextCursor)}
                    isQuerying={recordsState.isValidating || search !== deferredSearch}
                    recordHref={(recordId) => moduleRecordHrefWithListContext(installedModule.slug, collection.key, recordId, listContext)}
                    onViewChange={chooseView}
                    onSearchChange={(nextSearch) => replaceListContext({ search: nextSearch })}
                    onSortChange={(nextSort) => replaceListContext({ sort: nextSort
                      ? { field: nextSort.fieldKey, direction: nextSort.direction }
                      : undefined })}
                    onFilterChange={(nextFilter) => replaceListContext({ filters: moduleFieldFilterToQuery(collection, nextFilter) })}
                    onControlsClear={() => replaceListContext({ search: '', filters: [], sort: undefined })}
                  />
                  {recordsState.nextCursor && (
                    <div className="flex justify-center py-5">
                      <button
                        type="button"
                        onClick={() => void recordsState.loadMore()}
                        disabled={recordsState.isLoadingMore}
                        className="flex min-h-10 items-center gap-2 rounded-full px-4 text-[0.8125rem] font-medium transition-colors hover:bg-[var(--surface-container-high)] disabled:opacity-60"
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
          slug={slug}
          collections={installedModule.manifest.collections}
          onClose={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  );
}
