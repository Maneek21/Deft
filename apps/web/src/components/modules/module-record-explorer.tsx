'use client';

import { useState } from 'react';
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
  moduleRecordHref,
  type ModuleCollection,
  type ModuleField,
  type ModuleRecord,
  type ModuleRecordSort,
  type ModuleView,
} from '@/lib/modules';
import type { ModuleFieldFilter } from '@/lib/module-saved-views';

export function ModuleRecordExplorer({
  slug,
  collection,
  view,
  records,
  search,
  sort,
  filter,
  hasMore,
  isQuerying,
  onViewChange,
  onSearchChange,
  onSortChange,
  onFilterChange,
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
  search: string;
  sort: ModuleRecordSort | null;
  filter: ModuleFieldFilter;
  hasMore?: boolean;
  isQuerying?: boolean;
  onViewChange: (viewKey: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: ModuleRecordSort | null) => void;
  onFilterChange: (value: ModuleFieldFilter) => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const viewOptions = collection.views.filter((candidate) => (
    candidate.type === 'table' || candidate.type === 'board' || candidate.type === 'timeline'
  ));
  const filterFields = collection.fields.filter((field) => (
    field.type === 'single_select' || field.type === 'boolean'
  ));
  const sortableFields = collection.fields.filter((field) => field.type !== 'relation' && field.type !== 'long_text');
  const hasActiveControls = Boolean(search.trim() || sort || filter?.value);

  const clearControls = () => {
    onSearchChange('');
    onSortChange(null);
    onFilterChange(null);
  };

  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[1rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
                {collection.name}
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-[0.6875rem] tabular-nums"
                style={{ background: 'var(--surface-container-high)', color: 'var(--outline)' }}
              >
                {records.length}{hasMore ? '+' : ''}{isQuerying ? ' · updating' : ''}
              </span>
            </div>
            {collection.description && (
              <p className="mt-1 max-w-2xl text-[0.75rem] leading-relaxed" style={{ color: 'var(--outline)' }}>
                {collection.description}
              </p>
            )}
          </div>

          <div
            className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg p-1"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
            role="tablist"
            aria-label={`${collection.name} views`}
          >
            {(viewOptions.length > 0 ? viewOptions : [view]).map((candidate) => (
              <button
                key={candidate.key}
                type="button"
                role="tab"
                aria-selected={candidate.key === view.key}
                onClick={() => onViewChange(candidate.key)}
                className="flex min-h-9 flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.75rem] font-medium"
                style={{
                  color: candidate.key === view.key ? 'var(--on-surface)' : 'var(--outline)',
                  background: candidate.key === view.key ? 'var(--surface-container-high)' : 'transparent',
                }}
              >
                <ViewIcon type={candidate.type} />
                {candidate.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 sm:max-w-md"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
          >
            <Search size={15} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
            <span className="sr-only">Search records</span>
            <input
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
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md"
                style={{ color: 'var(--outline)' }}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </label>

          <div className="grid grid-cols-2 gap-2 sm:flex">
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.75rem] font-medium"
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
              className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-[0.75rem]"
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
            onClose={() => setFiltersOpen(false)}
          />
        )}

        {hasActiveControls && (
          <div className="flex items-center justify-between gap-3 text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
            <span>Search, filters, and sorting run across the full collection.</span>
            <button type="button" onClick={clearControls} className="flex-shrink-0 font-medium" style={{ color: 'var(--primary)' }}>
              Clear all
            </button>
          </div>
        )}
      </div>

      {records.length === 0 ? (
        <div
          className="flex min-h-[240px] flex-col items-center justify-center rounded-xl px-5 text-center"
          style={{ background: 'var(--surface-container-low)', border: '1px dashed var(--outline-variant)' }}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'var(--surface-container-high)', color: 'var(--outline)' }}>
            <Filter size={18} />
          </span>
          <p className="mt-3 text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>No matching records</p>
          <p className="mt-1 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Clear a search or filter to widen this view.</p>
          <button type="button" onClick={clearControls} className="mt-3 min-h-10 rounded-lg px-3 text-[0.75rem] font-medium" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}>
            Reset view
          </button>
        </div>
      ) : view.type === 'board' ? (
        <ModuleBoard slug={slug} collection={collection} view={view} records={records} />
      ) : view.type === 'timeline' ? (
        <ModuleTimeline slug={slug} collection={collection} view={view} records={records} />
      ) : (
        <ModuleRecordTable slug={slug} collection={collection} view={view} records={records} />
      )}
    </div>
  );
}

function FilterPanel({
  fields,
  filter,
  onChange,
  onClose,
}: {
  fields: ModuleField[];
  filter: ModuleFieldFilter;
  onChange: (filter: ModuleFieldFilter) => void;
  onClose: () => void;
}) {
  const field = fields.find((candidate) => candidate.key === filter?.fieldKey) ?? fields[0] ?? null;
  const values = field?.type === 'boolean'
    ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : field?.options ?? [];

  return (
    <div
      className="grid gap-2 rounded-xl p-3 sm:grid-cols-[minmax(140px,0.8fr)_minmax(160px,1fr)_auto] sm:items-center"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
    >
      {fields.length === 0 ? (
        <p className="text-[0.75rem] sm:col-span-2" style={{ color: 'var(--outline)' }}>
          This collection has no select or boolean fields to filter.
        </p>
      ) : (
        <>
          <label>
            <span className="sr-only">Filter field</span>
            <select
              value={field?.key ?? ''}
              onChange={(event) => onChange({ fieldKey: event.target.value, value: '' })}
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
              onChange={(event) => onChange(field ? { fieldKey: field.key, value: event.target.value } : null)}
              className="min-h-10 w-full rounded-lg px-3 text-[0.75rem] outline-none"
              style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--ghost-border)' }}
            >
              <option value="">Any value</option>
              {values.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        className="flex min-h-10 items-center justify-center rounded-lg px-3 text-[0.75rem] font-medium"
        style={{ color: 'var(--outline)' }}
      >
        Done
      </button>
    </div>
  );
}

function ModuleRecordTable({
  slug,
  collection,
  view,
  records,
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
}) {
  const fields = getModuleViewFields(collection, view).slice(0, 7);
  return (
    <div className="overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr style={{ background: 'var(--surface-container)' }}>
              {fields.map((field) => (
                <th key={field.key} className="px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--outline)' }}>
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
                      <Link href={moduleRecordHref(slug, collection.key, record.id)} className="block truncate hover:underline">
                        {formatModuleRecordFieldValue(record, field)}
                      </Link>
                    ) : (
                      <span className="block truncate">{formatModuleRecordFieldValue(record, field)}</span>
                    )}
                  </td>
                ))}
                <td className="pr-2">
                  <Link
                    href={moduleRecordHref(slug, collection.key, record.id)}
                    aria-label={`Open ${getModuleRecordTitle(record, collection)}`}
                    className="flex h-9 w-9 items-center justify-center rounded-lg"
                    style={{ color: 'var(--outline)' }}
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
          <RecordCardLink key={record.id} slug={slug} collection={collection} view={view} record={record} />
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
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
}) {
  const groupField = getModuleBoardGroupField(collection, view);
  if (!groupField) {
    return (
      <ViewFallback message="This board has no group field. Showing a table until the manifest defines one.">
        <ModuleRecordTable slug={slug} collection={collection} view={{ ...view, type: 'table' }} records={records} />
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

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-3 md:-mx-0 md:px-0">
      <div className="grid min-w-max auto-cols-[minmax(260px,300px)] grid-flow-col gap-3">
        {groups.map((group) => (
          <section key={group.value || '__empty'} className="rounded-xl p-2" style={{ background: 'var(--surface-container)' }}>
            <header className="flex items-center justify-between gap-2 px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: groupColor(group.value) }} />
                <h3 className="truncate text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{group.label}</h3>
              </div>
              <span className="text-[0.6875rem] tabular-nums" style={{ color: 'var(--outline)' }}>{group.records.length}</span>
            </header>
            <div className="mt-1 space-y-2">
              {group.records.map((record) => (
                <Link
                  key={record.id}
                  href={moduleRecordHref(slug, collection.key, record.id)}
                  className="block rounded-lg p-3 transition-transform hover:-translate-y-px"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
                >
                  <p className="line-clamp-2 text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>
                    {getModuleRecordTitle(record, collection)}
                  </p>
                  {getModuleViewRecordContext(record, collection, view) && (
                    <p className="mt-1.5 line-clamp-2 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--outline)' }}>
                      {getModuleViewRecordContext(record, collection, view)}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ModuleTimeline({
  slug,
  collection,
  view,
  records,
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  records: ModuleRecord[];
}) {
  const fields = getModuleTimelineFields(collection, view);
  if (!fields.start) {
    return (
      <ViewFallback message="This timeline has no date field. Showing a table until the manifest defines one.">
        <ModuleRecordTable slug={slug} collection={collection} view={{ ...view, type: 'table' }} records={records} />
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
        <ModuleRecordTable slug={slug} collection={collection} view={{ ...view, type: 'table' }} records={records} />
      </ViewFallback>
    );
  }
  const min = Math.min(...dated.map((entry) => entry.start.getTime()));
  const max = Math.max(...dated.map((entry) => entry.end.getTime()), min + 86_400_000);
  const span = Math.max(max - min, 86_400_000);

  return (
    <div className="overflow-hidden rounded-xl" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-[220px_minmax(480px,1fr)] text-[0.6875rem] font-medium" style={{ background: 'var(--surface-container)', color: 'var(--outline)' }}>
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
                <Link href={moduleRecordHref(slug, collection.key, record.id)} className="min-w-0 px-4 py-3 hover:underline">
                  <p className="truncate text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(record, collection)}</p>
                  <p className="mt-0.5 truncate text-[0.625rem]" style={{ color: 'var(--outline)' }}>
                    {formatCompactDate(start)}{getModuleViewRecordContext(record, collection, view) ? ` · ${getModuleViewRecordContext(record, collection, view)}` : ''}
                  </p>
                </Link>
                <div className="relative border-l border-[var(--ghost-border)] px-4 py-3">
                  <div className="absolute inset-y-0 left-1/4 border-l border-dashed border-[var(--ghost-border)]" />
                  <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-[var(--ghost-border)]" />
                  <div className="absolute inset-y-0 left-3/4 border-l border-dashed border-[var(--ghost-border)]" />
                  <Link
                    href={moduleRecordHref(slug, collection.key, record.id)}
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
          <summary className="cursor-pointer px-4 py-3 text-[0.75rem] font-medium" style={{ color: 'var(--outline)' }}>
            {undated.length} without {fields.start.label.toLowerCase()}
          </summary>
          <div className="divide-y divide-[var(--ghost-border)] border-t border-[var(--ghost-border)]">
            {undated.map((record) => <RecordCardLink key={record.id} slug={slug} collection={collection} view={view} record={record} />)}
          </div>
        </details>
      )}
    </div>
  );
}

function RecordCardLink({
  slug,
  collection,
  view,
  record,
}: {
  slug: string;
  collection: ModuleCollection;
  view: ModuleView;
  record: ModuleRecord;
}) {
  const context = getModuleViewRecordContext(record, collection, view);
  return (
    <Link href={moduleRecordHref(slug, collection.key, record.id)} className="flex min-h-[72px] items-center gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.875rem] font-medium" style={{ color: 'var(--on-surface)' }}>{getModuleRecordTitle(record, collection)}</p>
        <p className="mt-1 truncate text-[0.75rem]" style={{ color: 'var(--outline)' }}>{context || getModuleRecordSubtitle(record, collection) || 'No additional details'}</p>
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
      <div className="mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[0.75rem]" style={{ background: 'var(--surface-container-low)', color: 'var(--outline)' }}>
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
