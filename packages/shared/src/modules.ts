import { z } from 'zod';
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
]);

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

export const ModuleViewSchema = z.strictObject({
  key: ModuleKeySchema,
  name: ModuleDisplayNameSchema,
  type: z.enum(['table', 'form', 'detail']),
  fields: z.array(ModuleFieldKeySchema).min(1).max(MODULE_LIMITS.fields_per_view),
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
  if (field.default === undefined) return;

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

export const ModuleCollectionSchema = z
  .strictObject({
    key: ModuleKeySchema,
    name: ModuleDisplayNameSchema,
    singular_name: ModuleDisplayNameSchema.optional(),
    description: ModuleDescriptionSchema.optional(),
    fields: z.array(ModuleFieldSchema).min(1).max(MODULE_LIMITS.fields_per_collection),
    search: ModuleSearchSchema.optional(),
    views: z.array(ModuleViewSchema).max(MODULE_LIMITS.views_per_collection).optional(),
  })
  .superRefine((collection, ctx) => {
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
      if (titleField && !titleField.required && titleField.default === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['search', 'title_field'],
          message: 'Search title_field must be required or have a default',
        });
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
      });
    }
  });

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
  })
  .superRefine((manifest, ctx) => {
    addDuplicateIssues(
      manifest.collections.map((collection) => collection.key),
      ['collections'],
      ctx,
      'Collection keys',
    );
  });

export type DeftModuleManifestV1 = z.infer<typeof DeftModuleManifestV1Schema>;
export type DeftModuleManifestV1Input = z.input<typeof DeftModuleManifestV1Schema>;
export type ModuleCollection = z.infer<typeof ModuleCollectionSchema>;
export type ModuleField = z.infer<typeof ModuleFieldSchema>;
export type ModuleView = z.infer<typeof ModuleViewSchema>;

export function parseDeftModuleManifest(value: unknown): DeftModuleManifestV1 {
  return DeftModuleManifestV1Schema.parse(value);
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
  field: ModuleField,
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
  }
}

export function validateModuleRecordData(
  manifestValue: unknown,
  collectionKey: string,
  dataValue: unknown,
): ModuleRecordValidationResult {
  const manifest = parseDeftModuleManifest(manifestValue);
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
    if (value === undefined && field.default !== undefined) {
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

function fieldProjectionText(field: ModuleField, value: ModuleRecordFieldValue | undefined): string {
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
  const manifest = parseDeftModuleManifest(manifestValue);
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
  'module_record_create',
  'module_record_update',
  'module_record_archive',
] as const;

export const ModuleOperationNameSchema = z.enum(MODULE_OPERATION_NAMES);
export type ModuleOperationName = z.infer<typeof ModuleOperationNameSchema>;

export const MODULE_OPERATION_DEFINITIONS = Object.freeze({
  module_list: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_schema_get: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_search: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_query: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_get: { mode: 'read', approval_tier: 'auto', destructive: false },
  module_record_create: { mode: 'write', approval_tier: 'quick', destructive: false },
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
  z.array(z.string()).max(MODULE_LIMITS.select_options_per_field),
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
    operator: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in']),
    value: ModuleRecordFieldValueSchema,
  })
  .superRefine((filter, ctx) => {
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

export const ModuleRecordQueryRequestSchema = z.strictObject({
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  filters: z.array(ModuleQueryFilterSchema).max(16).default([]),
  sort: ModuleQuerySortSchema.optional(),
  limit: PageLimitSchema,
  cursor: CursorSchema.optional(),
});

export const ModuleRecordGetRequestSchema = z.strictObject({ record_id: OpaqueIdSchema });
export const ModuleRecordCreateRequestSchema = z.strictObject({
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  data: ModuleRecordDataSchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema,
});
export const ModuleRecordUpdateRequestSchema = z
  .strictObject({
    record_id: OpaqueIdSchema,
    patch: ModuleRecordDataSchema.default({}),
    unset_fields: z.array(ModuleFieldKeySchema).max(MODULE_LIMITS.fields_per_collection).default([]),
    expected_revision: ModuleExpectedRevisionSchema,
    expected_manifest_digest: ModuleManifestDigestSchema,
    idempotency_key: ModuleIdempotencyKeySchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (Object.keys(input.patch).length === 0 && input.unset_fields.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'Update must patch or unset at least one field',
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

export const MODULE_OPERATION_REQUEST_SCHEMAS = Object.freeze({
  module_list: ModuleListRequestSchema,
  module_schema_get: ModuleSchemaGetRequestSchema,
  module_record_search: ModuleRecordSearchRequestSchema,
  module_record_query: ModuleRecordQueryRequestSchema,
  module_record_get: ModuleRecordGetRequestSchema,
  module_record_create: ModuleRecordCreateRequestSchema,
  module_record_update: ModuleRecordUpdateRequestSchema,
  module_record_archive: ModuleRecordArchiveRequestSchema,
});

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const ModuleRecordSchema = z.strictObject({
  resource_id: ModuleRecordResourceIdSchema,
  id: OpaqueIdSchema,
  installation_id: OpaqueIdSchema,
  module_id: ModuleIdSchema,
  collection_key: ModuleKeySchema,
  manifest_digest: ModuleManifestDigestSchema,
  data: ModuleRecordDataSchema,
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

export const MODULE_OPERATION_RESULT_SCHEMAS = Object.freeze({
  module_list: z.strictObject({ modules: z.array(ModuleSummarySchema) }),
  module_schema_get: z.strictObject({
    installation_id: OpaqueIdSchema,
    enabled: z.boolean(),
    manifest_digest: ModuleManifestDigestSchema,
    manifest: DeftModuleManifestV1Schema,
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
  module_record_create: ModuleMutationResultSchema,
  module_record_update: ModuleMutationResultSchema,
  module_record_archive: ModuleMutationResultSchema,
});

export type ModuleListRequest = z.infer<typeof ModuleListRequestSchema>;
export type ModuleSchemaGetRequest = z.infer<typeof ModuleSchemaGetRequestSchema>;
export type ModuleRecordSearchRequest = z.infer<typeof ModuleRecordSearchRequestSchema>;
export type ModuleRecordQueryRequest = z.infer<typeof ModuleRecordQueryRequestSchema>;
export type ModuleRecordGetRequest = z.infer<typeof ModuleRecordGetRequestSchema>;
export type ModuleRecordCreateRequest = z.infer<typeof ModuleRecordCreateRequestSchema>;
export type ModuleRecordUpdateRequest = z.infer<typeof ModuleRecordUpdateRequestSchema>;
export type ModuleRecordArchiveRequest = z.infer<typeof ModuleRecordArchiveRequestSchema>;
export type ModuleRecord = z.infer<typeof ModuleRecordSchema>;
export type ModuleSummary = z.infer<typeof ModuleSummarySchema>;
export type ModuleSearchHit = z.infer<typeof ModuleSearchHitSchema>;
export type ModuleMutationResult = z.infer<typeof ModuleMutationResultSchema>;
