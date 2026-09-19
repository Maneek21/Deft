'use client';
import { ModuleRecordNextTask, useModuleRecordNextTasks } from './module-record-next-task';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownAZ,
  CalendarRange,
  ChevronRight,
  Columns3,
  Filter,
  ListFilter,
  Search,
  Table2,
  X,
} from 'lucide-react';
import {
  formatModuleFieldValue,
  formatModuleRecordFieldValue,
  getModuleBoardGroupField,
  getModuleRecordSubtitle,
  getModuleRecordTitle,
  getModuleTimelineFields,
  getModuleViewFields,
  type ModuleCollection,
  type ModuleField,
  type ModuleRecord,
  type ModuleRecordSort,
  type ModuleView,
  type ResourceRef,
} from '@/lib/modules';
import type { ModuleAppRunOutcome } from '@/lib/app-actions';
import { resolveModuleViewLayoutKey, type ModuleFieldFilter } from '@/lib/module-saved-views';
import type { ModuleBoardMove } from '@/lib/module-board';
import { formatModuleRecordCount } from '@/lib/module-list-context';
import { ModuleBoardMoveDialog } from './module-board-move-dialog';
import { ModuleAppRunOutcomeBadge } from './module-app-run-outcome';
import { useModuleAppRunOutcomes } from '@/hooks/use-app-actions';

type ModuleOutcomeLookup = (recordId: string) => ModuleAppRunOutcome | undefined;

export function ModuleRecordExplorer({
  slug,
  collection,
  view,
  records,
  providerInstanceId,
  search,
  sort,
  filter,
  hasMore,
  isQuerying,
  recordHref,
  onViewChange,
  onSearchChange,
  onSortChange,
  onFilterChange,
  onControlsClear,
  onMove,
  manifestDigest,
  loading = false,
  error,
  onRetry,
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
  providerInstanceId: string;
  search: string;
  sort: ModuleRecordSort | null;
  filter: ModuleFieldFilter;
  hasMore?: boolean;
  isQuerying?: boolean;
  recordHref: (recordId: string) => string;
  onViewChange: (viewKey: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: ModuleRecordSort | null) => void;
  onFilterChange: (value: ModuleFieldFilter) => void;
  onControlsClear: () => void;
  onMove?: ModuleBoardMove;
  manifestDigest?: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const outcomeRefs = useMemo<ResourceRef[]>(() => records.map((record) => ({
    schemaVersion: 'deft.resource_ref.v1',
    providerKind: 'module',
    providerInstanceId,
    resourceType: collection.key,
    resourceId: record.id,
  })), [collection.key, providerInstanceId, records]);
  const outcomeState = useModuleAppRunOutcomes(outcomeRefs, true);
  const outcomeForRecord: ModuleOutcomeLookup = (recordId) => outcomeState.outcomesByResourceId.get(recordId);
  const viewOptions = collection.views.filter((candidate) => (
    candidate.type === 'table' || candidate.type === 'board' || candidate.type === 'timeline'
  ));
  const selectedViewKey = resolveModuleViewLayoutKey(view, viewOptions);
  const filterFields = collection.fields.filter((field) => (
    field.type !== 'relation' && field.type !== 'resource_ref'
  ));
  const sortableFields = collection.fields.filter((field) => field.type !== 'relation' && field.type !== 'long_text');
  const hasActiveControls = Boolean(search.trim() || sort || filter?.value);

  const clearControls = () => {
    onControlsClear();
  };

  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="sr-only" style={{ color: 'var(--on-surface)' }}>
                {collection.name}
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-[0.6875rem] tabular-nums"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}
              >
                {formatModuleRecordCount(records.length, Boolean(hasMore), Boolean(isQuerying))}
              </span>
            </div>
            {collection.description && (
              <p className="mt-1 max-w-2xl text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                {collection.description}
              </p>
            )}
          </div>

          <div
            className="flex w-full max-w-full items-center gap-1 overflow-x-auto rounded-full p-1 sm:w-fit"
            style={{ background: 'var(--surface-container-low)' }}
            role="tablist"
            aria-label={`${collection.name} views`}
          >
            {(viewOptions.length > 0 ? viewOptions : [view]).map((candidate) => (
              <button
                key={candidate.key}
                type="button"
                role="tab"
                aria-selected={candidate.key === selectedViewKey}
                onClick={() => onViewChange(candidate.key)}
                className="flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[0.75rem] font-medium transition-colors sm:flex-none"
                style={{
                  color: candidate.key === selectedViewKey ? 'var(--on-surface)' : 'var(--outline)',
                  background: candidate.key === selectedViewKey ? 'var(--surface-container-high)' : 'transparent',
                }}
              >
                <ViewIcon type={candidate.type} />
                {candidate.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-full px-4 sm:max-w-md"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
          >
            <Search size={15} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
            <input
              aria-label="Search records"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={`Search ${collection.name.toLowerCase()}`}
              className="min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none"
              style={{ color: 'var(--on-surface)' }}
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
                style={{ color: 'var(--outline)' }}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            className="flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[0.75rem] font-medium sm:hidden"
            style={{
              background: filtersOpen || filter?.value || sort ? 'var(--bg-active)' : 'var(--surface-container-low)',
              color: filtersOpen || filter?.value || sort ? 'var(--on-surface)' : 'var(--on-surface-variant)',
              border: '1px solid var(--ghost-border)',
            }}
            aria-expanded={filtersOpen}
          >
            <ListFilter size={14} /> Filter
          </button>

          <div className="hidden gap-2 sm:flex">
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              className="flex min-h-10 items-center justify-center gap-2 rounded-full px-3 text-[0.75rem] font-medium"
              style={{
                background: filtersOpen || filter?.value ? 'var(--bg-active)' : 'var(--surface-container-low)',
                color: filtersOpen || filter?.value ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                border: '1px solid var(--ghost-border)',
              }}
              aria-expanded={filtersOpen}
            >
              <ListFilter size={14} /> Filter {filter?.value ? '1' : ''}
            </button>
            <label
              className="flex min-h-10 items-center gap-2 rounded-full px-3 text-[0.75rem]"
              style={{ background: 'var(--surface-container-low)', color: 'var(--on-surface-variant)', border: '1px solid var(--ghost-border)' }}
            >
              <ArrowDownAZ size={14} />
              <span className="sr-only">Sort records</span>
              <select
                value={sort ? `${sort.fieldKey}:${sort.direction}` : ''}
                onChange={(event) => {
                  const [fieldKey, direction] = event.target.value.split(':');
                  onSortChange(fieldKey && (direction === 'asc' || direction === 'desc') ? { fieldKey, direction } : null);
                }}
                className="min-w-0 flex-1 bg-transparent outline-none"
                aria-label="Sort records"
              >
                <option value="">Default order</option>
                {sortableFields.flatMap((field) => [
                  <option key={`${field.key}:asc`} value={`${field.key}:asc`}>{field.label} · A–Z</option>,
                  <option key={`${field.key}:desc`} value={`${field.key}:desc`}>{field.label} · Z–A</option>,
                ])}
              </select>
            </label>
          </div>
        </div>

        {filtersOpen && (
          <FilterPanel
            fields={filterFields}
            filter={filter}
            onChange={onFilterChange}
            sortableFields={sortableFields}
            sort={sort}
            onSortChange={onSortChange}
            onClose={() => setFiltersOpen(false)}
          />
        )}

        {hasActiveControls && (
          <div className="flex items-center justify-between gap-3 text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            <span>Search, filters, and sorting run across the full collection.</span>
            <button type="button" onClick={clearControls} className="flex-shrink-0 font-medium" style={{ color: 'var(--primary)' }}>
              Clear all
            </button>
          </div>
        )}
        {outcomeState.outcomesUnavailable && <p className="text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>Recent App outcomes are temporarily unavailable.</p>}
      </div>

      {error ? <div role="alert" className="rounded-xl p-5 text-sm">{error} <button className="min-h-11 underline" onClick={onRetry}>Retry records</button></div>
      : loading ? <p role="status" className="rounded-xl p-5 text-sm">Loading records…</p>
      : records.length === 0 ? (
        <div
          className="flex min-h-[240px] flex-col items-center justify-center rounded-xl px-5 text-center"
          style={{ background: 'var(--surface-container-low)', border: '1px dashed var(--outline-variant)' }}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'var(--surface-container-high)', color: 'var(--outline)' }}>
            <Filter size={18} />
          </span>
          <p className="mt-3 text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>No matching records</p>
          <p className="mt-1 text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>Clear a search or filter to widen this view.</p>
          <button type="button" onClick={clearControls} className="mt-3 min-h-10 rounded-full px-4 text-[0.75rem] font-medium" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}>
            Reset view
          </button>
        </div>
      ) : view.type === 'board' ? (
        <ModuleBoard slug={slug} collection={collection} view={view} records={records} recordHref={recordHref} outcomeForRecord={outcomeForRecord} hasMore={hasMore} onMove={onMove} manifestDigest={manifestDigest} />
      ) : view.type === 'timeline' ? (
        <ModuleTimeline collection={collection} view={view} records={records} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />
      ) : (
        <ModuleRecordTable collection={collection} view={view} records={records} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />
      )}
    </div>
  );
}

function FilterPanel({
  fields,
  filter,
  onChange,
  sortableFields,
  sort,
  onSortChange,
  onClose,
}: {
  fields: ModuleField[];
  filter: ModuleFieldFilter;
  onChange: (filter: ModuleFieldFilter) => void;
  sortableFields: ModuleField[];
  sort: ModuleRecordSort | null;
  onSortChange: (value: ModuleRecordSort | null) => void;
  onClose: () => void;
}) {
  const [selectedField, setSelectedField] = useState(filter?.fieldKey ?? fields[0]?.key ?? '');
  const field = fields.find((candidate) => candidate.key === selectedField) ?? fields[0] ?? null;
  const values = field?.type === 'boolean'
    ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : field?.type === 'single_select' ? field.options : [];

  return (
    <div
      className="grid gap-2 rounded-xl p-3 sm:grid-cols-[minmax(140px,0.8fr)_minmax(160px,1fr)_auto] sm:items-center"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
    >
      {fields.length === 0 ? (
        <p className="text-[0.75rem] sm:col-span-2" style={{ color: 'var(--on-surface-variant)' }}>
          This collection has no fields available to filter.
        </p>
      ) : (
        <>
          <label>
            <span className="sr-only">Filter field</span>
            <select
              value={field?.key ?? ''}
              aria-label="Filter field"
              onChange={(event) => { setSelectedField(event.target.value); onChange(null); }}
              className="min-h-10 w-full rounded-lg px-3 text-[0.75rem] outline-none"
              style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--ghost-border)' }}
            >
              {fields.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Filter value</span>
            <select
              value={filter?.fieldKey === field?.key ? filter.value : ''}
              aria-label="Filter value"
              onChange={(event) => onChange(field ? { fieldKey: field.key, value: event.target.value } : null)}
              className="min-h-10 w-full rounded-lg px-3 text-[0.75rem] outline-none"
              style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--ghost-border)' }}
            >
              <option value="">Any value</option>
              <option value="__empty__">Is empty</option>
              <option value="__present__">Has a value</option>
              {values.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </>
      )}
      <label className="sm:hidden">
        <span className="sr-only">Sort records</span>
        <select
          value={sort ? `${sort.fieldKey}:${sort.direction}` : ''}
          onChange={(event) => {
            const [fieldKey, direction] = event.target.value.split(':');
            onSortChange(fieldKey && (direction === 'asc' || direction === 'desc') ? { fieldKey, direction } : null);
          }}
          className="min-h-10 w-full rounded-lg px-3 text-[0.75rem] outline-none"
          style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--ghost-border)' }}
          aria-label="Sort records"
        >
          <option value="">Default order</option>
          {sortableFields.flatMap((sortableField) => [
            <option key={`${sortableField.key}:asc`} value={`${sortableField.key}:asc`}>{sortableField.label} · A–Z</option>,
            <option key={`${sortableField.key}:desc`} value={`${sortableField.key}:desc`}>{sortableField.label} · Z–A</option>,
          ])}
        </select>
      </label>
      <button
        type="button"
        onClick={onClose}
        className="flex min-h-10 items-center justify-center rounded-full px-4 text-[0.75rem] font-medium"
        style={{ color: 'var(--on-surface-variant)' }}
      >
        Done
      </button>
    </div>
  );
}

function ModuleRecordTable({
  collection,
  view,
  records,
  recordHref,
  outcomeForRecord,
}: {
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
  recordHref: (recordId: string) => string;
  outcomeForRecord: ModuleOutcomeLookup;
}) {
  const fields = getModuleViewFields(collection, view).slice(0, 7);
  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr style={{ background: 'var(--surface-container)' }}>
              {fields.map((field) => (
                <th key={field.key} className="px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--on-surface-variant)' }}>
                  {field.label}
                </th>
              ))}
              <th className="w-12"><span className="sr-only">Open record</span></th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id} style={{ borderTop: '1px solid var(--ghost-border)' }}>
                {fields.map((field, index) => (
                  <td key={field.key} className="max-w-[280px] px-4 py-3 text-[0.8125rem]" style={{ color: index === 0 ? 'var(--on-surface)' : 'var(--on-surface-variant)', fontWeight: index === 0 ? 500 : 400 }}>
                    {index === 0 ? (
                      <div className="min-w-0">
                        <Link href={recordHref(record.id)} className="block truncate hover:underline">
                          {formatModuleRecordFieldValue(record, field)}
                        </Link>
                        {outcomeForRecord(record.id) && <div className="mt-1"><ModuleAppRunOutcomeBadge outcome={outcomeForRecord(record.id)} /></div>}
                      </div>
                    ) : field.type === 'single_select' ? (
                      <span className="inline-flex max-w-full rounded-full px-2 py-0.5 text-[0.6875rem] font-medium" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
                        <span className="truncate">{formatModuleRecordFieldValue(record, field)}</span>
                      </span>
                    ) : (
                      <span className="block truncate">{formatModuleRecordFieldValue(record, field)}</span>
                    )}
                  </td>
                ))}
                <td className="pr-2">
                  <Link
                    href={recordHref(record.id)}
                    aria-label={`Open ${getModuleRecordTitle(record, collection)}`}
                    className="flex h-9 w-9 items-center justify-center rounded-full"
                    style={{ color: 'var(--on-surface-variant)' }}
                  >
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
          <RecordCardLink key={record.id} collection={collection} view={view} record={record} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />
        ))}
      </div>
    </div>
  );
}

function ModuleBoard({
  slug,
  collection,
  view,
  records,
  recordHref,
  outcomeForRecord,
  hasMore,
  onMove,
  manifestDigest,
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
  recordHref: (recordId: string) => string;
  outcomeForRecord: ModuleOutcomeLookup;
  hasMore?: boolean;
  onMove?: ModuleBoardMove;
  manifestDigest?: string;
}) {
  const [moving, setMoving] = useState<{ record: ModuleRecord; field: ModuleField; digest: string } | null>(null);
  const groupField = getModuleBoardGroupField(collection, view);
  const nextTasks = useModuleRecordNextTasks(slug, groupField ? records.map((record) => record.id) : []);
  if (!groupField) {
    return (
      <ViewFallback message="This board has no group field. Showing a table until the manifest defines one.">
        <ModuleRecordTable collection={collection} view={{ ...view, type: 'table' }} records={records} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />
      </ViewFallback>
    );
  }
  const optionGroups = groupField.type === 'boolean'
    ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : groupField.options;
  const discovered = records
    .flatMap((record) => {
      const value = record.data[groupField.key];
      return Array.isArray(value) ? value.map(String) : value === undefined || value === null || value === '' ? [] : [String(value)];
    })
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((value) => !optionGroups.some((option) => option.value === value));
  const groups = [
    ...optionGroups,
    ...discovered.map((value) => ({ value, label: moduleGroupValueLabel(records, groupField, value) })),
    { value: '', label: 'No value' },
  ].map((group) => ({
    ...group,
    records: records.filter((record) => {
      const value = record.data[groupField.key];
      if (group.value === '') return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
      return Array.isArray(value) ? value.map(String).includes(group.value) : String(value) === group.value;
    }),
  })).filter((group) => group.records.length > 0 || group.value !== '');

  const canMove = onMove && manifestDigest && ['single_select', 'boolean'].includes(groupField.type);
  const cardFields = getModuleViewFields(collection, view).filter((field) => field.key !== collection.titleField && field.key !== groupField.key);
  return (
    <div>
    <div id="module-board-focus" tabIndex={-1} className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>
      {hasMore && <p>Counts cover loaded records. Load more to include the remaining matches.</p>}
      <p className="sm:hidden">Swipe sideways for every {groupField.label.toLowerCase()}.</p>
    </div>
    <div className="-mx-4 snap-x snap-proximity overflow-x-auto px-4 pb-3 md:-mx-0 md:px-0">
      <div className="grid min-w-max auto-cols-[minmax(260px,300px)] grid-flow-col gap-3">
        {groups.map((group) => (
          <section key={group.value || '__empty'} aria-label={`${groupField.label}: ${group.label}`} className="w-[min(82vw,300px)] snap-start rounded-xl p-2" style={{ background: 'var(--surface-container)' }}>
            <header className="flex items-center justify-between gap-2 px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: groupColor(group.value) }} />
                <h3 className="truncate text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{group.label}</h3>
              </div>
              <span className="text-[0.6875rem] tabular-nums" style={{ color: 'var(--on-surface-variant)' }}>{group.records.length}</span>
            </header>
            <div role="region" aria-label={`${group.label} cards`} tabIndex={group.records.length ? 0 : -1} className="mt-1 max-h-[min(65vh,720px)] space-y-2 overflow-y-auto overscroll-contain rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
              {group.records.map((record) => (
                <article key={record.id} className="overflow-hidden rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
                <Link
                  href={recordHref(record.id)}
                  className="block p-3 hover:bg-[var(--surface-container-high)]"
                >
                  <p className="line-clamp-2 text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>
                    {getModuleRecordTitle(record, collection)}
                  </p>
                  {outcomeForRecord(record.id) && <div className="mt-2"><ModuleAppRunOutcomeBadge outcome={outcomeForRecord(record.id)} /></div>}
                  <dl className="mt-3 space-y-2">{cardFields.map((field) => <div key={field.key} className="flex items-start justify-between gap-3 text-xs"><dt className="shrink-0" style={{ color: 'var(--on-surface-variant)' }}>{field.label}</dt><dd className="min-w-0 break-words text-right" style={{ color: 'var(--on-surface-variant)' }}>{formatModuleRecordFieldValue(record, field)}</dd></div>)}</dl>
                </Link>
                {canMove && <button id={`module-board-move-${record.id}`} type="button" aria-label={`Change ${groupField.label.toLowerCase()} for ${getModuleRecordTitle(record, collection)}`} onClick={() => setMoving({ record, field: groupField, digest: manifestDigest! })} className="min-h-11 w-full border-t px-3 text-left text-xs font-medium" style={{ borderColor: 'var(--ghost-border)', color: 'var(--primary)' }}>Change {groupField.label.toLowerCase()}</button>}
                  <ModuleRecordNextTask result={nextTasks.data?.[record.id]} onRetry={() => void nextTasks.mutate()} />
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
    {moving && onMove && <ModuleBoardMoveDialog record={moving.record} field={moving.field} collection={collection} manifestDigest={moving.digest} onMove={onMove} onClose={() => {
      const recordId = moving.record.id;
      setMoving(null);
      requestAnimationFrame(() => (document.getElementById(`module-board-move-${recordId}`) ?? document.getElementById('module-board-focus'))?.focus());
    }} />}
    </div>
  );
}

function ModuleTimeline({
  collection,
  view,
  records,
  recordHref,
  outcomeForRecord,
}: {
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
  recordHref: (recordId: string) => string;
  outcomeForRecord: ModuleOutcomeLookup;
}) {
  const fields = getModuleTimelineFields(collection, view);
  if (!fields.start) {
    return (
      <ViewFallback message="This timeline has no date field. Showing a table until the manifest defines one.">
        <ModuleRecordTable collection={collection} view={{ ...view, type: 'table' }} records={records} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />
      </ViewFallback>
    );
  }
  const dated = records.flatMap((record) => {
    const start = parseDateValue(record.data[fields.start!.key]);
    if (!start) return [];
    const configuredEnd = fields.end ? parseDateValue(record.data[fields.end.key]) : null;
    const end = configuredEnd && configuredEnd.getTime() >= start.getTime() ? configuredEnd : start;
    return [{ record, start, end }];
  });
  const undated = records.filter((record) => !dated.some((entry) => entry.record.id === record.id));
  if (dated.length === 0) {
    return (
      <ViewFallback message={`No loaded records have a value in ${fields.start.label}.`}>
        <ModuleRecordTable collection={collection} view={{ ...view, type: 'table' }} records={records} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />
      </ViewFallback>
    );
  }
  const min = Math.min(...dated.map((entry) => entry.start.getTime()));
  const max = Math.max(...dated.map((entry) => entry.end.getTime()), min + 86_400_000);
  const span = Math.max(max - min, 86_400_000);

  return (
    <div className="relative overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
      <div className={`divide-y divide-[var(--ghost-border)] ${fields.end ? 'md:hidden' : ''}`}>
        {dated.map(({ record, start, end }) => (
          <Link key={record.id} href={recordHref(record.id)} className="flex min-h-[88px] items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[0.6875rem] font-medium" style={{ color: 'var(--primary)' }}>
                {formatCompactDate(start)}{end.getTime() !== start.getTime() ? ` – ${formatCompactDate(end)}` : ''}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="min-w-0 break-words text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(record, collection)}</p>
                <ModuleAppRunOutcomeBadge outcome={outcomeForRecord(record.id)} />
              </div>
              <p className="mt-1 truncate text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>{getModuleViewRecordContext(record, collection, view)}</p>
            </div>
            <ChevronRight size={16} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
          </Link>
        ))}
      </div>
      <div className={`hidden overflow-x-auto ${fields.end ? 'md:block' : ''}`}>
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[220px_minmax(480px,1fr)] text-[0.6875rem] font-medium" style={{ background: 'var(--surface-container)', color: 'var(--on-surface-variant)' }}>
            <div className="px-4 py-3">{collection.singularName}</div>
            <div className="flex items-center justify-between border-l border-[var(--ghost-border)] px-4 py-3">
              <span>{formatCompactDate(new Date(min))}</span>
              <span>{formatCompactDate(new Date(max))}</span>
            </div>
          </div>
          {dated.map(({ record, start, end }) => {
            const left = Math.max(0, ((start.getTime() - min) / span) * 100);
            const width = Math.max(2.5, ((end.getTime() - start.getTime() + 86_400_000) / span) * 100);
            return (
              <div key={record.id} className="grid min-h-[54px] grid-cols-[220px_minmax(480px,1fr)] border-t border-[var(--ghost-border)]">
                <Link href={recordHref(record.id)} className="min-w-0 px-4 py-3 hover:underline">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(record, collection)}</p>
                    <ModuleAppRunOutcomeBadge outcome={outcomeForRecord(record.id)} />
                  </div>
                  <p className="mt-0.5 truncate text-[0.625rem]" style={{ color: 'var(--on-surface-variant)' }}>
                    {formatCompactDate(start)}{getModuleViewRecordContext(record, collection, view) ? ` · ${getModuleViewRecordContext(record, collection, view)}` : ''}
                  </p>
                </Link>
                <div className="relative border-l border-[var(--ghost-border)] px-4 py-3">
                  <div className="absolute inset-y-0 left-1/4 border-l border-dashed border-[var(--ghost-border)]" />
                  <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-[var(--ghost-border)]" />
                  <div className="absolute inset-y-0 left-3/4 border-l border-dashed border-[var(--ghost-border)]" />
                  <Link
                    href={recordHref(record.id)}
                    className="absolute top-1/2 h-6 -translate-y-1/2 rounded-md px-2 text-[0.625rem] font-medium leading-6 text-white"
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, minWidth: 28, background: 'var(--primary-container)' }}
                    title={`${getModuleRecordTitle(record, collection)} · ${formatCompactDate(start)}${end.getTime() !== start.getTime() ? ` – ${formatCompactDate(end)}` : ''}`}
                  >
                    <span className="block truncate">{getModuleRecordTitle(record, collection)}</span>
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {undated.length > 0 && (
        <details className="border-t border-[var(--ghost-border)]">
          <summary className="cursor-pointer px-4 py-3 text-[0.75rem] font-medium" style={{ color: 'var(--on-surface-variant)' }}>
            {undated.length} without {fields.start.label.toLowerCase()}
          </summary>
          <div className="divide-y divide-[var(--ghost-border)] border-t border-[var(--ghost-border)]">
            {undated.map((record) => <RecordCardLink key={record.id} collection={collection} view={view} record={record} recordHref={recordHref} outcomeForRecord={outcomeForRecord} />)}
          </div>
        </details>
      )}
    </div>
  );
}

function RecordCardLink({
  collection,
  view,
  record,
  recordHref,
  outcomeForRecord,
}: {
  collection: ModuleCollection;
  view: ModuleView;
  record: ModuleRecord;
  recordHref: (recordId: string) => string;
  outcomeForRecord: ModuleOutcomeLookup;
}) {
  const context = getModuleViewRecordContext(record, collection, view);
  const outcome = outcomeForRecord(record.id);
  const titleKey = collection.titleField ?? collection.fields[0]?.key;
  const selectStates = getModuleViewFields(collection, view)
    .filter((field) => field.key !== titleKey && field.type === 'single_select')
    .map((field) => ({ field, value: formatModuleRecordFieldValue(record, field) }))
    .filter(({ value }) => value !== '—')
    .slice(0, 2);
  return (
    <Link href={recordHref(record.id)} className="flex min-h-[72px] items-center gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.875rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(record, collection)}</p>
        {(outcome || selectStates.length > 0) && <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <ModuleAppRunOutcomeBadge outcome={outcome} />
          {selectStates.map(({ field, value }) => <span
            key={field.key}
            aria-label={`${field.label}: ${value}`}
            className="inline-flex max-w-full rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
            style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}
          ><span className="truncate">{value}</span></span>)}
        </div>}
        <p className="mt-1 truncate text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>{context || getModuleRecordSubtitle(record, collection) || 'No additional details'}</p>
      </div>
      <ChevronRight size={16} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
    </Link>
  );
}

function getModuleViewRecordContext(
  record: ModuleRecord,
  collection: ModuleCollection,
  view: ModuleView,
): string {
  const titleKey = collection.titleField ?? collection.fields[0]?.key;
  return getModuleViewFields(collection, view)
    .filter((field) => field.key !== titleKey)
    .map((field) => formatModuleRecordFieldValue(record, field))
    .filter((value) => value && value !== '—')
    .slice(0, 2)
    .join(' · ');
}

function moduleGroupValueLabel(records: ModuleRecord[], field: ModuleField, value: string): string {
  if (field.type === 'member') {
    for (const record of records) {
      const label = record.members
        .find((group) => group.fieldKey === field.key)
        ?.members.find((member) => member.id === value)?.label;
      if (label) return label;
    }
  }
  return formatModuleFieldValue(value, field);
}

function ViewFallback({ message, children }: { message: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[0.75rem]" style={{ background: 'var(--surface-container-low)', color: 'var(--on-surface-variant)' }}>
        <CalendarRange size={14} className="mt-0.5 flex-shrink-0" />
        {message}
      </div>
      {children}
    </div>
  );
}

function ViewIcon({ type }: { type: ModuleView['type'] }) {
  if (type === 'board') return <Columns3 size={13} />;
  if (type === 'timeline') return <CalendarRange size={13} />;
  return <Table2 size={13} />;
}

function parseDateValue(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const local = new Date(year, month - 1, day);
    return Number.isFinite(local.getTime()) ? local : null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatCompactDate(value: Date): string {
  return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function groupColor(value: string): string {
  if (!value) return 'var(--outline-variant)';
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  const palette = ['#7C6CF2', '#2F80ED', '#30A46C', '#E5A000', '#D65A73', '#8B5CF6'];
  return palette[Math.abs(hash) % palette.length];
}
