import { z } from 'zod';
import { RuntimeObjectSchema } from './runtime-authoring.js';
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)
  .refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
/** Additional current document disclosure, reviewed separately from saved
 * scalar metadata. Provider and account selection remain host-owned. */
export const ResourceContentPolicySchema = z.strictObject({
  document: z.strictObject({ max_characters: z.number().int().min(1).max(16384),
    formats: z.array(z.enum(['plain','html'])).min(1).max(2).refine(values => new Set(values).size === values.length).optional(),
    metadata_schema: RuntimeObjectSchema.optional() }),
  source: z.strictObject({media_type:z.literal('message/rfc822'),filename:z.literal('message.eml'),max_bytes:z.number().int().min(1).max(8388608)}).optional(),
  triage_options: z.strictObject({max_options:z.number().int().min(1).max(100)}).optional(),
  search_filters:z.array(z.enum(['text','from','to','cc','bcc','subject','filename','has_attachments','received_on','after','before','unread','flagged'])).min(1).max(13).refine(rows=>new Set(rows).size===rows.length).optional(),
});
export const ResourceContentDeclarationSchema = z.strictObject({ resource_key: key, ...ResourceContentPolicySchema.shape });
export const ResourceContentDeclarationsSchema = z.array(ResourceContentDeclarationSchema).min(1).max(16)
  .refine(rows => rows.every((row, index) => !index || rows[index - 1]!.resource_key < row.resource_key),
    'Resource content declarations must be unique and sorted');
export type ResourceContentPolicy = z.infer<typeof ResourceContentPolicySchema>;
