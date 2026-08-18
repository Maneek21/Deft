'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/confirm-dialog';
import { useSetPageContext } from '@/components/app-header-context';
import { ModuleRecordFormDialog } from '@/components/modules/module-record-form';
import { ModuleErrorState, ModuleLoadingState, ModuleStatusBadge } from '@/components/modules/module-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  findModuleCollection,
  formatModuleFieldValue,
  getModuleCollectionFields,
  getModuleRecordTitle,
  moduleApiError,
  type ModuleField,
} from '@/lib/modules';
import {
  refreshModuleCaches,
  useModule,
  useModuleRealtime,
  useModuleRecord,
} from '@/hooks/use-modules';

export default function ModuleRecordDetailPage() {
  const params = useParams<{ slug: string; collectionKey: string; recordId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const slug = params?.slug ?? '';
  const collectionKey = params?.collectionKey ?? '';
  const recordId = params?.recordId ?? '';
  const moduleState = useModule(slug);
  const recordState = useModuleRecord(slug, collectionKey, recordId);
  const installedModule = moduleState.module;
  const record = recordState.record;
  const collection = installedModule ? findModuleCollection(installedModule.manifest, collectionKey) : null;
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [archiveIntentKey, setArchiveIntentKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const title = record && collection ? getModuleRecordTitle(record, collection) : 'Record';
  useModuleRealtime(slug);
  useSetPageContext(<span className="max-w-[55vw] truncate text-[0.875rem] font-semibold">{title}</span>, [title]);

  const canWrite = Boolean(installedModule?.enabled && user && user.role !== 'guest');
  const backHref = `/modules/${encodeURIComponent(slug)}?collection=${encodeURIComponent(collectionKey)}`;

  const handleUpdate = async (patch: Record<string, unknown>, idempotencyKey: string, unsetFields: string[]) => {
    if (!installedModule?.manifestDigest || !record || !collection) throw new Error('The active module schema is unavailable.');
    const response = await api.patch(`/api/modules/${encodeURIComponent(installedModule.slug)}/records/${encodeURIComponent(record.id)}`, {
      patch,
      unset_fields: unsetFields,
      expected_revision: record.revision,
      expected_manifest_digest: installedModule.manifestDigest,
      idempotency_key: idempotencyKey,
    });
    if (!response.ok) throw new Error(await moduleApiError(response, `Unable to update ${collection.singularName.toLowerCase()}.`));
    await recordState.mutate();
    await refreshModuleCaches(installedModule.slug);
    setNotice('Changes saved.');
  };

  const handleDelete = async () => {
    if (!installedModule?.manifestDigest || !record || !collection) return;
    setDeleting(true);
    setActionError(null);
    try {
      const response = await api.delete(`/api/modules/${encodeURIComponent(installedModule.slug)}/records/${encodeURIComponent(record.id)}`, {
        expected_revision: record.revision,
        expected_manifest_digest: installedModule.manifestDigest,
        idempotency_key: archiveIntentKey ?? createIntentKey(),
      });
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to archive ${collection.singularName.toLowerCase()}.`));
      await refreshModuleCaches(installedModule.slug);
      router.replace(backHref);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to archive this record.');
    } finally {
      setDeleting(false);
    }
  };

  if (moduleState.isLoading || recordState.isLoading) return <ModuleLoadingState label="Loading record…" />;
  if (moduleState.error || recordState.error || !installedModule || !record || !collection || record.collectionKey !== collection.key) {
    const error = moduleState.error ?? recordState.error;
    return (
      <ModuleErrorState
        message={error instanceof Error ? error.message : 'This module record was not found or is no longer available.'}
        onRetry={() => void Promise.all([moduleState.mutate(), recordState.mutate()])}
      />
    );
  }

  const configuredFields = getModuleCollectionFields(collection, 'detail');
  const fields = configuredFields.length > 0 ? configuredFields : collection.fields;

  return (
    <div className="h-full overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-3xl px-4 py-3 md:px-6 md:py-6">
        <Link href={backHref} className="inline-flex min-h-9 items-center gap-1.5 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
          <ArrowLeft size={14} /> {collection.name}
        </Link>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-words text-[1.25rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{title}</h1>
              <ModuleStatusBadge enabled={installedModule.enabled} />
            </div>
            <p className="mt-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>
              {installedModule.manifest.name} · {collection.singularName} · revision {record.revision}
            </p>
          </div>
          {canWrite && (
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <button
                type="button"
                onClick={() => { setNotice(null); setActionError(null); setEditing(true); }}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
              >
                <Pencil size={14} /> Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setArchiveIntentKey(createIntentKey());
                  setConfirmingDelete(true);
                }}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium"
                style={{ background: 'var(--danger-subtle)', color: 'var(--error)' }}
              >
                <Trash2 size={14} /> Archive
              </button>
            </div>
          )}
        </div>

        {(actionError || notice) && (
          <div
            role={actionError ? 'alert' : 'status'}
            className="mt-4 rounded-lg px-3 py-2 text-[0.8125rem]"
            style={{ color: actionError ? 'var(--error)' : 'var(--status-green)', background: actionError ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)' }}
          >
            {actionError ?? notice}
          </div>
        )}

        {!installedModule.enabled && (
          <div className="mt-4 rounded-lg px-3 py-2 text-[0.75rem]" style={{ background: 'var(--surface-container-low)', color: 'var(--outline)' }}>
            This module is disabled. Its data is preserved, but records are unavailable until the module is enabled.
          </div>
        )}

        <section className="mt-5 overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
          {fields.map((field, index) => (
            <div
              key={field.key}
              className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(120px,0.35fr)_minmax(0,1fr)] sm:gap-5"
              style={{ borderTop: index > 0 ? '1px solid var(--ghost-border)' : undefined }}
            >
              <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--outline)' }}>{field.label}</dt>
              <dd className="min-w-0 break-words text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface)' }}>
                <RecordFieldValue field={field} value={record.data[field.key]} />
              </dd>
            </div>
          ))}
        </section>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
          {record.createdAt && <span>Created {new Date(record.createdAt).toLocaleString()}</span>}
          {record.updatedAt && <span>Updated {new Date(record.updatedAt).toLocaleString()}</span>}
        </div>
      </div>

      <ModuleRecordFormDialog
        open={editing}
        collection={collection}
        record={record}
        onClose={() => setEditing(false)}
        onSubmit={handleUpdate}
      />
      {confirmingDelete && (
        <ConfirmDialog
          title={`Archive ${collection.singularName.toLowerCase()}?`}
          message="The record will leave normal views but remain available for audit and recovery."
          confirmLabel={deleting ? 'Archiving…' : 'Archive'}
          danger
          onConfirm={() => { if (!deleting) void handleDelete(); }}
          onCancel={() => {
            if (!deleting) {
              setConfirmingDelete(false);
              setArchiveIntentKey(null);
            }
          }}
        />
      )}
    </div>
  );
}

function RecordFieldValue({ field, value }: { field: ModuleField; value: unknown }) {
  if (field.type === 'url' && typeof value === 'string' && /^https?:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 underline" style={{ color: 'var(--primary)' }}>
        <span className="truncate">{value}</span><ExternalLink size={12} className="flex-shrink-0" />
      </a>
    );
  }
  if (field.type === 'email' && typeof value === 'string') {
    return <a href={`mailto:${encodeURIComponent(value)}`} className="underline" style={{ color: 'var(--primary)' }}>{value}</a>;
  }
  return formatModuleFieldValue(value, field);
}

function createIntentKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `module-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
