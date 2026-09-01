import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  APP_AUTOMATION_POLICY_V1,
  canonicalAppPrivateInterfaceIdentity,
  DeftAppManifestV2Schema,
} from '@deft/app-kit';
import {
  appActionBindings,
  appGrantSnapshots,
  appInstallations,
  appVersions,
  capabilityProviderSnapshots,
  moduleRecords,
  orgMembers,
  resourceRelationEdges,
  resourceRelationSets,
} from '@deft/db/schema';
import {
  ResourceRefV1Schema,
  canonicalCapabilityJson,
  type ResourceRefV1,
} from '@deft/shared';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { connectedAppActionBindingMatches } from './app-connected-contract.js';
import {
  getAppAutomationDefinitionWithExecutor,
  insertAppAutomationDefinitionWithExecutor,
  insertAppAutomationFireWithExecutor,
  listAppAutomationDefinitionsWithExecutor,
  transitionAppAutomationDefinitionWithExecutor,
  type AppAutomationDefinitionRow,
  type AppAutomationFireRow,
} from './app-automation-repository.js';

export const APP_AUTOMATION_DEFINITION_REVIEW_VERSION =
  'deft.app_automation_definition_review.v1' as const;
export const APP_AUTOMATION_DEFINITION_VERSION =
  'deft.app_automation_definition.v1' as const;
export const APP_AUTOMATION_POLICY_DIGEST = digestAppGrantValue(APP_AUTOMATION_POLICY_V1);

export const APP_AUTOMATION_FOUNDATION_LIMITS = Object.freeze({
  validity_seconds: 30 * 24 * 60 * 60,
  max_actions_per_fire: 1,
  max_org_runs_per_utc_day: 100,
  max_pending_org_fires: 25,
  catch_up_window_minutes: 15,
  list_limit: 100,
} as const);

const OpaqueIdSchema = z.string().min(1).max(256)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const KeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((value) => !/^(deft|core|system)(_|$)/.test(value));
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RevisionSchema = z.string().min(1).max(128)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const LocalTimeSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const LogicalLocalDateSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$/);

const ResourcePinSchema = z.strictObject({
  resource_ref: ResourceRefV1Schema,
  revision: RevisionSchema,
  content_digest: DigestSchema,
}).superRefine((pin, ctx) => {
  if (pin.resource_ref.provider.kind !== 'module') {
    ctx.addIssue({
      code: 'custom',
      path: ['resource_ref', 'provider', 'kind'],
      message: 'Track A definitions currently accept Module resources only',
    });
  }
});

export const AppAutomationDefinitionReviewInputSchema = z.strictObject({
  app_installation_id: OpaqueIdSchema,
  app_version_id: OpaqueIdSchema,
  action_binding_id: OpaqueIdSchema,
  automation_request_key: KeySchema,
  placement: ResourcePinSchema,
  selected: ResourcePinSchema,
  local_time: LocalTimeSchema,
  timezone: z.string().min(1).max(128)
    .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)),
  validity_seconds: z.number().int().min(1).max(APP_AUTOMATION_FOUNDATION_LIMITS.validity_seconds),
  max_org_runs_per_utc_day: z.number().int().min(1)
    .max(APP_AUTOMATION_FOUNDATION_LIMITS.max_org_runs_per_utc_day)
    .default(APP_AUTOMATION_FOUNDATION_LIMITS.max_org_runs_per_utc_day),
  max_pending_org_fires: z.number().int().min(1)
    .max(APP_AUTOMATION_FOUNDATION_LIMITS.max_pending_org_fires)
    .default(APP_AUTOMATION_FOUNDATION_LIMITS.max_pending_org_fires),
});

export type AppAutomationDefinitionReviewInput = z.input<
  typeof AppAutomationDefinitionReviewInputSchema
>;

export type AppAutomationDefinitionReview = Readonly<{
  review_version: typeof APP_AUTOMATION_DEFINITION_REVIEW_VERSION;
  organization_id: string;
  approving_user_id: string;
  app_installation_id: string;
  app_version_id: string;
  grant_snapshot_id: string;
  action_binding_id: string;
  action_key: string;
  automation_request_key: string;
  automation_request_digest: `sha256:${string}`;
  placement: Readonly<{ resource_ref: ResourceRefV1; revision: string; content_digest: string }>;
  selected: Readonly<{ resource_ref: ResourceRefV1; revision: string; content_digest: string }>;
  schedule: Readonly<{
    kind: 'daily_local_time';
    local_time: string;
    timezone: string;
    misfire_policy: 'catch_up_within_15m';
    catch_up_window_minutes: 15;
  }>;
  budgets: Readonly<{
    max_actions_per_fire: 1;
    max_org_runs_per_utc_day: number;
    max_pending_org_fires: number;
  }>;
  validity_seconds: number;
  policy_version: '1';
  policy_digest: `sha256:${string}`;
  authorization_digest: `sha256:${string}`;
  review_digest: `sha256:${string}`;
}>;

export type CreateReviewedAppAutomationDefinitionInput = AppAutomationDefinitionReviewInput & Readonly<{
  expected_review_digest: `sha256:${string}`;
  accept_code_owned_policy: true;
}>;

type DefinitionContext = Readonly<{
  membership: typeof orgMembers.$inferSelect;
  installation: typeof appInstallations.$inferSelect;
  version: typeof appVersions.$inferSelect;
  grant: typeof appGrantSnapshots.$inferSelect;
  binding: typeof appActionBindings.$inferSelect;
  provider_snapshot: typeof capabilityProviderSnapshots.$inferSelect;
  request: z.infer<typeof DeftAppManifestV2Schema>['automation_requests'][number];
  action: z.infer<typeof DeftAppManifestV2Schema>['actions'][number];
  selected_relation: Readonly<{
    input_key: string;
    relation_key: string;
    revision: number;
  }>;
}>;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError(message, 'APP_ACTION_INVALID', 400, details);
}

function stale(message: string, details?: Record<string, unknown>): never {
  throw new AppError(message, 'APP_STALE', 409, details);
}

export function canonicalAppAutomationTimezone(value: string): string {
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone;
    if (canonical !== value) invalid('Timezone must use the host-canonical IANA identifier', {
      supplied_timezone: value,
      canonical_timezone: canonical,
    });
    return canonical;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalid('Timezone is not supported by the host ICU database', { timezone: value });
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(canonicalCapabilityJson(value)) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') invalid(`${label} must be an object`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalid(`${label} must contain bounded JSON-compatible values`);
  }
}

function contentDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex')}`;
}

async function assertManager(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actor: ModuleActor,
): Promise<typeof orgMembers.$inferSelect> {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new AppError('Only active workspace owners and admins can manage App automations', 'APP_ACCESS_DENIED', 403);
  }
  const [membership] = await executor.select().from(orgMembers).where(and(
    eq(orgMembers.org_id, actor.org_id),
    eq(orgMembers.user_id, actor.actor_id),
  )).limit(1).for('update');
  if (!membership?.is_active || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw new AppError('Only active workspace owners and admins can manage App automations', 'APP_ACCESS_DENIED', 403);
  }
  return membership;
}

async function validateResourcePin(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  pin: z.infer<typeof ResourcePinSchema>,
): Promise<void> {
  if (pin.resource_ref.provider.kind !== 'module') invalid('Track A definitions require Module resources');
  const [record] = await executor.select({
    collection_key: moduleRecords.collection_key,
    revision: moduleRecords.revision,
    data: moduleRecords.data,
    is_deleted: moduleRecords.is_deleted,
  }).from(moduleRecords).where(and(
    eq(moduleRecords.org_id, organizationId),
    eq(moduleRecords.installation_id, pin.resource_ref.provider.provider_instance_id),
    eq(moduleRecords.collection_key, pin.resource_ref.resource_type),
    eq(moduleRecords.id, pin.resource_ref.resource_id),
  )).limit(1).for('update');
  if (!record || record.is_deleted) stale('Pinned automation resource is unavailable');
  if (String(record.revision) !== pin.revision || contentDigest(record.data) !== pin.content_digest) {
    stale('Pinned automation resource revision or content changed', {
      resource_id: pin.resource_ref.resource_id,
    });
  }
}

async function loadDefinitionContext(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actor: ModuleActor,
  input: z.infer<typeof AppAutomationDefinitionReviewInputSchema>,
): Promise<DefinitionContext> {
  const membership = await assertManager(executor, actor);
  const [installation] = await executor.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.id, input.app_installation_id),
  )).limit(1).for('update');
  if (!installation) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
  if (installation.state !== 'active'
    || installation.active_version_id !== input.app_version_id
    || !installation.active_grant_snapshot_id
    || installation.active_grant_snapshot_kind !== 'effective') {
    stale('App installation is not active with an exact effective grant');
  }
  const [version] = await executor.select().from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id),
    eq(appVersions.installation_id, installation.id),
    eq(appVersions.id, input.app_version_id),
  )).limit(1).for('update');
  if (!version || version.protocol_version !== '2' || version.state !== 'active') {
    throw new AppError('Automation definitions require an active Protocol v2 App version', 'APP_PROTOCOL_UNSUPPORTED', 409);
  }
  const manifest = DeftAppManifestV2Schema.safeParse(version.manifest);
  if (!manifest.success) stale('Stored Protocol v2 manifest no longer validates');
  const request = manifest.data.automation_requests.find(
    (candidate) => candidate.key === input.automation_request_key,
  );
  if (!request) invalid('Automation request does not exist in the exact App version');
  const action = manifest.data.actions.find((candidate) => candidate.key === request.action_key);
  if (!action || !connectedAppActionBindingMatches(APP_AUTOMATION_POLICY_V1.private_interface, action)) {
    stale('Automation request no longer resolves to the exact code-owned action interface');
  }
  const selectedBindings = action.input_bindings.filter(
    (candidate) => candidate.source.kind === 'selected_relation_field',
  );
  if (selectedBindings.length !== 1
    || action.input_bindings.some((candidate) => candidate.source.kind === 'user_input')) {
    invalid('Track A automation requires exactly one selected relation and no user input');
  }
  const selectedBinding = selectedBindings[0]!;
  if (selectedBinding.source.kind !== 'selected_relation_field') {
    invalid('Track A automation relation binding is invalid');
  }
  const selectedSource = selectedBinding.source;
  const placementRequirement = manifest.data.resource_requirements.find(
    (candidate) => candidate.key === action.placement.resource_requirement_key,
  );
  const selectedRequirement = manifest.data.resource_requirements.find(
    (candidate) => candidate.key === selectedSource.target_resource_requirement_key,
  );
  if (!placementRequirement || !selectedRequirement
    || placementRequirement.resource_type !== input.placement.resource_ref.resource_type
    || selectedRequirement.resource_type !== input.selected.resource_ref.resource_type) {
    invalid('Pinned resources do not match the exact action resource requirements');
  }

  const [grant] = await executor.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, actor.org_id),
    eq(appGrantSnapshots.app_installation_id, installation.id),
    eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.id, installation.active_grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  )).limit(1).for('update');
  if (!grant) stale('Effective App grant is unavailable');
  const [binding] = await executor.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, actor.org_id),
    eq(appActionBindings.app_installation_id, installation.id),
    eq(appActionBindings.app_version_id, version.id),
    eq(appActionBindings.grant_snapshot_id, grant.id),
    eq(appActionBindings.action_key, request.action_key),
    eq(appActionBindings.id, input.action_binding_id),
  )).limit(1).for('update');
  if (!binding
    || binding.review_scope !== 'per_invocation'
    || binding.automation_eligibility !== 'forbidden'
    || binding.review_requirement !== 'always'
    || binding.risk_class !== 'external_write'
    || binding.retry_class !== 'idempotent_with_key'
    || binding.retention_class !== 'standard') {
    stale('Exact frozen App action binding is unavailable');
  }
  const expectedInterfaceIdentity = canonicalAppPrivateInterfaceIdentity({
    organization_id: actor.org_id,
    app_lineage_id: installation.id,
    interface_key: APP_AUTOMATION_POLICY_V1.private_interface.key,
    interface_version: APP_AUTOMATION_POLICY_V1.private_interface.version,
  });
  if (binding.interface_identity !== expectedInterfaceIdentity
    || binding.operation_name !== APP_AUTOMATION_POLICY_V1.private_interface.operation_name) {
    stale('Exact code-owned provider interface is unavailable');
  }
  const [providerSnapshot] = await executor.select().from(capabilityProviderSnapshots).where(and(
    eq(capabilityProviderSnapshots.org_id, actor.org_id),
    eq(capabilityProviderSnapshots.provider_kind, binding.provider_kind),
    eq(capabilityProviderSnapshots.provider_instance_id, binding.mcp_connection_id),
    eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id),
  )).limit(1).for('update');
  if (!providerSnapshot) stale('Exact provider snapshot is unavailable');
  await validateResourcePin(executor, actor.org_id, input.placement);
  await validateResourcePin(executor, actor.org_id, input.selected);
  const [relation] = await executor.select({
    revision: resourceRelationSets.revision,
  }).from(resourceRelationSets).innerJoin(resourceRelationEdges, and(
    eq(resourceRelationEdges.org_id, resourceRelationSets.org_id),
    eq(resourceRelationEdges.relation_set_id, resourceRelationSets.id),
    eq(resourceRelationEdges.is_deleted, false),
  )).where(and(
    eq(resourceRelationSets.org_id, actor.org_id),
    eq(resourceRelationSets.source_provider_kind, input.placement.resource_ref.provider.kind),
    eq(
      resourceRelationSets.source_provider_instance_id,
      input.placement.resource_ref.provider.provider_instance_id,
    ),
    eq(resourceRelationSets.source_resource_type, input.placement.resource_ref.resource_type),
    eq(resourceRelationSets.source_resource_id, input.placement.resource_ref.resource_id),
    eq(resourceRelationSets.relation_key, selectedSource.relation_field_key),
    eq(resourceRelationEdges.target_provider_kind, input.selected.resource_ref.provider.kind),
    eq(
      resourceRelationEdges.target_provider_instance_id,
      input.selected.resource_ref.provider.provider_instance_id,
    ),
    eq(resourceRelationEdges.target_resource_type, input.selected.resource_ref.resource_type),
    eq(resourceRelationEdges.target_resource_id, input.selected.resource_ref.resource_id),
  )).limit(1).for('update');
  if (!relation) stale('Selected resource is not in the current declared relation');
  return {
    membership,
    installation,
    version,
    grant,
    binding,
    provider_snapshot: providerSnapshot,
    request,
    action,
    selected_relation: {
      input_key: selectedBinding.input_key,
      relation_key: selectedSource.relation_field_key,
      revision: relation.revision,
    },
  };
}

function buildReview(
  actor: Extract<ModuleActor, { kind: 'human' }>,
  input: z.infer<typeof AppAutomationDefinitionReviewInputSchema>,
  context: DefinitionContext,
): AppAutomationDefinitionReview {
  const timezone = canonicalAppAutomationTimezone(input.timezone);
  const automationRequestDigest = digestAppGrantValue(context.request);
  const schedule = {
    kind: 'daily_local_time' as const,
    local_time: input.local_time,
    timezone,
    misfire_policy: 'catch_up_within_15m' as const,
    catch_up_window_minutes: 15 as const,
  };
  const budgets = {
    max_actions_per_fire: 1 as const,
    max_org_runs_per_utc_day: input.max_org_runs_per_utc_day,
    max_pending_org_fires: input.max_pending_org_fires,
  };
  const authorization = buildHostAuthorizationVector({
    actor,
    input,
    context,
    automation_request_digest: automationRequestDigest,
    schedule,
    budgets,
  });
  const authorizationDigest = digestAppGrantValue(authorization);
  const withoutDigest = {
    review_version: APP_AUTOMATION_DEFINITION_REVIEW_VERSION,
    organization_id: actor.org_id,
    approving_user_id: actor.actor_id,
    app_installation_id: context.installation.id,
    app_version_id: context.version.id,
    grant_snapshot_id: context.grant.id,
    action_binding_id: context.binding.id,
    action_key: context.binding.action_key,
    automation_request_key: context.request.key,
    automation_request_digest: automationRequestDigest,
    placement: input.placement,
    selected: input.selected,
    schedule,
    budgets,
    validity_seconds: input.validity_seconds,
    policy_version: APP_AUTOMATION_POLICY_V1.version,
    policy_digest: APP_AUTOMATION_POLICY_DIGEST,
    authorization_digest: authorizationDigest,
  };
  return { ...withoutDigest, review_digest: digestAppGrantValue(withoutDigest) };
}

function buildHostAuthorizationVector(input: Readonly<{
  actor: Extract<ModuleActor, { kind: 'human' }>;
  input: z.infer<typeof AppAutomationDefinitionReviewInputSchema>;
  context: DefinitionContext;
  automation_request_digest: `sha256:${string}`;
  schedule: AppAutomationDefinitionReview['schedule'];
  budgets: AppAutomationDefinitionReview['budgets'];
}>): Record<string, unknown> {
  const { actor, context } = input;
  return jsonObject({
    schema_version: 'deft.app_automation_authorization.v1',
    organization_id: actor.org_id,
    approver: {
      user_id: context.membership.user_id,
      role: context.membership.role,
      authorization_version: context.membership.app_run_authorization_version,
    },
    installation: {
      id: context.installation.id,
      lifecycle_epoch: context.installation.lifecycle_epoch,
      grant_epoch: context.installation.grant_epoch,
    },
    app_version: {
      id: context.version.id,
      manifest_digest: context.version.manifest_digest,
      package_digest: context.version.package_digest,
    },
    grant: {
      id: context.grant.id,
      snapshot_kind: context.grant.snapshot_kind,
      snapshot_digest: context.grant.snapshot_digest,
    },
    automation_request: {
      key: context.request.key,
      digest: input.automation_request_digest,
    },
    action_binding: {
      id: context.binding.id,
      action_key: context.binding.action_key,
      interface_identity: context.binding.interface_identity,
      binding_digest: context.binding.binding_digest,
      connector_authorization_version: context.binding.connector_authorization_version,
    },
    provider: {
      kind: context.binding.provider_kind,
      connection_id: context.binding.mcp_connection_id,
      snapshot_id: context.provider_snapshot.id,
      snapshot_digest: context.provider_snapshot.snapshot_digest,
      operation_name: context.binding.operation_name,
      operation_schema_digest: context.binding.operation_schema_digest,
    },
    resources: {
      placement: input.input.placement,
      selected: input.input.selected,
    },
    relation: {
      input_key: context.selected_relation.input_key,
      source_ref: input.input.placement.resource_ref,
      relation_key: context.selected_relation.relation_key,
      revision: context.selected_relation.revision,
      selected_ref: input.input.selected.resource_ref,
    },
    schedule: input.schedule,
    budgets: input.budgets,
    validity_seconds: input.input.validity_seconds,
    policy: {
      key: APP_AUTOMATION_POLICY_V1.key,
      version: APP_AUTOMATION_POLICY_V1.version,
      digest: APP_AUTOMATION_POLICY_DIGEST,
    },
  }, 'Host automation authorization vector');
}

export async function prepareAppAutomationDefinitionReview(
  actor: ModuleActor,
  rawInput: AppAutomationDefinitionReviewInput,
): Promise<AppAutomationDefinitionReview> {
  const input = AppAutomationDefinitionReviewInputSchema.parse(rawInput);
  if (actor.kind !== 'human') {
    throw new AppError('Only humans can approve App automation definitions', 'APP_ACCESS_DENIED', 403);
  }
  return db.transaction(async (tx) => buildReview(actor, input, await loadDefinitionContext(tx, actor, input)));
}

export async function createReviewedAppAutomationDefinition(
  actor: ModuleActor,
  rawInput: CreateReviewedAppAutomationDefinitionInput,
  options: Readonly<{ now?: () => Date }> = {},
): Promise<AppAutomationDefinitionRow> {
  const { expected_review_digest: expectedReviewDigest, accept_code_owned_policy: accepted, ...reviewInput } = rawInput;
  if (!accepted) invalid('The exact code-owned automation policy must be accepted');
  const input = AppAutomationDefinitionReviewInputSchema.parse(reviewInput);
  if (actor.kind !== 'human') {
    throw new AppError('Only humans can approve App automation definitions', 'APP_ACCESS_DENIED', 403);
  }
  return db.transaction(async (tx) => {
    const context = await loadDefinitionContext(tx, actor, input);
    const review = buildReview(actor, input, context);
    if (review.review_digest !== expectedReviewDigest) stale('Automation definition review changed');
    const approvedAt = (options.now ?? (() => new Date()))();
    const validUntil = new Date(approvedAt.getTime() + input.validity_seconds * 1000);
    const authorization = buildHostAuthorizationVector({
      actor,
      input,
      context,
      automation_request_digest: review.automation_request_digest,
      schedule: review.schedule,
      budgets: review.budgets,
    });
    const canonicalDefinition = jsonObject({
      definition_version: APP_AUTOMATION_DEFINITION_VERSION,
      organization_id: actor.org_id,
      app: {
        installation_id: context.installation.id,
        version_id: context.version.id,
        manifest_digest: context.version.manifest_digest,
        package_digest: context.version.package_digest,
        grant_snapshot_id: context.grant.id,
        grant_snapshot_digest: context.grant.snapshot_digest,
        lifecycle_epoch: context.installation.lifecycle_epoch,
        grant_epoch: context.installation.grant_epoch,
      },
      request: {
        key: context.request.key,
        digest: review.automation_request_digest,
      },
      action_binding: {
        id: context.binding.id,
        action_key: context.binding.action_key,
        interface_identity: context.binding.interface_identity,
        provider_kind: context.binding.provider_kind,
        mcp_connection_id: context.binding.mcp_connection_id,
        provider_snapshot_id: context.binding.provider_snapshot_id,
        provider_snapshot_digest: context.provider_snapshot.snapshot_digest,
        operation_name: context.binding.operation_name,
        operation_schema_digest: context.binding.operation_schema_digest,
        binding_digest: context.binding.binding_digest,
        connector_authorization_version: context.binding.connector_authorization_version,
      },
      placement: review.placement,
      selected: review.selected,
      selected_relation: context.selected_relation,
      schedule: review.schedule,
      budgets: review.budgets,
      validity: { valid_from: approvedAt.toISOString(), valid_until: validUntil.toISOString() },
      policy: { version: review.policy_version, digest: review.policy_digest },
      authorization: { vector: authorization, digest: review.authorization_digest },
      approval: {
        user_id: context.membership.user_id,
        role: context.membership.role,
        authorization_version: context.membership.app_run_authorization_version,
        approved_at: approvedAt.toISOString(),
      },
      definition_epoch: 1,
    }, 'Canonical automation definition');
    return insertAppAutomationDefinitionWithExecutor(tx, {
      id: randomUUID(),
      org_id: actor.org_id,
      app_installation_id: context.installation.id,
      app_version_id: context.version.id,
      app_manifest_digest: context.version.manifest_digest,
      app_package_digest: context.version.package_digest,
      grant_snapshot_id: context.grant.id,
      grant_snapshot_kind: 'effective',
      grant_snapshot_digest: context.grant.snapshot_digest,
      action_binding_id: context.binding.id,
      action_key: context.binding.action_key,
      interface_identity: context.binding.interface_identity,
      automation_request_key: context.request.key,
      automation_request_digest: review.automation_request_digest,
      installation_lifecycle_epoch: context.installation.lifecycle_epoch,
      installation_grant_epoch: context.installation.grant_epoch,
      provider_kind: context.binding.provider_kind,
      mcp_connection_id: context.binding.mcp_connection_id,
      provider_snapshot_id: context.binding.provider_snapshot_id,
      provider_snapshot_digest: context.provider_snapshot.snapshot_digest,
      operation_name: context.binding.operation_name,
      operation_schema_digest: context.binding.operation_schema_digest,
      binding_digest: context.binding.binding_digest,
      connector_authorization_version: context.binding.connector_authorization_version,
      placement_resource_ref: review.placement.resource_ref,
      placement_resource_revision: review.placement.revision,
      placement_content_digest: review.placement.content_digest,
      selected_resource_ref: review.selected.resource_ref,
      selected_resource_revision: review.selected.revision,
      selected_content_digest: review.selected.content_digest,
      selected_relation_input_key: context.selected_relation.input_key,
      selected_relation_key: context.selected_relation.relation_key,
      selected_relation_revision: context.selected_relation.revision,
      schedule_kind: 'daily_local_time',
      local_time: review.schedule.local_time,
      timezone: review.schedule.timezone,
      misfire_policy: 'catch_up_within_15m',
      catch_up_window_minutes: 15,
      max_actions_per_fire: 1,
      max_org_runs_per_utc_day: review.budgets.max_org_runs_per_utc_day,
      max_pending_org_fires: review.budgets.max_pending_org_fires,
      valid_from: approvedAt,
      valid_until: validUntil,
      policy_version: '1',
      policy_digest: review.policy_digest,
      authorization_vector: authorization,
      authorization_digest: review.authorization_digest,
      canonical_definition: canonicalDefinition,
      definition_digest: digestAppGrantValue(canonicalDefinition),
      state: 'active',
      definition_epoch: 1,
      created_by_user_id: actor.actor_id,
      approved_by_user_id: actor.actor_id,
      approver_authorization_version: context.membership.app_run_authorization_version,
      approved_at: approvedAt,
      state_changed_at: approvedAt,
      revoked_at: null,
      expired_at: null,
      created_at: approvedAt,
      updated_at: approvedAt,
    });
  });
}

type MutableDefinitionState = 'active' | 'paused';
type DefinitionTransition = 'active' | 'paused' | 'revoked' | 'expired';

async function transitionDefinition(
  actor: ModuleActor,
  input: Readonly<{ definition_id: string; expected_epoch: number }>,
  expectedState: MutableDefinitionState,
  nextState: DefinitionTransition,
  options: Readonly<{ now?: () => Date }> = {},
): Promise<AppAutomationDefinitionRow> {
  return db.transaction(async (tx) => {
    await assertManager(tx, actor);
    const definition = await getAppAutomationDefinitionWithExecutor(
      tx,
      actor.org_id,
      input.definition_id,
      { lock: true },
    );
    if (!definition) throw new AppError('App automation definition not found', 'APP_NOT_FOUND', 404);
    if (definition.definition_epoch !== input.expected_epoch || definition.state !== expectedState) {
      stale('App automation definition changed', {
        current_epoch: definition.definition_epoch,
        current_state: definition.state,
      });
    }
    const updated = await transitionAppAutomationDefinitionWithExecutor(tx, {
      organization_id: actor.org_id,
      definition_id: definition.id,
      expected_epoch: input.expected_epoch,
      expected_state: expectedState,
      next_state: nextState,
      changed_at: (options.now ?? (() => new Date()))(),
    });
    return updated ?? stale('App automation definition changed during transition');
  });
}

export const pauseAppAutomationDefinition = (
  actor: ModuleActor,
  input: Readonly<{ definition_id: string; expected_epoch: number }>,
  options?: Readonly<{ now?: () => Date }>,
) => transitionDefinition(actor, input, 'active', 'paused', options);

export const resumeAppAutomationDefinition = (
  actor: ModuleActor,
  input: Readonly<{ definition_id: string; expected_epoch: number }>,
  options?: Readonly<{ now?: () => Date }>,
) => transitionDefinition(actor, input, 'paused', 'active', options);

export async function revokeAppAutomationDefinition(
  actor: ModuleActor,
  input: Readonly<{ definition_id: string; expected_epoch: number }>,
  options?: Readonly<{ now?: () => Date }>,
): Promise<AppAutomationDefinitionRow> {
  const current = await getAppAutomationDefinition(actor, input.definition_id);
  if (current.state !== 'active' && current.state !== 'paused') {
    return stale('Only active or paused App automation definitions can be revoked');
  }
  return transitionDefinition(actor, input, current.state, 'revoked', options);
}

export async function expireAppAutomationDefinition(
  actor: ModuleActor,
  input: Readonly<{ definition_id: string; expected_epoch: number }>,
  options?: Readonly<{ now?: () => Date }>,
): Promise<AppAutomationDefinitionRow> {
  const current = await getAppAutomationDefinition(actor, input.definition_id);
  if (current.state !== 'active' && current.state !== 'paused') {
    return stale('Only active or paused App automation definitions can expire');
  }
  return transitionDefinition(actor, input, current.state, 'expired', options);
}

export async function getAppAutomationDefinition(
  actor: ModuleActor,
  definitionId: string,
): Promise<AppAutomationDefinitionRow> {
  return db.transaction(async (tx) => {
    await assertManager(tx, actor);
    const definition = await getAppAutomationDefinitionWithExecutor(tx, actor.org_id, definitionId);
    if (!definition) throw new AppError('App automation definition not found', 'APP_NOT_FOUND', 404);
    return definition;
  });
}

export async function listAppAutomationDefinitions(
  actor: ModuleActor,
  input: Readonly<{ app_installation_id?: string; limit?: number }> = {},
): Promise<AppAutomationDefinitionRow[]> {
  return db.transaction(async (tx) => {
    await assertManager(tx, actor);
    return listAppAutomationDefinitionsWithExecutor(tx, {
      organization_id: actor.org_id,
      app_installation_id: input.app_installation_id,
      limit: Math.max(1, Math.min(APP_AUTOMATION_FOUNDATION_LIMITS.list_limit, input.limit ?? 50)),
    });
  });
}

export async function persistAppAutomationFire(
  input: Readonly<{
    organization_id: string;
    definition_id: string;
    expected_epoch: number;
    logical_local_date: string;
    resolution:
      | Readonly<{ kind: 'resolved'; resolved_at_utc: Date }>
      | Readonly<{ kind: 'dst_gap' }>;
  }>,
  options: Readonly<{ now?: () => Date }> = {},
): Promise<AppAutomationFireRow> {
  const logicalLocalDate = LogicalLocalDateSchema.parse(input.logical_local_date);
  return db.transaction(async (tx) => {
    const definition = await getAppAutomationDefinitionWithExecutor(
      tx,
      input.organization_id,
      input.definition_id,
      { lock: true },
    );
    if (!definition) throw new AppError('App automation definition not found', 'APP_NOT_FOUND', 404);
    if (definition.state !== 'active' || definition.definition_epoch !== input.expected_epoch) {
      stale('App automation definition is not eligible for this fire');
    }
    const fireIdentity = digestAppAutomationFireIdentity({
      organization_id: input.organization_id,
      definition_id: definition.id,
      definition_epoch: definition.definition_epoch,
      logical_local_date: logicalLocalDate,
      local_time: definition.local_time,
      timezone: definition.timezone,
    });
    const now = (options.now ?? (() => new Date()))();
    return insertAppAutomationFireWithExecutor(tx, {
      id: randomUUID(),
      org_id: input.organization_id,
      definition_id: definition.id,
      definition_epoch: definition.definition_epoch,
      logical_local_date: logicalLocalDate,
      local_time: definition.local_time,
      timezone: definition.timezone,
      resolved_at_utc: input.resolution.kind === 'resolved' ? input.resolution.resolved_at_utc : null,
      fire_identity: fireIdentity,
      state: input.resolution.kind === 'dst_gap' ? 'skipped' : 'pending',
      attempt_count: 0,
      claim_owner: null,
      claim_token: null,
      claimed_at: null,
      lease_expires_at: null,
      app_run_id: null,
      terminal_reason: input.resolution.kind === 'dst_gap' ? 'dst_gap' : null,
      terminal_at: input.resolution.kind === 'dst_gap' ? now : null,
      created_at: now,
      updated_at: now,
    });
  });
}

export function digestAppAutomationFireIdentity(input: Readonly<{
  organization_id: string;
  definition_id: string;
  definition_epoch: number;
  logical_local_date: string;
  local_time: string;
  timezone: string;
}>): `sha256:${string}` {
  return digestAppGrantValue({
    organization_id: input.organization_id,
    definition_id: input.definition_id,
    definition_epoch: input.definition_epoch,
    logical_local_date: LogicalLocalDateSchema.parse(input.logical_local_date),
    local_time: LocalTimeSchema.parse(input.local_time),
    timezone: canonicalAppAutomationTimezone(input.timezone),
  });
}
