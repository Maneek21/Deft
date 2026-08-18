'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Loader2,
  Plus,
  Power,
  Search,
  TableProperties,
} from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { useSetPageContext } from '@/components/app-header-context';
import { ModuleRecordFormDialog } from '@/components/modules/module-record-form';
import {
  ModuleErrorState,
  ModuleIcon,
  ModuleLoadingState,
  ModuleStatusBadge,
} from '@/components/modules/module-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  formatModuleFieldValue,
  getModuleCollectionFields,
  getModuleRecordSubtitle,
  getModuleRecordTitle,
  moduleApiError,
  moduleRecordHref,
  type ModuleCollection,
  type ModuleRecord,
} from '@/lib/modules';
import {
  refreshModuleCaches,
  useModule,
  useModuleRealtime,
  useModuleRecords,
} from '@/hooks/use-modules';

export default function ModuleWorkspacePage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const slug = params?.slug ?? '';
  const moduleState = useModule(slug);
  const installedModule = moduleState.module;
  const requestedCollection = searchParams.get('collection');
  const collection = installedModule?.manifest.collections.find((candidate) => candidate.key === requestedCollection)
    ?? installedModule?.manifest.collections[0]
    ?? null;
  const recordsState = useModuleRecords(slug, installedModule?.enabled ? collection?.key ?? '' : '');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useModuleRealtime(slug);
  useSetPageContext(
    <span className="max-w-[55vw] truncate text-[0.875rem] font-semibold">{installedModule?.manifest.name ?? 'Module'}</span>,
    [installedModule?.manifest.name],
  );

  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const canWrite = Boolean(installedModule?.enabled && user && user.role !== 'guest');
  const filteredRecords = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle || !collection) return recordsState.records;
    return recordsState.records.filter((record) => {
      const haystack = [
        getModuleRecordTitle(record, collection),
        getModuleRecordSubtitle(record, collection),
        ...Object.values(record.data).flatMap((value) => Array.isArray(value) ? value : [value]).map(String),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [collection, filter, recordsState.records]);

  const handleLifecycle = async (patch: { enabled?: boolean; agent_access?: 'none' | 'read' | 'write' }) => {
    if (!installedModule) return;
    setLifecycleBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.patch(`/api/modules/${encodeURIComponent(installedModule.slug)}`, {
        ...patch,
      });
      if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to update this module.'));
      await refreshModuleCaches(installedModule.slug);
      setNotice('Module settings updated.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update this module.');
    } finally {
      setLifecycleBusy(false);
    }
  };

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

  const chooseCollection = (key: string) => {
    setFilter('');
    router.replace(`/modules/${encodeURIComponent(slug)}?collection=${encodeURIComponent(key)}`);
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
      <div className="flex-shrink-0 px-4 pb-3 pt-2 md:px-6 md:pt-5">
        <Link href="/modules" className="mb-3 inline-flex min-h-9 items-center gap-1.5 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
          <ArrowLeft size={14} /> All modules
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
              <ModuleIcon token={installedModule.manifest.icon} size={22} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-[1.25rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{installedModule.manifest.name}</h1>
                <ModuleStatusBadge enabled={installedModule.enabled} />
              </div>
              <p className="mt-1 max-w-2xl text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                {installedModule.manifest.description ?? 'A schema-driven workspace module.'}
              </p>
            </div>
          </div>
          {canManage && (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <label className="col-span-2 flex min-h-11 items-center gap-2 rounded-lg px-3 text-[0.75rem] sm:col-span-1" style={{ background: 'var(--surface-container-low)', color: 'var(--on-surface-variant)' }}>
                <Bot size={14} />
                <span className="sr-only sm:not-sr-only">Agent access</span>
                <select
                  value={installedModule.agentAccess}
                  onChange={(event) => void handleLifecycle({ agent_access: event.target.value as 'none' | 'read' | 'write' })}
                  disabled={lifecycleBusy}
                  className="min-w-0 flex-1 bg-transparent text-[0.75rem] outline-none"
                  aria-label="Agent access"
                >
                  <option value="none">No access</option>
                  <option value="read">Read</option>
                  <option value="write">Read & write</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => void handleLifecycle({ enabled: !installedModule.enabled })}
                disabled={lifecycleBusy}
                className="col-span-2 flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.75rem] font-medium disabled:opacity-60 sm:col-span-1"
                style={{ color: installedModule.enabled ? 'var(--error)' : 'var(--status-green)', background: installedModule.enabled ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)' }}
              >
                {lifecycleBusy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                {installedModule.enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          )}
        </div>
        {installedModule.manifest.collections.length > 1 && (
          <div className="-mx-1 mt-4 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Module collections">
            {installedModule.manifest.collections.map((candidate) => (
              <button
                key={candidate.key}
                type="button"
                role="tab"
                aria-selected={candidate.key === collection?.key}
                onClick={() => chooseCollection(candidate.key)}
                className="min-h-11 flex-shrink-0 rounded-lg px-3 text-[0.8125rem] font-medium"
                style={{
                  color: candidate.key === collection?.key ? 'var(--on-surface)' : 'var(--outline)',
                  background: candidate.key === collection?.key ? 'var(--bg-active)' : 'transparent',
                }}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6">
        {(actionError || notice) && (
          <div
            role={actionError ? 'alert' : 'status'}
            className="mb-3 rounded-lg px-3 py-2 text-[0.8125rem]"
            style={{ color: actionError ? 'var(--error)' : 'var(--status-green)', background: actionError ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)' }}
          >
            {actionError ?? notice}
          </div>
        )}

        {!installedModule.enabled ? (
          <EmptyState
            icon={<Power size={20} style={{ color: 'var(--outline)' }} />}
            title="Module disabled"
            description="Its data is preserved. A workspace owner or admin can enable it when the team is ready."
            action={canManage ? { label: 'Enable module', onClick: () => void handleLifecycle({ enabled: true }) } : undefined}
          />
        ) : !collection ? (
          <EmptyState
            icon={<TableProperties size={20} style={{ color: 'var(--outline)' }} />}
            title="No collections"
            description="This module manifest does not expose a record collection."
          />
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{collection.name}</h2>
                {collection.description && <p className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--outline)' }}>{collection.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 sm:w-56" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
                  <Search size={14} style={{ color: 'var(--outline)' }} />
                  <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter loaded records"
                    className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none"
                    style={{ color: 'var(--on-surface)' }}
                  />
                </label>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => { setActionError(null); setNotice(null); setCreating(true); }}
                    aria-label={`New ${collection.singularName.toLowerCase()}`}
                    className="flex min-h-11 flex-shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium text-white"
                    style={{ background: 'var(--primary-container)' }}
                  >
                    <Plus size={15} /> <span className="hidden sm:inline">New</span>
                  </button>
                )}
              </div>
            </div>

            {recordsState.isLoading ? (
              <ModuleLoadingState label={`Loading ${collection.name.toLowerCase()}…`} />
            ) : recordsState.error ? (
              <ModuleErrorState
                message={recordsState.error instanceof Error ? recordsState.error.message : 'Records could not be loaded.'}
                onRetry={() => void recordsState.mutate()}
              />
            ) : filteredRecords.length === 0 ? (
              <EmptyState
                icon={<TableProperties size={20} style={{ color: 'var(--primary)' }} />}
                title={filter ? 'No matching records' : `No ${collection.name.toLowerCase()} yet`}
                description={filter ? 'Try a different local filter.' : `Create the first ${collection.singularName.toLowerCase()} for this module.`}
                action={!filter && canWrite ? { label: `New ${collection.singularName.toLowerCase()}`, onClick: () => setCreating(true) } : undefined}
              />
            ) : (
              <>
                <ModuleRecordTable slug={installedModule.slug} collection={collection} records={filteredRecords} />
                {recordsState.nextCursor && !filter && (
                  <div className="flex justify-center py-4">
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

            <ModuleRecordFormDialog
              open={creating}
              collection={collection}
              onClose={() => setCreating(false)}
              onSubmit={handleCreate}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ModuleRecordTable({ slug, collection, records }: { slug: string; collection: ModuleCollection; records: ModuleRecord[] }) {
  const configuredFields = getModuleCollectionFields(collection, 'table');
  const fields = (configuredFields.length > 0 ? configuredFields : collection.fields).slice(0, 6);
  return (
    <div className="overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr style={{ background: 'var(--surface-container)' }}>
              {fields.map((field) => (
                <th key={field.key} className="px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--outline)' }}>{field.label}</th>
              ))}
              <th className="w-10"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id} className="group" style={{ borderTop: '1px solid var(--ghost-border)' }}>
                {fields.map((field, index) => (
                  <td key={field.key} className="max-w-[280px] px-4 py-3 text-[0.8125rem]" style={{ color: index === 0 ? 'var(--on-surface)' : 'var(--on-surface-variant)', fontWeight: index === 0 ? 500 : 400 }}>
                    <span className="block truncate">{formatModuleFieldValue(record.data[field.key], field)}</span>
                  </td>
                ))}
                <td className="pr-2">
                  <Link href={moduleRecordHref(slug, collection.key, record.id)} aria-label={`Open ${getModuleRecordTitle(record, collection)}`} className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: 'var(--outline)' }}>
                    <ChevronRight size={15} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-[var(--ghost-border)] md:hidden">
        {records.map((record) => (
          <Link
            key={record.id}
            href={moduleRecordHref(slug, collection.key, record.id)}
            className="flex min-h-[72px] items-center gap-3 px-3 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.875rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(record, collection)}</p>
              <p className="mt-1 truncate text-[0.75rem]" style={{ color: 'var(--outline)' }}>{getModuleRecordSubtitle(record, collection) || 'No additional details'}</p>
            </div>
            <ChevronRight size={16} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
          </Link>
        ))}
      </div>
    </div>
  );
}
