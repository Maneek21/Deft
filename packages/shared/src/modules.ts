import { z } from 'zod';
import { abortOnUnknownContractKeys } from './zod-compat';
import { SEMVER_REGEX } from './schemas';

/**
 * Shared, transport-neutral contract for declarative Deft modules.
 *
 * Everything in a manifest is untrusted author-controlled metadata. Parsing a
 * manifest proves only that it conforms to this data contract; it never grants
 * access, authorizes an action, or turns descriptions into agent instructions.
 */

export const DEFT_MODULE_MANIFEST_FILENAME = 'deft.module.json';
export const DEFT_MODULE_MANIFEST_SCHEMA_VERSION = '1' as const;
export const DEFT_MODULE_MANIFEST_SCHEMA_VERSION_V2 = '2' as const;

export const MODULE_LIMITS = Object.freeze({
  manifest_bytes: 128 * 1024,
  module_id_chars: 128,
  module_slug_chars: 48,
  display_name_chars: 80,
  description_chars: 500,
  icon_token_chars: 48,
  collections_per_module: 8,
  collection_key_chars: 48,
  fields_per_collection: 64,
  field_key_chars: 48,
  select_options_per_field: 50,
  relation_values_per_field: 100,
  tags_per_field: 50,
  tag_value_chars: 80,
  views_per_collection: 8,
  fields_per_view: 32,
  search_fields_per_collection: 16,
  search_subtitle_fields: 3,
  record_bytes: 256 * 1024,
  text_value_chars: 10_000,
  long_text_value_chars: 100_000,
  email_value_chars: 320,
  url_value_chars: 2_048,
  search_title_chars: 200,
  search_subtitle_chars: 300,
  search_text_chars: 10_000,
  operation_page_size: 100,
} as const);

const MANIFEST_UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff<>]/u;
const MODULE_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
const MODULE_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MODULE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ICON_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const MODULE_RESERVED_FIELD_KEYS = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
  'id',
  'org_id',
  'module_id',
  'installation_id',
  'collection_key',
  'revision',
  'created_at',
  'updated_at',
  'archived_at',
] as const);

const reservedFieldKeys = new Set<string>(MODULE_RESERVED_FIELD_KEYS);

function boundedPlainText(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine(
      (value) => !MANIFEST_UNSAFE_TEXT.test(value),
      `${label} must be single-line plain text without markup, control characters, or bidi controls`,
    );
}

export const ModuleIdSchema = z
  .string()
  .min(3)
  .max(MODULE_LIMITS.module_id_chars)
  .regex(MODULE_ID_PATTERN, 'Module id must be a lowercase reverse-DNS identifier');

export const ModuleSlugSchema = z
  .string()
  .min(1)
  .max(MODULE_LIMITS.module_slug_chars)
  .regex(MODULE_SLUG_PATTERN, 'Module slug must be lowercase kebab-case');

export const ModuleKeySchema = z
  .string()
  .min(1)
  .max(MODULE_LIMITS.collection_key_chars)
  .regex(MODULE_KEY_PATTERN, 'Key must be lowercase snake_case');

export const ModuleFieldKeySchema = z
  .string()
  .min(1)
  .max(MODULE_LIMITS.field_key_chars)
  .regex(MODULE_KEY_PATTERN, 'Field key must be lowercase snake_case')
  .refine((key) => !reservedFieldKeys.has(key), 'Field key is reserved by Deft');

export const ModuleDisplayNameSchema = boundedPlainText(
  MODULE_LIMITS.display_name_chars,
  'Display name',
);

export const ModuleDescriptionSchema = boundedPlainText(
  MODULE_LIMITS.description_chars,
  'Description',
);

export const ModuleIconTokenSchema = z
  .string()
  .min(1)
  .max(MODULE_LIMITS.icon_token_chars)
  .regex(ICON_TOKEN_PATTERN, 'Icon must be a safe lowercase token, not a URL or markup');

export const ModuleSemverSchema = z
  .string()
  .max(64)
  .regex(SEMVER_REGEX, 'Version must be strict semantic versioning');

const fieldCommonShape = {
  key: ModuleFieldKeySchema,
  label: ModuleDisplayNameSchema,
  description: ModuleDescriptionSchema.optional(),
  required: z.boolean().default(false),
};

const stringField = (type: 'text' | 'long_text' | 'email' | 'url' | 'date' | 'datetime') =>
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal(type),
    default: z.string().optional(),
  });

export const ModuleSelectOptionSchema = z.strictObject({
  value: ModuleKeySchema,
  label: ModuleDisplayNameSchema,
});

export const ModuleFieldSchema = z.discriminatedUnion('type', [
  stringField('text'),
  stringField('long_text'),
  stringField('email'),
  stringField('url'),
  stringField('date'),
  stringField('datetime'),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('number'),
    default: z.number().finite().optional(),
  }),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('single_select'),
    options: z
      .array(ModuleSelectOptionSchema)
      .min(1)
      .max(MODULE_LIMITS.select_options_per_field),
    default: ModuleKeySchema.optional(),
  }),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('multi_select'),
    options: z
      .array(ModuleSelectOptionSchema)
      .min(1)
      .max(MODULE_LIMITS.select_options_per_field),
    default: z
      .array(ModuleKeySchema)
      .max(MODULE_LIMITS.select_options_per_field)
      .optional(),
  }),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('member'),
    multiple: z.boolean().default(false),
  }),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('tags'),
  }),
  z.strictObject({
    ...fieldCommonShape,
    type: z.literal('relation'),
    target_collection: ModuleKeySchema,
    multiple: z.boolean().default(false),
  }),
]);

/**
 * Schema v2 adds only a host-resolved resource reference. The declaration is
 * identity-only: it cannot carry tenant, grant, connector, URL, or execution
 * authority. Required cross-resource writes are intentionally deferred until
 * record and relation mutation can share one public atomic contract.
 */
export const ModuleResourceReferenceFieldSchema = z.strictObject({
  key: ModuleFieldKeySchema,
  label: ModuleDisplayNameSchema,
  description: ModuleDescriptionSchema.optional(),
  required: z.literal(false).default(false),
  type: z.literal('resource_ref'),
  target: z.strictObject({
    module_id: ModuleIdSchema,
    resource_type: ModuleKeySchema,
  }),
  multiple: z.boolean().default(false),
  display: z.literal('label').default('label'),
});

export const ModuleFieldV2Schema = z.discriminatedUnion('type', [
  ...ModuleFieldSchema.options,
  ModuleResourceReferenceFieldSchema,
]);

type ModuleFilterCompatibilityInput = {
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_empty' | 'date_relative';
  value: unknown;
};

/** Match manifest quick-filter authoring to the runtime query compiler. */
function moduleFilterCompatibilityIssue(
  field: ModuleFieldV2,
  filter: ModuleFilterCompatibilityInput,
): string | null {
  if (field.type === 'relation' || field.type === 'resource_ref') {
    return 'Reference fields must be queried through the relation endpoint';
  }
  if (filter.operator === 'date_relative') {
    return field.type === 'date' ? null : 'date_relative requires a date field';
  }
  if (filter.operator === 'is_empty') return null;
  if (filter.operator === 'eq' || filter.operator === 'neq') {
    const issue = validateModuleFieldValue(field, filter.value);
    return issue ? `${filter.operator} value for ${field.key}: ${issue.message}` : null;
  }
  if (filter.operator === 'contains') {
    if (typeof filter.value !== 'string') return 'contains requires a string value';
    if (field.type === 'multi_select') {
      return field.options.some((option) => option.value === filter.value)
        ? null
        : `contains value for ${field.key} must match a declared option`;
    }
    if (field.type === 'tags' || (field.type === 'member' && field.multiple)) {
      const issue = validateModuleFieldValue(field, [filter.value]);
      return issue ? `contains value for ${field.key}: ${issue.message}` : null;
    }
    return ['text', 'long_text', 'email', 'url'].includes(field.type)
      ? null
      : 'contains is only valid for text or multi-select fields';
  }
  if (filter.operator === 'in') {
    if (!Array.isArray(filter.value) || !filter.value.every((item) => typeof item === 'string')) {
      return 'in requires an array of string values';
    }
    if (![
      'text',
      'long_text',
      'email',
      'url',
      'date',
      'datetime',
      'single_select',
      'multi_select',
      'member',
      'tags',
    ].includes(field.type)) return 'in is not valid for this field type';
    if (field.type === 'tags' || (field.type === 'member' && field.multiple)) {
      const issue = validateModuleFieldValue(field, filter.value);
      return issue ? `in value for ${field.key}: ${issue.message}` : null;
    }
    for (const item of filter.value) {
      if (field.type === 'multi_select') {
        if (!field.options.some((option) => option.value === item)) {
          return `in value for ${field.key} must match a declared option`;
        }
      } else {
        const issue = validateModuleFieldValue(field, item);
        if (issue) return `in value for ${field.key}: ${issue.message}`;
      }
    }
    return null;
  }
  if (!['number', 'date', 'datetime'].includes(field.type)) {
    return `${filter.operator} is only valid for number/date fields`;
  }
  const issue = validateModuleFieldValue(field, filter.value);
  return issue ? `${filter.operator} value for ${field.key}: ${issue.message}` : null;
}

export const ModuleSearchSchema = z.strictObject({
  title_field: ModuleFieldKeySchema,
  subtitle_fields: z
    .array(ModuleFieldKeySchema)
    .max(MODULE_LIMITS.search_subtitle_fields)
    .default([]),
  fields: z
    .array(ModuleFieldKeySchema)
    .min(1)
    .max(MODULE_LIMITS.search_fields_per_collection),
});

const moduleViewCommonShape = {
  key: ModuleKeySchema,
  name: ModuleDisplayNameSchema,
  fields: z.array(ModuleFieldKeySchema).min(1).max(MODULE_LIMITS.fields_per_view),
  quick_filters: z.array(z.strictObject({
    key: ModuleKeySchema,
    name: ModuleDisplayNameSchema,
    filters: z.array(z.lazy(() => ModuleQueryFilterSchema)).min(1).max(16),
  })).max(8).optional(),
};

export const ModuleViewSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...moduleViewCommonShape, type: z.literal('table') }),
  z.strictObject({
    ...moduleViewCommonShape,
    type: z.literal('board'),
    group_by: ModuleFieldKeySchema,
    summary: z.strictObject({ value_field: ModuleFieldKeySchema, unit_field: ModuleFieldKeySchema }).optional(),
  }),
  z.strictObject({
    ...moduleViewCommonShape,
    type: z.literal('timeline'),
    start_field: ModuleFieldKeySchema,
    end_field: ModuleFieldKeySchema.optional(),
  }),
  z.strictObject({ ...moduleViewCommonShape, type: z.literal('form') }),
  z.strictObject({ ...moduleViewCommonShape, type: z.literal('detail') }),
]);

export const ModuleNavigationSchema = z.strictObject({
  default_collection: ModuleKeySchema,
  default_view: ModuleKeySchema.optional(),
});

function addDuplicateIssues(
  values: readonly string[],
  pathPrefix: (string | number)[],
  ctx: z.RefinementCtx,
  label: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, index],
        message: `${label} must be unique`,
      });
    }
    seen.add(value);
  });
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // PostgreSQL date/timestamptz use 1 BC followed by 1 AD and reject year zero.
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function isValidDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isValidDate(match[1]!)) return false;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (match[6] !== undefined) {
    const offsetHour = Number(match[7]);
    const offsetMinute = Number(match[8]);
    // ISO-8601 civil-time offsets top out at UTC+/-14:00.
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return false;
    }
  }

  return true;
}

function isValidEmail(value: string): boolean {
  return (
    value.length <= MODULE_LIMITS.email_value_chars &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function isValidHttpUrl(value: string): boolean {
  if (value.length > MODULE_LIMITS.url_value_chars) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateManifestDefault(
  field: z.infer<typeof ModuleFieldSchema>,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (!('default' in field) || field.default === undefined) return;

  let valid = true;
  switch (field.type) {
    case 'text':
      valid = field.default.length <= MODULE_LIMITS.text_value_chars;
      break;
    case 'long_text':
      valid = field.default.length <= MODULE_LIMITS.long_text_value_chars;
      break;
    case 'email':
      valid = isValidEmail(field.default);
      break;
    case 'url':
      valid = isValidHttpUrl(field.default);
      break;
    case 'date':
      valid = isValidDate(field.default);
      break;
    case 'datetime':
      valid = isValidDateTime(field.default);
      break;
    case 'single_select': {
      const options = new Set(field.options.map((option) => option.value));
      valid = options.has(field.default);
      break;
    }
    case 'multi_select': {
      const options = new Set(field.options.map((option) => option.value));
      valid = new Set(field.default).size === field.default.length &&
        field.default.every((value) => options.has(value));
      break;
    }
    case 'number':
    case 'boolean':
      valid = true;
      break;
  }

  if (!valid) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'default'],
      message: `Default is invalid for ${field.type}`,
    });
  }
}

export const ModuleRelatedLatestSchema = z.strictObject({
  key: ModuleKeySchema,
  label: ModuleDisplayNameSchema,
  description: ModuleDescriptionSchema.optional(),
  source_collection: ModuleKeySchema,
  relation_field: ModuleFieldKeySchema,
  date_field: ModuleFieldKeySchema,
  where: z.array(z.strictObject({
    field: ModuleFieldKeySchema,
    values: z.array(ModuleSelectOptionSchema.shape.value).min(1).max(100),
  })).max(4).optional(),
});

export const ModuleCollectionSchema = z
  .strictObject({
    key: ModuleKeySchema,
    name: ModuleDisplayNameSchema,
    singular_name: ModuleDisplayNameSchema.optional(),
    description: ModuleDescriptionSchema.optional(),
    fields: z.array(ModuleFieldSchema).min(1).max(MODULE_LIMITS.fields_per_collection),
    search: ModuleSearchSchema.optional(),
    views: z.array(ModuleViewSchema).max(MODULE_LIMITS.views_per_collection).optional(),
    latest_related: z.array(ModuleRelatedLatestSchema).max(4).optional(),
  })
  .superRefine((collection, ctx) => {
    if (abortOnUnknownContractKeys(ctx)) return;
    addDuplicateIssues(
      collection.fields.map((field) => field.key),
      ['fields'],
      ctx,
      'Field keys',
    );

    collection.fields.forEach((field, fieldIndex) => {
      validateManifestDefault(field, ['fields', fieldIndex], ctx);
      if (field.type === 'single_select' || field.type === 'multi_select') {
        addDuplicateIssues(
          field.options.map((option) => option.value),
          ['fields', fieldIndex, 'options'],
          ctx,
          'Select option values',
        );
      }
    });

    const fieldByKey = new Map(collection.fields.map((field) => [field.key, field]));
    collection.fields.forEach((field, fieldIndex) => {
      if (field.type === 'relation' && field.required) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'required'],
          message: 'Relation fields must be optional in schema version 1',
        });
      }
    });
    if (collection.search) {
      const search = collection.search;
      const allReferences = [search.title_field, ...search.subtitle_fields, ...search.fields];
      allReferences.forEach((fieldKey) => {
        if (!fieldByKey.has(fieldKey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['search'],
            message: `Search references unknown field: ${fieldKey}`,
          });
        }
      });
      addDuplicateIssues(search.subtitle_fields, ['search', 'subtitle_fields'], ctx, 'Subtitle fields');
      addDuplicateIssues(search.fields, ['search', 'fields'], ctx, 'Search fields');

      if (!search.fields.includes(search.title_field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['search', 'fields'],
          message: 'Search fields must include title_field',
        });
      }
      for (const subtitleField of search.subtitle_fields) {
        if (!search.fields.includes(subtitleField)) {
          ctx.addIssue({
            code: 'custom',
            path: ['search', 'fields'],
            message: `Search fields must include subtitle field: ${subtitleField}`,
          });
        }
      }
      const titleField = fieldByKey.get(search.title_field);
      if (
        titleField
        && !titleField.required
        && (!('default' in titleField) || titleField.default === undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['search', 'title_field'],
          message: 'Search title_field must be required or have a default',
        });
      }
      for (const searchableField of allReferences) {
        const field = fieldByKey.get(searchableField);
        if (field?.type === 'relation' || field?.type === 'member') {
          ctx.addIssue({
            code: 'custom',
            path: ['search'],
            message: `Search cannot directly index ${field.type} field: ${searchableField}`,
          });
        }
      }
    }

    if (collection.views) {
      addDuplicateIssues(
        collection.views.map((view) => view.key),
        ['views'],
        ctx,
        'View keys',
      );
      collection.views.forEach((view, viewIndex) => {
        addDuplicateIssues(view.fields, ['views', viewIndex, 'fields'], ctx, 'View fields');
        view.fields.forEach((fieldKey, fieldIndex) => {
          if (!fieldByKey.has(fieldKey)) {
            ctx.addIssue({
              code: 'custom',
              path: ['views', viewIndex, 'fields', fieldIndex],
              message: `View references unknown field: ${fieldKey}`,
            });
          }
        });
        addDuplicateIssues((view.quick_filters ?? []).map((preset) => preset.key), ['views', viewIndex, 'quick_filters'], ctx, 'Quick filters');
        for (const [presetIndex, preset] of (view.quick_filters ?? []).entries()) {
          for (const [filterIndex, filter] of preset.filters.entries()) {
            const field = fieldByKey.get(filter.field);
            if (!field) {
              ctx.addIssue({ code: 'custom', path: ['views', viewIndex, 'quick_filters', presetIndex], message: 'Quick filter must reference a non-reference collection field' });
              continue;
            }
            const issue = moduleFilterCompatibilityIssue(field, filter);
            if (issue) {
              ctx.addIssue({
                code: 'custom',
                path: ['views', viewIndex, 'quick_filters', presetIndex, 'filters', filterIndex],
                message: issue,
              });
            }
          }
        }

        if (view.type === 'board') {
          const groupField = fieldByKey.get(view.group_by);
          if (view.summary && (groupField?.type !== 'single_select'
            || fieldByKey.get(view.summary.value_field)?.type !== 'number'
            || fieldByKey.get(view.summary.unit_field)?.type !== 'single_select')) {
            ctx.addIssue({ code: 'custom', path: ['views', viewIndex, 'summary'], message: 'Summary requires a number value and single-select group and unit fields' });
          }
          if (!groupField) {
            ctx.addIssue({
              code: 'custom',
              path: ['views', viewIndex, 'group_by'],
              message: `Board references unknown field: ${view.group_by}`,
            });
          } else if (!['single_select', 'member', 'tags'].includes(groupField.type)) {
            ctx.addIssue({
              code: 'custom',
              path: ['views', viewIndex, 'group_by'],
              message: 'Board group_by must reference a select, member, or tags field',
            });
          }
        }

        if (view.type === 'timeline') {
          const timelineFields = [view.start_field, ...(view.end_field ? [view.end_field] : [])];
          timelineFields.forEach((fieldKey) => {
            const field = fieldByKey.get(fieldKey);
            if (!field) {
              ctx.addIssue({
                code: 'custom',
                path: ['views', viewIndex],
                message: `Timeline references unknown field: ${fieldKey}`,
              });
            } else if (field.type !== 'date' && field.type !== 'datetime') {
              ctx.addIssue({
                code: 'custom',
                path: ['views', viewIndex],
                message: `Timeline field must be a date or datetime: ${fieldKey}`,
              });
            }
          });
        }
      });
    }
  });

export const ModuleCollectionV2Schema = z
  .strictObject({
    key: ModuleKeySchema,
    name: ModuleDisplayNameSchema,
    singular_name: ModuleDisplayNameSchema.optional(),
    description: ModuleDescriptionSchema.optional(),
    fields: z.array(ModuleFieldV2Schema).min(1).max(MODULE_LIMITS.fields_per_collection),
    search: ModuleSearchSchema.optional(),
    views: z.array(ModuleViewSchema).max(MODULE_LIMITS.views_per_collection).optional(),
    latest_related: z.array(ModuleRelatedLatestSchema).max(4).optional(),
  })
  .superRefine((collection, ctx) => {
    if (abortOnUnknownContractKeys(ctx)) return;
    // Reuse the exact v1 collection invariants by projecting resource refs to
    // the already non-inline v1 relation shape. This keeps defaults, views,
    // search restrictions, duplicate checks, and all scalar behavior aligned.
    const compatible = ModuleCollectionSchema.safeParse({
      ...collection,
      fields: collection.fields.map((field) => field.type === 'resource_ref'
        ? {
            key: field.key,
            label: field.label,
            description: field.description,
            required: false,
            type: 'relation' as const,
            target_collection: field.target.resource_type,
            multiple: field.multiple,
          }
        : field),
    });
    if (!compatible.success) {
      for (const issue of compatible.error.issues) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    }
  });

function validateLatestRelated(
  collections: { key: string; fields: z.infer<typeof ModuleFieldV2Schema>[]; latest_related?: z.infer<typeof ModuleRelatedLatestSchema>[] }[],
  ctx: z.RefinementCtx,
): void {
  for (const [collectionIndex, collection] of collections.entries()) {
    addDuplicateIssues((collection.latest_related ?? []).map((item) => item.key), ['collections', collectionIndex, 'latest_related'], ctx, 'Related summary keys');
    for (const [index, definition] of (collection.latest_related ?? []).entries()) {
      const source = collections.find((item) => item.key === definition.source_collection);
      const relation = source?.fields.find((field) => field.key === definition.relation_field);
      const date = source?.fields.find((field) => field.key === definition.date_field);
      const validMatches = (definition.where ?? []).every((match) => {
        const field = source?.fields.find((candidate) => candidate.key === match.field);
        return field?.type === 'single_select' && match.values.every((value) => field.options.some((option) => option.value === value));
      });
      if (relation?.type !== 'relation' || relation.target_collection !== collection.key
        || !date || !['date', 'datetime'].includes(date.type) || !validMatches) {
        ctx.addIssue({ code: 'custom', path: ['collections', collectionIndex, 'latest_related', index], message: 'Latest related summary requires a direct relation to this collection, a date field and declared select values' });
      }
    }
  }
}

export const DeftModuleManifestV1Schema = z
  .strictObject({
    schema_version: z.literal(DEFT_MODULE_MANIFEST_SCHEMA_VERSION),
    id: ModuleIdSchema,
    slug: ModuleSlugSchema,
    version: ModuleSemverSchema,
    name: ModuleDisplayNameSchema,
    description: ModuleDescriptionSchema.optional(),
    icon: ModuleIconTokenSchema.optional(),
    collections: z
      .array(ModuleCollectionSchema)
      .min(1)
      .max(MODULE_LIMITS.collections_per_module),
    navigation: ModuleNavigationSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (abortOnUnknownContractKeys(ctx)) return;
    validateLatestRelated(manifest.collections, ctx);
    addDuplicateIssues(
      manifest.collections.map((collection) => collection.key),
      ['collections'],
      ctx,
      'Collection keys',
    );

    const collectionByKey = new Map(
      manifest.collections.map((collection) => [collection.key, collection]),
    );
    manifest.collections.forEach((collection, collectionIndex) => {
      collection.fields.forEach((field, fieldIndex) => {
        if (field.type === 'relation' && !collectionByKey.has(field.target_collection)) {
          ctx.addIssue({
            code: 'custom',
            path: ['collections', collectionIndex, 'fields', fieldIndex, 'target_collection'],
            message: `Relation target collection does not exist: ${field.target_collection}`,
          });
        }
      });
    });

    if (manifest.navigation) {
      const defaultCollection = collectionByKey.get(manifest.navigation.default_collection);
      if (!defaultCollection) {
        ctx.addIssue({
          code: 'custom',
          path: ['navigation', 'default_collection'],
          message: 'Default collection must reference a declared collection',
        });
      } else if (
        manifest.navigation.default_view
        && !defaultCollection.views?.some((view) => view.key === manifest.navigation?.default_view)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['navigation', 'default_view'],
          message: 'Default view must belong to the default collection',
        });
      }
    }
  });

export const DeftModuleManifestV2Schema = z
  .strictObject({
    schema_version: z.literal(DEFT_MODULE_MANIFEST_SCHEMA_VERSION_V2),
    id: ModuleIdSchema,
    slug: ModuleSlugSchema,
    version: ModuleSemverSchema,
    name: ModuleDisplayNameSchema,
    description: ModuleDescriptionSchema.optional(),
    icon: ModuleIconTokenSchema.optional(),
    collections: z
      .array(ModuleCollectionV2Schema)
      .min(1)
      .max(MODULE_LIMITS.collections_per_module),
    navigation: ModuleNavigationSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (abortOnUnknownContractKeys(ctx)) return;
    validateLatestRelated(manifest.collections, ctx);
    addDuplicateIssues(
      manifest.collections.map((collection) => collection.key),
      ['collections'],
      ctx,
      'Collection keys',
    );
    const collectionByKey = new Map(
      manifest.collections.map((collection) => [collection.key, collection]),
    );
    manifest.collections.forEach((collection, collectionIndex) => {
      collection.fields.forEach((field, fieldIndex) => {
        const target = field.type === 'relation'
          ? { module_id: manifest.id, resource_type: field.target_collection }
          : field.type === 'resource_ref'
            ? field.target
            : null;
        if (target?.module_id === manifest.id && !collectionByKey.has(target.resource_type)) {
          ctx.addIssue({
            code: 'custom',
            path: ['collections', collectionIndex, 'fields', fieldIndex],
            message: `Reference target collection does not exist: ${target.resource_type}`,
          });
        }
      });
    });
    if (manifest.navigation) {
      const defaultCollection = collectionByKey.get(manifest.navigation.default_collection);
      if (!defaultCollection) {
        ctx.addIssue({
          code: 'custom',
          path: ['navigation', 'default_collection'],
          message: 'Default collection must reference a declared collection',
        });
      } else if (
        manifest.navigation.default_view
        && !defaultCollection.views?.some((view) => view.key === manifest.navigation?.default_view)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['navigation', 'default_view'],
          message: 'Default view must belong to the default collection',
        });
      }
    }
  });

export const DeftModuleManifestSchema = z.union([
  DeftModuleManifestV1Schema,
  DeftModuleManifestV2Schema,
]);

export type DeftModuleManifestV1 = z.infer<typeof DeftModuleManifestV1Schema>;
export type DeftModuleManifestV1Input = z.input<typeof DeftModuleManifestV1Schema>;
export type DeftModuleManifestV2 = z.infer<typeof DeftModuleManifestV2Schema>;
export type DeftModuleManifestV2Input = z.input<typeof DeftModuleManifestV2Schema>;
export type DeftModuleManifest = z.infer<typeof DeftModuleManifestSchema>;
export type DeftModuleManifestInput = z.input<typeof DeftModuleManifestSchema>;
export type ModuleCollection = z.infer<typeof ModuleCollectionSchema>;
export type ModuleField = z.infer<typeof ModuleFieldSchema>;
export type ModuleFieldV2 = z.infer<typeof ModuleFieldV2Schema>;
export type ModuleView = z.infer<typeof ModuleViewSchema>;

export function parseDeftModuleManifest(value: unknown): DeftModuleManifestV1 {
  const parsed = DeftModuleManifestV1Schema.parse(value);
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).byteLength > MODULE_LIMITS.manifest_bytes) {
    throw new Error(`Manifest exceeds ${MODULE_LIMITS.manifest_bytes} bytes`);
  }
  return parsed;
}

export function parseDeftModuleManifestJson(value: string): DeftModuleManifestV1 {
  if (new TextEncoder().encode(value).byteLength > MODULE_LIMITS.manifest_bytes) {
    throw new Error(`Manifest exceeds ${MODULE_LIMITS.manifest_bytes} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('Manifest is not valid JSON', { cause: error });
  }
  return parseDeftModuleManifest(parsed);
}

export function parseSupportedDeftModuleManifest(value: unknown): DeftModuleManifest {
  const parsed = DeftModuleManifestSchema.parse(value);
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).byteLength > MODULE_LIMITS.manifest_bytes) {
    throw new Error(`Manifest exceeds ${MODULE_LIMITS.manifest_bytes} bytes`);
  }
  return parsed;
}

export function parseSupportedDeftModuleManifestJson(value: string): DeftModuleManifest {
  if (new TextEncoder().encode(value).byteLength > MODULE_LIMITS.manifest_bytes) {
    throw new Error(`Manifest exceeds ${MODULE_LIMITS.manifest_bytes} bytes`);
  }
  try {
    return parseSupportedDeftModuleManifest(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Manifest is not valid JSON', { cause: error });
    throw error;
  }
}

/**
 * Machine-readable authoring schema. Runtime consumers must still use the Zod
 * parser because cross-field references and uniqueness are enforced by
 * super-refinements that JSON Schema cannot fully express.
 */
export function getDeftModuleManifestV1JsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deft declarative module manifest v1',
    ...z.toJSONSchema(DeftModuleManifestV1Schema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }),
  } as Record<string, unknown>;
}

export function getDeftModuleManifestV2JsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deft declarative module manifest v2',
    ...z.toJSONSchema(DeftModuleManifestV2Schema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }),
  } as Record<string, unknown>;
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | {
  [key: string]: CanonicalJson;
};

function canonicalizeJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? value.normalize('NFC') : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item !== undefined) output[key.normalize('NFC')] = canonicalizeJson(item);
    }
    return output;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export function canonicalizeModuleManifest(value: unknown): CanonicalJson {
  return canonicalizeJson(parseDeftModuleManifest(value));
}

export function canonicalModuleManifestJson(value: unknown): string {
  return JSON.stringify(canonicalizeModuleManifest(value));
}

export const ModuleManifestDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Manifest digest must be sha256:<lowercase hex>');

export type ModuleManifestDigest = z.infer<typeof ModuleManifestDigestSchema>;

export async function digestModuleManifest(value: unknown): Promise<ModuleManifestDigest> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime');
  }
  const bytes = new TextEncoder().encode(canonicalModuleManifestJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return ModuleManifestDigestSchema.parse(`sha256:${hex}`);
}

export function canonicalSupportedModuleManifestJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(parseSupportedDeftModuleManifest(value)));
}

export async function digestSupportedModuleManifest(value: unknown): Promise<ModuleManifestDigest> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime');
  }
  const bytes = new TextEncoder().encode(canonicalSupportedModuleManifestJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return ModuleManifestDigestSchema.parse(`sha256:${hex}`);
}

export type ModuleRecordFieldValue = string | number | boolean | string[];
export type ModuleRecordData = Record<string, ModuleRecordFieldValue>;

export type ModuleRecordValidationIssue = {
  field: string | null;
  code:
    | 'invalid_collection'
    | 'invalid_data'
    | 'unknown_field'
    | 'required'
    | 'invalid_type'
    | 'invalid_value'
    | 'record_too_large';
  message: string;
};

export type ModuleRecordValidationResult =
  | { success: true; data: ModuleRecordData }
  | { success: false; issues: ModuleRecordValidationIssue[] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationIssue(
  field: string | null,
  code: ModuleRecordValidationIssue['code'],
  message: string,
): ModuleRecordValidationIssue {
  return { field, code, message };
}

export function validateModuleFieldValue(
  field: ModuleFieldV2,
  value: unknown,
): ModuleRecordValidationIssue | null {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be text');
      if (field.required && value.length === 0) return validationIssue(field.key, 'required', 'Must not be empty');
      if (value.length > MODULE_LIMITS.text_value_chars) {
        return validationIssue(field.key, 'invalid_value', `Must be at most ${MODULE_LIMITS.text_value_chars} characters`);
      }
      return null;
    case 'long_text':
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be text');
      if (field.required && value.length === 0) return validationIssue(field.key, 'required', 'Must not be empty');
      if (value.length > MODULE_LIMITS.long_text_value_chars) {
        return validationIssue(field.key, 'invalid_value', `Must be at most ${MODULE_LIMITS.long_text_value_chars} characters`);
      }
      return null;
    case 'email':
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be an email string');
      return isValidEmail(value)
        ? null
        : validationIssue(field.key, 'invalid_value', 'Must be a valid email address');
    case 'url':
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be a URL string');
      return isValidHttpUrl(value)
        ? null
        : validationIssue(field.key, 'invalid_value', 'Must be an absolute HTTP or HTTPS URL');
    case 'date':
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be a date string');
      return isValidDate(value)
        ? null
        : validationIssue(field.key, 'invalid_value', 'Must be a real calendar date in YYYY-MM-DD format');
    case 'datetime':
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be a datetime string');
      return isValidDateTime(value)
        ? null
        : validationIssue(field.key, 'invalid_value', 'Must be an ISO 8601 datetime with a timezone');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : validationIssue(field.key, 'invalid_type', 'Must be a finite number');
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : validationIssue(field.key, 'invalid_type', 'Must be true or false');
    case 'single_select': {
      if (typeof value !== 'string') return validationIssue(field.key, 'invalid_type', 'Must be one option value');
      return field.options.some((option) => option.value === value)
        ? null
        : validationIssue(field.key, 'invalid_value', 'Must match a declared option value');
    }
    case 'multi_select': {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return validationIssue(field.key, 'invalid_type', 'Must be an array of option values');
      }
      if (value.length > MODULE_LIMITS.select_options_per_field || new Set(value).size !== value.length) {
        return validationIssue(field.key, 'invalid_value', 'Option values must be unique and within the option limit');
      }
      const options = new Set(field.options.map((option) => option.value));
      return value.every((item) => options.has(item))
        ? null
        : validationIssue(field.key, 'invalid_value', 'Every item must match a declared option value');
    }
    case 'member': {
      const values = field.multiple ? value : [value];
      if (
        (field.multiple && !Array.isArray(value))
        || (!field.multiple && typeof value !== 'string')
        || !Array.isArray(values)
        || !values.every((item) => typeof item === 'string')
      ) {
        return validationIssue(
          field.key,
          'invalid_type',
          field.multiple ? 'Must be an array of member IDs' : 'Must be one member ID',
        );
      }
      if (
        values.length > MODULE_LIMITS.relation_values_per_field
        || new Set(values).size !== values.length
        || !values.every((item) => OPAQUE_ID_PATTERN.test(item))
      ) {
        return validationIssue(field.key, 'invalid_value', 'Member IDs must be unique valid identifiers within the field limit');
      }
      return null;
    }
    case 'tags': {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return validationIssue(field.key, 'invalid_type', 'Must be an array of tags');
      }
      if (
        value.length > MODULE_LIMITS.tags_per_field
        || new Set(value).size !== value.length
        || value.some((item) => item.trim().length === 0 || item.length > MODULE_LIMITS.tag_value_chars)
      ) {
        return validationIssue(
          field.key,
          'invalid_value',
          `Tags must be unique non-empty strings of at most ${MODULE_LIMITS.tag_value_chars} characters`,
        );
      }
      return null;
    }
    case 'relation':
    case 'resource_ref':
      return validationIssue(
        field.key,
        'invalid_value',
        'Relations must be managed through the relation endpoint, not record data',
      );
  }
}

export function validateModuleRecordData(
  manifestValue: unknown,
  collectionKey: string,
  dataValue: unknown,
): ModuleRecordValidationResult {
  const manifest = parseSupportedDeftModuleManifest(manifestValue);
  const collection = manifest.collections.find((candidate) => candidate.key === collectionKey);
  if (!collection) {
    return {
      success: false,
      issues: [validationIssue(null, 'invalid_collection', `Unknown collection: ${collectionKey}`)],
    };
  }
  if (!isPlainRecord(dataValue)) {
    return {
      success: false,
      issues: [validationIssue(null, 'invalid_data', 'Record data must be a plain object')],
    };
  }

  const fieldByKey = new Map(collection.fields.map((field) => [field.key, field]));
  const issues: ModuleRecordValidationIssue[] = [];
  for (const key of Object.keys(dataValue)) {
    if (!fieldByKey.has(key)) {
      issues.push(validationIssue(key, 'unknown_field', 'Field is not declared by the active manifest'));
    }
  }

  const output: ModuleRecordData = {};
  for (const field of collection.fields) {
    let value = dataValue[field.key];
    if (value === undefined && 'default' in field && field.default !== undefined) {
      value = Array.isArray(field.default) ? [...field.default] : field.default;
    }
    if (value === undefined) {
      if (field.required) issues.push(validationIssue(field.key, 'required', 'Field is required'));
      continue;
    }

    const issue = validateModuleFieldValue(field, value);
    if (issue) {
      issues.push(issue);
      continue;
    }
    output[field.key] = Array.isArray(value) ? [...value] : value as ModuleRecordFieldValue;
  }

  if (issues.length > 0) return { success: false, issues };

  const encodedBytes = new TextEncoder().encode(JSON.stringify(output)).byteLength;
  if (encodedBytes > MODULE_LIMITS.record_bytes) {
    return {
      success: false,
      issues: [
        validationIssue(
          null,
          'record_too_large',
          `Record exceeds ${MODULE_LIMITS.record_bytes} bytes`,
        ),
      ],
    };
  }
  return { success: true, data: output };
}

export class ModuleRecordValidationError extends Error {
  constructor(public readonly issues: ModuleRecordValidationIssue[]) {
    super('Module record data is invalid');
    this.name = 'ModuleRecordValidationError';
  }
}

export function parseModuleRecordData(
  manifest: unknown,
  collectionKey: string,
  data: unknown,
): ModuleRecordData {
  const result = validateModuleRecordData(manifest, collectionKey, data);
  if (!result.success) throw new ModuleRecordValidationError(result.issues);
  return result.data;
}

export type ModuleRecordSearchProjection = {
  title: string;
  subtitle: string | null;
  text: string;
};

function collapseProjectionWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function sliceUnicode(value: string, max: number): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function fieldProjectionText(field: ModuleFieldV2, value: ModuleRecordFieldValue | undefined): string {
  if (value === undefined) return '';
  if (field.type === 'single_select' && typeof value === 'string') {
    return field.options.find((option) => option.value === value)?.label ?? value;
  }
  if (field.type === 'multi_select' && Array.isArray(value)) {
    const labels = new Map(field.options.map((option) => [option.value, option.label]));
    return value.map((item) => labels.get(item) ?? item).join(', ');
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export function projectModuleRecordSearch(
  manifestValue: unknown,
  collectionKey: string,
  dataValue: unknown,
): ModuleRecordSearchProjection | null {
  const manifest = parseSupportedDeftModuleManifest(manifestValue);
  const collection = manifest.collections.find((candidate) => candidate.key === collectionKey);
  if (!collection) throw new ModuleRecordValidationError([
    validationIssue(null, 'invalid_collection', `Unknown collection: ${collectionKey}`),
  ]);
  if (!collection.search) return null;

  const data = parseModuleRecordData(manifest, collectionKey, dataValue);
  const fieldByKey = new Map(collection.fields.map((field) => [field.key, field]));
  const display = (fieldKey: string): string => {
    const field = fieldByKey.get(fieldKey);
    return field ? collapseProjectionWhitespace(fieldProjectionText(field, data[fieldKey])) : '';
  };

  const title = sliceUnicode(display(collection.search.title_field), MODULE_LIMITS.search_title_chars);
  const subtitleValue = collection.search.subtitle_fields
    .map(display)
    .filter(Boolean)
    .join(' · ');
  const subtitle = subtitleValue
    ? sliceUnicode(subtitleValue, MODULE_LIMITS.search_subtitle_chars)
    : null;
  const text = sliceUnicode(
    collection.search.fields.map(display).filter(Boolean).join('\n'),
    MODULE_LIMITS.search_text_chars,
  );
  return { title, subtitle, text };
}

/** Resolve the generic host display title even when a Module intentionally
 * omits search indexing. Host-rendered links must follow the same declared
 * title/first-field fallback as the record workspace. */
export function projectModuleRecordDisplayTitle(
  manifestValue: unknown,
  collectionKey: string,
  dataValue: unknown,
): string | null {
  const manifest = parseSupportedDeftModuleManifest(manifestValue);
  const collection = manifest.collections.find((candidate) => candidate.key === collectionKey);
  if (!collection) throw new ModuleRecordValidationError([
    validationIssue(null, 'invalid_collection', `Unknown collection: ${collectionKey}`),
  ]);
  const titleFieldKey = collection.search?.title_field ?? collection.fields[0]?.key;
  if (!titleFieldKey) return null;
  const field = collection.fields.find((candidate) => candidate.key === titleFieldKey);
  if (!field) return null;
  const data = parseModuleRecordData(manifest, collectionKey, dataValue);
  const title = sliceUnicode(
    collapseProjectionWhitespace(fieldProjectionText(field, data[titleFieldKey])),
    MODULE_LIMITS.search_title_chars,
  );
  return title || null;
}

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(OPAQUE_ID_PATTERN, 'Identifier contains unsupported characters');

export const ModuleActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('human'),
    org_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    role: z.enum(['owner', 'admin', 'member', 'guest']),
    source: z.enum(['ui', 'rest', 'mcp']),
    scopes: z.array(z.string().min(1).max(80)).max(64).default([]),
  }),
  z.strictObject({
    kind: z.literal('defty'),
    org_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    role: z.enum(['owner', 'admin', 'member', 'guest']),
    source: z.literal('defty'),
    conversation_id: OpaqueIdSchema.optional(),
    action_id: OpaqueIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('agent_employee'),
    org_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    trust_level: z.enum(['conservative', 'standard', 'autonomous']),
    source: z.enum(['mcp', 'runtime']),
    scopes: z.array(z.string().min(1).max(80)).max(64).default([]),
    action_id: OpaqueIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('system'),
    org_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    source: z.literal('system'),
  }),
]);

export type ModuleActor = z.infer<typeof ModuleActorSchema>;

export const MODULE_RECORD_RESOURCE_PREFIX = 'module_record:' as const;
export const ModuleRecordResourceIdSchema = z
  .string()
  .max(MODULE_RECORD_RESOURCE_PREFIX.length + 128)
  .regex(/^module_record:[A-Za-z0-9][A-Za-z0-9_-]*$/);

export type ModuleRecordResourceId = z.infer<typeof ModuleRecordResourceIdSchema>;

export function formatModuleRecordResourceId(recordId: string): ModuleRecordResourceId {
  return ModuleRecordResourceIdSchema.parse(`${MODULE_RECORD_RESOURCE_PREFIX}${recordId}`);
}

export function parseModuleRecordResourceId(resourceId: string): string {
  return ModuleRecordResourceIdSchema.parse(resourceId).slice(MODULE_RECORD_RESOURCE_PREFIX.length);
}

export const ModuleResourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('module'),
    installation_id: OpaqueIdSchema,
    module_id: ModuleIdSchema,
  }),
  z.strictObject({
    type: z.literal('module_collection'),
    installation_id: OpaqueIdSchema,
    module_id: ModuleIdSchema,
    collection_key: ModuleKeySchema,
  }),
  z.strictObject({
    type: z.literal('module_record'),
    resource_id: ModuleRecordResourceIdSchema,
    record_id: OpaqueIdSchema,
    installation_id: OpaqueIdSchema,
    module_id: ModuleIdSchema,
    collection_key: ModuleKeySchema,
  }),
]);

export type ModuleResource = z.infer<typeof ModuleResourceSchema>;

export const MODULE_OPERATION_NAMES = [
  'module_list',
  'module_schema_get',
  'module_record_search',
  'module_record_query',
  'module_record_get',
  'module_record_incoming',
  'module_record_latest_related',
  'module_record_task_links',
  'module_record_task_link',
  'module_record_task_unlink',
  'module_record_create',
  'module_record_bulk_create',
  'module_record_update',
  'module_record_archive',
] as const;

export const ModuleOperationNameSchema = z.enum(MODULE_OPERATION_NAMES);

export function moduleTaskOperationRequiredScopes(operation: string): readonly string[] | undefined {
  if (operation === 'module_record_task_links') return ['read:modules', 'read:tasks'];
  if (operation === 'module_record_task_link' || operation === 'module_record_task_unlink') return ['write:modules', 'write:tasks'];
  return undefined;
}
export type ModuleOperationName = z.infer<typeof ModuleOperationNameSchema>;

export const MODULE_OPERATION_DEFINITIONS = Object.freeze({
  module_list: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_schema_get: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_search: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_query: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_get: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_incoming: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_latest_related: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_task_links: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_task_link: { mode: 'write', approval_tier: 'quick', destructive: false },
  module_record_task_unlink: { mode: 'write', approval_tier: 'quick', destructive: true },
  module_record_create: { mode: 'write', approval_tier: 'quick', destructive: false },
  module_record_bulk_create: { mode: 'write', approval_tier: 'full', destructive: true },
  module_record_update: { mode: 'write', approval_tier: 'quick', destructive: false },
  module_record_archive: { mode: 'write', approval_tier: 'full', destructive: true },
} as const satisfies Record<
  ModuleOperationName,
  { mode: 'read' | 'write'; approval_tier: 'auto' | 'quick' | 'full'; destructive: boolean }
>);

export const ModuleRecordFieldValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()).max(MODULE_LIMITS.relation_values_per_field),
]);

export const ModuleRecordDataSchema = z.record(ModuleFieldKeySchema, ModuleRecordFieldValueSchema);


export const ModuleExpectedRevisionSchema = z.number().int().min(1);
export const ModuleIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'Invalid idempotency key');

const PageLimitSchema = z.number().int().min(1).max(MODULE_LIMITS.operation_page_size).default(25);
const CursorSchema = z.string().min(1).max(2_048);

export const ModuleListRequestSchema = z.strictObject({});
export const ModuleSchemaGetRequestSchema = z.strictObject({ module_id: ModuleIdSchema });
export const ModuleRecordSearchRequestSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(500),
    module_id: ModuleIdSchema.optional(),
    collection_key: ModuleKeySchema.optional(),
    limit: PageLimitSchema,
    cursor: CursorSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.collection_key && !input.module_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['collection_key'],
        message: 'collection_key requires module_id',
      });
    }
  });

export const ModuleQueryFilterSchema = z
  .strictObject({
    field: ModuleFieldKeySchema,
    operator: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'is_empty', 'date_relative']),
    value: ModuleRecordFieldValueSchema,
  })
  .superRefine((filter, ctx) => {
    if (filter.operator === 'date_relative' && (typeof filter.value !== 'string' || !['past', 'today', 'next_7_days'].includes(filter.value))) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'date_relative requires past, today or next_7_days' });
    }
    if (filter.operator === 'is_empty' && typeof filter.value !== 'boolean') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'is_empty requires a boolean value' });
    }
    if (filter.operator === 'contains' && typeof filter.value !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'contains requires a string value',
      });
    }
    if (filter.operator === 'in' && (
      !Array.isArray(filter.value) ||
      !filter.value.every((item) => typeof item === 'string')
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'in requires an array of string values',
      });
    }
    if (
      ['gt', 'gte', 'lt', 'lte'].includes(filter.operator) &&
      typeof filter.value !== 'string' &&
      typeof filter.value !== 'number'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `${filter.operator} requires a number, date, or datetime value`,
      });
    }
  });

export const ModuleQuerySortSchema = z.strictObject({
  field: z.union([z.enum(['created_at', 'updated_at']), ModuleFieldKeySchema]),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

const moduleSavedViewCommonShape = {
  fields: z
    .array(ModuleFieldKeySchema)
    .min(1)
    .max(MODULE_LIMITS.fields_per_view)
    .refine((fields) => new Set(fields).size === fields.length, 'View fields must be unique'),
  filters: z.array(ModuleQueryFilterSchema).max(16).default([]),
  sort: ModuleQuerySortSchema.optional(),
};

export const ModuleSavedViewConfigSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...moduleSavedViewCommonShape, type: z.literal('table') }),
  z.strictObject({
    ...moduleSavedViewCommonShape,
    type: z.literal('board'),
    group_by: ModuleFieldKeySchema,
    summary: z.strictObject({ value_field: ModuleFieldKeySchema, unit_field: ModuleFieldKeySchema }).optional(),
  }),
  z.strictObject({
    ...moduleSavedViewCommonShape,
    type: z.literal('timeline'),
    start_field: ModuleFieldKeySchema,
    end_field: ModuleFieldKeySchema.optional(),
  }),
]);

export const ModuleSavedViewCreateRequestSchema = z.strictObject({
  collection_key: ModuleKeySchema,
  name: ModuleDisplayNameSchema,
  config: ModuleSavedViewConfigSchema,
});

export const ModuleSavedViewUpdateRequestSchema = z
  .strictObject({
    name: ModuleDisplayNameSchema.optional(),
    config: ModuleSavedViewConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: 'Saved view update must include a name or config',
  });

export const ModuleRelationRecordIdsSchema = z
  .array(z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN))
  .max(MODULE_LIMITS.relation_values_per_field)
  .refine((ids) => new Set(ids).size === ids.length, 'Relation record IDs must be unique');

export const ModuleRelationPatchSchema = z.record(
  ModuleFieldKeySchema,
  ModuleRelationRecordIdsSchema,
);

export const ModuleRelationReplaceRequestSchema = z.strictObject({
  record_ids: ModuleRelationRecordIdsSchema,
  expected_revision: ModuleExpectedRevisionSchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema,
});

export const ModuleRecordQueryRequestSchema = z.strictObject({
  module_id: ModuleIdSchema,
  today: z.iso.date().describe('Calendar day in the caller timezone; required when using date_relative filters').optional(),
  collection_key: ModuleKeySchema,
  search: z.string().trim().min(1).max(500).optional(),
  filters: z.array(ModuleQueryFilterSchema).max(16).default([]),
  sort: ModuleQuerySortSchema.optional(),
  limit: PageLimitSchema,
  cursor: CursorSchema.optional(),
});

export const ModuleRecordGetRequestSchema = z.strictObject({ record_id: OpaqueIdSchema });
export const ModuleRecordIncomingRequestSchema = z.strictObject({
  record_id: OpaqueIdSchema, collection_key: ModuleKeySchema, field_key: ModuleFieldKeySchema,
  date_field: ModuleFieldKeySchema.optional(), limit: PageLimitSchema, cursor: CursorSchema.optional(),
});
export const ModuleRecordNextTasksRequestSchema = z.strictObject({
  record_ids: z.array(OpaqueIdSchema).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Record IDs must be unique'),
});
export const ModuleRecordSummaryRequestSchema = ModuleRecordQueryRequestSchema.omit({
  sort: true, limit: true, cursor: true,
}).extend({
  value_field: ModuleFieldKeySchema,
  group_field: ModuleFieldKeySchema,
  unit_field: ModuleFieldKeySchema.optional(),
});
export type ModuleRecordSummaryRequest = z.infer<typeof ModuleRecordSummaryRequestSchema>;
export const ModuleRecordSummaryResponseSchema = z.object({ groups: z.array(z.object({
  group: z.string().nullable(), unit: z.string().nullable(),
  record_count: z.string().regex(/^\d+$/), valued_count: z.string().regex(/^\d+$/),
  total: z.string().nullable(),
})) });

export const ModuleImportPreviewRequestSchema = z.strictObject({
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  match_field: ModuleFieldKeySchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  rows: z.array(ModuleRecordDataSchema).min(1).max(100),
});
export const ModuleImportCommitRequestSchema = ModuleImportPreviewRequestSchema.extend({
  expected_preview_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema,
});
export type ModuleImportPreviewRequest = z.infer<typeof ModuleImportPreviewRequestSchema>;
export type ModuleImportCommitRequest = z.infer<typeof ModuleImportCommitRequestSchema>;

export const ModuleRecordCreateRequestSchema = z.strictObject({
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  data: ModuleRecordDataSchema,
  relations: ModuleRelationPatchSchema.default({}),
  expected_manifest_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema,
});
export const ModuleRecordUpdateRequestSchema = z
  .strictObject({
    record_id: OpaqueIdSchema,
    patch: ModuleRecordDataSchema.default({}),
    unset_fields: z.array(ModuleFieldKeySchema).max(MODULE_LIMITS.fields_per_collection).default([]),
    relations: ModuleRelationPatchSchema.default({}),
    expected_revision: ModuleExpectedRevisionSchema,
    expected_manifest_digest: ModuleManifestDigestSchema,
    idempotency_key: ModuleIdempotencyKeySchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      Object.keys(input.patch).length === 0
      && input.unset_fields.length === 0
      && Object.keys(input.relations).length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'Update must patch, unset, or replace at least one field',
      });
    }
    addDuplicateIssues(input.unset_fields, ['unset_fields'], ctx, 'Unset fields');
    input.unset_fields.forEach((field, index) => {
      if (Object.hasOwn(input.patch, field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unset_fields', index],
          message: `Field cannot be patched and unset in the same update: ${field}`,
        });
      }
    });
  });
export const ModuleRecordArchiveRequestSchema = z.strictObject({
  record_id: OpaqueIdSchema,
  expected_revision: ModuleExpectedRevisionSchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema.optional(),
});

export const ModuleMergeHistoryRequestSchema = z.strictObject({ offset: z.coerce.number().int().min(0).max(100000).default(0) });

export const ModuleMergePreviewRequestSchema = z.strictObject({
  source_record_id: OpaqueIdSchema,
  target_record_id: OpaqueIdSchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  field_choices: z.record(ModuleFieldKeySchema, z.enum(['source', 'target'])).default({}),
  relation_choices: z.record(ModuleFieldKeySchema, z.enum(['source', 'target'])).default({}),
});
export const ModuleMergeCommitRequestSchema = ModuleMergePreviewRequestSchema.extend({
  expected_preview_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema,
});
export type ModuleMergePreviewRequest = z.infer<typeof ModuleMergePreviewRequestSchema>;

export const ModuleDuplicateListRequestSchema = z.strictObject({
  collection_key: ModuleKeySchema,
  match_field: ModuleFieldKeySchema,
  search: z.string().trim().max(240).default(''),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  match_value: z.string().max(10000).optional(),
  record_offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const ModuleRecordRestoreRequestSchema = ModuleRecordArchiveRequestSchema.extend({ idempotency_key: ModuleIdempotencyKeySchema });
export type ModuleRecordRestoreRequest = z.infer<typeof ModuleRecordRestoreRequestSchema>;
export const ModuleArchiveListRequestSchema = z.strictObject({
  collection_key: ModuleKeySchema,
  search: z.string().trim().max(240).default(''),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const ModuleRecordTaskWriteRequestSchema = z.strictObject({
  resource_id: ModuleRecordResourceIdSchema,
  task_identifier: z.string().trim().min(1).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid task identifier'),
  idempotency_key: ModuleIdempotencyKeySchema,
});

export const ModuleRecordBulkCreateRequestSchema = z.strictObject({
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  rows: z.array(z.strictObject({ data: ModuleRecordDataSchema })).min(1).max(100),
  idempotency_key: ModuleIdempotencyKeySchema,
  // Legacy native CSV proposals may carry display/provenance labels. They
  // remain optional compatibility metadata, never authority for MCP callers.
  module_name: z.string().trim().min(1).max(160).optional(),
  collection_name: z.string().trim().min(1).max(160).optional(),
  source_file_name: z.string().trim().min(1).max(255).optional(),
});

export const MODULE_OPERATION_REQUEST_SCHEMAS = Object.freeze({
  module_list: ModuleListRequestSchema,
  module_schema_get: ModuleSchemaGetRequestSchema,
  module_record_search: ModuleRecordSearchRequestSchema,
  module_record_query: ModuleRecordQueryRequestSchema,
  module_record_get: ModuleRecordGetRequestSchema,
  module_record_incoming: ModuleRecordIncomingRequestSchema,
  module_record_latest_related: ModuleRecordGetRequestSchema,
  module_record_task_links: z.strictObject({
    resource_id: ModuleRecordResourceIdSchema,
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  module_record_create: ModuleRecordCreateRequestSchema,
  module_record_bulk_create: ModuleRecordBulkCreateRequestSchema,
  module_record_task_link: ModuleRecordTaskWriteRequestSchema,
  module_record_task_unlink: ModuleRecordTaskWriteRequestSchema,
  module_record_update: ModuleRecordUpdateRequestSchema,
  module_record_archive: ModuleRecordArchiveRequestSchema,
});

/**
 * Generate the transport contract from the same Zod parser that executes the
 * operation. Agent-facing transports require retry identity for every write,
 * including update/archive where older in-process callers may omit it.
 */
export function getModuleOperationInputJsonSchema(
  operation: ModuleOperationName,
  options?: { require_write_idempotency?: boolean },
): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(
    MODULE_OPERATION_REQUEST_SCHEMAS[operation],
    {
      target: 'draft-7',
      io: 'input',
      reused: 'inline',
      cycles: 'throw',
    },
  ) as Record<string, unknown>;
  if (options?.require_write_idempotency && MODULE_OPERATION_DEFINITIONS[operation].mode === 'write') {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === 'string')
        : [],
    );
    required.add('idempotency_key');
    schema.required = [...required];
  }
  return schema;
}

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ModuleSavedViewSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  installation_id: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  owner_user_id: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  name: ModuleDisplayNameSchema,
  config: ModuleSavedViewConfigSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

export const ModuleRecordReferenceSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  collection_key: ModuleKeySchema,
  label: z.string().max(MODULE_LIMITS.search_title_chars),
  subtitle: z.string().max(MODULE_LIMITS.search_subtitle_chars).optional(),
});

export const ModuleRelatedLatestResponseSchema = z.strictObject({
  summaries: z.array(z.strictObject({
    key: ModuleKeySchema, label: ModuleDisplayNameSchema, description: ModuleDescriptionSchema.optional(),
    date_type: z.enum(['date', 'datetime']),
    latest: z.strictObject({ record: ModuleRecordReferenceSchema, date: z.union([z.iso.date(), z.iso.datetime({ offset: true })]) }).nullable(),
  })).max(4),
});

export const ModuleRelationGroupSchema = z.strictObject({
  field_key: ModuleFieldKeySchema,
  records: z.array(ModuleRecordReferenceSchema).max(MODULE_LIMITS.relation_values_per_field),
});

export const ModuleMemberReferenceSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(OPAQUE_ID_PATTERN),
  label: z.string().max(500),
});

export const ModuleMemberGroupSchema = z.strictObject({
  field_key: ModuleFieldKeySchema,
  members: z.array(ModuleMemberReferenceSchema).max(MODULE_LIMITS.relation_values_per_field),
});

export const ModuleRecordSchema = z.strictObject({
  resource_id: ModuleRecordResourceIdSchema,
  id: OpaqueIdSchema,
  installation_id: OpaqueIdSchema,
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  manifest_digest: ModuleManifestDigestSchema,
  data: ModuleRecordDataSchema,
  relations: z.array(ModuleRelationGroupSchema).max(MODULE_LIMITS.fields_per_collection),
  members: z.array(ModuleMemberGroupSchema).max(MODULE_LIMITS.fields_per_collection),
  revision: ModuleExpectedRevisionSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  archived_at: IsoTimestampSchema.nullable(),
});

export const ModuleSummarySchema = z.strictObject({
  installation_id: OpaqueIdSchema,
  module_id: ModuleIdSchema,
  slug: ModuleSlugSchema,
  version: ModuleSemverSchema,
  manifest_digest: ModuleManifestDigestSchema,
  name: ModuleDisplayNameSchema,
  description: ModuleDescriptionSchema.optional(),
  icon: ModuleIconTokenSchema.optional(),
  enabled: z.boolean(),
  collections: z.array(z.strictObject({
    key: ModuleKeySchema,
    name: ModuleDisplayNameSchema,
    singular_name: ModuleDisplayNameSchema.optional(),
  })).max(MODULE_LIMITS.collections_per_module),
});

export const ModuleSearchHitSchema = z.strictObject({
  resource_id: ModuleRecordResourceIdSchema,
  record_id: OpaqueIdSchema,
  installation_id: OpaqueIdSchema,
  module_id: ModuleIdSchema,
  module_slug: ModuleSlugSchema,
  module_name: ModuleDisplayNameSchema,
  collection_key: ModuleKeySchema,
  collection_name: ModuleDisplayNameSchema,
  title: z.string().max(MODULE_LIMITS.search_title_chars),
  subtitle: z.string().max(MODULE_LIMITS.search_subtitle_chars).nullable(),
  snippet: z.string().max(MODULE_LIMITS.search_text_chars).nullable(),
  url: z.string().startsWith('/'),
  score: z.number().finite(),
  updated_at: IsoTimestampSchema,
});

export const ModuleMutationResultSchema = z.strictObject({
  resource_id: ModuleRecordResourceIdSchema,
  record_id: OpaqueIdSchema,
  installation_id: OpaqueIdSchema,
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  manifest_digest: ModuleManifestDigestSchema,
  revision: ModuleExpectedRevisionSchema,
  archived: z.boolean(),
  changed_fields: z
    .array(ModuleFieldKeySchema)
    .max(MODULE_LIMITS.fields_per_collection)
    .refine((fields) => new Set(fields).size === fields.length, 'Changed fields must be unique'),
  replayed: z.boolean(),
});

export const ModuleOperationContractSchema = z.strictObject({
  input_schema: z.record(z.string(), z.unknown()),
});

export const ModuleCollectionContractSchema = z.strictObject({
  collection_key: ModuleKeySchema,
  relation_fields: z.array(z.strictObject({
    field_key: ModuleFieldKeySchema,
    target_collection: ModuleKeySchema,
    cardinality: z.enum(['one', 'many']),
    required: z.boolean(),
    request_value_shape: z.literal('record_id[]'),
  })).max(MODULE_LIMITS.fields_per_collection),
  examples: z.strictObject({
    create: z.record(z.string(), z.unknown()),
    update: z.record(z.string(), z.unknown()),
  }),
});

export const MODULE_OPERATION_RESULT_SCHEMAS = Object.freeze({
  module_list: z.strictObject({ modules: z.array(ModuleSummarySchema) }),
  module_schema_get: z.strictObject({
    installation_id: OpaqueIdSchema,
    enabled: z.boolean(),
    manifest_digest: ModuleManifestDigestSchema,
    manifest: DeftModuleManifestSchema,
    operation_contracts: z.strictObject({
      module_record_create: ModuleOperationContractSchema,
      module_record_update: ModuleOperationContractSchema,
    }),
    collection_contracts: z.array(ModuleCollectionContractSchema).max(MODULE_LIMITS.collections_per_module),
  }),
  module_record_search: z.strictObject({
    items: z.array(ModuleSearchHitSchema),
    next_cursor: CursorSchema.nullable(),
  }),
  module_record_query: z.strictObject({
    items: z.array(ModuleRecordSchema),
    next_cursor: CursorSchema.nullable(),
  }),
  module_record_get: z.strictObject({ record: ModuleRecordSchema }),
  module_record_incoming: z.strictObject({ items: z.array(ModuleRecordSchema), next_cursor: CursorSchema.nullable() }),
  module_record_latest_related: ModuleRelatedLatestResponseSchema,
  module_record_task_links: z.strictObject({
    resource_id: ModuleRecordResourceIdSchema,
    tasks: z.array(z.strictObject({
      edge_id: z.string(), task_id: z.string(), title: z.string(), identifier: z.string().nullable(),
      status: z.string(), priority: z.string(), due_date: z.string().nullable(),
      assignee_id: z.string().nullable(), assignee_name: z.string().nullable(),
      project_id: z.string(), project_name: z.string(), url: z.string().startsWith('/'), created_at: IsoTimestampSchema,
    })).max(100),
    count: z.number().int().min(0).max(100),
    next_offset: z.number().int().nonnegative().nullable(),
  }),
  module_record_create: ModuleMutationResultSchema,
  module_record_bulk_create: z.strictObject({
    module_id: ModuleIdSchema,
    collection_key: ModuleKeySchema,
    status: z.enum(['completed', 'partial_failed']),
    requested: z.number().int().min(1).max(100),
    created: z.number().int().min(0).max(100),
    replayed: z.number().int().min(0).max(100),
    failed: z.number().int().min(0).max(1),
    failed_index: z.number().int().min(0).max(99).nullable(),
    resource_ids: z.array(ModuleRecordResourceIdSchema).max(100),
  }),
  module_record_task_link: z.strictObject({
    resource_id: ModuleRecordResourceIdSchema, task_id: OpaqueIdSchema, edge_id: OpaqueIdSchema, created: z.boolean(),
  }),
  module_record_task_unlink: z.strictObject({
    resource_id: ModuleRecordResourceIdSchema, task_id: OpaqueIdSchema, removed: z.boolean(),
  }),
  module_record_update: ModuleMutationResultSchema,
  module_record_archive: ModuleMutationResultSchema,
});

export type ModuleListRequest = z.infer<typeof ModuleListRequestSchema>;
export type ModuleSchemaGetRequest = z.infer<typeof ModuleSchemaGetRequestSchema>;
export type ModuleRecordSearchRequest = z.infer<typeof ModuleRecordSearchRequestSchema>;
export type ModuleRecordQueryRequest = z.infer<typeof ModuleRecordQueryRequestSchema>;
export type ModuleRecordGetRequest = z.infer<typeof ModuleRecordGetRequestSchema>;
export type ModuleRecordCreateRequest = Omit<
  z.infer<typeof ModuleRecordCreateRequestSchema>,
  'relations'
> & {
  /** Omitted by older in-process callers; parsed MCP/REST inputs always receive {}. */
  relations?: z.infer<typeof ModuleRelationPatchSchema>;
};
export type ModuleRecordUpdateRequest = Omit<
  z.infer<typeof ModuleRecordUpdateRequestSchema>,
  'relations'
> & {
  /** Omitted by older in-process callers; parsed MCP/REST inputs always receive {}. */
  relations?: z.infer<typeof ModuleRelationPatchSchema>;
};
export type ModuleRecordArchiveRequest = z.infer<typeof ModuleRecordArchiveRequestSchema>;
export type ModuleRecordBulkCreateRequest = z.infer<typeof ModuleRecordBulkCreateRequestSchema>;
export type ModuleRecord = z.infer<typeof ModuleRecordSchema>;
export type ModuleSummary = z.infer<typeof ModuleSummarySchema>;
export type ModuleSearchHit = z.infer<typeof ModuleSearchHitSchema>;
export type ModuleMutationResult = z.infer<typeof ModuleMutationResultSchema>;
export type ModuleSavedViewConfig = z.infer<typeof ModuleSavedViewConfigSchema>;
export type ModuleSavedViewCreateRequest = z.infer<typeof ModuleSavedViewCreateRequestSchema>;
export type ModuleSavedViewUpdateRequest = z.infer<typeof ModuleSavedViewUpdateRequestSchema>;
export type ModuleSavedView = z.infer<typeof ModuleSavedViewSchema>;
export type ModuleRecordReference = z.infer<typeof ModuleRecordReferenceSchema>;
export type ModuleRelationGroup = z.infer<typeof ModuleRelationGroupSchema>;
export type ModuleMemberReference = z.infer<typeof ModuleMemberReferenceSchema>;
export type ModuleMemberGroup = z.infer<typeof ModuleMemberGroupSchema>;
