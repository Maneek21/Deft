import { z } from 'zod';
const Id = z.string().uuid();
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RuntimeSetupReviewRequestSchema = z.strictObject({ installation_id:Id, action_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), operator_user_id:Id, expected_app_version_id:Id, expected_package_digest:Digest, expected_grant_snapshot_digest:Digest, expected_lifecycle_epoch:z.number().int().nonnegative(), expected_grant_epoch:z.number().int().nonnegative() });
export const RuntimeSetupContextSchema = z.strictObject({
  schema_version: z.literal('deft.app_runtime_setup_context.v1'),
  installation_id: Id, app_version_id: Id, grant_snapshot_id: Id,
  package_digest: Digest, grant_snapshot_digest: Digest,
  lifecycle_epoch: z.number().int().nonnegative(), grant_epoch: z.number().int().nonnegative(),
  operator_user_id: Id,
  policy: z.strictObject({ review_requirement: z.literal('always'), review_scope: z.literal('per_invocation'), retry_class: z.literal('unsafe_or_unknown') }),
  actions: z.array(z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), label: z.string().max(128),
    review_request: RuntimeSetupReviewRequestSchema,
    binding: z.strictObject({ id: Id, registration_id: Id, operator_user_id: Id,
      state: z.enum(['disabled','active','revoked']), registration_state: z.enum(['disabled','active','revoked']),
      can_issue_session: z.boolean() }).nullable(),
  })).max(16),
});
export type RuntimeSetupContext = z.infer<typeof RuntimeSetupContextSchema>;
