import {
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

export type ModuleFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'email'
  | 'url'
  | 'single_select'
  | 'multi_select';

export type ModuleFieldOption = {
  value: string;
  label: string;
  color?: string | null;
};

export type ModuleField = {
  key: string;
  label: string;
  type: ModuleFieldType;
  required: boolean;
  description: string | null;
  options: ModuleFieldOption[];
  defaultValue?: unknown;
};

export type ModuleCollection = {
  key: string;
  name: string;
  singularName: string;
  description: string | null;
  fields: ModuleField[];
  titleField: string | null;
  subtitleFields: string[];
  views: ModuleView[];
};

export type ModuleView = {
  key: string;
  name: string;
  type: 'table' | 'form' | 'detail';
  fields: string[];
};

export type ModuleManifest = {
  schemaVersion: string | number | null;
  moduleId: string | null;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  icon: string | null;
  collections: ModuleCollection[];
  raw: Record<string, unknown>;
};

export type ModuleInstallation = {
  id: string;
  slug: string;
  moduleId: string;
  enabled: boolean;
  agentAccess: 'none' | 'read' | 'write';
  activeVersionId: string | null;
  manifestDigest: string | null;
  manifest: ModuleManifest;
};

export type BundledModule = {
  slug: string;
  moduleId: string;
  name: string;
  description: string | null;
  version: string | null;
  icon: string | null;
  installed: boolean;
};

export type ModuleRecord = {
  id: string;
  collectionKey: string;
  data: Record<string, unknown>;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ModuleRecordPage = {
  records: ModuleRecord[];
  nextCursor: string | null;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseManifestValue(value: unknown): DeftModuleManifestV1 {
  if (typeof value !== 'string') return parseDeftModuleManifest(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid module manifest: expected valid JSON.');
  }
  return parseDeftModuleManifest(parsed);
}

export function normalizeModuleManifest(value: unknown, _fallbackSlug = ''): ModuleManifest {
  const manifest = parseManifestValue(value);
  const raw = manifest as unknown as Record<string, unknown>;
  const collections = manifest.collections.map((collection) => ({
    key: collection.key,
    name: collection.name,
    singularName: collection.singular_name ?? collection.name,
    description: collection.description ?? null,
    fields: collection.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      description: field.description ?? null,
      options: 'options' in field
        ? field.options.map((option) => ({ value: option.value, label: option.label }))
        : [],
      defaultValue: field.default,
    })),
    titleField: collection.search?.title_field ?? collection.fields[0]?.key ?? null,
    subtitleFields: collection.search?.subtitle_fields ?? [],
    views: (collection.views ?? []).map((view) => ({
      key: view.key,
      name: view.name,
      type: view.type,
      fields: [...view.fields],
    })),
  }));
  return {
    schemaVersion: manifest.schema_version,
    moduleId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description ?? null,
    version: manifest.version,
    icon: manifest.icon ?? null,
    collections,
    raw,
  };
}

export function normalizeModuleInstallation(value: unknown): ModuleInstallation | null {
  const row = asRecord(value);
  const slug = asString(row.slug) ?? asString(row.module_slug);
  const id = asString(row.id) ?? asString(row.installation_id);
  if (!slug || !id) return null;
  const manifest = normalizeModuleManifest(row.manifest, slug);
  return {
    id,
    slug,
    moduleId: asString(row.module_id) ?? manifest.moduleId ?? slug,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : asBoolean(row.is_enabled, true),
    agentAccess: row.agent_access === 'read' || row.agent_access === 'write' ? row.agent_access : 'none',
    activeVersionId: asString(row.active_version_id),
    manifestDigest: asString(row.manifest_digest),
    manifest,
  };
}

export function normalizeInstalledModulesResponse(value: unknown): ModuleInstallation[] {
  const body = asRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body.modules)
      ? body.modules
      : Array.isArray(body.installed)
        ? body.installed
        : [];
  return rows.map(normalizeModuleInstallation).filter((module): module is ModuleInstallation => Boolean(module));
}

export function normalizeBundledModule(value: unknown): BundledModule | null {
  const row = asRecord(value);
  const slug = asString(row.slug) ?? asString(row.module_slug);
  if (!slug) return null;
  return {
    slug,
    moduleId: asString(row.module_id) ?? slug,
    name: asString(row.name) ?? asString(row.title) ?? humanizeIdentifier(slug),
    description: asString(row.description),
    version: asString(row.version),
    icon: asString(row.icon),
    installed: asBoolean(row.installed) || asBoolean(row.is_installed),
  };
}

export function normalizeBundledModulesResponse(value: unknown): BundledModule[] {
  const body = asRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body.modules)
      ? body.modules
      : Array.isArray(body.bundled)
        ? body.bundled
        : [];
  return rows.map(normalizeBundledModule).filter((module): module is BundledModule => Boolean(module));
}

export function normalizeModuleRecord(value: unknown): ModuleRecord | null {
  const row = asRecord(value);
  const id = asString(row.id);
  const collectionKey = asString(row.collection_key) ?? asString(row.collectionKey);
  if (!id || !collectionKey) return null;
  return {
    id,
    collectionKey,
    data: asRecord(row.data),
    revision: typeof row.revision === 'number' && Number.isFinite(row.revision) ? row.revision : 1,
    createdAt: asString(row.created_at) ?? asString(row.createdAt),
    updatedAt: asString(row.updated_at) ?? asString(row.updatedAt),
  };
}

export function normalizeModuleRecordPage(value: unknown): ModuleRecordPage {
  const body = asRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body.records)
      ? body.records
      : Array.isArray(body.items)
        ? body.items
        : [];
  return {
    records: rows.map(normalizeModuleRecord).filter((record): record is ModuleRecord => Boolean(record)),
    nextCursor: asString(body.next_cursor) ?? asString(body.nextCursor),
  };
}

export function normalizeModuleRecordResponse(value: unknown): ModuleRecord | null {
  const body = asRecord(value);
  return normalizeModuleRecord(body.record ?? value);
}

export function humanizeIdentifier(value: string): string {
  const text = value
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Untitled';
}

export function findModuleCollection(manifest: ModuleManifest, key: string): ModuleCollection | null {
  return manifest.collections.find((collection) => collection.key === key) ?? null;
}

export function getModuleCollectionFields(
  collection: ModuleCollection,
  viewType: ModuleView['type'],
): ModuleField[] {
  const view = collection.views.find((candidate) => candidate.type === viewType);
  if (!view) return collection.fields;
  const byKey = new Map(collection.fields.map((field) => [field.key, field]));
  return view.fields.map((key) => byKey.get(key)).filter((field): field is ModuleField => Boolean(field));
}

export function getModuleRecordTitle(record: ModuleRecord, collection: ModuleCollection): string {
  const titleKey = collection.titleField ?? collection.fields[0]?.key;
  const title = titleKey ? formatModuleFieldValue(record.data[titleKey], collection.fields.find((field) => field.key === titleKey)) : '';
  return title && title !== '—' ? title : `Record ${record.id.slice(0, 8)}`;
}

export function getModuleRecordSubtitle(record: ModuleRecord, collection: ModuleCollection): string {
  const keys = collection.subtitleFields.length > 0
    ? collection.subtitleFields
    : collection.fields.filter((field) => field.key !== collection.titleField).slice(0, 2).map((field) => field.key);
  return keys
    .map((key) => formatModuleFieldValue(record.data[key], collection.fields.find((field) => field.key === key)))
    .filter((value) => value && value !== '—')
    .join(' · ');
}

export function formatModuleFieldValue(value: unknown, field?: Pick<ModuleField, 'type' | 'options'>): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return value.map((item) => optionLabel(String(item), field?.options ?? [])).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if ((field?.type === 'date' || field?.type === 'datetime') && typeof value === 'string') {
    if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day).toLocaleDateString();
    }
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return field.type === 'date'
        ? parsed.toLocaleDateString()
        : parsed.toLocaleString();
    }
  }
  if (field?.type === 'single_select') return optionLabel(String(value), field.options);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function optionLabel(value: string, options: ModuleFieldOption[]): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function initialModuleRecordValues(collection: ModuleCollection, record?: ModuleRecord | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of collection.fields) {
    const current = record?.data[field.key];
    if (current !== undefined && current !== null) {
      values[field.key] = field.type === 'datetime' && typeof current === 'string'
        ? toDatetimeLocalValue(current)
        : current;
      continue;
    }
    if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
    } else if (field.type === 'boolean') {
      values[field.key] = field.required ? false : undefined;
    } else if (field.type === 'multi_select') {
      values[field.key] = [];
    } else {
      values[field.key] = '';
    }
  }
  return values;
}

export function validateModuleRecordValues(
  collection: ModuleCollection,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of collection.fields) {
    const value = values[field.key];
    const missing = value === null
      || value === undefined
      || value === '';
    if (field.required && missing) {
      errors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (missing) continue;
    if (field.type === 'number' && !Number.isFinite(Number(value))) {
      errors[field.key] = `${field.label} must be a number.`;
    } else if (field.type === 'email' && typeof value === 'string' && !/^\S+@\S+\.\S+$/.test(value)) {
      errors[field.key] = `${field.label} must be a valid email address.`;
    } else if (field.type === 'url' && typeof value === 'string') {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
      } catch {
        errors[field.key] = `${field.label} must be a valid http or https URL.`;
      }
    }
  }
  return errors;
}

export function moduleRecordPayload(
  collection: ModuleCollection,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of collection.fields) {
    const value = values[field.key];
    if (field.type === 'number') {
      if (value !== '' && value !== null && value !== undefined) payload[field.key] = Number(value);
    } else if (field.type === 'datetime') {
      if (typeof value === 'string' && value) payload[field.key] = new Date(value).toISOString();
    } else if (field.type === 'date') {
      if (typeof value === 'string' && value) payload[field.key] = value;
    } else if (field.type === 'multi_select') {
      const selected = Array.isArray(value) ? value.map(String) : [];
      if (field.required || selected.length > 0) payload[field.key] = selected;
    } else if (field.type === 'boolean') {
      if (value !== undefined && value !== null) payload[field.key] = Boolean(value);
    } else {
      if (value !== '' && value !== undefined && value !== null) payload[field.key] = value;
    }
  }
  return payload;
}

export function diffModuleRecordUpdate(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  changedKeys?: Iterable<string>,
): { patch: Record<string, unknown>; unsetFields: string[] } {
  const patch: Record<string, unknown> = {};
  const unsetFields: string[] = [];
  const keys = changedKeys
    ? new Set(changedKeys)
    : new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    const hadPrevious = Object.prototype.hasOwnProperty.call(previous, key);
    const hasNext = Object.prototype.hasOwnProperty.call(next, key);
    if (hadPrevious && !hasNext) {
      unsetFields.push(key);
    } else if (hasNext && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      patch[key] = next[key];
    }
  }
  return { patch, unsetFields };
}

export async function moduleApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
  const detail = typeof body.error === 'string' ? body.error : fallback;
  if (response.status === 409) return `${detail} Refresh and try again.`;
  return detail;
}

export function moduleRecordHref(slug: string, collectionKey: string, recordId: string): string {
  return `/modules/${encodeURIComponent(slug)}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(recordId)}`;
}

function toDatetimeLocalValue(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
