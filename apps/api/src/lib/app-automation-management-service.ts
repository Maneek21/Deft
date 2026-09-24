import { createHash, randomUUID } from 'node:crypto';
import { AppDigestSchema } from '@deft/app-kit';
import { appActionBindings, appAutomationFires, appGrantSnapshots, appInstallations, appRuns, appVersions, capabilityProviderSnapshots, mcpConnections, mcpToolOverrides, moduleInstallations, moduleRecords, orgMembers, resourceRelationEdges, resourceRelationSets } from '@deft/db/schema';
import { ResourceRefV1Schema, canonicalCapabilityJson } from '@deft/shared';
import type { ModuleActor } from '@deft/shared/modules';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appActionService, type AppActionResourceEvidence } from './app-action-service.js';
import { AppBindingInvokeInputSchema } from './app-action-operations.js';
import {
  AppAutomationDefinitionReviewInputSchema,
  createReviewedAppAutomationDefinition,
  getAppAutomationDefinition,
  listAppAutomationDefinitions,
  pauseAppAutomationDefinition,
  prepareAppAutomationDefinitionReview,
  resumeAppAutomationDefinition,
} from './app-automation-definition-service.js';
import type { AppAutomationDefinitionRow } from './app-automation-repository.js';
import { nextEligibleAppAutomationOccurrence } from './app-automation-schedule.js';
import { db } from './db.js';
import { APP_AUTOMATIONS_ENABLED } from './env.js';
import { AppError } from './app-errors.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { isMcpToolEnabled } from './mcp-tool-identity.js';

const KeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((value) => !/^(deft|core|system)(_|$)/.test(value));
const ManagementCursorSchema = z.string().min(1).max(512);
const MANAGEMENT_PAGE_LIMIT = 50;

export type AppAutomationManagementCursor = Readonly<{
  app_installation_id: string;
  created_at: Date;
  id: string;
}>;

export function encodeAppAutomationManagementCursor(definition: AppAutomationManagementCursor): string {
  return Buffer.from(JSON.stringify({
    app_installation_id: definition.app_installation_id,
    created_at: definition.created_at.toISOString(),
    id: definition.id,
  })).toString('base64url');
}

export function decodeAppAutomationManagementCursor(
  value: string | undefined,
  appInstallationId: string,
): AppAutomationManagementCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(ManagementCursorSchema.parse(value), 'base64url').toString('utf8')) as {
      app_installation_id?: unknown;
      created_at?: unknown;
      id?: unknown;
    };
    const createdAt = typeof parsed.created_at === 'string' ? new Date(parsed.created_at) : null;
    if (
      !createdAt
      || Number.isNaN(createdAt.getTime())
      || parsed.app_installation_id !== appInstallationId
      || typeof parsed.id !== 'string'
      || !parsed.id.trim()
    ) {
      throw new Error('invalid cursor');
    }
    return { app_installation_id: appInstallationId, created_at: createdAt, id: parsed.id };
  } catch {
    throw new AppError('Invalid App automation cursor', 'APP_ACTION_INVALID', 400);
  }
}

export function selectAppAutomationManagementPage<T extends {
  app_installation_id: string;
  created_at: Date;
  id: string;
}>(definitions: readonly T[], limit: number) {
  const page = definitions.slice(0, limit);
  return {
    page,
    next_cursor: definitions.length > page.length && page.length > 0
      ? encodeAppAutomationManagementCursor(page[page.length - 1]!)
      : null,
  };
}

export function projectAppAutomationManagementEligibility(
  definition: Pick<AppAutomationDefinitionRow, 'state' | 'valid_from' | 'valid_until'>,
  now: Date,
  enabled: boolean,
  currentAuthority = true,
) {
  if (!enabled) return { status: 'delivery_disabled' as const, reason: 'Scheduled delivery is disabled by the host kill switch.' };
  if (definition.state !== 'active') return { status: definition.state, reason: `Definition is ${definition.state}.` };
  if (now >= definition.valid_until) return { status: 'expired' as const, reason: 'The approved validity window ended; create a freshly reviewed definition.' };
  if (!currentAuthority) return { status: 'blocked' as const, reason: 'Pinned App authority or resources changed; create a freshly reviewed definition.' };
  if (now < definition.valid_from) return { status: 'waiting' as const, reason: 'Waiting for the approved validity window to begin.' };
  return { status: 'awaiting_delivery_check' as const, reason: 'Schedule time is eligible; pinned authority and resources are rechecked before delivery.' };
}

export function nextManagedAppAutomationFire(
  definition: Pick<AppAutomationDefinitionRow, 'state' | 'local_time' | 'timezone' | 'valid_from' | 'valid_until' | 'state_changed_at'>,
  now: Date,
  enabled: boolean,
  currentAuthority: boolean,
): string | null {
  if (!enabled || !currentAuthority || definition.state !== 'active' || now >= definition.valid_until) return null;
  const eligibleAfter = definition.state_changed_at > definition.valid_from
    ? definition.state_changed_at
    : definition.valid_from;
  const next = nextEligibleAppAutomationOccurrence({
    local_time: definition.local_time,
    timezone: definition.timezone,
    now,
    eligible_after: eligibleAfter,
    eligible_before: definition.valid_until,
  });
  return next?.resolution.kind === 'resolved' ? next.resolution.resolved_at_utc.toISOString() : null;
}

export function isCurrentAutomationModulePin(
  definition: Pick<AppAutomationDefinitionRow,
    'placement_resource_ref' | 'placement_resource_revision' | 'placement_content_digest'
    | 'selected_resource_ref' | 'selected_resource_revision' | 'selected_content_digest'>,
  side: 'placement' | 'selected',
  organizationId: string,
  record: Pick<typeof moduleRecords.$inferSelect,
    'org_id' | 'installation_id' | 'collection_key' | 'id' | 'revision' | 'data' | 'is_deleted'> | undefined,
  moduleInstallation: Pick<typeof moduleInstallations.$inferSelect, 'id' | 'is_enabled' | 'is_deleted'> | undefined,
): boolean {
  const parsed = ResourceRefV1Schema.safeParse(side === 'placement'
    ? definition.placement_resource_ref : definition.selected_resource_ref);
  if (!parsed.success || parsed.data.provider.kind !== 'module') return false;
  const ref = parsed.data;
  if (!record || record.is_deleted || record.org_id !== organizationId
    || !moduleInstallation || !moduleInstallation.is_enabled || moduleInstallation.is_deleted
    || moduleInstallation.id !== ref.provider.provider_instance_id
    || record.installation_id !== ref.provider.provider_instance_id
    || record.collection_key !== ref.resource_type || record.id !== ref.resource_id) return false;
  const revision = side === 'placement' ? definition.placement_resource_revision : definition.selected_resource_revision;
  const digest = side === 'placement' ? definition.placement_content_digest : definition.selected_content_digest;
  return String(record.revision) === revision
    && `sha256:${createHash('sha256').update(canonicalCapabilityJson(record.data)).digest('hex')}` === digest;
}

export function isCurrentAutomationConnector(
  definition: Pick<AppAutomationDefinitionRow, 'mcp_connection_id' | 'operation_name' | 'connector_authorization_version'>,
  connection: Pick<typeof mcpConnections.$inferSelect,
    'id' | 'is_active' | 'app_run_authorization_version' | 'enabled_tools' | 'slug'> | undefined,
  operationDisabled: boolean,
): boolean {
  return Boolean(connection?.id === definition.mcp_connection_id && connection.is_active
    && connection.app_run_authorization_version === definition.connector_authorization_version
    && isMcpToolEnabled(connection.enabled_tools, connection.slug, definition.operation_name)
    && !operationDisabled);
}

/** A bounded, read-only known-block projection for the operator. It is not
 * delivery authorization; delivery performs full locked preparation before claim. */
async function currentAutomationAuthority(
  organizationId: string,
  definitions: readonly AppAutomationDefinitionRow[],
): Promise<Map<string, boolean>> {
  const result = new Map(definitions.map((definition) => [definition.id, false]));
  if (definitions.length === 0) return result;
  const installationIds = [...new Set(definitions.map((row) => row.app_installation_id))];
  const versionIds = [...new Set(definitions.map((row) => row.app_version_id))];
  const grantIds = [...new Set(definitions.map((row) => row.grant_snapshot_id))];
  const bindingIds = [...new Set(definitions.map((row) => row.action_binding_id))];
  const connectionIds = [...new Set(definitions.map((row) => row.mcp_connection_id))];
  const providerIds = [...new Set(definitions.map((row) => row.provider_snapshot_id))];
  const approverIds = [...new Set(definitions.map((row) => row.approved_by_user_id))];
  const refs = new Map<string, ReturnType<typeof ResourceRefV1Schema.safeParse>>();
  for (const definition of definitions) {
    refs.set(`${definition.id}:placement`, ResourceRefV1Schema.safeParse(definition.placement_resource_ref));
    refs.set(`${definition.id}:selected`, ResourceRefV1Schema.safeParse(definition.selected_resource_ref));
  }
  const resourceIds = [...new Set([...refs.values()].flatMap((ref) => ref.success ? [ref.data.resource_id] : []))];
  const placementIds = [...new Set(definitions.flatMap((definition) => {
    const ref = refs.get(`${definition.id}:placement`);
    return ref?.success ? [ref.data.resource_id] : [];
  }))];
  const selectedIds = [...new Set(definitions.flatMap((definition) => {
    const ref = refs.get(`${definition.id}:selected`);
    return ref?.success ? [ref.data.resource_id] : [];
  }))];
  const relationKeys = [...new Set(definitions.map((row) => row.selected_relation_key))];
  const operationNames = [...new Set(definitions.map((row) => row.operation_name))];
  const moduleIds = [...new Set([...refs.values()].flatMap((ref) => ref.success && ref.data.provider.kind === 'module'
    ? [ref.data.provider.provider_instance_id] : []))];
  const [installations, versions, grants, bindings, connections, providers, approvers, records, relations, overrides, modules] = await Promise.all([
    db.select({ id: appInstallations.id, state: appInstallations.state, active_version_id: appInstallations.active_version_id,
      active_grant_snapshot_id: appInstallations.active_grant_snapshot_id,
      active_grant_snapshot_kind: appInstallations.active_grant_snapshot_kind,
      lifecycle_epoch: appInstallations.lifecycle_epoch, grant_epoch: appInstallations.grant_epoch,
    }).from(appInstallations).where(and(eq(appInstallations.org_id, organizationId), inArray(appInstallations.id, installationIds))),
    db.select({ id: appVersions.id, installation_id: appVersions.installation_id, state: appVersions.state,
      protocol_version: appVersions.protocol_version, manifest_digest: appVersions.manifest_digest,
      package_digest: appVersions.package_digest,
    }).from(appVersions).where(and(eq(appVersions.org_id, organizationId), inArray(appVersions.id, versionIds))),
    db.select({ id: appGrantSnapshots.id, app_installation_id: appGrantSnapshots.app_installation_id,
      app_version_id: appGrantSnapshots.app_version_id, snapshot_kind: appGrantSnapshots.snapshot_kind,
      snapshot_digest: appGrantSnapshots.snapshot_digest, canonical_snapshot: appGrantSnapshots.canonical_snapshot,
    }).from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, organizationId), inArray(appGrantSnapshots.id, grantIds))),
    db.select({ id: appActionBindings.id, app_installation_id: appActionBindings.app_installation_id,
      app_version_id: appActionBindings.app_version_id, grant_snapshot_id: appActionBindings.grant_snapshot_id,
      action_key: appActionBindings.action_key, interface_identity: appActionBindings.interface_identity,
      binding_digest: appActionBindings.binding_digest, canonical_binding: appActionBindings.canonical_binding,
      provider_kind: appActionBindings.provider_kind, mcp_connection_id: appActionBindings.mcp_connection_id,
      provider_snapshot_id: appActionBindings.provider_snapshot_id, operation_name: appActionBindings.operation_name,
      operation_schema_digest: appActionBindings.operation_schema_digest,
      connector_authorization_version: appActionBindings.connector_authorization_version,
    }).from(appActionBindings).where(and(eq(appActionBindings.org_id, organizationId), inArray(appActionBindings.id, bindingIds))),
    db.select({ id: mcpConnections.id, is_active: mcpConnections.is_active,
      app_run_authorization_version: mcpConnections.app_run_authorization_version,
      enabled_tools: mcpConnections.enabled_tools, slug: mcpConnections.slug,
    }).from(mcpConnections).where(and(eq(mcpConnections.org_id, organizationId), inArray(mcpConnections.id, connectionIds))),
    db.select({ id: capabilityProviderSnapshots.id, provider_kind: capabilityProviderSnapshots.provider_kind,
      provider_instance_id: capabilityProviderSnapshots.provider_instance_id,
      snapshot_digest: capabilityProviderSnapshots.snapshot_digest,
    }).from(capabilityProviderSnapshots).where(and(eq(capabilityProviderSnapshots.org_id, organizationId), inArray(capabilityProviderSnapshots.id, providerIds))),
    db.select({ user_id: orgMembers.user_id, is_active: orgMembers.is_active, role: orgMembers.role,
      app_run_authorization_version: orgMembers.app_run_authorization_version,
    }).from(orgMembers).where(and(eq(orgMembers.org_id, organizationId), inArray(orgMembers.user_id, approverIds))),
    resourceIds.length ? db.select({ id: moduleRecords.id, org_id: moduleRecords.org_id,
      installation_id: moduleRecords.installation_id, collection_key: moduleRecords.collection_key,
      is_deleted: moduleRecords.is_deleted, revision: moduleRecords.revision, data: moduleRecords.data,
    }).from(moduleRecords).where(and(eq(moduleRecords.org_id, organizationId), inArray(moduleRecords.id, resourceIds))) : Promise.resolve([]),
    placementIds.length ? db.select({ set: resourceRelationSets, edge: resourceRelationEdges }).from(resourceRelationSets)
      .innerJoin(resourceRelationEdges, and(eq(resourceRelationEdges.org_id, resourceRelationSets.org_id), eq(resourceRelationEdges.relation_set_id, resourceRelationSets.id)))
      .where(and(eq(resourceRelationSets.org_id, organizationId), inArray(resourceRelationSets.source_resource_id, placementIds),
        inArray(resourceRelationSets.relation_key, relationKeys), inArray(resourceRelationEdges.target_resource_id, selectedIds),
        eq(resourceRelationEdges.is_deleted, false))) : Promise.resolve([]),
    db.select({ mcp_connection_id: mcpToolOverrides.mcp_connection_id, tool_name: mcpToolOverrides.tool_name,
      is_disabled: mcpToolOverrides.is_disabled,
    }).from(mcpToolOverrides).where(and(eq(mcpToolOverrides.org_id, organizationId),
      inArray(mcpToolOverrides.mcp_connection_id, connectionIds), inArray(mcpToolOverrides.tool_name, operationNames))),
    moduleIds.length ? db.select({ id: moduleInstallations.id, is_enabled: moduleInstallations.is_enabled,
      is_deleted: moduleInstallations.is_deleted,
    }).from(moduleInstallations).where(and(eq(moduleInstallations.org_id, organizationId), inArray(moduleInstallations.id, moduleIds))) : Promise.resolve([]),
  ]);
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
  const installationById = byId(installations);
  const versionById = byId(versions);
  const grantById = byId(grants);
  const bindingById = byId(bindings);
  const connectionById = byId(connections);
  const providerById = byId(providers);
  const approverById = new Map(approvers.map((row) => [row.user_id, row]));
  const recordById = byId(records);
  const moduleById = byId(modules);
  for (const definition of definitions) {
    const installation = installationById.get(definition.app_installation_id);
    const version = versionById.get(definition.app_version_id);
    const grant = grantById.get(definition.grant_snapshot_id);
    const binding = bindingById.get(definition.action_binding_id);
    const connection = connectionById.get(definition.mcp_connection_id);
    const provider = providerById.get(definition.provider_snapshot_id);
    const approver = approverById.get(definition.approved_by_user_id);
    const placement = refs.get(`${definition.id}:placement`);
    const selected = refs.get(`${definition.id}:selected`);
    const relationCurrent = placement?.success && selected?.success && relations.some(({ set, edge }) =>
      set.source_provider_kind === placement.data.provider.kind
      && set.source_provider_instance_id === placement.data.provider.provider_instance_id
      && set.source_resource_type === placement.data.resource_type
      && set.source_resource_id === placement.data.resource_id
      && set.relation_key === definition.selected_relation_key
      && set.revision === definition.selected_relation_revision
      && edge.target_provider_kind === selected.data.provider.kind
      && edge.target_provider_instance_id === selected.data.provider.provider_instance_id
      && edge.target_resource_type === selected.data.resource_type
      && edge.target_resource_id === selected.data.resource_id
      && !edge.is_deleted);
    const current = Boolean(installation?.state === 'active'
      && installation.active_version_id === definition.app_version_id
      && installation.active_grant_snapshot_id === definition.grant_snapshot_id
      && installation.active_grant_snapshot_kind === 'effective'
      && installation.lifecycle_epoch === definition.installation_lifecycle_epoch
      && installation.grant_epoch === definition.installation_grant_epoch
      && version?.installation_id === definition.app_installation_id
      && version.state === 'active' && version.protocol_version === '2'
      && version.manifest_digest === definition.app_manifest_digest
      && version.package_digest === definition.app_package_digest
      && grant?.app_installation_id === definition.app_installation_id
      && grant.app_version_id === definition.app_version_id
      && grant.snapshot_kind === 'effective'
      && grant.snapshot_digest === definition.grant_snapshot_digest
      && digestAppGrantValue(grant.canonical_snapshot) === grant.snapshot_digest
      && binding?.app_installation_id === definition.app_installation_id
      && binding.app_version_id === definition.app_version_id
      && binding.grant_snapshot_id === definition.grant_snapshot_id
      && binding.action_key === definition.action_key
      && binding.interface_identity === definition.interface_identity
      && binding.binding_digest === definition.binding_digest
      && digestAppGrantValue(binding.canonical_binding) === binding.binding_digest
      && binding.provider_kind === definition.provider_kind
      && binding.mcp_connection_id === definition.mcp_connection_id
      && binding.provider_snapshot_id === definition.provider_snapshot_id
      && binding.operation_name === definition.operation_name
      && binding.operation_schema_digest === definition.operation_schema_digest
      && binding.connector_authorization_version === definition.connector_authorization_version
      && isCurrentAutomationConnector(definition, connection,
        overrides.some((override) => override.mcp_connection_id === definition.mcp_connection_id
          && override.tool_name === definition.operation_name && override.is_disabled))
      && provider?.provider_kind === definition.provider_kind
      && provider.provider_instance_id === definition.mcp_connection_id
      && provider.snapshot_digest === definition.provider_snapshot_digest
      && approver?.is_active && (approver.role === 'owner' || approver.role === 'admin')
      && approver.app_run_authorization_version === definition.approver_authorization_version
      && isCurrentAutomationModulePin(definition, 'placement', organizationId,
        placement?.success ? recordById.get(placement.data.resource_id) : undefined,
        placement?.success ? moduleById.get(placement.data.provider.provider_instance_id) : undefined)
      && isCurrentAutomationModulePin(definition, 'selected', organizationId,
        selected?.success ? recordById.get(selected.data.resource_id) : undefined,
        selected?.success ? moduleById.get(selected.data.provider.provider_instance_id) : undefined)
      && relationCurrent);
    result.set(definition.id, current);
  }
  return result;
}
const AutomationActionInputSchema = AppBindingInvokeInputSchema.omit({
  idempotency_key: true,
  user_inputs: true,
}).extend({
  automation_request_key: KeySchema,
  local_time: AppAutomationDefinitionReviewInputSchema.shape.local_time,
  timezone: AppAutomationDefinitionReviewInputSchema.shape.timezone,
  validity_seconds: AppAutomationDefinitionReviewInputSchema.shape.validity_seconds,
  max_org_runs_per_utc_day:
    AppAutomationDefinitionReviewInputSchema.shape.max_org_runs_per_utc_day,
  max_pending_org_fires: AppAutomationDefinitionReviewInputSchema.shape.max_pending_org_fires,
});

export const AppAutomationReviewRequestSchema = AutomationActionInputSchema;
export const AppAutomationCreateRequestSchema = AutomationActionInputSchema.extend({
  expected_review_digest: AppDigestSchema,
  accept_code_owned_policy: z.literal(true),
});

function unavailable(message: string): never {
  throw new AppError(message, 'APP_STALE', 409);
}

function interactiveAutomationActionActor(
  actor: ModuleActor,
): Extract<ModuleActor, { kind: 'human' }> {
  if (
    actor.kind !== 'human'
    || (actor.role !== 'owner' && actor.role !== 'admin')
    || (actor.source !== 'ui' && actor.source !== 'rest')
  ) {
    throw new AppError(
      'Only interactive workspace owners and admins can manage App automations',
      'APP_ACCESS_DENIED',
      403,
    );
  }
  // The /api/apps management adapter authenticates an interactive browser
  // through its REST route. App Action prepared authority records the caller
  // surface, not the transport, so keep the original actor for approval/audit
  // and use the established human:ui surface only for effect-free preparation.
  return Object.freeze({ ...actor, source: 'ui' });
}

function refIdentity(ref: AppActionResourceEvidence['ref']): string {
  return `${ref.provider.provider_instance_id}\0${ref.resource_type}\0${ref.resource_id}`;
}

async function pinEvidence(
  actor: ModuleActor,
  evidence: AppActionResourceEvidence,
) {
  const [record] = await db.select({
    revision: moduleRecords.revision,
    data: moduleRecords.data,
  }).from(moduleRecords).where(and(
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.installation_id, evidence.ref.provider.provider_instance_id),
    eq(moduleRecords.collection_key, evidence.ref.resource_type),
    eq(moduleRecords.id, evidence.ref.resource_id),
    eq(moduleRecords.is_deleted, false),
  )).limit(1);
  if (!record || record.revision !== evidence.revision) {
    return unavailable('Automation resource changed while preparing its review');
  }
  return {
    resource_ref: evidence.ref,
    revision: String(record.revision),
    content_digest: digestAppGrantValue(record.data),
  };
}

async function resolveReviewInput(
  actor: ModuleActor,
  appInstallationId: string,
  rawInput: z.input<typeof AppAutomationReviewRequestSchema>,
) {
  const input = AppAutomationReviewRequestSchema.parse(rawInput);
  if (input.selections.length !== 1) {
    throw new AppError(
      'Scheduled App actions require exactly one selected related resource',
      'APP_ACTION_INVALID',
      400,
    );
  }
  const prepared = await appActionService.prepare({
    actor: interactiveAutomationActionActor(actor),
  }, {
    binding_id: input.binding_id,
    resource_ref: input.resource_ref,
    selections: input.selections,
    user_inputs: {},
    idempotency_key: `automation-review:${randomUUID()}`,
  });
  if (prepared.action.installation_id !== appInstallationId) {
    throw new AppError('App action does not belong to this installation', 'APP_NOT_FOUND', 404);
  }
  const placementIdentity = refIdentity(input.resource_ref);
  const selectedIdentity = refIdentity(input.selections[0]!.resource_ref);
  const placementEvidence = prepared.authority_vector.resources.find(
    (item) => refIdentity(item.ref) === placementIdentity,
  );
  const selectedEvidence = prepared.authority_vector.resources.find(
    (item) => refIdentity(item.ref) === selectedIdentity,
  );
  if (!placementEvidence || !selectedEvidence || prepared.authority_vector.resources.length !== 2) {
    return unavailable('Prepared automation resources do not match the exact bounded action');
  }
  const [placement, selected] = await Promise.all([
    pinEvidence(actor, placementEvidence),
    pinEvidence(actor, selectedEvidence),
  ]);
  return {
    app_installation_id: prepared.action.installation_id,
    app_version_id: prepared.action.app_version_id,
    action_binding_id: prepared.action.binding_id,
    automation_request_key: input.automation_request_key,
    placement,
    selected,
    local_time: input.local_time,
    timezone: input.timezone,
    validity_seconds: input.validity_seconds,
    max_org_runs_per_utc_day: input.max_org_runs_per_utc_day,
    max_pending_org_fires: input.max_pending_org_fires,
  };
}

export async function prepareManagedAppAutomationReview(
  actor: ModuleActor,
  appInstallationId: string,
  input: z.input<typeof AppAutomationReviewRequestSchema>,
) {
  return prepareAppAutomationDefinitionReview(
    actor,
    await resolveReviewInput(actor, appInstallationId, input),
  );
}

export async function createManagedAppAutomation(
  actor: ModuleActor,
  appInstallationId: string,
  rawInput: z.input<typeof AppAutomationCreateRequestSchema>,
) {
  const input = AppAutomationCreateRequestSchema.parse(rawInput);
  const {
    expected_review_digest: expectedReviewDigest,
    accept_code_owned_policy: acceptCodeOwnedPolicy,
    ...reviewRequest
  } = input;
  const reviewInput = await resolveReviewInput(actor, appInstallationId, reviewRequest);
  return createReviewedAppAutomationDefinition(actor, {
    ...reviewInput,
    expected_review_digest: expectedReviewDigest as `sha256:${string}`,
    accept_code_owned_policy: acceptCodeOwnedPolicy,
  });
}

function projectDefinition(definition: AppAutomationDefinitionRow) {
  return {
    id: definition.id,
    app_installation_id: definition.app_installation_id,
    app_version_id: definition.app_version_id,
    action_key: definition.action_key,
    automation_request_key: definition.automation_request_key,
    state: definition.state,
    definition_epoch: definition.definition_epoch,
    schedule: {
      kind: definition.schedule_kind,
      local_time: definition.local_time,
      timezone: definition.timezone,
      misfire_policy: definition.misfire_policy,
      catch_up_window_minutes: definition.catch_up_window_minutes,
    },
    validity: {
      valid_from: definition.valid_from.toISOString(),
      valid_until: definition.valid_until.toISOString(),
    },
    budgets: {
      max_actions_per_fire: definition.max_actions_per_fire,
      max_org_runs_per_utc_day: definition.max_org_runs_per_utc_day,
      max_pending_org_fires: definition.max_pending_org_fires,
    },
    approved_at: definition.approved_at.toISOString(),
    state_changed_at: definition.state_changed_at.toISOString(),
  };
}

export async function listManagedAppAutomations(
  actor: ModuleActor,
  appInstallationId: string,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
  now = new Date(),
) {
  const limit = Math.max(1, Math.min(MANAGEMENT_PAGE_LIMIT, input.limit ?? MANAGEMENT_PAGE_LIMIT));
  const definitions = await listAppAutomationDefinitions(actor, {
    app_installation_id: appInstallationId,
    limit: limit + 1,
    after: decodeAppAutomationManagementCursor(input.cursor, appInstallationId),
  });
  const { page, next_cursor: nextCursor } = selectAppAutomationManagementPage(definitions, limit);
  const definitionIds = page.map((definition) => definition.id);
  const latestFires = new Map<string, typeof appAutomationFires.$inferSelect>();
  const fireCounts = new Map<string, Record<string, number>>();
  const runs = new Map<string, Pick<typeof appRuns.$inferSelect, 'id' | 'state' | 'updated_at' | 'terminal_at'>>();
  const currentAuthority = await currentAutomationAuthority(actor.org_id, page);

  if (definitionIds.length > 0) {
    const latestRows = await db.selectDistinctOn([appAutomationFires.definition_id])
      .from(appAutomationFires)
      .where(and(
        eq(appAutomationFires.org_id, actor.org_id),
        inArray(appAutomationFires.definition_id, definitionIds),
      ))
      .orderBy(
        appAutomationFires.definition_id,
        desc(appAutomationFires.created_at),
        desc(appAutomationFires.id),
      );
    for (const latest of latestRows) latestFires.set(latest.definition_id, latest);
    const counts = await db.select({
      definition_id: appAutomationFires.definition_id,
      state: appAutomationFires.state,
      value: count(appAutomationFires.id),
    }).from(appAutomationFires).where(and(
      eq(appAutomationFires.org_id, actor.org_id),
      inArray(appAutomationFires.definition_id, definitionIds),
    )).groupBy(appAutomationFires.definition_id, appAutomationFires.state);
    for (const item of counts) {
      const current = fireCounts.get(item.definition_id) ?? {};
      current[item.state] = Number(item.value);
      fireCounts.set(item.definition_id, current);
    }
    const runIds = [...latestFires.values()].flatMap((fire) => fire.app_run_id ? [fire.app_run_id] : []);
    if (runIds.length > 0) {
      const rows = await db.select({
        id: appRuns.id,
        state: appRuns.state,
        updated_at: appRuns.updated_at,
        terminal_at: appRuns.terminal_at,
      }).from(appRuns).where(and(
        eq(appRuns.org_id, actor.org_id),
        inArray(appRuns.id, runIds),
      ));
      for (const run of rows) runs.set(run.id, run);
    }
  }

  return {
    schema: 'deft.app_automation_management.v1' as const,
    generated_at: now.toISOString(),
    kill_switch: {
      enabled: APP_AUTOMATIONS_ENABLED,
      status: APP_AUTOMATIONS_ENABLED ? 'enabled' as const : 'disabled' as const,
    },
    definitions: page.map((definition) => {
      const latest = latestFires.get(definition.id) ?? null;
      const run = latest?.app_run_id ? runs.get(latest.app_run_id) ?? null : null;
      const counts = fireCounts.get(definition.id) ?? {};
      const eligibility = projectAppAutomationManagementEligibility(
        definition,
        now,
        APP_AUTOMATIONS_ENABLED,
        currentAuthority.get(definition.id) === true,
      );
      const next = nextManagedAppAutomationFire(definition, now, APP_AUTOMATIONS_ENABLED,
        currentAuthority.get(definition.id) === true);
      return {
        ...projectDefinition(definition),
        next_fire_at_utc: next,
        eligibility,
        fire_summary: {
          pending: counts.pending ?? 0,
          claimed: counts.claimed ?? 0,
          run_created: counts.run_created ?? 0,
          skipped: counts.skipped ?? 0,
          dead_letter: counts.dead_letter ?? 0,
        },
        latest_fire: latest ? {
          id: latest.id,
          logical_local_date: latest.logical_local_date,
          resolved_at_utc: latest.resolved_at_utc?.toISOString() ?? null,
          state: latest.state,
          attempt_count: latest.attempt_count,
          terminal_reason: latest.terminal_reason,
          terminal_at: latest.terminal_at?.toISOString() ?? null,
        } : null,
        latest_run: run ? {
          id: run.id,
          state: run.state,
          updated_at: run.updated_at.toISOString(),
          terminal_at: run.terminal_at?.toISOString() ?? null,
        } : null,
        retry: {
          eligible: false,
          reason: latest?.state === 'dead_letter'
            ? 'Create a freshly reviewed definition; silent dead-letter replay is forbidden.'
            : 'No dead-lettered fire requires review.',
        },
      };
    }),
    next_cursor: nextCursor,
  };
}

async function exactManagedDefinition(
  actor: ModuleActor,
  appInstallationId: string,
  definitionId: string,
) {
  const definition = await getAppAutomationDefinition(actor, definitionId);
  if (definition.app_installation_id !== appInstallationId) {
    throw new AppError('App automation definition not found', 'APP_NOT_FOUND', 404);
  }
  return definition;
}

export async function pauseManagedAppAutomation(
  actor: ModuleActor,
  appInstallationId: string,
  definitionId: string,
  expectedEpoch: number,
) {
  await exactManagedDefinition(actor, appInstallationId, definitionId);
  return pauseAppAutomationDefinition(actor, { definition_id: definitionId, expected_epoch: expectedEpoch });
}

export async function resumeManagedAppAutomation(
  actor: ModuleActor,
  appInstallationId: string,
  definitionId: string,
  expectedEpoch: number,
) {
  await exactManagedDefinition(actor, appInstallationId, definitionId);
  return resumeAppAutomationDefinition(actor, { definition_id: definitionId, expected_epoch: expectedEpoch });
}

export const projectManagedAppAutomationDefinition = projectDefinition;
