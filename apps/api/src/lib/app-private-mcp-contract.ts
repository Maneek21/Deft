import { z } from 'zod';
import { AppRuntimeResourceRefV2Schema } from '@deft/shared';
import { HumanAccessSnapshot, HumanAccessOperations } from './app-resource-access-contract.js';

// Closed wire DTOs only. This file creates no principal, credential, grant or live authority.
export const PRIVATE_MCP_TOOL_NAMES = [
  'app_private_resource_read',
  'app_private_resource_search',
  'app_private_resource_cite',
] as const;
export const PRIVATE_MCP_WIRE_LIMITS = Object.freeze({ input_bytes: 16384, result_bytes: 65536, hits: 25, snippet_chars: 240 });
export const PRIVATE_MCP_GRANT_MS = 15 * 60 * 1000;
const uuid = z.string().uuid();
const expiry = z.string().datetime({ offset: true });
const fields = z.array(z.string().min(1).max(48)).min(1).max(32).refine(value => new Set(value).size === value.length);
const opaque = z.string().min(1).max(2048);
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const data = z.record(z.string().min(1).max(48), scalar).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 32);
const label = z.literal('Private App record');

export const PrivateMcpDestination = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal_mcp'), token_id: uuid }),
  z.strictObject({ kind: z.literal('employee_mcp'), token_id: uuid }),
]);
export const PrivateMcpReviewInput = z.strictObject({
  schema_version: z.literal('deft.app_private_mcp_review.v1'),
  ref: AppRuntimeResourceRefV2Schema, destination: PrivateMcpDestination,
  field_keys: fields, operations: HumanAccessOperations, expires_at: expiry,
});
export const PrivateMcpGrantSnapshot = HumanAccessSnapshot.omit({
  schema_version: true, purpose: true, recipient_user_id: true, recipient_label: true,
}).extend({
  schema_version: z.literal('deft.app_private_mcp_snapshot.v1'),
  purpose: z.literal('mcp_private_context'), destination: PrivateMcpDestination,
  subject_user_id: uuid, employee_id: uuid.nullable(),
  token_authorization_version: z.number().int().positive(),
  token_hash_digest: z.string().regex(/^[a-f0-9]{64}$/),
  scope_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  subject_membership_authorization_version: z.number().int().positive(),
  employee_authorization_version: z.number().int().positive().nullable(),
  token_label: z.string().max(200), subject_label: z.string().max(200),
}).refine(s => s.destination.kind === 'personal_mcp'
  ? s.employee_id === null && s.employee_authorization_version === null
  : s.employee_id !== null && s.employee_authorization_version !== null);
export type PrivateMcpSnapshot = z.infer<typeof PrivateMcpGrantSnapshot>;
export const PrivateMcpReviewResponse = z.strictObject({
  snapshot: PrivateMcpGrantSnapshot,
  selected_data: data,
  custody_notice: z.literal('Anyone holding this exact credential may receive these fields in an external MCP client. Revocation stops future Deft access and cannot recall copies already delivered.'),
  review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  review_token: z.string().min(1).max(16384),
});

export const PrivateMcpReadInput = z.union([
  z.strictObject({ schema_version: z.literal('deft.app_private_mcp_read.v1'), grant_id: uuid }),
  z.strictObject({ schema_version: z.literal('deft.app_private_mcp_read.v1'), citation_token: opaque }),
]);
export const PrivateMcpSearchInput = z.strictObject({
  schema_version: z.literal('deft.app_private_mcp_search.v1'), grant_id: uuid,
  query: z.string().min(1).max(200), field_keys: fields, cursor: opaque.optional(),
});
export const PrivateMcpCiteInput = z.strictObject({ schema_version: z.literal('deft.app_private_mcp_cite.v1'), grant_id: uuid });
export const PrivateMcpCitationPayload = z.strictObject({ grant_id: uuid, scope_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), expires_at: expiry });
export const PrivateMcpSearchCursor = z.strictObject({
  scope_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), checkpoint_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  cutoff: z.string().regex(/^[0-9]+$/), after: z.string().regex(/^[0-9]+$/), expires_at: expiry,
});
export const PrivateMcpInventoryInput = z.strictObject({ app_installation_id: uuid, cursor: opaque.optional() });
export const PrivateMcpInventoryCursor = z.strictObject({
  org_id: uuid, owner_user_id: uuid, sid: uuid, app_installation_id: uuid,
  cutoff: z.string().regex(/^[0-9]+$/), after: z.string().regex(/^[0-9]+$/), expires_at: expiry,
});

export const PrivateMcpReadOutput = z.strictObject({
  schema_version: z.literal('deft.app_private_mcp_record.v1'), grant_id: uuid,
  label, data, freshness: z.literal('unknown'), expires_at: expiry,
});
export const PrivateMcpSearchOutput = z.strictObject({
  schema_version: z.literal('deft.app_private_mcp_search_page.v1'),
  hits: z.array(z.strictObject({ grant_id: uuid, label,
    snippets: z.record(z.string().min(1).max(48), z.string().max(PRIVATE_MCP_WIRE_LIMITS.snippet_chars))
      .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 32),
  })).max(PRIVATE_MCP_WIRE_LIMITS.hits),
  next_cursor: opaque.nullable(), complete: z.boolean(), expires_at: expiry,
}).refine(value => value.complete === (value.next_cursor === null));
export const PrivateMcpCiteOutput = z.strictObject({
  schema_version: z.literal('deft.app_private_mcp_citation.v1'),
  citation_token: opaque, label, freshness: z.literal('unknown'), expires_at: expiry,
});
export const PrivateMcpOutput = z.union([PrivateMcpReadOutput, PrivateMcpSearchOutput, PrivateMcpCiteOutput]);

export function encodePrivateMcpToolResult(raw: unknown) {
  const value = PrivateMcpOutput.parse(raw);
  const result = { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > PRIVATE_MCP_WIRE_LIMITS.result_bytes) {
    throw new RangeError('Private MCP result exceeds its whole-envelope bound');
  }
  return result;
}
