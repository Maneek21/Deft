import { z } from 'zod';
import { parseNativeSafeComposeHtml, parseSafeComposeHtml } from './safe-compose-html.js';

/** Candidate public UI profiles. A declaration is not a host capability grant. */
export const DEFT_EXPERIENCE_CAPABILITIES_VERSION = 'deft.experience_capabilities.v1' as const;
export const DEFT_EXPERIENCE_VIEW_VERSION = 'deft.experience_view.v2' as const;
export const DEFT_RESOURCE_DOCUMENT_VERSION = 'deft.resource_document.v1' as const;
export const DEFT_EXPERIENCE_UI_BUDGETS = Object.freeze({
  richtext_characters: 256 * 1024, richtext_bytes: 480 * 1024,
  files: 32, file_bytes: 25 * 1024 * 1024, total_file_bytes: 25 * 1024 * 1024,
});
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// Existing workspace record IDs are opaque to authors; provider IDs/URLs are not locators.
const recordId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const DeftExperienceCapabilitySchema = z.enum([
  'menu.v1', 'resource_document.v1', 'richtext_field.v1', 'file_field.v1', 'resource_refresh.v1',
  'record_form.v1','record_form_seed.v1', 'record_form.v2','record_form.v3','repeated_fields.v1', 'record_document.v1','record_document_policy.v1','record_initial_change.v1','record_change_parameters.v1','record_form_presentation.v1','record_intake.mailto.v1','local_job.v1','keyboard_controls.v1','record_mirror.v1',
]);
export type DeftExperienceCapability = z.infer<typeof DeftExperienceCapabilitySchema>;
/** Refresh has a public declaration but no installable renderer adapter yet. */
export const DeftImplementedExperienceCapabilitySchema = DeftExperienceCapabilitySchema.exclude(['resource_refresh.v1']);
const capabilities = z.array(DeftExperienceCapabilitySchema).max(DeftExperienceCapabilitySchema.options.length)
  .refine(values => new Set(values).size === values.length, 'Capabilities must be unique');
export const DeftExperienceCapabilitiesSchema = z.strictObject({
  schema_version: z.literal(DEFT_EXPERIENCE_CAPABILITIES_VERSION),
  view_version: z.literal(DEFT_EXPERIENCE_VIEW_VERSION), capabilities,
});
export type DeftExperienceCapabilities = z.infer<typeof DeftExperienceCapabilitiesSchema>;
export const DeftExperienceCapabilityRequestSchema = z.strictObject({
  schema_version: z.literal(DEFT_EXPERIENCE_CAPABILITIES_VERSION),
  view_version: z.literal(DEFT_EXPERIENCE_VIEW_VERSION), required: capabilities, optional: capabilities,
}).refine(value => !value.required.some(capability => value.optional.includes(capability)),
  'Required and optional capabilities must be disjoint');
export type DeftExperienceCapabilityRequest = z.infer<typeof DeftExperienceCapabilityRequestSchema>;
/** Closed version negotiation: unsupported required profiles fail before mounting. */
export function negotiateDeftExperienceCapabilities(requestInput: unknown, hostInput: unknown): DeftExperienceCapabilities {
  const request = DeftExperienceCapabilityRequestSchema.parse(requestInput);
  const host = DeftExperienceCapabilitiesSchema.parse(hostInput);
  if (request.required.some(capability => !host.capabilities.includes(capability))) {
    throw new Error('EXPERIENCE_CAPABILITY_UNAVAILABLE');
  }
  return DeftExperienceCapabilitiesSchema.parse({ schema_version: DEFT_EXPERIENCE_CAPABILITIES_VERSION,
    view_version: host.view_version, capabilities: [...request.required,
      ...request.optional.filter(capability => host.capabilities.includes(capability))] });
}

/** The host resolves, sanitizes and presents this resource using the current session.
 * This node grants no network, remote-image, attachment or credential authority. */
export const DeftExperienceResourceDocumentNodeSchema = z.strictObject({
  kind: z.literal('resource_document'), id: nodeId,
  profile_version: z.literal(DEFT_RESOURCE_DOCUMENT_VERSION), resource_key: key, record_id: recordId,
  printable: z.boolean().optional(), print_control_id: nodeId.optional(),
}).refine(value => value.print_control_id === undefined || value.printable === true,
  'Linked print controls require printable documents');
export type DeftExperienceResourceDocumentNode = z.infer<typeof DeftExperienceResourceDocumentNodeSchema>;

/** Maximum declarations are reviewed with the package; they never widen host budgets.
 * Links and inline media use the selected closed profile, never a nativeLinks flag. */
export const DeftExperienceRichtextFieldProfileSchema = z.strictObject({
  profile_version: z.literal('deft.richtext_field.v1'),
  format: z.literal('safe_compose_html'),
  max_characters: z.number().int().positive().max(DEFT_EXPERIENCE_UI_BUDGETS.richtext_characters),
  max_bytes: z.number().int().positive().max(DEFT_EXPERIENCE_UI_BUDGETS.richtext_bytes),
  links: z.enum(['none', 'host_validated']), inline_images: z.enum(['none', 'host_files']),
});
export type DeftExperienceRichtextFieldProfile = z.infer<typeof DeftExperienceRichtextFieldProfileSchema>;
export const DeftExperienceFileFieldProfileSchema = z.strictObject({
  profile_version: z.literal('deft.file_field.v1'),
  max_files: z.number().int().positive().max(DEFT_EXPERIENCE_UI_BUDGETS.files),
  max_file_bytes: z.number().int().positive().max(DEFT_EXPERIENCE_UI_BUDGETS.file_bytes),
  max_total_bytes: z.number().int().positive().max(DEFT_EXPERIENCE_UI_BUDGETS.total_file_bytes),
  purpose: z.enum(['attachment', 'inline_raster']),
}).refine(value => value.max_file_bytes <= value.max_total_bytes, 'File limit exceeds total budget');
export type DeftExperienceFileFieldProfile = z.infer<typeof DeftExperienceFileFieldProfileSchema>;
export const DeftExperienceFileReferenceSchema = z.strictObject({ file_id: recordId });
export type DeftExperienceFileReference = z.infer<typeof DeftExperienceFileReferenceSchema>;

/** Implemented selection: the bridge and existing governed state/file custody
 * remain bounded independently of the larger declaration ceilings above. */
export const DEFT_EXPERIENCE_CONTROL_BUDGETS = Object.freeze({
  richtext_characters: 4096, richtext_bytes: 16384, draft_bytes: 16384,
  files: 8, file_bytes: 2 * 1024 * 1024, total_file_bytes: 8 * 1024 * 1024,
});
export const DeftExperienceRichtextValueSchema = z.strictObject({
  html: z.string().max(DEFT_EXPERIENCE_CONTROL_BUDGETS.richtext_characters),
  plain_text: z.string().max(DEFT_EXPERIENCE_CONTROL_BUDGETS.richtext_characters),
});
export const DeftExperienceRichtextFieldNodeSchema = z.strictObject({
  kind: z.literal('richtext_field'), id: nodeId, label: z.string().min(1).max(128),
  profile: DeftExperienceRichtextFieldProfileSchema,
  value: DeftExperienceRichtextValueSchema, disabled: z.boolean().optional(),
}).superRefine((node, ctx) => {
  const p = node.profile, v = node.value;
  try {
    if (p.max_characters > DEFT_EXPERIENCE_CONTROL_BUDGETS.richtext_characters
      || p.max_bytes > DEFT_EXPERIENCE_CONTROL_BUDGETS.richtext_bytes || p.inline_images !== 'none'
      || v.html.length > p.max_characters || v.plain_text.length > p.max_characters
      || new TextEncoder().encode(JSON.stringify(v)).byteLength > p.max_bytes) throw Error();
    if (v.html !== '') {
      const parse = p.links === 'host_validated' ? parseNativeSafeComposeHtml : parseSafeComposeHtml;
      if (parse(v.html, { maxCharacters: p.max_characters, maxBytes: p.max_bytes }).plainText !== v.plain_text) throw Error();
    } else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(v.plain_text)) throw Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'Unsupported richtext selection or mismatched HTML/plain pair' }); }
});
export type DeftExperienceRichtextFieldNode = z.infer<typeof DeftExperienceRichtextFieldNodeSchema>;
export const DeftExperienceFileFieldNodeSchema = z.strictObject({
  kind: z.literal('file_field'), id: nodeId, label: z.string().min(1).max(128),
  state_key: key, record_id: recordId, expected_revision: z.number().int().min(1).max(2147483646),
  profile: DeftExperienceFileFieldProfileSchema, disabled: z.boolean().optional(),
}).refine(node => node.profile.purpose === 'attachment'
  && node.profile.max_files <= DEFT_EXPERIENCE_CONTROL_BUDGETS.files
  && node.profile.max_file_bytes <= DEFT_EXPERIENCE_CONTROL_BUDGETS.file_bytes
  && node.profile.max_total_bytes <= DEFT_EXPERIENCE_CONTROL_BUDGETS.total_file_bytes,
  'Unsupported file custody selection');
export type DeftExperienceFileFieldNode = z.infer<typeof DeftExperienceFileFieldNodeSchema>;
export const DeftExperienceResourceRefreshNodeSchema = z.strictObject({
  kind: z.literal('resource_refresh'), id: nodeId, label: z.string().min(1).max(128),
  resource_key: key, record_id: recordId.optional(), disabled: z.boolean().optional(),
});
export type DeftExperienceResourceRefreshNode = z.infer<typeof DeftExperienceResourceRefreshNodeSchema>;

/** Refresh is an explicit runtime request, not an alias for rereading a saved row. */
export const DeftExperienceResourceRefreshRequestSchema = z.strictObject({
  schema_version: z.literal('deft.experience_resource_refresh.v1'), operation: z.literal('refresh'),
  record_id: recordId.optional(),
});
export type DeftExperienceResourceRefreshRequest = z.infer<typeof DeftExperienceResourceRefreshRequestSchema>;
export const DeftExperienceResourceFreshnessSchema = z.strictObject({
  schema_version: z.literal('deft.experience_resource_freshness.v1'),
  status: z.enum(['unknown', 'current', 'stale', 'refreshing', 'failed']),
  observed_at: z.iso.datetime().nullable(), revision: z.string().min(1).max(128).nullable(),
}).refine(value => value.status !== 'current' || value.observed_at !== null,
  'Current data requires a host observation time');
export type DeftExperienceResourceFreshness = z.infer<typeof DeftExperienceResourceFreshnessSchema>;
