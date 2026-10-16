import { z } from 'zod';
import { parseRuntimeObjectInput, RuntimeObjectSchema } from './runtime-authoring.js';

/** Pure candidate contracts. A host must separately review the descriptor and
 * pin an App/version/grant/owner/Runtime binding before admitting a sync Run. */
export const RESOURCE_SYNC_VERSIONS = Object.freeze({
  descriptor: 'deft.app_sync_descriptor.v1',
  request: 'deft.app_sync_request.v1',
  page: 'deft.app_sync_page.v1',
} as const);

export const RESOURCE_SYNC_LIMITS = Object.freeze({
  items_per_page: 100,
  page_bytes: 512 * 1024,
  cursor_bytes: 2_048,
  record_fields: 32,
  label_chars: 200,
  resource_type_chars: 64,
  resource_id_chars: 256,
  revision_chars: 128,
} as const);

const controls = /[\u0000-\u001f\u007f]/u;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const key = z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/u)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
function exactIdentity(max: number, pattern = opaque) {
  return z.string().min(1).max(max)
    .refine((value) => value === value.trim() && !controls.test(value))
    .regex(pattern);
}
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function validUnicode(value: string): boolean {
  return new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) === value;
}

const resourceType = exactIdentity(RESOURCE_SYNC_LIMITS.resource_type_chars,
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
const resourceId = exactIdentity(RESOURCE_SYNC_LIMITS.resource_id_chars);
const revision = exactIdentity(RESOURCE_SYNC_LIMITS.revision_chars);
const cursor = z.string().min(1)
  .refine((value) => value.length <= RESOURCE_SYNC_LIMITS.cursor_bytes
    && !controls.test(value) && validUnicode(value)
    && utf8Bytes(value) <= RESOURCE_SYNC_LIMITS.cursor_bytes,
  'Cursor must be valid UTF-8 without controls and at most 2,048 bytes');

export const SyncDescriptorV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_SYNC_VERSIONS.descriptor),
  key,
  runtime_requirement_key: key,
  resource_type: resourceType,
  requested_visibility: z.literal('user_private'),
  record_schema: RuntimeObjectSchema,
  label_field: key,
}).superRefine((descriptor, ctx) => {
  const field = descriptor.record_schema.properties[descriptor.label_field];
  if (!field || field.type !== 'string' || field.maxLength > RESOURCE_SYNC_LIMITS.label_chars
    || !descriptor.record_schema.required.includes(descriptor.label_field)) {
    ctx.addIssue({ code: 'custom', path: ['label_field'],
      message: 'Label field must be a required bounded string of at most 200 characters' });
  }
});
export type SyncDescriptorV1 = z.infer<typeof SyncDescriptorV1Schema>;

export const SyncRequestV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_SYNC_VERSIONS.request),
  cursor: cursor.nullable(),
  max_items: z.number().int().min(1).max(RESOURCE_SYNC_LIMITS.items_per_page),
});
export type SyncRequestV1 = z.infer<typeof SyncRequestV1Schema>;

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const data = z.record(key, scalar).refine(
  (value) => Object.keys(value).length <= RESOURCE_SYNC_LIMITS.record_fields,
  'Record has too many scalar fields',
);
const upsert = z.strictObject({ id: resourceId, revision, data });
const tombstone = z.strictObject({ id: resourceId, revision });
export const SyncPageV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_SYNC_VERSIONS.page),
  upserts: z.array(upsert).max(RESOURCE_SYNC_LIMITS.items_per_page),
  tombstones: z.array(tombstone).max(RESOURCE_SYNC_LIMITS.items_per_page),
  next_cursor: cursor.nullable(),
  has_more: z.boolean(),
}).superRefine((page, ctx) => {
  if (page.upserts.length + page.tombstones.length > RESOURCE_SYNC_LIMITS.items_per_page) {
    ctx.addIssue({ code: 'custom', path: ['upserts'], message: 'Sync page has too many items' });
  }
  const seen = new Set<string>();
  for (const [kind, rows] of [['upserts', page.upserts], ['tombstones', page.tombstones]] as const) {
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.id)) ctx.addIssue({ code: 'custom', path: [kind, index, 'id'],
        message: 'Sync page resource IDs must be unique across all items' });
      seen.add(row.id);
    }
  }
});
export type SyncPageV1 = z.infer<typeof SyncPageV1Schema>;

/** Stable serialized bytes for the page ceiling and a future host digest.
 * This checks page shape; callers still need parseSyncPage's reviewed schema. */
export function canonicalSyncPageJson(pageValue: unknown): string {
  const page = SyncPageV1Schema.parse(pageValue);
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value).sort().map((name) =>
      `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`).join(',')}}`;
  };
  return canonical(page);
}

export function parseSyncDescriptor(value: unknown): SyncDescriptorV1 {
  return SyncDescriptorV1Schema.parse(value);
}
export function parseSyncRequest(value: unknown): SyncRequestV1 {
  return SyncRequestV1Schema.parse(value);
}

/** Page shape is provider input; this parser needs the reviewed descriptor and
 * exact host-created starting request. Neither can be nominated by the page. */
export function parseSyncPage(
  descriptorValue: unknown,
  requestValue: unknown,
  pageValue: unknown,
): SyncPageV1 {
  const descriptor = parseSyncDescriptor(descriptorValue);
  const request = parseSyncRequest(requestValue);
  const page = SyncPageV1Schema.parse(pageValue);
  if (page.upserts.length + page.tombstones.length > request.max_items) {
    throw new TypeError('Sync page exceeds the requested item limit');
  }
  if (page.has_more && (page.next_cursor === null || page.next_cursor === request.cursor)) {
    throw new TypeError('Sync page must advance its cursor when more pages remain');
  }
  for (const row of page.upserts) {
    row.data = parseRuntimeObjectInput(descriptor.record_schema, row.data);
    if (Object.values(row.data).some((value) => typeof value === 'string' && !validUnicode(value))) {
      throw new TypeError('Sync record contains malformed Unicode');
    }
    const label = row.data[descriptor.label_field];
    if (typeof label !== 'string' || !validUnicode(label)
      || label.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().length === 0) {
      throw new TypeError('Sync record label normalizes to empty');
    }
  }
  if (utf8Bytes(canonicalSyncPageJson(page)) > RESOURCE_SYNC_LIMITS.page_bytes) {
    throw new TypeError('Sync page exceeds 512 KiB');
  }
  return page;
}
