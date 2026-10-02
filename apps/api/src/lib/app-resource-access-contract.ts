import { z } from "zod";
import { AppRuntimeResourceRefV2Schema } from "@deft/shared";
export const ACCESS_LIMITS = Object.freeze({
  review_ms: 300000,
  grant_ms: 86400000,
  fields: 32,
  bytes: 65536,
  inventory: 25,
  search_candidates: 100,
  search_hits: 25,
  owner_active: 256,
  recipient_active: 512,
  owner_retained: 4096,
  recipient_retained: 8192,
  retention_ms: 2592000000,
  prune: 100
});
const uuid = z.string().uuid().transform(v => v.toLowerCase()), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), time = z.string().datetime();
export const HumanAccessOperations = z.array(z.enum(["cite", "read", "search"])).min(1).max(3).refine(v => v.every((x, i) => !i || v[i - 1]! < x));
export const HumanAccessReviewInput = z.strictObject({
  schema_version: z.literal("deft.app_resource_access_review.v1"),
  ref: AppRuntimeResourceRefV2Schema,
  destination: z.strictObject({ kind: z.literal("human"), user_id: uuid }),
  operations: HumanAccessOperations,
  field_keys: z.array(z.string().min(1).max(48)).min(1).max(32).refine(v => new Set(v).size === v.length),
  expires_at: time
});
export const HumanAccessSnapshot = z.strictObject({
  schema_version: z.literal("deft.app_resource_access_snapshot.v1"),
  purpose: z.literal("human_view"),
  org_id: uuid,
  owner_user_id: uuid,
  recipient_user_id: uuid,
  app_installation_id: uuid,
  app_version_id: uuid,
  grant_snapshot_id: uuid,
  lifecycle_epoch: z.number().int().nonnegative(),
  grant_epoch: z.number().int().nonnegative(),
  registration_id: uuid,
  operator_user_id: uuid,
  runtime_epoch: z.number().int().positive(),
  resource_binding_id: uuid,
  descriptor_digest: digest,
  checkpoint_id: uuid,
  generation: z.number().int().positive(),
  ref: AppRuntimeResourceRefV2Schema,
  revision_digest: digest,
  content_digest: digest,
  operations: HumanAccessOperations,
  field_keys: z.array(z.string().min(1).max(48)).min(1).max(32).refine(v => v.every((x, i) => !i || v[i - 1]! < x)),
  app_label: z.string().max(200),
  recipient_label: z.string().max(200),
  expires_at: time,
  review_expires_at: time
});
export type AccessSnapshot = z.infer<typeof HumanAccessSnapshot>;
export const HumanAccessReviewResponse = z.strictObject({
  snapshot: HumanAccessSnapshot,
  record_label: z.string().max(200),
  selected_data: z.record(z.string().min(1).max(48), z.union([z.string(), z.number().finite(), z.boolean()])),
  review_digest: digest,
  review_token: z.string().max(16384)
});
export const HumanAccessAccept = z.strictObject({ review_token: z.string().min(1).max(16384), review_digest: digest, accept_access: z.literal(true) });
export class PrivateResourceAccessError extends Error {
  constructor(readonly code: "APP_RESOURCE_ACCESS_UNAVAILABLE" | "APP_RESOURCE_ACCESS_STALE" | "APP_RESOURCE_ACCESS_LIMIT" | "APP_RESOURCE_ACCESS_TOO_LARGE", readonly status: 404 | 409 | 413 = 404) {
    super(code);
  }
}
export const accessUnavailable = () => new PrivateResourceAccessError("APP_RESOURCE_ACCESS_UNAVAILABLE");
export const HumanAccessInventoryInput = z.strictObject({ view: z.enum(["received", "owned"]).default("received"), app_installation_id: uuid.optional(), cursor: z.string().max(4096).nullable().default(null) }).refine(v => v.view === "owned" ? !!v.app_installation_id : !v.app_installation_id);
export const HumanAccessInventoryCursor = z.strictObject({
  schema_version: z.literal("deft.app_resource_access_inventory_cursor.v1"),
  org_id: uuid,
  user_id: uuid,
  sid: uuid,
  view: z.enum(["received", "owned"]),
  app_installation_id: uuid.nullable(),
  cutoff: z.string().regex(/^[0-9]+$/),
  after: z.string().regex(/^[0-9]+$/),
  expires_at: time
});
export const HumanAccessCursor = z.strictObject({
  schema_version: z.literal("deft.app_resource_access_cursor.v1"),
  org_id: uuid,
  recipient_user_id: uuid,
  sid: uuid,
  cutoff: z.string().regex(/^[0-9]+$/),
  after: z.string().regex(/^[0-9]+$/),
  expires_at: time
});
export const HumanAccessSearchInput = z.strictObject({ query: z.string().min(1).max(200), field_keys: z.array(z.string().min(1).max(48)).min(1).max(32).refine(v => v.every((x, i) => !i || v[i - 1]! < x)), cursor: z.string().max(8192).nullable().default(null) });
export const HumanAccessSearchCursor = HumanAccessCursor.extend({
  schema_version: z.literal("deft.app_resource_access_search_cursor.v1"),
  anchor_id: uuid,
  resource_binding_id: uuid,
  checkpoint_id: uuid,
  generation: z.number().int().positive(),
  query_digest: digest
});
