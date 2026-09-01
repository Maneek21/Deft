import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunAuthorizationSnapshotSchema,
  AppRunSafePreviewSchema,
  CapabilityProviderDiscoverySnapshotSchema,
  ModuleResourceRefV1Schema,
  RESOURCE_CONTRACT_VERSIONS,
  canonicalCapabilityJson,
  type AppRunActor,
  type AppRunAuthorizationSnapshot,
  type AppRunPolicySnapshot,
  type AppRunSubmission,
  type ModuleResourceRefV1,
} from '@deft/shared';
import { DeftAppManifestV1Schema } from '@deft/app-kit';
import {
  agentEmployees,
  appActionBindings,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appRuns,
  appVersions,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpTokens,
  mcpToolOverrides,
  moduleInstallations,
  moduleRecords,
  moduleVersions,
  oauthAccessTokens,
  orgMembers,
  resourceRelationEdges,
  resourceRelationSets,
} from '@deft/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db.js';
import type {
  AppRunExecutionAuthorizer,
  AppRunReadAuthorityRef,
} from './app-run-authorization.js';
import type {
  AppRunSafeView,
  AppRunTransaction,
} from './app-run-repository.js';
import { canonicalMcpToolName, isMcpToolEnabled } from './mcp-tool-identity.js';
import { digestAppGrantValue } from './app-grant-service.js';
import {
  APP_RUN_APP_AUTHORITY_KINDS,
  AppRunCallerSurfaceSchema,
  appRelationAuthorityId,
  appResourceAuthorityId,
  projectPreparedAppAuthorityRefs,
  type AppRunPreparedAuthorityVector,
} from './app-run-prepared-input.js';

const HOST_POLICY_VERSION = 'deft.app_run.host_policy.v1';
const APP_MCP_INVOKE_SCOPES = Object.freeze(['read:modules', 'invoke:apps'] as const);

type AuthorityRef = AppRunAuthorizationSnapshot['authority_refs'][number];
export type AppRunTokenAuthority = Readonly<{
  token_kind: 'mcp' | 'oauth';
  token_id: string;
}>;

export type AppRunTokenScopeAuthorization = Readonly<{
  org_id: string;
  authenticated_subject: AppRunActor;
  required_token_scopes: readonly string[];
  token_authorities: readonly AppRunTokenAuthority[];
}>;

type TokenScopeCheckInput = Readonly<{
  org_id: string;
  authenticated_subject: AppRunActor;
  required_token_scopes?: readonly string[];
}>;

export type AppRunAuthorizationCapture = Readonly<{
  org_id: string;
  authenticated_subject: AppRunActor;
  execution_actor: AppRunActor;
  provider_instance_id: string;
  provider_snapshot_id: string;
  operation_name: string;
  policy: AppRunPolicySnapshot;
  required_token_scopes?: readonly string[];
  token_authorities?: readonly AppRunTokenAuthority[];
}>;

type InternalRunAuthorization = Readonly<{
  authorization_snapshot: Record<string, unknown>;
  provider_snapshot_id: string;
  origin_app_installation_id: string | null;
  origin_app_version_id: string | null;
  origin_app_binding_key: string | null;
  origin_app_grant_snapshot_id: string | null;
  safe_preview: Record<string, unknown>;
  budget_reserved_at: Date | null;
  budget_reserved_count: number | null;
  budget_limit_at_reservation: number | null;
}>;

type AppVectorCaptureInput = Readonly<{
  org_id: string;
  initiating_actor: AppRunActor;
  execution_actor: AppRunActor;
  installation_id: string;
  app_version_id: string;
  binding_key: string;
  grant_snapshot_id: string;
  provider_instance_id: string;
  provider_snapshot_id: string;
  provider_snapshot_digest: string;
  operation_name: string;
  policy: AppRunPolicySnapshot;
  base_authorization: AppRunAuthorizationSnapshot;
  caller_surface: z.infer<typeof AppRunCallerSurfaceSchema>;
  resource_refs: readonly ModuleResourceRefV1[];
  relation_refs: readonly Readonly<{
    source_ref: ModuleResourceRefV1;
    relation_key: string;
    selected_ref: ModuleResourceRefV1;
  }>[];
}>;

export type AppRunPreparedAppVerification = Readonly<{
  submission: AppRunSubmission;
  authority_vector: AppRunPreparedAuthorityVector;
}>;

const APP_AUTHORITY_KINDS = new Set<string>(APP_RUN_APP_AUTHORITY_KINDS);

function isAppAuthorityRef(ref: AuthorityRef): boolean {
  return APP_AUTHORITY_KINDS.has(ref.authority_kind);
}

function actorMatchesSurface(
  actor: AppRunActor,
  surface: z.infer<typeof AppRunCallerSurfaceSchema>,
  hasToken: boolean,
): boolean {
  if (surface === 'human:ui' || surface === 'defty') {
    return actor.actor_type === 'human' && !hasToken;
  }
  if (surface === 'human:mcp') return actor.actor_type === 'human' && hasToken;
  if (surface === 'agent_employee:runtime') {
    return actor.actor_type === 'agent_employee' && !hasToken;
  }
  return actor.actor_type === 'agent_employee' && hasToken;
}

function authorityVersion(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(`deft.app_run.authority.v1\0${domain}\0`)
    .update(canonicalCapabilityJson(value))
    .digest('hex')}`;
}

function actorIdentity(actor: AppRunActor): string {
  switch (actor.actor_type) {
    case 'human': return actor.user_id;
    case 'agent_employee': return actor.agent_employee_id;
    case 'system': return actor.system_id;
    case 'automation': return actor.automation_id;
  }
}

function runActor(type: AppRunSafeView['execution_actor_type'], id: string): AppRunActor {
  switch (type) {
    case 'human': return { actor_type: 'human', user_id: id };
    case 'agent_employee': return { actor_type: 'agent_employee', agent_employee_id: id };
    case 'system': return { actor_type: 'system', system_id: id };
    case 'automation': return { actor_type: 'automation', automation_id: id };
  }
}

function sameAuthorityRefs(
  left: readonly AuthorityRef[],
  right: readonly AuthorityRef[],
): boolean {
  const encode = (ref: AuthorityRef) => `${ref.authority_kind}\0${ref.authority_id}\0${ref.version}`;
  if (left.length !== right.length) return false;
  const expected = new Set(right.map(encode));
  return left.every((ref) => expected.has(encode(ref)));
}

/**
 * Host-owned authorization snapshot builder and live verifier for governed
 * Runs. Callers receive only opaque versions; live rows remain authoritative.
 */
export class PostgresAppRunLiveAuthorization implements AppRunExecutionAuthorizer {
  async capture(input: AppRunAuthorizationCapture): Promise<AppRunAuthorizationSnapshot> {
    return db.transaction((tx) => this.#capture(tx, input));
  }

  /** Read-only preparation gate for future effects. It captures the same live
   * authority vector as Run submission and additionally rejects an already
   * exhausted employee budget without reserving or consuming a slot. */
  async captureForPreparation(
    input: AppRunAuthorizationCapture,
  ): Promise<AppRunAuthorizationSnapshot> {
    return db.transaction(async (tx) => {
      const snapshot = await this.#capture(tx, input);
      if (input.execution_actor.actor_type === 'agent_employee' && input.policy.risk_class !== 'read') {
        const [available] = await tx.select({ id: agentEmployees.id }).from(agentEmployees).where(and(
          eq(agentEmployees.org_id, input.org_id),
          eq(agentEmployees.id, input.execution_actor.agent_employee_id),
          eq(agentEmployees.is_active, true),
          eq(agentEmployees.is_deleted, false),
          eq(agentEmployees.unhealthy, false),
          sql`${agentEmployees.daily_action_count} < ${agentEmployees.max_daily_actions}`,
        )).limit(1);
        if (!available) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      return snapshot;
    });
  }

  /** Revalidate an exact MCP/OAuth token and its current scopes for actor-
   * scoped Run reads. This does not create or mutate Run authority. */
  async assertTokenScopes(input: AppRunTokenScopeAuthorization): Promise<AppRunReadAuthorityRef> {
    if (input.token_authorities.length !== 1) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    return db.transaction((tx) => this.#tokenAuthority(tx, input, input.token_authorities[0]!));
  }

  /** Trusted App submission verifier. The encrypted candidate supplies the
   * immutable prepared vector; every row is rederived in the Run insertion
   * transaction before an approval can be linked. */
  async capturePreparedAppInTransaction(
    tx: AppRunTransaction,
    input: AppRunPreparedAppVerification,
  ): Promise<AppRunAuthorizationSnapshot> {
    const { submission, authority_vector: prepared } = input;
    if (
      submission.origin.origin_kind !== 'app'
      || submission.org_id !== submission.operation.provider.org_id
      || submission.origin.installation_id !== prepared.installation.id
      || submission.origin.app_version_id !== prepared.app_version.id
      || submission.origin.binding_key !== prepared.binding.action_key
      || submission.origin.grant_snapshot_id !== prepared.grant.id
      || submission.operation.provider.provider_instance_id !== prepared.provider.connection_id
      || submission.operation.operation_name !== prepared.provider.operation_name
      || submission.provider_snapshot_digest !== prepared.provider.snapshot_digest
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');

    const tokenAuthorities = prepared.run_authorization.authority_refs
      .filter((ref) => ref.authority_kind === 'token_scope')
      .map((ref) => ({ token_id: ref.authority_id }));
    const currentBase = await this.#capture(tx, {
      org_id: submission.org_id,
      authenticated_subject: submission.initiating_actor,
      execution_actor: submission.execution_actor,
      provider_instance_id: prepared.provider.connection_id,
      provider_snapshot_id: prepared.provider.snapshot_id,
      operation_name: prepared.provider.operation_name,
      policy: submission.policy,
      required_token_scopes: prepared.caller_surface.endsWith(':mcp') ? APP_MCP_INVOKE_SCOPES : [],
      token_authorities: await Promise.all(tokenAuthorities.map(async ({ token_id }) => ({
        token_id,
        token_kind: await this.#tokenKind(tx, submission.org_id, token_id),
      }))),
    });
    if (!sameAuthorityRefs(prepared.run_authorization.authority_refs, currentBase.authority_refs)) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    const currentApp = await this.#captureAppVector(tx, {
      org_id: submission.org_id,
      initiating_actor: submission.initiating_actor,
      execution_actor: submission.execution_actor,
      installation_id: submission.origin.installation_id,
      app_version_id: submission.origin.app_version_id,
      binding_key: submission.origin.binding_key,
      grant_snapshot_id: submission.origin.grant_snapshot_id,
      provider_instance_id: submission.operation.provider.provider_instance_id,
      provider_snapshot_id: prepared.provider.snapshot_id,
      provider_snapshot_digest: submission.provider_snapshot_digest,
      operation_name: submission.operation.operation_name,
      policy: submission.policy,
      base_authorization: currentBase,
      caller_surface: prepared.caller_surface,
      resource_refs: prepared.resources.map((resource) => resource.ref),
      relation_refs: prepared.relations.map((relation) => ({
        source_ref: relation.source_ref,
        relation_key: relation.relation_key,
        selected_ref: relation.selected_ref,
      })),
    });
    const preparedRefs = projectPreparedAppAuthorityRefs(prepared);
    const currentRefs = projectPreparedAppAuthorityRefs(currentApp);
    if (!sameAuthorityRefs(preparedRefs, currentRefs)) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    return AppRunAuthorizationSnapshotSchema.parse({
      ...currentBase,
      authority_refs: [...currentBase.authority_refs, ...currentRefs],
    });
  }

  async authorizeApproval(input: Readonly<{
    org_id: string;
    run: AppRunSafeView;
  }>): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        const internal = await this.#loadInternalRun(tx, input.org_id, input.run.id);
        return internal !== null && await this.#matchesLiveState(tx, input.run, internal);
      });
    } catch {
      return false;
    }
  }

  async authorizeApprovalInTransaction(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    now: Date = new Date(),
  ): Promise<boolean> {
    // Approval is the execution release boundary. Reuse the prepare-stage
    // authorizer so an employee budget slot is reserved atomically before the
    // approval and attempt are committed; a later scheduler call can then only
    // observe that same reservation.
    return this.authorizeExecution({
      org_id: run.org_id,
      run,
      tx,
      stage: 'prepare',
      now,
    });
  }

  async authorizeDelivery(input: Readonly<{
    org_id: string;
    run: AppRunSafeView;
  }>): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        const internal = await this.#loadInternalRun(tx, input.org_id, input.run.id);
        return internal !== null && await this.#matchesLiveState(tx, input.run, internal);
      });
    } catch {
      return false;
    }
  }

  async authorizeExecution(input: Parameters<AppRunExecutionAuthorizer['authorizeExecution']>[0]): Promise<boolean> {
    try {
      if (input.org_id !== input.run.org_id) return false;
      const internal = await this.#loadInternalRun(input.tx, input.org_id, input.run.id);
      if (!internal || !await this.#matchesLiveState(input.tx, input.run, internal)) return false;

      const reservesEmployeeBudget = input.run.execution_actor_type === 'agent_employee'
        && input.run.risk_class !== 'read';
      if (!reservesEmployeeBudget) {
        return internal.budget_reserved_at === null
          && internal.budget_reserved_count === null
          && internal.budget_limit_at_reservation === null;
      }

      if (input.stage !== 'prepare') {
        return internal.budget_reserved_at !== null
          && internal.budget_reserved_count === 1
          && internal.budget_limit_at_reservation !== null;
      }
      if (internal.budget_reserved_at !== null) {
        return internal.budget_reserved_count === 1
          && internal.budget_limit_at_reservation !== null;
      }

      const [reservation] = await input.tx
        .update(agentEmployees)
        .set({ daily_action_count: sql`${agentEmployees.daily_action_count} + 1` })
        .where(and(
          eq(agentEmployees.org_id, input.org_id),
          eq(agentEmployees.id, input.run.execution_actor_id),
          eq(agentEmployees.is_active, true),
          eq(agentEmployees.is_deleted, false),
          eq(agentEmployees.unhealthy, false),
          sql`${agentEmployees.daily_action_count} < ${agentEmployees.max_daily_actions}`,
        ))
        .returning({
          count: agentEmployees.daily_action_count,
          limit: agentEmployees.max_daily_actions,
        });
      if (!reservation) return false;

      const [recorded] = await input.tx.update(appRuns).set({
        budget_reserved_at: input.now,
        budget_reserved_count: 1,
        budget_limit_at_reservation: reservation.limit,
        updated_at: input.now,
      }).where(and(
        eq(appRuns.org_id, input.org_id),
        eq(appRuns.id, input.run.id),
        isNull(appRuns.budget_reserved_at),
      )).returning({ id: appRuns.id });
      return Boolean(recorded);
    } catch {
      return false;
    }
  }

  async #loadInternalRun(
    tx: AppRunTransaction,
    orgId: string,
    runId: string,
  ): Promise<InternalRunAuthorization | null> {
    const [row] = await tx.select({
      authorization_snapshot: appRuns.authorization_snapshot,
      provider_snapshot_id: appRuns.provider_snapshot_id,
      origin_app_installation_id: appRuns.origin_app_installation_id,
      origin_app_version_id: appRuns.origin_app_version_id,
      origin_app_binding_key: appRuns.origin_app_binding_key,
      origin_app_grant_snapshot_id: appRuns.origin_app_grant_snapshot_id,
      safe_preview: appRuns.safe_preview,
      budget_reserved_at: appRuns.budget_reserved_at,
      budget_reserved_count: appRuns.budget_reserved_count,
      budget_limit_at_reservation: appRuns.budget_limit_at_reservation,
    }).from(appRuns).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, runId))).limit(1);
    return row ?? null;
  }

  async #matchesLiveState(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    internal: InternalRunAuthorization,
  ): Promise<boolean> {
    const stored = AppRunAuthorizationSnapshotSchema.parse(internal.authorization_snapshot);
    if (
      stored.authenticated_subject.actor_type !== run.initiating_actor_type
      || actorIdentity(stored.authenticated_subject) !== run.initiating_actor_id
    ) return false;

    const storedBaseRefs = stored.authority_refs.filter((ref) => !isAppAuthorityRef(ref));
    const storedAppRefs = stored.authority_refs.filter(isAppAuthorityRef);
    const surfaceRef = storedAppRefs.find((ref) => ref.authority_kind === 'app_surface');
    const surface = surfaceRef ? AppRunCallerSurfaceSchema.parse(surfaceRef.authority_id) : null;
    if ((run.origin_kind === 'app') !== (surface !== null)) return false;
    const tokenAuthorities = storedBaseRefs
      .filter((ref) => ref.authority_kind === 'token_scope')
      .map((ref) => ({ token_id: ref.authority_id }));
    const current = await this.#capture(tx, {
      org_id: run.org_id,
      authenticated_subject: stored.authenticated_subject,
      execution_actor: runActor(run.execution_actor_type, run.execution_actor_id),
      provider_instance_id: run.provider_instance_id,
      provider_snapshot_id: internal.provider_snapshot_id,
      operation_name: run.operation_name,
      policy: {
        risk_class: run.risk_class,
        review_requirement: run.review_requirement,
        review_scope: run.review_scope,
        retry_class: run.retry_class,
      },
      required_token_scopes: surface?.endsWith(':mcp') ? APP_MCP_INVOKE_SCOPES : [],
      token_authorities: await Promise.all(tokenAuthorities.map(async ({ token_id }) => ({
        token_id,
        token_kind: await this.#tokenKind(tx, run.org_id, token_id),
      }))),
    });
    if (!sameAuthorityRefs(storedBaseRefs, current.authority_refs)) return false;
    if (!surface) return storedAppRefs.length === 0;
    const currentApp = await this.#captureAppVectorFromRun(
      tx,
      run,
      internal,
      current,
      surface,
      storedAppRefs,
    );
    return sameAuthorityRefs(storedAppRefs, projectPreparedAppAuthorityRefs(currentApp));
  }

  async #captureAppVectorFromRun(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    internal: InternalRunAuthorization,
    baseAuthorization: AppRunAuthorizationSnapshot,
    callerSurface: z.infer<typeof AppRunCallerSurfaceSchema>,
    storedAppRefs: readonly AuthorityRef[],
  ): Promise<AppRunPreparedAuthorityVector> {
    if (
      !internal.origin_app_installation_id
      || !internal.origin_app_version_id
      || !internal.origin_app_binding_key
      || !internal.origin_app_grant_snapshot_id
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const preview = AppRunSafePreviewSchema.parse(internal.safe_preview);
    const resourceRefs = preview.resource_refs.map((resource) => {
      const match = /^module:([^:]+):([^:]+)$/u.exec(resource.resource_kind);
      if (!match) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      return ModuleResourceRefV1Schema.parse({
        schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module', provider_instance_id: match[1] },
        resource_type: match[2],
        resource_id: resource.resource_id,
      });
    });
    if (resourceRefs.length < 2) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const relationRefs = await this.#relationRefsFromStored(
      tx,
      run.org_id,
      resourceRefs,
      storedAppRefs.filter((ref) => ref.authority_kind === 'relation'),
    );
    const [snapshot] = await tx.select({
      snapshot_digest: capabilityProviderSnapshots.snapshot_digest,
    }).from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, run.org_id),
      eq(capabilityProviderSnapshots.id, internal.provider_snapshot_id),
    )).limit(1);
    if (!snapshot) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    return this.#captureAppVector(tx, {
      org_id: run.org_id,
      initiating_actor: runActor(run.initiating_actor_type, run.initiating_actor_id),
      execution_actor: runActor(run.execution_actor_type, run.execution_actor_id),
      installation_id: internal.origin_app_installation_id,
      app_version_id: internal.origin_app_version_id,
      binding_key: internal.origin_app_binding_key,
      grant_snapshot_id: internal.origin_app_grant_snapshot_id,
      provider_instance_id: run.provider_instance_id,
      provider_snapshot_id: internal.provider_snapshot_id,
      provider_snapshot_digest: snapshot.snapshot_digest,
      operation_name: run.operation_name,
      policy: {
        risk_class: run.risk_class,
        review_requirement: run.review_requirement,
        review_scope: run.review_scope,
        retry_class: run.retry_class,
      },
      base_authorization: baseAuthorization,
      caller_surface: callerSurface,
      resource_refs: resourceRefs,
      relation_refs: relationRefs,
    });
  }

  async #relationRefsFromStored(
    tx: AppRunTransaction,
    orgId: string,
    resources: readonly ModuleResourceRefV1[],
    stored: readonly AuthorityRef[],
  ): Promise<AppVectorCaptureInput['relation_refs']> {
    const source = resources[0]!;
    const targets = new Map(resources.slice(1).map((ref) => [appResourceAuthorityId(ref), ref]));
    const sets = await tx.select().from(resourceRelationSets).where(and(
      eq(resourceRelationSets.org_id, orgId),
      eq(resourceRelationSets.source_provider_kind, source.provider.kind),
      eq(resourceRelationSets.source_provider_instance_id, source.provider.provider_instance_id),
      eq(resourceRelationSets.source_resource_type, source.resource_type),
      eq(resourceRelationSets.source_resource_id, source.resource_id),
    ));
    if (sets.length === 0) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const edges = await tx.select().from(resourceRelationEdges).where(and(
      eq(resourceRelationEdges.org_id, orgId),
      inArray(resourceRelationEdges.relation_set_id, sets.map((set) => set.id)),
      eq(resourceRelationEdges.is_deleted, false),
    ));
    const expectedIds = new Set(stored.map((ref) => ref.authority_id));
    const result: Array<AppVectorCaptureInput['relation_refs'][number]> = [];
    for (const set of sets) {
      for (const edge of edges.filter((candidate) => candidate.relation_set_id === set.id)) {
        const selected = ModuleResourceRefV1Schema.safeParse({
          schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
          provider: {
            kind: edge.target_provider_kind,
            provider_instance_id: edge.target_provider_instance_id,
          },
          resource_type: edge.target_resource_type,
          resource_id: edge.target_resource_id,
        });
        if (!selected.success || !targets.has(appResourceAuthorityId(selected.data))) continue;
        const relation = {
          source_ref: source,
          relation_key: set.relation_key,
          selected_ref: selected.data,
        };
        if (expectedIds.has(appRelationAuthorityId(relation))) result.push(relation);
      }
    }
    if (result.length !== stored.length) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    return result;
  }

  async #captureAppVector(
    tx: AppRunTransaction,
    input: AppVectorCaptureInput,
  ): Promise<AppRunPreparedAuthorityVector> {
    const hasToken = input.base_authorization.authority_refs.some(
      (ref) => ref.authority_kind === 'token_scope',
    );
    if (
      !actorMatchesSurface(input.initiating_actor, input.caller_surface, hasToken)
      || !actorMatchesSurface(input.execution_actor, input.caller_surface, hasToken)
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    if (input.initiating_actor.actor_type === 'human') {
      const [member] = await tx.select({ role: orgMembers.role }).from(orgMembers).where(and(
        eq(orgMembers.org_id, input.org_id),
        eq(orgMembers.user_id, input.initiating_actor.user_id),
        eq(orgMembers.is_active, true),
      )).limit(1);
      if (!member || member.role === 'guest') throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }

    const [installation] = await tx.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, input.org_id),
      eq(appInstallations.id, input.installation_id),
      eq(appInstallations.state, 'active'),
      eq(appInstallations.active_version_id, input.app_version_id),
      eq(appInstallations.active_grant_snapshot_id, input.grant_snapshot_id),
      eq(appInstallations.active_grant_snapshot_kind, 'effective'),
    )).limit(1);
    const [version] = await tx.select().from(appVersions).where(and(
      eq(appVersions.org_id, input.org_id),
      eq(appVersions.installation_id, input.installation_id),
      eq(appVersions.id, input.app_version_id),
      eq(appVersions.protocol_version, '1'),
      eq(appVersions.state, 'active'),
    )).limit(1);
    const [grant] = await tx.select().from(appGrantSnapshots).where(and(
      eq(appGrantSnapshots.org_id, input.org_id),
      eq(appGrantSnapshots.app_installation_id, input.installation_id),
      eq(appGrantSnapshots.app_version_id, input.app_version_id),
      eq(appGrantSnapshots.id, input.grant_snapshot_id),
      eq(appGrantSnapshots.snapshot_kind, 'effective'),
    )).limit(1);
    const [binding] = await tx.select().from(appActionBindings).where(and(
      eq(appActionBindings.org_id, input.org_id),
      eq(appActionBindings.app_installation_id, input.installation_id),
      eq(appActionBindings.app_version_id, input.app_version_id),
      eq(appActionBindings.grant_snapshot_id, input.grant_snapshot_id),
      eq(appActionBindings.action_key, input.binding_key),
      eq(appActionBindings.provider_kind, 'mcp'),
      eq(appActionBindings.mcp_connection_id, input.provider_instance_id),
      eq(appActionBindings.provider_snapshot_id, input.provider_snapshot_id),
      eq(appActionBindings.operation_name, input.operation_name),
    )).limit(1);
    if (!installation || !version || !grant || !binding) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    if (
      grant.snapshot_digest !== digestAppGrantValue(grant.canonical_snapshot)
      || grant.manifest_digest !== version.manifest_digest
      || grant.package_digest !== version.package_digest
      || binding.binding_digest !== digestAppGrantValue(binding.canonical_binding)
      || binding.risk_class !== input.policy.risk_class
      || binding.review_requirement !== input.policy.review_requirement
      || binding.review_scope !== input.policy.review_scope
      || binding.retry_class !== input.policy.retry_class
      || binding.retention_class !== 'standard'
      || binding.automation_eligibility !== 'forbidden'
      || binding.provider_idempotency_key_required !== true
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');

    const [providerSnapshot] = await tx.select().from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, input.org_id),
      eq(capabilityProviderSnapshots.id, input.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_kind, 'mcp'),
      eq(capabilityProviderSnapshots.provider_instance_id, input.provider_instance_id),
      eq(capabilityProviderSnapshots.snapshot_digest, input.provider_snapshot_digest),
    )).limit(1);
    if (!providerSnapshot) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const snapshot = CapabilityProviderDiscoverySnapshotSchema.parse(providerSnapshot.safe_snapshot);
    const operation = snapshot.operations.find(
      (candidate) => candidate.identity.operation_name === input.operation_name,
    );
    if (
      snapshot.snapshot_digest !== providerSnapshot.snapshot_digest
      || !operation
      || operation.schema_digest !== binding.operation_schema_digest
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');

    const dependencyRows = await tx.select().from(appDependencyLocks).where(and(
      eq(appDependencyLocks.org_id, input.org_id),
      eq(appDependencyLocks.app_installation_id, input.installation_id),
      eq(appDependencyLocks.app_version_id, input.app_version_id),
      eq(appDependencyLocks.grant_snapshot_id, input.grant_snapshot_id),
      eq(appDependencyLocks.grant_snapshot_kind, 'effective'),
    ));
    const dependencies: AppRunPreparedAuthorityVector['dependencies'][number][] = [];
    for (const dependency of dependencyRows) {
      const [current] = await tx.select().from(appInstallations).where(and(
        eq(appInstallations.org_id, input.org_id),
        eq(appInstallations.id, dependency.dependency_installation_id),
        eq(appInstallations.app_id, dependency.required_app_id),
        eq(appInstallations.state, 'active'),
        eq(appInstallations.active_version_id, dependency.dependency_version_id),
        eq(appInstallations.lifecycle_epoch, dependency.dependency_lifecycle_epoch),
      )).limit(1);
      const [dependencyVersion] = await tx.select().from(appVersions).where(and(
        eq(appVersions.org_id, input.org_id),
        eq(appVersions.installation_id, dependency.dependency_installation_id),
        eq(appVersions.id, dependency.dependency_version_id),
        eq(appVersions.manifest_digest, dependency.dependency_manifest_digest),
        eq(appVersions.package_digest, dependency.dependency_package_digest),
        eq(appVersions.state, 'active'),
      )).limit(1);
      if (
        !current
        || !dependencyVersion
        || dependency.lock_digest !== digestAppGrantValue(dependency.canonical_lock)
      ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      dependencies.push({
        dependency_key: dependency.dependency_key,
        installation_id: dependency.dependency_installation_id,
        version_id: dependency.dependency_version_id,
        lifecycle_epoch: dependency.dependency_lifecycle_epoch,
        lock_digest: dependency.lock_digest,
      });
    }
    dependencies.sort((left, right) => left.dependency_key.localeCompare(right.dependency_key));

    const manifest = DeftAppManifestV1Schema.parse(version.manifest);
    const dependencyByKey = new Map(dependencyRows.map((row) => [row.dependency_key, row]));
    const resourceAncestry = new Set<string>();
    for (const requirement of manifest.resource_requirements) {
      const dependency = requirement.source.kind === 'dependency_module'
        ? dependencyByKey.get(requirement.source.dependency_key)
        : undefined;
      const ownerInstallationId = requirement.source.kind === 'included_module'
        ? installation.id
        : dependency?.dependency_installation_id;
      const ownerVersionId = requirement.source.kind === 'included_module'
        ? version.id
        : dependency?.dependency_version_id;
      if (!ownerInstallationId || !ownerVersionId) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      const [moduleBinding] = await tx.select({
        module_installation_id: appModuleBindings.module_installation_id,
        version: moduleVersions.version,
        is_active: moduleVersions.is_active,
      }).from(appModuleBindings).innerJoin(moduleVersions, and(
        eq(moduleVersions.org_id, appModuleBindings.org_id),
        eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
        eq(moduleVersions.id, appModuleBindings.module_version_id),
      )).where(and(
        eq(appModuleBindings.org_id, input.org_id),
        eq(appModuleBindings.app_installation_id, ownerInstallationId),
        eq(appModuleBindings.app_version_id, ownerVersionId),
        eq(appModuleBindings.module_id, requirement.source.module_id),
      )).limit(1);
      if (
        !moduleBinding
        || !moduleBinding.is_active
        || moduleBinding.version !== requirement.source.version
      ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      resourceAncestry.add(
        `${moduleBinding.module_installation_id}\0${requirement.resource_type}`,
      );
    }

    const resources: AppRunPreparedAuthorityVector['resources'][number][] = [];
    for (const ref of input.resource_refs) {
      if (!resourceAncestry.has(`${ref.provider.provider_instance_id}\0${ref.resource_type}`)) {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      const [moduleInstallation] = await tx.select().from(moduleInstallations).where(and(
        eq(moduleInstallations.org_id, input.org_id),
        eq(moduleInstallations.id, ref.provider.provider_instance_id),
        eq(moduleInstallations.is_enabled, true),
        eq(moduleInstallations.is_deleted, false),
      )).limit(1);
      const [activeVersion] = await tx.select().from(moduleVersions).where(and(
        eq(moduleVersions.org_id, input.org_id),
        eq(moduleVersions.installation_id, ref.provider.provider_instance_id),
        eq(moduleVersions.is_active, true),
      )).limit(1);
      const [record] = await tx.select().from(moduleRecords).where(and(
        eq(moduleRecords.org_id, input.org_id),
        eq(moduleRecords.installation_id, ref.provider.provider_instance_id),
        eq(moduleRecords.collection_key, ref.resource_type),
        eq(moduleRecords.id, ref.resource_id),
        eq(moduleRecords.is_deleted, false),
      )).limit(1);
      if (!moduleInstallation || !activeVersion || !record) {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      if (
        (input.caller_surface === 'defty' || input.caller_surface.startsWith('agent_employee:'))
        && moduleInstallation.agent_access === 'none'
      ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      const [validatedVersion] = await tx.select().from(moduleVersions).where(and(
        eq(moduleVersions.org_id, input.org_id),
        eq(moduleVersions.installation_id, ref.provider.provider_instance_id),
        eq(moduleVersions.id, record.validated_version_id),
      )).limit(1);
      if (!validatedVersion) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      resources.push({
        ref,
        revision: record.revision,
        active_manifest_digest: activeVersion.manifest_digest,
        validated_manifest_digest: validatedVersion.manifest_digest,
        updated_at: record.updated_at.toISOString(),
      });
    }
    resources.sort((left, right) => appResourceAuthorityId(left.ref).localeCompare(
      appResourceAuthorityId(right.ref),
    ));

    const resourceIds = new Set(resources.map((resource) => appResourceAuthorityId(resource.ref)));
    const relations: AppRunPreparedAuthorityVector['relations'][number][] = [];
    for (const relation of input.relation_refs) {
      if (
        !resourceIds.has(appResourceAuthorityId(relation.source_ref))
        || !resourceIds.has(appResourceAuthorityId(relation.selected_ref))
      ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      const [set] = await tx.select().from(resourceRelationSets).where(and(
        eq(resourceRelationSets.org_id, input.org_id),
        eq(resourceRelationSets.source_provider_kind, relation.source_ref.provider.kind),
        eq(resourceRelationSets.source_provider_instance_id, relation.source_ref.provider.provider_instance_id),
        eq(resourceRelationSets.source_resource_type, relation.source_ref.resource_type),
        eq(resourceRelationSets.source_resource_id, relation.source_ref.resource_id),
        eq(resourceRelationSets.relation_key, relation.relation_key),
      )).limit(1);
      if (!set) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      const [edge] = await tx.select({ id: resourceRelationEdges.id }).from(resourceRelationEdges).where(and(
        eq(resourceRelationEdges.org_id, input.org_id),
        eq(resourceRelationEdges.relation_set_id, set.id),
        eq(resourceRelationEdges.target_provider_kind, relation.selected_ref.provider.kind),
        eq(resourceRelationEdges.target_provider_instance_id, relation.selected_ref.provider.provider_instance_id),
        eq(resourceRelationEdges.target_resource_type, relation.selected_ref.resource_type),
        eq(resourceRelationEdges.target_resource_id, relation.selected_ref.resource_id),
        eq(resourceRelationEdges.is_deleted, false),
      )).limit(1);
      if (!edge) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      relations.push({ ...relation, revision: set.revision });
    }
    relations.sort((left, right) => appRelationAuthorityId(left).localeCompare(
      appRelationAuthorityId(right),
    ));

    return {
      schema_version: 'deft.app_action_authority.v1',
      caller_surface: input.caller_surface,
      installation: {
        id: installation.id,
        lifecycle_epoch: installation.lifecycle_epoch,
        grant_epoch: installation.grant_epoch,
      },
      app_version: {
        id: version.id,
        manifest_digest: version.manifest_digest,
        package_digest: version.package_digest,
      },
      grant: { id: grant.id, snapshot_digest: grant.snapshot_digest },
      binding: {
        id: binding.id,
        action_key: binding.action_key,
        binding_digest: binding.binding_digest,
        connector_authorization_version: binding.connector_authorization_version,
      },
      dependencies,
      provider: {
        connection_id: binding.mcp_connection_id,
        snapshot_id: binding.provider_snapshot_id,
        snapshot_digest: providerSnapshot.snapshot_digest,
        operation_name: binding.operation_name,
        operation_schema_digest: binding.operation_schema_digest,
      },
      run_authorization: input.base_authorization,
      resources,
      relations,
    };
  }

  async #capture(
    tx: AppRunTransaction,
    input: AppRunAuthorizationCapture,
  ): Promise<AppRunAuthorizationSnapshot> {
    const refs = new Map<string, AuthorityRef>();
    const add = (ref: AuthorityRef): void => {
      refs.set(`${ref.authority_kind}\0${ref.authority_id}`, ref);
    };

    const employees = new Map<string, typeof agentEmployees.$inferSelect>();
    const captureActor = async (actor: AppRunActor, reserveBudgetAuthority: boolean): Promise<void> => {
      if (actor.actor_type === 'system' || actor.actor_type === 'automation') {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      if (actor.actor_type === 'human') {
        add(await this.#membership(tx, input.org_id, actor.user_id));
        return;
      }
      let employee = employees.get(actor.agent_employee_id);
      if (!employee) {
        employee = await this.#employee(tx, input.org_id, actor.agent_employee_id);
        employees.set(actor.agent_employee_id, employee);
        add(await this.#membership(tx, input.org_id, employee.user_id));
        add({
          authority_kind: 'employee_health',
          authority_id: employee.id,
          version: authorityVersion('employee_health', {
            id: employee.id,
            authority_version: employee.app_run_authorization_version,
          }),
        });
      }
      if (reserveBudgetAuthority) {
        add({
          authority_kind: 'employee_budget',
          authority_id: employee.id,
          version: authorityVersion('employee_budget', {
            id: employee.id,
            authority_version: employee.app_run_authorization_version,
          }),
        });
      }
    };

    await captureActor(input.authenticated_subject, false);
    await captureActor(
      input.execution_actor,
      input.execution_actor.actor_type === 'agent_employee' && input.policy.risk_class !== 'read',
    );

    const [connection] = await tx.select().from(mcpConnections).where(and(
      eq(mcpConnections.org_id, input.org_id),
      eq(mcpConnections.id, input.provider_instance_id),
      eq(mcpConnections.is_active, true),
    )).limit(1);
    if (!connection || !isMcpToolEnabled(connection.enabled_tools, connection.slug, input.operation_name)) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    const overrideRows = await tx.select().from(mcpToolOverrides).where(and(
      eq(mcpToolOverrides.org_id, input.org_id),
      eq(mcpToolOverrides.mcp_connection_id, connection.id),
    ));
    const operationOverrides = overrideRows.filter(
      (row) => canonicalMcpToolName(row.tool_name) === input.operation_name,
    );
    if (operationOverrides.some((row) => row.is_disabled)) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    add({
      authority_kind: 'connector',
      authority_id: connection.id,
      version: authorityVersion('connector', {
        id: connection.id,
        authority_version: connection.app_run_authorization_version,
        overrides: operationOverrides
          .map((row) => ({
            id: row.id,
            authority_version: row.app_run_authorization_version,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }),
    });

    if (input.execution_actor.actor_type === 'agent_employee') {
      const employee = employees.get(input.execution_actor.agent_employee_id)!;
      if (!(employee.mcp_connection_ids ?? []).includes(connection.id)) {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      if ((employee.disabled_tools ?? []).some(
        (name) => canonicalMcpToolName(name) === input.operation_name,
      )) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      add({
        authority_kind: 'assignment',
        authority_id: `${employee.id}:${connection.id}`,
        version: authorityVersion('assignment', {
          employee_id: employee.id,
          connection_id: connection.id,
          employee_authority_version: employee.app_run_authorization_version,
          connector_authority_version: connection.app_run_authorization_version,
        }),
      });
    }

    const [snapshotRow] = await tx.select().from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, input.org_id),
      eq(capabilityProviderSnapshots.id, input.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_kind, 'mcp'),
      eq(capabilityProviderSnapshots.provider_instance_id, connection.id),
    )).limit(1);
    if (!snapshotRow) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const snapshot = CapabilityProviderDiscoverySnapshotSchema.parse(snapshotRow.safe_snapshot);
    if (
      snapshot.snapshot_digest !== snapshotRow.snapshot_digest
      || snapshot.adapter_contract_version !== snapshotRow.adapter_contract_version
    ) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    const operation = snapshot.operations.find(
      (candidate) => candidate.identity.operation_name === input.operation_name,
    );
    if (!operation) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    add({
      authority_kind: 'provider_schema',
      authority_id: `${connection.id}:${input.operation_name}`,
      version: authorityVersion('provider_schema', {
        snapshot_id: snapshotRow.id,
        snapshot_digest: snapshotRow.snapshot_digest,
        adapter_contract_version: snapshotRow.adapter_contract_version,
        schema_digest: operation.schema_digest,
      }),
    });
    add({
      authority_kind: 'policy',
      authority_id: `${connection.id}:${input.operation_name}`,
      version: authorityVersion('policy', {
        host_policy_version: HOST_POLICY_VERSION,
        policy: input.policy,
      }),
    });

    for (const token of input.token_authorities ?? []) {
      add(await this.#tokenAuthority(tx, input, token));
    }

    return AppRunAuthorizationSnapshotSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      authenticated_subject: input.authenticated_subject,
      authority_refs: [...refs.values()].sort((left, right) => {
        const leftKey = `${left.authority_kind}\0${left.authority_id}`;
        const rightKey = `${right.authority_kind}\0${right.authority_id}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    });
  }

  async #membership(tx: AppRunTransaction, orgId: string, userId: string): Promise<AuthorityRef> {
    const [membership] = await tx.select().from(orgMembers).where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, userId),
      eq(orgMembers.is_active, true),
    )).limit(1);
    if (!membership) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    return {
      authority_kind: 'membership',
      authority_id: userId,
      version: authorityVersion('membership', {
        id: membership.id,
        authority_version: membership.app_run_authorization_version,
      }),
    };
  }

  async #employee(tx: AppRunTransaction, orgId: string, employeeId: string) {
    const [employee] = await tx.select().from(agentEmployees).where(and(
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.id, employeeId),
      eq(agentEmployees.is_active, true),
      eq(agentEmployees.is_deleted, false),
      eq(agentEmployees.unhealthy, false),
    )).limit(1);
    if (!employee) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    return employee;
  }

  async #tokenKind(
    tx: AppRunTransaction,
    orgId: string,
    tokenId: string,
  ): Promise<AppRunTokenAuthority['token_kind']> {
    const [mcp] = await tx.select({ id: mcpTokens.id }).from(mcpTokens).where(and(
      eq(mcpTokens.org_id, orgId), eq(mcpTokens.id, tokenId),
    )).limit(1);
    if (mcp) return 'mcp';
    const [oauth] = await tx.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(and(
      eq(oauthAccessTokens.org_id, orgId), eq(oauthAccessTokens.id, tokenId),
    )).limit(1);
    if (oauth) return 'oauth';
    throw new Error('APP_RUN_AUTHORIZATION_STALE');
  }

  async #tokenAuthority(
    tx: AppRunTransaction,
    input: TokenScopeCheckInput,
    token: AppRunTokenAuthority,
  ): Promise<AppRunReadAuthorityRef> {
    if (token.token_kind === 'mcp') {
      const [row] = await tx.select().from(mcpTokens).where(and(
        eq(mcpTokens.org_id, input.org_id),
        eq(mcpTokens.id, token.token_id),
        isNull(mcpTokens.revoked_at),
      )).limit(1);
      if (!row) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      if ((input.required_token_scopes ?? []).some((scope) => !row.scopes.includes(scope))) {
        throw new Error('APP_RUN_AUTHORIZATION_STALE');
      }
      const subjectMatches = input.authenticated_subject.actor_type === 'human'
        ? row.principal_kind === 'human' && row.user_id === input.authenticated_subject.user_id
        : input.authenticated_subject.actor_type === 'agent_employee'
          && row.principal_kind === 'agent'
          && row.agent_employee_id === input.authenticated_subject.agent_employee_id;
      if (!subjectMatches) throw new Error('APP_RUN_AUTHORIZATION_STALE');
      return {
        authority_kind: 'token_scope',
        authority_id: row.id,
        version: authorityVersion('mcp_token_scope', {
          id: row.id,
          authority_version: row.app_run_authorization_version,
        }),
      };
    }

    if (input.authenticated_subject.actor_type !== 'human') {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    const [row] = await tx.select().from(oauthAccessTokens).where(and(
      eq(oauthAccessTokens.org_id, input.org_id),
      eq(oauthAccessTokens.id, token.token_id),
      eq(oauthAccessTokens.user_id, input.authenticated_subject.user_id),
      isNull(oauthAccessTokens.revoked_at),
      sql`${oauthAccessTokens.expires_at} > now()`,
    )).limit(1);
    if (!row) throw new Error('APP_RUN_AUTHORIZATION_STALE');
    if ((input.required_token_scopes ?? []).some((scope) => !row.scopes.includes(scope))) {
      throw new Error('APP_RUN_AUTHORIZATION_STALE');
    }
    return {
      authority_kind: 'token_scope',
      authority_id: row.id,
      version: authorityVersion('oauth_token_scope', {
        id: row.id,
        authority_version: row.app_run_authorization_version,
      }),
    };
  }
}
