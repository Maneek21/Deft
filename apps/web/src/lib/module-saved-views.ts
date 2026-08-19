import type {
  ModuleCollection,
  ModuleField,
  ModuleRecordSort,
  ModuleView,
} from '@/lib/modules';
import { moduleCollectionHref } from './modules';

export type ModuleQueryFilter = {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: string | number | boolean | string[];
};

export type ModuleQuerySort = {
  field: string;
  direction: 'asc' | 'desc';
};

type ModuleSavedViewConfigBase = {
  fields: string[];
  filters: ModuleQueryFilter[];
  sort?: ModuleQuerySort;
};

export type ModuleSavedViewConfig =
  | (ModuleSavedViewConfigBase & { type: 'table' })
  | (ModuleSavedViewConfigBase & { type: 'board'; group_by: string })
  | (ModuleSavedViewConfigBase & {
      type: 'timeline';
      start_field: string;
      end_field?: string;
    });

export type ModuleSavedView = {
  id: string;
  installationId: string;
  moduleId: string;
  collectionKey: string;
  ownerUserId: string;
  name: string;
  config: ModuleSavedViewConfig;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ModuleFieldFilter = { fieldKey: string; value: string } | null;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeFilter(value: unknown): ModuleQueryFilter | null {
  const row = asRecord(value);
  const field = asString(row.field);
  const operator = asString(row.operator);
  const filterValue = row.value;
  if (
    !field
    || !operator
    || !['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in'].includes(operator)
    || !(
      typeof filterValue === 'string'
      || typeof filterValue === 'number'
      || typeof filterValue === 'boolean'
      || (Array.isArray(filterValue) && filterValue.every((item) => typeof item === 'string'))
    )
  ) return null;
  return {
    field,
    operator: operator as ModuleQueryFilter['operator'],
    value: Array.isArray(filterValue) ? [...filterValue] : filterValue,
  };
}

function normalizeSort(value: unknown): ModuleQuerySort | undefined {
  const row = asRecord(value);
  const field = asString(row.field);
  if (!field || (row.direction !== 'asc' && row.direction !== 'desc')) return undefined;
  return { field, direction: row.direction };
}

function normalizeConfig(value: unknown): ModuleSavedViewConfig | null {
  const row = asRecord(value);
  const type = asString(row.type);
  const fields = Array.isArray(row.fields)
    ? row.fields.filter((field): field is string => typeof field === 'string' && Boolean(field.trim()))
    : [];
  if (fields.length === 0) return null;
  const filters = Array.isArray(row.filters)
    ? row.filters.map(normalizeFilter).filter((filter): filter is ModuleQueryFilter => Boolean(filter))
    : [];
  const sort = normalizeSort(row.sort);
  const common = { fields, filters, ...(sort ? { sort } : {}) };
  if (type === 'table') return { ...common, type };
  if (type === 'board') {
    const groupBy = asString(row.group_by) ?? asString(row.groupBy);
    return groupBy ? { ...common, type, group_by: groupBy } : null;
  }
  if (type === 'timeline') {
    const startField = asString(row.start_field) ?? asString(row.startField);
    const endField = asString(row.end_field) ?? asString(row.endField);
    return startField
      ? { ...common, type, start_field: startField, ...(endField ? { end_field: endField } : {}) }
      : null;
  }
  return null;
}

export function normalizeModuleSavedViewsResponse(value: unknown): ModuleSavedView[] {
  const body = asRecord(value);
  const rows = Array.isArray(value) ? value : Array.isArray(body.views) ? body.views : [];
  return rows.flatMap((candidate) => {
    const row = asRecord(candidate);
    const id = asString(row.id);
    const installationId = asString(row.installation_id) ?? asString(row.installationId);
    const moduleId = asString(row.module_id) ?? asString(row.moduleId);
    const collectionKey = asString(row.collection_key) ?? asString(row.collectionKey);
    const ownerUserId = asString(row.owner_user_id) ?? asString(row.ownerUserId);
    const name = asString(row.name);
    const config = normalizeConfig(row.config);
    if (!id || !installationId || !moduleId || !collectionKey || !ownerUserId || !name || !config) return [];
    return [{
      id,
      installationId,
      moduleId,
      collectionKey,
      ownerUserId,
      name,
      config,
      createdAt: asString(row.created_at) ?? asString(row.createdAt),
      updatedAt: asString(row.updated_at) ?? asString(row.updatedAt),
    }];
  });
}

export function moduleFieldFilterToQuery(
  collection: ModuleCollection,
  filter: ModuleFieldFilter,
): ModuleQueryFilter[] {
  if (!filter?.fieldKey || !filter.value) return [];
  const field = collection.fields.find((candidate) => candidate.key === filter.fieldKey);
  if (!field) return [];
  if (field.type === 'boolean') {
    if (filter.value !== 'true' && filter.value !== 'false') return [];
    return [{ field: field.key, operator: 'eq', value: filter.value === 'true' }];
  }
  if (field.type === 'single_select') {
    if (!field.options.some((option) => option.value === filter.value)) return [];
    return [{ field: field.key, operator: 'eq', value: filter.value }];
  }
  return [];
}

export function moduleQueryFilterToFieldFilter(
  collection: ModuleCollection,
  filters: ModuleQueryFilter[],
): ModuleFieldFilter {
  const filter = filters.length === 1 && filters[0]?.operator === 'eq' ? filters[0] : null;
  if (!filter) return null;
  const field = collection.fields.find((candidate) => candidate.key === filter.field);
  if (!field || !['single_select', 'boolean'].includes(field.type)) return null;
  if (field.type === 'boolean' && typeof filter.value === 'boolean') {
    return { fieldKey: field.key, value: filter.value ? 'true' : 'false' };
  }
  if (field.type === 'single_select' && typeof filter.value === 'string') {
    return { fieldKey: field.key, value: filter.value };
  }
  return null;
}

export function moduleSavedViewToView(savedView: ModuleSavedView): ModuleView {
  const { config } = savedView;
  return {
    key: `personal:${savedView.id}`,
    name: savedView.name,
    type: config.type,
    fields: [...config.fields],
    groupBy: config.type === 'board' ? config.group_by : null,
    startField: config.type === 'timeline' ? config.start_field : null,
    endField: config.type === 'timeline' ? config.end_field ?? null : null,
  };
}

export function buildModuleSavedViewConfig(input: {
  collection: ModuleCollection;
  view: ModuleView;
  filter?: ModuleFieldFilter;
  filters?: ModuleQueryFilter[];
  sort?: ModuleRecordSort | null;
  querySort?: ModuleQuerySort;
}): ModuleSavedViewConfig {
  const { collection, view } = input;
  const allowedKeys = new Set(collection.fields.map((field) => field.key));
  const fields = view.fields.filter((field) => allowedKeys.has(field));
  const normalizedFields = fields.length > 0 ? fields : collection.fields.map((field) => field.key);
  const filters = input.filters ?? moduleFieldFilterToQuery(collection, input.filter ?? null);
  const candidateSort = input.querySort ?? (input.sort
    ? { field: input.sort.fieldKey, direction: input.sort.direction }
    : undefined);
  const sortField = candidateSort?.field;
  const sort = sortField && (sortField === 'created_at' || sortField === 'updated_at' || allowedKeys.has(sortField))
    ? { field: sortField, direction: candidateSort!.direction }
    : undefined;
  const common = { fields: normalizedFields, filters, ...(sort ? { sort } : {}) };

  if (view.type === 'board') {
    const requestedGroup = view.groupBy
      ? collection.fields.find((field) => field.key === view.groupBy)
      : undefined;
    const groupBy = requestedGroup && isBoardField(requestedGroup)
      ? requestedGroup.key
      : collection.fields.find(isBoardField)?.key;
    if (groupBy) return { ...common, type: 'board', group_by: groupBy };
  }
  if (view.type === 'timeline') {
    const dateFields = collection.fields.filter(isDateField);
    const requestedStart = view.startField
      ? collection.fields.find((field) => field.key === view.startField)
      : undefined;
    const requestedEnd = view.endField
      ? collection.fields.find((field) => field.key === view.endField)
      : undefined;
    const startField = requestedStart && isDateField(requestedStart)
      ? requestedStart.key
      : dateFields[0]?.key;
    const endField = requestedEnd && isDateField(requestedEnd) ? requestedEnd.key : undefined;
    if (startField) {
      return {
        ...common,
        type: 'timeline',
        start_field: startField,
        ...(endField ? { end_field: endField } : {}),
      };
    }
  }
  return { ...common, type: 'table' };
}

export function moduleSavedViewSortToRecordSort(
  sort: ModuleQuerySort | undefined,
): ModuleRecordSort | null {
  if (!sort || sort.field === 'created_at' || sort.field === 'updated_at') return null;
  return { fieldKey: sort.field, direction: sort.direction };
}

export function modulePersonalViewHref(
  slug: string,
  collectionKey: string,
  savedViewId: string,
): string {
  return `${moduleCollectionHref(slug, collectionKey)}?saved=${encodeURIComponent(savedViewId)}`;
}

function isBoardField(field: ModuleField): boolean {
  return field.type === 'single_select' || field.type === 'member' || field.type === 'tags';
}

function isDateField(field: ModuleField): boolean {
  return field.type === 'date' || field.type === 'datetime';
}
