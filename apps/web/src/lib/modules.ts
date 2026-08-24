import {
  MODULE_LIMITS,
  digestModuleManifest,
  parseDeftModuleManifest,
  parseDeftModuleManifestJson,
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
  | 'multi_select'
  | 'member'
  | 'tags'
  | 'relation';

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
  multiple: boolean;
  targetCollection: string | null;
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

export type ModuleViewType = 'table' | 'board' | 'timeline' | 'form' | 'detail';

export type ModuleView = {
  key: string;
  name: string;
  type: ModuleViewType;
  fields: string[];
  groupBy: string | null;
  startField: string | null;
  endField: string | null;
};

export type ModuleNavigation = {
  defaultCollection: string;
  defaultView: string | null;
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
  navigation: ModuleNavigation | null;
  raw: Record<string, unknown>;
};

export type ModuleInstallation = {
  id: string;
  slug: string;
  moduleId: string;
  source: string;
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
  installedVersion: string | null;
  updateAvailable: boolean;
};

export type ModuleManifestPreview = {
  manifest: DeftModuleManifestV1;
  moduleId: string;
  slug: string;
  name: string;
  version: string;
  digest: string;
  collections: Array<{ key: string; name: string }>;
};

export type ModuleManifestUploadDecision =
  | { mode: 'install'; target: null }
  | { mode: 'upgrade'; target: ModuleInstallation };

export const MODULE_MANIFEST_MAX_BYTES = MODULE_LIMITS.manifest_bytes;

export type ModuleRecord = {
  id: string;
  resourceId: string;
  collectionKey: string;
  data: Record<string, unknown>;
  relations: ModuleRelationGroup[];
  members: ModuleMemberGroup[];
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ModuleRecordPage = {
  records: ModuleRecord[];
  nextCursor: string | null;
};

export type ModuleRecordRelation = {
  id: string;
  collectionKey: string;
  label: string;
};

export type ModuleRelationGroup = {
  fieldKey: string;
  records: ModuleRecordRelation[];
};

export type ModuleRecordMember = {
  id: string;
  label: string;
};

export type ModuleMemberGroup = {
  fieldKey: string;
  members: ModuleRecordMember[];
};

export type ModuleRelationReplacePayload = {
  record_ids: string[];
  expected_revision: number;
  expected_manifest_digest: string;
  idempotency_key: string;
};

export type ModuleRecordActivity = {
  id: string;
  action: string;
  actorType: string | null;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
};

export type ModuleMember = {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
};

export type ModuleRecordSort = {
  fieldKey: string;
  direction: 'asc' | 'desc';
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
  const collections = manifest.collections.map((collection) => {
    return {
      key: collection.key,
      name: collection.name,
      singularName: collection.singular_name ?? collection.name,
      description: collection.description ?? null,
      fields: collection.fields.map((field) => {
        const rawField = field as unknown as UnknownRecord;
        return {
          key: field.key,
          label: field.label,
          type: field.type as ModuleFieldType,
          required: field.required,
          description: field.description ?? null,
          options: 'options' in field
            ? field.options.map((option) => ({ value: option.value, label: option.label }))
            : [],
          defaultValue: 'default' in field ? field.default : undefined,
          multiple: asBoolean(rawField.multiple),
          targetCollection: asString(rawField.target_collection),
        };
      }),
      titleField: collection.search?.title_field ?? collection.fields[0]?.key ?? null,
      subtitleFields: collection.search?.subtitle_fields ?? [],
      views: (collection.views ?? []).map((view) => {
        const rawView = view as unknown as UnknownRecord;
        return {
          key: view.key,
          name: view.name,
          type: view.type as ModuleViewType,
          fields: [...view.fields],
          groupBy: asString(rawView.group_by),
          startField: asString(rawView.start_field),
          endField: asString(rawView.end_field),
        };
      }),
    };
  });
  const rawNavigation = asRecord(raw.navigation);
  const defaultCollection = asString(rawNavigation.default_collection);
  return {
    schemaVersion: manifest.schema_version,
    moduleId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description ?? null,
    version: manifest.version,
    icon: manifest.icon ?? null,
    collections,
    navigation: defaultCollection
      ? {
          defaultCollection,
          defaultView: asString(rawNavigation.default_view),
        }
      : null,
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
    source: asString(row.source) ?? 'unknown',
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
    installedVersion: asString(row.installed_version),
    updateAvailable: asBoolean(row.update_available),
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

export async function previewModuleManifestJson(value: string): Promise<ModuleManifestPreview> {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength > MODULE_MANIFEST_MAX_BYTES) {
    throw new Error(`Module manifest must be ${MODULE_MANIFEST_MAX_BYTES} bytes or smaller.`);
  }
  const manifest = parseDeftModuleManifestJson(value);
  return {
    manifest,
    moduleId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    version: manifest.version,
    digest: await digestModuleManifest(manifest),
    collections: manifest.collections.map((collection) => ({
      key: collection.key,
      name: collection.name,
    })),
  };
}

export function resolveModuleManifestUpload(
  preview: ModuleManifestPreview,
  installed: ModuleInstallation[],
  requestedTargetId?: string | null,
): ModuleManifestUploadDecision {
  const requested = requestedTargetId
    ? installed.find((module) => module.id === requestedTargetId)
    : undefined;
  if (requestedTargetId && !requested) throw new Error('The selected module is no longer installed.');

  const collisions = installed.filter((module) => (
    module.moduleId === preview.moduleId || module.slug === preview.slug
  ));
  const target = requested ?? collisions.find((module) => (
    module.moduleId === preview.moduleId && module.slug === preview.slug
  ));
  if (collisions.some((module) => (
    module.moduleId !== preview.moduleId || module.slug !== preview.slug
  ))) {
    throw new Error('The manifest id or slug conflicts with another installed module.');
  }
  if (!target) return { mode: 'install', target: null };
  if (target.moduleId !== preview.moduleId || target.slug !== preview.slug) {
    throw new Error('The selected manifest does not match this module id and slug.');
  }
  if (target.source !== 'sideloaded') {
    throw new Error('Bundled modules can only be updated from the bundled catalog.');
  }
  if (!target.manifestDigest) {
    throw new Error('The installed module is missing its active manifest digest. Refresh and try again.');
  }
  return { mode: 'upgrade', target };
}

export function normalizeModuleRecord(value: unknown): ModuleRecord | null {
  const row = asRecord(value);
  const id = asString(row.id);
  const collectionKey = asString(row.collection_key) ?? asString(row.collectionKey);
  if (!id || !collectionKey) return null;
  return {
    id,
    resourceId: asString(row.resource_id) ?? asString(row.resourceId) ?? `module_record:${id}`,
    collectionKey,
    data: asRecord(row.data),
    relations: normalizeModuleRelationsResponse({ relations: row.relations }),
    members: normalizeModuleMemberGroupsResponse({ members: row.members }),
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

export function normalizeModuleRelationsResponse(value: unknown): ModuleRelationGroup[] {
  const body = asRecord(value);
  const rows = Array.isArray(body.relations) ? body.relations : [];
  return rows.flatMap((entry) => {
    const relation = asRecord(entry);
    const fieldKey = asString(relation.field_key) ?? asString(relation.fieldKey);
    if (!fieldKey) return [];
    const records = Array.isArray(relation.records)
      ? relation.records.flatMap((candidate) => {
          const record = asRecord(candidate);
          const id = asString(record.id);
          const collectionKey = asString(record.collection_key) ?? asString(record.collectionKey);
          if (!id || !collectionKey) return [];
          return [{
            id,
            collectionKey,
            label: asString(record.label) ?? `Record ${id.slice(0, 8)}`,
          }];
        })
      : [];
    return [{ fieldKey, records }];
  });
}

export function normalizeModuleMemberGroupsResponse(value: unknown): ModuleMemberGroup[] {
  const body = asRecord(value);
  const rows = Array.isArray(body.members) ? body.members : [];
  return rows.flatMap((entry) => {
    const group = asRecord(entry);
    const fieldKey = asString(group.field_key) ?? asString(group.fieldKey);
    if (!fieldKey) return [];
    const members = Array.isArray(group.members)
      ? group.members.flatMap((candidate) => {
          const member = asRecord(candidate);
          const id = asString(member.id);
          if (!id) return [];
          return [{ id, label: asString(member.label) ?? `Member ${id.slice(0, 8)}` }];
        })
      : [];
    return [{ fieldKey, members }];
  });
}

export function formatModuleRecordFieldValue(record: ModuleRecord, field: ModuleField): string {
  if (field.type === 'relation') {
    const labels = record.relations
      .find((group) => group.fieldKey === field.key)
      ?.records.map((reference) => reference.label) ?? [];
    return labels.length > 0 ? labels.join(', ') : '—';
  }
  if (field.type === 'member') {
    const labels = record.members
      .find((group) => group.fieldKey === field.key)
      ?.members.map((reference) => reference.label) ?? [];
    return labels.length > 0 ? labels.join(', ') : '—';
  }
  return formatModuleFieldValue(record.data[field.key], field);
}

export function buildModuleRelationReplacePayload(input: {
  recordIds: string[];
  expectedRevision: number;
  expectedManifestDigest: string;
  idempotencyKey: string;
}): ModuleRelationReplacePayload {
  return {
    record_ids: [...input.recordIds],
    expected_revision: input.expectedRevision,
    expected_manifest_digest: input.expectedManifestDigest,
    idempotency_key: input.idempotencyKey,
  };
}

export function normalizeModuleActivityResponse(value: unknown): ModuleRecordActivity[] {
  const body = asRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body.events)
      ? body.events
      : Array.isArray(body.activity)
        ? body.activity
        : [];
  return rows.flatMap((candidate) => {
    const event = asRecord(candidate);
    const id = asString(event.id);
    const action = asString(event.action);
    if (!id || !action) return [];
    return [{
      id,
      action,
      actorType: asString(event.actor_type) ?? asString(event.actorType),
      actorId: asString(event.actor_id) ?? asString(event.actorId),
      actorName: asString(event.actor_name) ?? asString(event.actorName),
      metadata: asRecord(event.metadata),
      createdAt: asString(event.created_at) ?? asString(event.createdAt),
    }];
  });
}

export function normalizeModuleMembersResponse(value: unknown): ModuleMember[] {
  const body = asRecord(value);
  const rows = Array.isArray(value) ? value : Array.isArray(body.members) ? body.members : [];
  return rows.flatMap((candidate) => {
    const member = asRecord(candidate);
    const id = asString(member.id);
    if (!id) return [];
    return [{
      id,
      name: asString(member.name) ?? asString(member.email) ?? 'Unnamed member',
      email: asString(member.email),
      avatarUrl: asString(member.avatar_url) ?? asString(member.avatarUrl),
    }];
  });
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

export function getDefaultModuleCollection(manifest: ModuleManifest): ModuleCollection | null {
  const configured = manifest.navigation?.defaultCollection;
  return (configured ? findModuleCollection(manifest, configured) : null)
    ?? manifest.collections[0]
    ?? null;
}

export function getModuleCollectionViews(collection: ModuleCollection): ModuleView[] {
  const browsable = collection.views.filter((view) => (
    view.type === 'table' || view.type === 'board' || view.type === 'timeline'
  ));
  if (browsable.length > 0) return browsable;
  return [{
    key: 'table',
    name: 'Table',
    type: 'table',
    fields: collection.fields.map((field) => field.key),
    groupBy: null,
    startField: null,
    endField: null,
  }];
}

export function resolveModuleView(
  manifest: ModuleManifest,
  collection: ModuleCollection,
  requestedKey?: string | null,
): ModuleView {
  const views = getModuleCollectionViews(collection);
  const configuredDefault = manifest.navigation?.defaultCollection === collection.key
    ? manifest.navigation.defaultView
    : null;
  return views.find((view) => view.key === requestedKey)
    ?? views.find((view) => view.key === configuredDefault)
    ?? views[0];
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

export function getModuleViewFields(collection: ModuleCollection, view: ModuleView): ModuleField[] {
  const byKey = new Map(collection.fields.map((field) => [field.key, field]));
  const configured = view.fields
    .map((key) => byKey.get(key))
    .filter((field): field is ModuleField => Boolean(field));
  return configured.length > 0 ? configured : collection.fields;
}

export function getModuleBoardGroupField(collection: ModuleCollection, view: ModuleView): ModuleField | null {
  if (view.groupBy) {
    const configured = collection.fields.find((field) => field.key === view.groupBy);
    if (configured) return configured;
  }
  return collection.fields.find((field) => field.type === 'single_select' || field.type === 'boolean') ?? null;
}

export function getModuleTimelineFields(
  collection: ModuleCollection,
  view: ModuleView,
): { start: ModuleField | null; end: ModuleField | null } {
  const dateFields = collection.fields.filter((field) => field.type === 'date' || field.type === 'datetime');
  const start = (view.startField
    ? collection.fields.find((field) => field.key === view.startField)
    : null) ?? dateFields[0] ?? null;
  const end = (view.endField
    ? collection.fields.find((field) => field.key === view.endField)
    : null) ?? dateFields.find((field) => field.key !== start?.key) ?? null;
  return { start, end };
}

export function filterAndSortModuleRecords(
  records: ModuleRecord[],
  collection: ModuleCollection,
  query: string,
  sort: ModuleRecordSort | null,
  fieldFilter?: { fieldKey: string; value: string } | null,
): ModuleRecord[] {
  const needle = query.trim().toLocaleLowerCase();
  const matching = records.filter((record) => {
    if (fieldFilter?.fieldKey && fieldFilter.value) {
      const value = record.data[fieldFilter.fieldKey];
      const entries = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
      if (!entries.includes(fieldFilter.value)) return false;
    }
    if (!needle) return true;
    const haystack = [
      getModuleRecordTitle(record, collection),
      getModuleRecordSubtitle(record, collection),
      ...Object.values(record.data).flatMap((value) => Array.isArray(value) ? value : [value]).map(String),
    ].join(' ').toLocaleLowerCase();
    return haystack.includes(needle);
  });
  if (!sort) return matching;
  const field = collection.fields.find((candidate) => candidate.key === sort.fieldKey);
  if (!field) return matching;
  const direction = sort.direction === 'desc' ? -1 : 1;
  return matching
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const comparison = compareModuleValues(
        left.record.data[field.key],
        right.record.data[field.key],
        field,
      );
      return comparison === 0 ? left.index - right.index : comparison * direction;
    })
    .map(({ record }) => record);
}

export function getModuleRecordTitle(record: ModuleRecord, collection: ModuleCollection): string {
  const titleKey = collection.titleField ?? collection.fields[0]?.key;
  const titleField = titleKey ? collection.fields.find((field) => field.key === titleKey) : undefined;
  const title = titleField ? formatModuleRecordFieldValue(record, titleField) : '';
  return title && title !== '—' ? title : `Record ${record.id.slice(0, 8)}`;
}

export function getModuleRecordSubtitle(record: ModuleRecord, collection: ModuleCollection): string {
  const keys = collection.subtitleFields.length > 0
    ? collection.subtitleFields
    : collection.fields.filter((field) => field.key !== collection.titleField).slice(0, 2).map((field) => field.key);
  return keys
    .map((key) => collection.fields.find((field) => field.key === key))
    .filter((field): field is ModuleField => Boolean(field))
    .map((field) => formatModuleRecordFieldValue(record, field))
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
    } else if (field.type === 'multi_select' || field.type === 'tags' || (field.type === 'member' && field.multiple)) {
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
      || value === ''
      || (Array.isArray(value) && value.length === 0)
      || (field.type === 'tags' && typeof value === 'string' && value.split(',').every((tag) => !tag.trim()));
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
    if (field.type === 'relation') continue;
    const value = values[field.key];
    if (field.type === 'number') {
      if (value !== '' && value !== null && value !== undefined) payload[field.key] = Number(value);
    } else if (field.type === 'datetime') {
      if (typeof value === 'string' && value) payload[field.key] = new Date(value).toISOString();
    } else if (field.type === 'date') {
      if (typeof value === 'string' && value) payload[field.key] = value;
    } else if (field.type === 'multi_select' || field.type === 'tags' || (field.type === 'member' && field.multiple)) {
      const selected = Array.isArray(value)
        ? value.map(String)
        : field.type === 'tags' && typeof value === 'string'
          ? value.split(',').map((tag) => tag.trim()).filter(Boolean)
          : [];
      const normalized = field.type === 'tags' ? [...new Set(selected)] : selected;
      if (field.required || normalized.length > 0) payload[field.key] = normalized;
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

export function moduleCollectionHref(slug: string, collectionKey: string, viewKey?: string | null): string {
  const base = `/modules/${encodeURIComponent(slug)}/${encodeURIComponent(collectionKey)}`;
  return viewKey ? `${base}?view=${encodeURIComponent(viewKey)}` : base;
}

function compareModuleValues(left: unknown, right: unknown, field: ModuleField): number {
  const emptyLeft = left === null || left === undefined || left === '';
  const emptyRight = right === null || right === undefined || right === '';
  if (emptyLeft || emptyRight) return emptyLeft === emptyRight ? 0 : emptyLeft ? 1 : -1;
  if (field.type === 'number') return Number(left) - Number(right);
  if (field.type === 'date' || field.type === 'datetime') {
    const leftTime = new Date(String(left)).getTime();
    const rightTime = new Date(String(right)).getTime();
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  }
  return formatModuleFieldValue(left, field).localeCompare(
    formatModuleFieldValue(right, field),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
}

function toDatetimeLocalValue(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
