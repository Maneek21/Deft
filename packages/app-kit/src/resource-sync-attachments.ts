import { z } from 'zod';
import {
  parseSyncPage, RESOURCE_SYNC_LIMITS, SyncDescriptorV1Schema, SyncPageV1Schema, SyncRequestV1Schema,
} from './resource-sync.js';

/** New candidate contracts. Descriptor1/page1 and channel2 remain closed. */
export const RESOURCE_ATTACHMENT_LIMITS = Object.freeze({
  attachment_bytes: 2 * 1024 * 1024, attachments_per_record: 8, attachments_per_run: 32,
  attachment_bytes_per_run: 8 * 1024 * 1024, retention_days: 30, header_bytes: 8192,
  filename_scalars: 200, filename_bytes: 800, transfer_ms: 10_000, concurrent_transfers: 2,
  stage_lifetime_ms: 60 * 60 * 1000,
} as const);
export const AttachmentMediaTypeSchema = z.enum([
  'text/plain', 'text/csv', 'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);
export const AttachmentPolicySchema = z.strictObject({
  max_attachment_bytes: z.number().int().min(1).max(RESOURCE_ATTACHMENT_LIMITS.attachment_bytes),
  max_attachments_per_record: z.number().int().min(1).max(RESOURCE_ATTACHMENT_LIMITS.attachments_per_record),
  max_attachments_per_run: z.number().int().min(1).max(RESOURCE_ATTACHMENT_LIMITS.attachments_per_run),
  max_attachment_bytes_per_run: z.number().int().min(1).max(RESOURCE_ATTACHMENT_LIMITS.attachment_bytes_per_run),
  retention_days: z.number().int().min(1).max(RESOURCE_ATTACHMENT_LIMITS.retention_days),
  allowed_media_types: z.array(AttachmentMediaTypeSchema).min(1).max(7)
    .refine(value => new Set(value).size === value.length, 'Media types must be unique'),
});
export type AttachmentPolicy = z.infer<typeof AttachmentPolicySchema>;
export const SyncDescriptorV2Schema = z.strictObject({
  ...SyncDescriptorV1Schema.shape, schema_version: z.literal('deft.app_sync_descriptor.v2'),
  attachments: AttachmentPolicySchema,
}).superRefine((value, ctx) => {
  const { attachments: _attachments, ...scalar } = value;
  const parsed = SyncDescriptorV1Schema.safeParse({ ...scalar, schema_version: 'deft.app_sync_descriptor.v1' });
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export type SyncDescriptorV2 = z.infer<typeof SyncDescriptorV2Schema>;
export const SyncRequestV2Schema = z.strictObject({
  ...SyncRequestV1Schema.shape, schema_version: z.literal('deft.app_sync_request.v2'),
  attachments: AttachmentPolicySchema,
});
export type SyncRequestV2 = z.infer<typeof SyncRequestV2Schema>;
const attachmentKey = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const SyncAttachmentLinkSchema = z.strictObject({ attachment_key: attachmentKey, staging_id: z.uuid() });
export const SyncPageV2Schema = z.strictObject({
  ...SyncPageV1Schema.shape, schema_version: z.literal('deft.app_sync_page.v2'),
  upserts: z.array(SyncPageV1Schema.shape.upserts.element.extend({
    attachments: z.array(SyncAttachmentLinkSchema).max(RESOURCE_ATTACHMENT_LIMITS.attachments_per_record),
  })).max(RESOURCE_SYNC_LIMITS.items_per_page),
}).superRefine((value, ctx) => {
  const scalar = SyncPageV1Schema.safeParse({ ...value, schema_version: 'deft.app_sync_page.v1',
    upserts: value.upserts.map(({ attachments: _attachments, ...row }) => row) });
  if (!scalar.success) for (const issue of scalar.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  const stages = new Set<string>();
  value.upserts.forEach((row, index) => {
    if (new Set(row.attachments.map(item => item.attachment_key)).size !== row.attachments.length) {
      ctx.addIssue({ code: 'custom', path: ['upserts', index, 'attachments'], message: 'Attachment keys must be unique per parent' });
    }
    for (const item of row.attachments) {
      if (stages.has(item.staging_id)) ctx.addIssue({ code: 'custom', path: ['upserts', index, 'attachments'], message: 'Stage may occur only once per page' });
      stages.add(item.staging_id);
    }
  });
});
export type SyncPageV2 = z.infer<typeof SyncPageV2Schema>;

export function canonicalAttachmentJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAttachmentJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAttachmentJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function parseSyncPageV2(descriptorValue: unknown, requestValue: unknown, pageValue: unknown): SyncPageV2 {
  const descriptor = SyncDescriptorV2Schema.parse(descriptorValue);
  const request = SyncRequestV2Schema.parse(requestValue);
  const page = SyncPageV2Schema.parse(pageValue);
  for (const name of ['max_attachment_bytes', 'max_attachments_per_record', 'max_attachments_per_run',
    'max_attachment_bytes_per_run', 'retention_days'] as const) {
    if (request.attachments[name] > descriptor.attachments[name]) throw new TypeError('Host attachment policy exceeds descriptor');
  }
  if (request.attachments.allowed_media_types.some(type => !descriptor.attachments.allowed_media_types.includes(type))) {
    throw new TypeError('Host attachment media policy exceeds descriptor');
  }
  const { attachments: _descriptorAttachments, ...scalarDescriptor } = descriptor;
  parseSyncPage({ ...scalarDescriptor, schema_version: 'deft.app_sync_descriptor.v1' },
    { schema_version: 'deft.app_sync_request.v1', cursor: request.cursor, max_items: request.max_items },
    { ...page, schema_version: 'deft.app_sync_page.v1', upserts: page.upserts.map(({ attachments: _attachments, ...row }) => row) });
  if (page.upserts.some(row => row.attachments.length > request.attachments.max_attachments_per_record)
    || page.upserts.reduce((total, row) => total + row.attachments.length, 0) > request.attachments.max_attachments_per_run) {
    throw new TypeError('Sync page exceeds reviewed attachment count');
  }
  if (new TextEncoder().encode(canonicalAttachmentJson(page)).byteLength > RESOURCE_SYNC_LIMITS.page_bytes) {
    throw new TypeError('Sync page exceeds 512 KiB');
  }
  return page;
}
export async function digestResourceSyncDescriptorV2(value: unknown): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    canonicalAttachmentJson(SyncDescriptorV2Schema.parse(value))));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const AttachmentFilenameSchema = z.string().min(1).refine(value =>
  Array.from(value).length <= RESOURCE_ATTACHMENT_LIMITS.filename_scalars
  && new TextEncoder().encode(value).byteLength <= RESOURCE_ATTACHMENT_LIMITS.filename_bytes
  && new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) === value
  && !/[\u0000-\u001f\u007f/\\]/u.test(value), 'Filename must be bounded valid Unicode without controls or paths');
export const AttachmentStageHeaderSchema = z.strictObject({
  schema_version: z.literal('deft.app_sync_attachment_stage.v1'),
  channel_version: z.literal('deft.app_runtime_channel.v3'), audience: z.literal('app_resource_sync'),
  session_id: z.uuid(), run_id: z.uuid(), attempt_id: z.uuid(), claim_token: z.uuid(),
  sequence: z.number().int().positive().max(2_147_483_647),
  parent_resource_id: SyncPageV1Schema.shape.upserts.element.shape.id,
  parent_revision: SyncPageV1Schema.shape.upserts.element.shape.revision,
  attachment_key: attachmentKey, filename: AttachmentFilenameSchema,
  declared_media_type: AttachmentMediaTypeSchema,
  declared_size_bytes: z.number().int().nonnegative().max(RESOURCE_ATTACHMENT_LIMITS.attachment_bytes),
});
export type AttachmentStageHeader = z.infer<typeof AttachmentStageHeaderSchema>;
export const AttachmentStagedReplySchema = z.strictObject({
  schema_version: z.literal('deft.app_sync_attachment_staged.v1'), staging_id: z.uuid(),
  state: z.enum(['ready', 'blocked']), size_bytes: z.number().int().nonnegative().max(RESOURCE_ATTACHMENT_LIMITS.attachment_bytes),
});
export type AttachmentStagedReply = z.infer<typeof AttachmentStagedReplySchema>;

/** Exactly framed bytes; tokens occur only in the HTTP Authorization header. */
export function frameResourceSyncAttachment(headerValue: unknown, bytes: Uint8Array): Uint8Array {
  const header = AttachmentStageHeaderSchema.parse(headerValue);
  if (header.declared_size_bytes !== bytes.byteLength) throw new TypeError('Attachment size does not match header');
  const encoded = new TextEncoder().encode(canonicalAttachmentJson(header));
  if (encoded.byteLength > RESOURCE_ATTACHMENT_LIMITS.header_bytes) throw new TypeError('Attachment header exceeds 8 KiB');
  const result = new Uint8Array(4 + encoded.byteLength + bytes.byteLength);
  new DataView(result.buffer).setUint32(0, encoded.byteLength, false);
  result.set(encoded, 4); result.set(bytes, 4 + encoded.byteLength);
  return result;
}
