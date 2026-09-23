'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/confirm-dialog';
import { AnchoredOverlay } from '@/components/overlay-primitives';
import { useSetPageContext } from '@/components/app-header-context';
import { ModuleRecordActivity } from '@/components/modules/module-record-activity';
import { ModuleAppRunHistory } from '@/components/modules/module-app-run-history';
import { ModuleRecordAppActions } from '@/components/modules/module-record-app-actions';
import { ModuleAppRunOutcomeSummary } from '@/components/modules/module-app-run-outcome';
import { ModuleRecordFormDialog } from '@/components/modules/module-record-form';
import { ModuleRecordRelations } from '@/components/modules/module-record-relations';
import { ModuleRelatedLatest } from '@/components/modules/module-related-latest';
import { ModuleIncomingRecords } from '@/components/modules/module-incoming-records';
import { ModuleResourceRelations } from '@/components/modules/module-resource-relations';
import { ModuleMergeHistory } from '@/components/modules/module-merge-history';
import { ModuleRecordTaskLinks } from '@/components/modules/module-record-task-links';
import { ModuleErrorState, ModuleLoadingState } from '@/components/modules/module-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { moduleListBackHref, moduleRecordHrefFromReturnContext } from '@/lib/module-list-context';
import {
  findModuleCollection,
  formatModuleFieldValue,
  getModuleCollectionFields,
  getModuleRecordTitle,
  getModuleRecordSubtitle,
  moduleApiError,
  type ModuleField,
  type ModuleMember,
  type ModuleRecord,
} from '@/lib/modules';
import {
  refreshModuleCaches,
  useModule,
  useModuleMembers,
  useModuleRealtime,
  useModuleRecord,
} from '@/hooks/use-modules';

export default function ModuleRecordDetailPage() {
  const params = useParams<{ slug: string; collectionKey: string; recordId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const slug = params?.slug ?? '';
  const collectionKey = params?.collectionKey ?? '';
  const recordId = params?.recordId ?? '';
  const moduleState = useModule(slug);
  const recordState = useModuleRecord(slug, collectionKey, recordId);
  const installedModule = moduleState.module;
  const record = recordState.record;
  const collection = installedModule ? findModuleCollection(installedModule.manifest, collectionKey) : null;
  const memberState = useModuleMembers(Boolean(collection?.fields.some((field) => field.type === 'member')));
  const [editingRecord, setEditingRecord] = useState<ModuleRecord | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [archiveIntentKey, setArchiveIntentKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [archivedRecord, setArchivedRecord] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const title = record && collection ? getModuleRecordTitle(record, collection) : 'Record';
  useModuleRealtime(slug);
  useSetPageContext(<span className="max-w-[55vw] truncate text-[0.875rem] font-semibold">{title}</span>, [title]);

  const canWrite = Boolean(
    installedModule?.enabled
    && installedModule.manifestDigest
    && user
    && user.role !== 'guest',
  );
  const backHref = moduleListBackHref(slug, collectionKey, searchParams);
  const recordReturnHref = moduleRecordHrefFromReturnContext(slug, collectionKey, recordId, searchParams);

  const handleUpdate = async (patch: Record<string, unknown>, idempotencyKey: string, unsetFields: string[], relations: Record<string, string[]>) => {
    if (!installedModule?.manifestDigest || !record || !collection || !editingRecord) throw new Error('The active module schema is unavailable.');
    const response = await api.patch(`/api/modules/${encodeURIComponent(installedModule.slug)}/records/${encodeURIComponent(record.id)}`, {
      patch,
      unset_fields: unsetFields,
      relations,
      expected_revision: editingRecord.revision,
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
      setArchivedRecord(`${slug}/${recordId}`);
      try {
        await refreshModuleCaches(installedModule.slug);
      } finally {
        router.replace(backHref);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to archive this record.');
    } finally {
      setDeleting(false);
    }
  };

  // Archiving invalidates this record before navigation commits. Its expected
  // not-found response must not replace the successful action with an error.
  if (deleting || archivedRecord === `${slug}/${recordId}`) return <ModuleLoadingState label="Archiving record…" />;
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
  const fields = (configuredFields.length > 0 ? configuredFields : collection.fields)
    .filter((field) => field.type !== 'relation' && field.type !== 'resource_ref' && !(field.key === collection.titleField && field.type === 'text'));
  const emptyFields = fields.filter((field) => {
    const value = record.data[field.key];
    return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  });
  const populatedFields = fields.filter((field) => !emptyFields.includes(field));
  const resourceRef = {
    schemaVersion: 'deft.resource_ref.v1' as const,
    providerKind: 'module' as const,
    providerInstanceId: installedModule.id,
    resourceType: collection.key,
    resourceId: record.id,
  };

  return (
    <div className="h-full overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-6xl px-4 py-3 md:px-6 md:py-6">
        <Link href={backHref} className="inline-flex min-h-9 items-center gap-1.5 text-[0.75rem] font-medium" style={{ color: 'var(--on-surface-variant)' }}>
          <ArrowLeft size={14} /> {collection.name}
        </Link>

        <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--primary)' }}>
              {collection.singularName}
            </p>
            <h1 className="mt-1 break-words text-[1.5rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>{title}</h1>
            {getModuleRecordSubtitle(record, collection) && <p className="mt-2 break-words text-sm text-[var(--on-surface-variant)]">{getModuleRecordSubtitle(record, collection)}</p>}
            <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>
              {record.updatedAt ? `Updated ${new Date(record.updatedAt).toLocaleString()}` : ''}
            </p>
            <ModuleAppRunOutcomeSummary resourceRef={resourceRef} />
          </div>
          {canWrite && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setNotice(null); setActionError(null); setEditingRecord(record); }}
                className="flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-[0.8125rem] font-medium"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
              >
                <Pencil size={14} /> Edit
              </button>
              <button ref={actionsRef} type="button" aria-label="More record actions" aria-haspopup="menu" aria-expanded={actionsOpen} onClick={() => setActionsOpen((current) => !current)} className="flex min-h-11 items-center rounded-full px-4 text-sm text-[var(--on-surface-variant)]">More</button>
              <AnchoredOverlay open={actionsOpen} onClose={() => setActionsOpen(false)} anchorRef={actionsRef} role="menu" ariaLabel="Record actions" width={180}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false);
                  setArchiveIntentKey(createIntentKey());
                  setConfirmingDelete(true);
                }}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium"
                style={{ background: 'var(--danger-subtle)', color: 'var(--error)' }}
              >
                <Trash2 size={14} /> Archive
              </button>
              </AnchoredOverlay>
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

        <div className="mt-5 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
          <div className="min-w-0 space-y-4">
            <ModuleRecordAppActions
              enabled={canWrite}
              resourceRef={resourceRef}
            />
            <ModuleRecordTaskLinks key={`tasks:${record.id}`} slug={installedModule.slug} recordId={record.id} resourceId={record.resourceId} title={title} returnHref={recordReturnHref} canWrite={canWrite} />
          {collection.hasRelatedLatest && <ModuleRelatedLatest key={`latest:${record.id}`} slug={installedModule.slug} recordId={record.id} />}
          <ModuleIncomingRecords key={`incoming:${record.id}`} installedModule={installedModule} collection={collection} record={record} canWrite={canWrite} />
          <details className="rounded-xl border border-[var(--ghost-border)]">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium text-[var(--on-surface-variant)]">Record history and receipts</summary>
            <div className="space-y-3 px-3 pb-3">
              <ModuleAppRunHistory key={`history:${record.id}`} resourceRef={resourceRef} />
              <ModuleRecordActivity resourceId={record.resourceId} fields={collection.fields} />
              {canWrite && <ModuleMergeHistory key={`merges:${record.id}`} slug={installedModule.slug} recordId={record.id} collection={collection} />}
            </div>
          </details>
          </div>

          <aside className="min-w-0 space-y-4">
          <section
            className="overflow-hidden rounded-xl"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
            aria-label={`${collection.singularName} fields`}
          >
            <h2 className="border-b border-[var(--ghost-border)] px-4 py-3 text-sm font-semibold">{collection.singularName} details</h2>
            {populatedFields.length === 0 ? (
              <p className="px-4 py-5 text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>No additional details yet.</p>
            ) : <RecordFieldRows fields={populatedFields} record={record} members={memberState.members} />}
            {emptyFields.length > 0 && <details className="border-t border-[var(--ghost-border)]">
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Show {emptyFields.length} empty {emptyFields.length === 1 ? 'field' : 'fields'}</summary>
              <RecordFieldRows fields={emptyFields} record={record} members={memberState.members} />
            </details>}
            <footer className="flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--ghost-border)] px-4 py-3 text-[0.625rem]" style={{ color: 'var(--on-surface-variant)' }}>
              {record.createdAt && <span>Created {new Date(record.createdAt).toLocaleString()}</span>}
              <span>Revision {record.revision}</span>
            </footer>
          </section>

            <ModuleRecordRelations
              slug={installedModule.slug}
              collection={collection}
              collections={installedModule.manifest.collections}
              recordId={record.id}
              recordRevision={record.revision}
              manifestDigest={installedModule.manifestDigest ?? ''}
              canWrite={canWrite}
              onRecordChanged={async () => {
                await recordState.mutate();
                await refreshModuleCaches(installedModule.slug);
              }}
            />
            <ModuleResourceRelations
              slug={installedModule.slug}
              collection={collection}
              recordId={record.id}
              canWrite={canWrite}
            />
          </aside>
        </div>
      </div>

      <ModuleRecordFormDialog
        open={Boolean(editingRecord)}
        collection={collection}
        slug={slug}
        collections={installedModule.manifest.collections}
        record={editingRecord}
        onClose={() => setEditingRecord(null)}
        onSubmit={handleUpdate}
      />
      {confirmingDelete && (
        <ConfirmDialog
          title={`Archive ${collection.singularName.toLowerCase()}?`}
          message="The record will leave normal views but remain available for audit and recovery."
          confirmLabel={deleting ? 'Archiving…' : 'Archive'}
          returnFocusRef={actionsRef}
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

function RecordFieldValue({ field, value, members }: { field: ModuleField; value: unknown; members: ModuleMember[] }) {
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
  if (field.type === 'member') {
    const ids = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
    if (ids.length === 0) return '—';
    return (
      <span className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const member = members.find((candidate) => candidate.id === id);
          return <ValuePill key={id}>{member?.name ?? 'Unknown member'}</ValuePill>;
        })}
      </span>
    );
  }
  if (field.type === 'tags' || field.type === 'multi_select') {
    const values = Array.isArray(value) ? value : [];
    if (values.length === 0) return '—';
    return (
      <span className="flex flex-wrap gap-1.5">
        {values.map((entry) => <ValuePill key={String(entry)}>{formatModuleFieldValue(entry, field)}</ValuePill>)}
      </span>
    );
  }
  if (field.type === 'single_select' && value !== null && value !== undefined && value !== '') {
    return <ValuePill>{formatModuleFieldValue(value, field)}</ValuePill>;
  }
  return formatModuleFieldValue(value, field);
}

function RecordFieldRows({ fields, record, members }: { fields: ModuleField[]; record: ModuleRecord; members: ModuleMember[] }) {
  return <dl className="divide-y divide-[var(--ghost-border)]">
    {fields.map((field) => <div key={field.key} className="grid gap-1.5 px-4 py-3.5">
      <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--on-surface-variant)' }}>{field.label}</dt>
      <dd className="min-w-0 break-words text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface)' }}><RecordFieldValue field={field} value={record.data[field.key]} members={members} /></dd>
    </div>)}
  </dl>;
}

function ValuePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-[0.6875rem]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
      {children}
    </span>
  );
}

function createIntentKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `module-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
