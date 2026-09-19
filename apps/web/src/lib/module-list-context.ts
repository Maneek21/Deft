import { moduleCollectionHref, moduleRecordHref } from './modules';
import type { ModuleQueryFilter, ModuleQuerySort } from './module-saved-views';

type SearchParamsReader = Pick<URLSearchParams, 'get' | 'has'>;

export type ModuleListContext = {
  viewKey: string | null;
  savedViewId: string | null;
  search: string;
  filters: ModuleQueryFilter[];
  sort: ModuleQuerySort | undefined;
  filtersExplicit: boolean;
};

const MODULE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MODULE_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RECORD_RETURN_PARAM = 'module_return';
const RECORD_CONTEXT_KEYS = ['view', 'saved', 'q', 'filters', 'sort', 'direction'] as const;
const FILTER_OPERATORS = new Set<ModuleQueryFilter['operator']>([
  'eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'is_empty', 'date_relative',
]);
const RESERVED_FIELDS = new Set([
  '__proto__', 'constructor', 'prototype', 'id', 'org_id', 'module_id', 'installation_id',
  'collection_key', 'revision', 'created_at', 'updated_at', 'archived_at',
]);

function boundedParam(value: string | null, maximum: number, pattern?: RegExp): string | null {
  if (!value || value.length > maximum || (pattern && !pattern.test(value))) return null;
  return value;
}

function validFieldKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 48
    && MODULE_KEY.test(value)
    && !RESERVED_FIELDS.has(value);
}

function validFilterValue(value: unknown): value is ModuleQueryFilter['value'] {
  if (typeof value === 'string') return value.length <= 10_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return Array.isArray(value)
    && value.length <= 100
    && value.every((item) => typeof item === 'string' && item.length <= 10_000);
}

function normalizeFilter(value: unknown): ModuleQueryFilter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3 || !['field', 'operator', 'value'].every((key) => Object.hasOwn(candidate, key))) return null;
  if (!validFieldKey(candidate.field) || !FILTER_OPERATORS.has(candidate.operator as ModuleQueryFilter['operator']) || !validFilterValue(candidate.value)) return null;
  if (candidate.operator === 'date_relative' && !(typeof candidate.value === 'string' && ['past', 'today', 'next_7_days'].includes(candidate.value))) return null;
  if (candidate.operator === 'is_empty' && typeof candidate.value !== 'boolean') return null;
  if (candidate.operator === 'contains' && typeof candidate.value !== 'string') return null;
  if (candidate.operator === 'in' && !(Array.isArray(candidate.value) && candidate.value.every((item) => typeof item === 'string'))) return null;
  if (['gt', 'gte', 'lt', 'lte'].includes(String(candidate.operator)) && typeof candidate.value !== 'string' && typeof candidate.value !== 'number') return null;
  return {
    field: candidate.field,
    operator: candidate.operator as ModuleQueryFilter['operator'],
    value: Array.isArray(candidate.value) ? [...candidate.value] : candidate.value,
  };
}

function parseFilters(value: string | null): { filters: ModuleQueryFilter[]; valid: boolean } {
  if (value === null || value.length > 8_192) return { filters: [], valid: false };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 16) return { filters: [], valid: false };
    const filters = parsed.map(normalizeFilter);
    if (filters.some((filter) => filter === null)) return { filters: [], valid: false };
    return { filters: filters as ModuleQueryFilter[], valid: true };
  } catch {
    return { filters: [], valid: false };
  }
}

export function parseModuleListContext(params: SearchParamsReader): ModuleListContext {
  const savedViewId = boundedParam(params.get('saved'), 128, OPAQUE_ID);
  const viewKey = savedViewId ? null : boundedParam(params.get('view'), 48, MODULE_KEY);
  const rawSearch = params.get('q');
  const search = rawSearch && rawSearch.length <= 500 ? rawSearch : '';
  const parsedFilters = parseFilters(params.get('filters'));
  const filtersExplicit = params.has('filters') && parsedFilters.valid;
  const filters = parsedFilters.filters;
  const sortField = params.get('sort');
  const sortDirection = params.get('direction');
  const validSortField = sortField === 'created_at' || sortField === 'updated_at' || validFieldKey(sortField);
  let sort: ModuleQuerySort | undefined;
  if (sortField && validSortField && (sortDirection === 'asc' || sortDirection === 'desc')) {
    sort = { field: sortField, direction: sortDirection };
  }
  return { viewKey, savedViewId, search, filters, sort, filtersExplicit };
}

function moduleListParams(context: ModuleListContext): URLSearchParams {
  const params = new URLSearchParams();
  if (context.savedViewId) params.set('saved', context.savedViewId);
  else if (context.viewKey) params.set('view', context.viewKey);
  if (context.search) params.set('q', context.search.slice(0, 500));
  if (context.filters.length > 0 || context.filtersExplicit) params.set('filters', JSON.stringify(context.filters.slice(0, 16)));
  if (context.sort) {
    params.set('sort', context.sort.field);
    params.set('direction', context.sort.direction);
  }
  return params;
}

export function moduleCollectionListHref(
  slug: string,
  collectionKey: string,
  context: ModuleListContext,
): string {
  const base = moduleCollectionHref(slug, collectionKey);
  const query = moduleListParams(context).toString();
  return query ? `${base}?${query}` : base;
}

export function moduleRecordHrefWithListContext(
  slug: string,
  collectionKey: string,
  recordId: string,
  context: ModuleListContext,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of moduleListParams(context)) params.set(`from_${key}`, value);
  const query = params.toString();
  const base = moduleRecordHref(slug, collectionKey, recordId);
  return query ? `${base}?${query}` : base;
}

export function moduleListBackHref(
  slug: string,
  collectionKey: string,
  recordParams: SearchParamsReader,
): string {
  const params = new URLSearchParams();
  for (const key of RECORD_CONTEXT_KEYS) {
    const value = recordParams.get(`from_${key}`);
    if (value !== null) params.set(key, value);
  }
  return moduleCollectionListHref(slug, collectionKey, parseModuleListContext(params));
}

export function moduleRecordHrefFromReturnContext(
  slug: string,
  collectionKey: string,
  recordId: string,
  recordParams: SearchParamsReader,
): string {
  const listUrl = new URL(moduleListBackHref(slug, collectionKey, recordParams), 'https://deft.invalid');
  return moduleRecordHrefWithListContext(
    slug,
    collectionKey,
    recordId,
    parseModuleListContext(listUrl.searchParams),
  );
}

function safeModuleRecordReturnHref(value: string | null): string | null {
  if (!value || value.length > 100_000 || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'https://deft.invalid');
    if (url.origin !== 'https://deft.invalid' || url.hash) return null;
    const match = /^\/modules\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (!match) return null;
    const [slug, collectionKey, recordId] = match.slice(1).map((part) => decodeURIComponent(part!));
    if (!slug || slug.length > 128 || !MODULE_SLUG.test(slug)
      || !collectionKey || collectionKey.length > 128 || !MODULE_KEY.test(collectionKey)
      || !recordId || recordId.length > 128 || !OPAQUE_ID.test(recordId)) return null;
    if ([...url.searchParams.keys()].some((key) => !RECORD_CONTEXT_KEYS.some((allowed) => key === `from_${allowed}`))) return null;

    const listParams = new URLSearchParams();
    for (const key of RECORD_CONTEXT_KEYS) {
      const contextValue = url.searchParams.get(`from_${key}`);
      if (contextValue !== null) listParams.set(key, contextValue);
    }
    return moduleRecordHrefWithListContext(slug, collectionKey, recordId, parseModuleListContext(listParams));
  } catch {
    return null;
  }
}

export function moduleTaskHrefWithRecordReturn(taskHref: string, recordHref: string): string {
  const safeReturn = safeModuleRecordReturnHref(recordHref);
  try {
    const taskUrl = new URL(taskHref, 'https://deft.invalid');
    if (taskUrl.origin !== 'https://deft.invalid' || taskUrl.pathname !== '/tasks' || taskUrl.hash) return '/tasks';
    if (safeReturn) taskUrl.searchParams.set(RECORD_RETURN_PARAM, safeReturn);
    return `${taskUrl.pathname}${taskUrl.search}`;
  } catch {
    return '/tasks';
  }
}

export function moduleRecordReturnHrefFromTask(taskParams: SearchParamsReader): string | null {
  return safeModuleRecordReturnHref(taskParams.get(RECORD_RETURN_PARAM));
}

export function formatModuleRecordCount(count: number, hasMore: boolean, isQuerying: boolean): string {
  const countLabel = `${count}${hasMore ? '+' : ''}`;
  const noun = count === 1 && !hasMore ? 'record' : 'records';
  return `${countLabel} ${noun}${isQuerying ? ' · updating' : ''}`;
}
