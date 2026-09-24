import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  appRuns,
  appRuntimeBindings, appRuntimeRegistrations, appRuntimeSessions,
  auditLog, orgMembers,
} from '@deft/db/schema';
import { createCapabilityProviderDiscoverySnapshot } from '@deft/shared';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { isModuleError } from './module-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { persistCapabilityProviderSnapshotWithExecutor } from './capability-provider-snapshot-repository.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { loadReviewedRuntimeAction } from './app-runtime-review.js';
import { APP_RUNTIME_CHANNEL_VERSION } from './app-runtime-contract.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import { issueAppRuntimeSession } from './app-runtime-authority.js';

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ActionKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((value) => !/^(deft|core|system)(_|$)/.test(value));

export const RuntimeReviewInputSchema = z.strictObject({
  installation_id: Id,
  action_key: ActionKey,
  operator_user_id: Id,
  expected_app_version_id: Id,
  expected_package_digest: Digest,
  expected_grant_snapshot_digest: Digest,
  expected_lifecycle_epoch: z.number().int().nonnegative(),
  expected_grant_epoch: z.number().int().nonnegative(),
});
export const RuntimeActivateInputSchema = RuntimeReviewInputSchema.extend({
  expected_review_digest: Digest,
  accept_host_policy: z.literal(true),
});
export type RuntimeReviewInput = z.infer<typeof RuntimeReviewInputSchema>;
export type RuntimeActivateInput = z.infer<typeof RuntimeActivateInputSchema>;

type Manager = Extract<ModuleActor, { kind: 'human' }>;
function manager(actor: ModuleActor): asserts actor is Manager {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')
    || (actor.source !== 'ui' && actor.source !== 'rest')) {
    throw new AppError('Only interactive workspace owners and admins can review App runtimes',
      'APP_ACCESS_DENIED', 403);
  }
}
function stale(): never {
  throw new AppError('Reviewed App Runtime authority changed', 'APP_STALE', 409);
}
function denied(): never {
  throw new AppError('App Runtime authority unavailable', 'APP_ACCESS_DENIED', 403);
}

async function assertManager(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], actor: Manager) {
  try { await assertCurrentModuleManagerWithExecutor(tx, actor); }
  catch (error) {
    if (isModuleError(error)) denied();
    throw error;
  }
}

async function reviewContext(tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actor: Manager, input: RuntimeReviewInput) {
  // All Runtime management paths lock member rows before App. Sorting these
  // two identities also avoids owner A / operator B review racing with owner
  // B / operator A review in the opposite row order.
  for (const userId of [...new Set([actor.actor_id, input.operator_user_id])].sort()) {
    await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${actor.org_id}
      AND user_id = ${userId} FOR UPDATE`);
  }
  await assertManager(tx, actor);
  const [operator] = await tx.select({ is_active: orgMembers.is_active,
    role: orgMembers.role }).from(orgMembers).where(and(
      eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, input.operator_user_id),
    )).limit(1);
  if (!operator?.is_active || operator.role === 'guest') denied();
  await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
    AND id = ${input.installation_id} FOR UPDATE`);
  const reviewed = await loadReviewedRuntimeAction(tx, actor.org_id,
    input.installation_id, input.action_key);
  const { installation, version, grant, action } = reviewed;
  if (installation.state !== 'active'
    || installation.active_version_id !== version.id
    || installation.active_grant_snapshot_id !== grant.id
    || version.state !== 'active'
    || grant.snapshot_kind !== 'effective'
    || version.id !== input.expected_app_version_id
    || version.package_digest !== input.expected_package_digest
    || grant.snapshot_digest !== input.expected_grant_snapshot_digest
    || installation.lifecycle_epoch !== input.expected_lifecycle_epoch
    || installation.grant_epoch !== input.expected_grant_epoch
    || action.action_key !== input.action_key
    || action.host_policy.risk_class !== 'external_write'
    || action.host_policy.review_requirement !== 'always'
    || action.host_policy.review_scope !== 'per_invocation'
    || action.host_policy.retry_class !== 'unsafe_or_unknown'
    || action.host_policy.retention_class !== 'standard') stale();
  const review = Object.freeze({
    schema_version: 'deft.app_runtime_management_review.v1' as const,
    org_id: actor.org_id,
    installation_id: installation.id,
    app_version_id: version.id,
    grant_snapshot_id: grant.id,
    grant_snapshot_digest: grant.snapshot_digest,
    package_digest: version.package_digest,
    lifecycle_epoch: installation.lifecycle_epoch,
    grant_epoch: installation.grant_epoch,
    operator_user_id: input.operator_user_id,
    action_key: action.action_key,
    operation_name: action.operation_name,
    contract_digest: action.contract_digest,
    host_policy: action.host_policy,
  });
  return { ...reviewed, review: { ...review, review_digest: digestAppGrantValue(review) } };
}

export async function prepareRuntimeBindingReview(actor: ModuleActor, value: unknown) {
  manager(actor);
  const input = RuntimeReviewInputSchema.parse(value);
  return db.transaction(async (tx) => {
    const { review } = await reviewContext(tx, actor, input);
    return review;
  });
}

export async function activateRuntimeBinding(actor: ModuleActor, value: unknown) {
  manager(actor);
  const input = RuntimeActivateInputSchema.parse(value);
  return db.transaction(async (tx) => {
    const { installation, version, grant, action, review } = await reviewContext(tx, actor, input);
    if (review.review_digest !== input.expected_review_digest) stale();
    // One live binding for an action/version/grant. Historical revoked rows
    // remain immutable and may coexist with a later reviewed registration.
    const [existing] = await tx.select({ id: appRuntimeBindings.id }).from(appRuntimeBindings)
      .where(and(eq(appRuntimeBindings.org_id, actor.org_id),
        eq(appRuntimeBindings.app_installation_id, installation.id),
        eq(appRuntimeBindings.app_version_id, version.id),
        eq(appRuntimeBindings.grant_snapshot_id, grant.id),
        eq(appRuntimeBindings.action_key, action.action_key),
        inArray(appRuntimeBindings.state, ['disabled', 'active']))).limit(1);
    if (existing) throw new AppError('App Runtime action is already registered', 'APP_STATE_CONFLICT', 409);
    const now = new Date();
    const registrationId = randomUUID();
    const bindingId = randomUUID();
    await tx.insert(appRuntimeRegistrations).values({
      id: registrationId, org_id: actor.org_id,
      app_installation_id: installation.id, app_version_id: version.id,
      grant_snapshot_id: grant.id, operator_user_id: input.operator_user_id,
      contract_version: APP_RUNTIME_CHANNEL_VERSION, state: 'disabled',
      created_at: now, updated_at: now,
    });
    const provider = { org_id: actor.org_id, provider_kind: 'app_runtime' as const,
      provider_instance_id: registrationId };
    const providerSnapshot = await createCapabilityProviderDiscoverySnapshot({
      adapter_contract_version: APP_RUNTIME_CHANNEL_VERSION,
      provider, captured_at: now.toISOString(),
      operations: [{
        identity: { provider, operation_name: action.operation_name },
        title: action.action_key, description: '',
        input_schema: action.input_schema, output_schema: action.output_schema,
      }],
    });
    const providerSnapshotId = await persistCapabilityProviderSnapshotWithExecutor(tx, providerSnapshot);
    await tx.insert(appRuntimeBindings).values({
      id: bindingId, org_id: actor.org_id,
      app_installation_id: installation.id, app_version_id: version.id,
      grant_snapshot_id: grant.id, runtime_registration_id: registrationId,
      action_key: action.action_key,
      interface_identity: `deft.runtime.v1:${actor.org_id.toLowerCase()}:${installation.id.toLowerCase()}:${action.action_key}`,
      provider_kind: 'app_runtime', provider_instance_id: registrationId,
      provider_snapshot_id: providerSnapshotId, operation_name: action.operation_name,
      risk_class: action.host_policy.risk_class,
      review_requirement: action.host_policy.review_requirement,
      retry_class: action.host_policy.retry_class,
      retention_class: action.host_policy.retention_class,
      state: 'disabled', created_at: now, updated_at: now,
    });
    await tx.update(appRuntimeRegistrations).set({ state: 'active', runtime_epoch: 1,
      reviewed_by_user_id: actor.actor_id, reviewed_at: now, updated_at: now })
      .where(and(eq(appRuntimeRegistrations.org_id, actor.org_id),
        eq(appRuntimeRegistrations.id, registrationId)));
    await tx.update(appRuntimeBindings).set({ state: 'active',
      reviewed_by_user_id: actor.actor_id, reviewed_at: now, updated_at: now })
      .where(and(eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.id, bindingId)));
    await tx.insert(auditLog).values({
      org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
      action: 'app.runtime_review_activate', entity_type: 'app_runtime_binding', entity_id: bindingId,
      before_state: null,
      after_state: { registration_id: registrationId, binding_id: bindingId,
        installation_id: installation.id, app_version_id: version.id,
        grant_snapshot_id: grant.id, action_key: action.action_key,
        contract_digest: action.contract_digest, review_digest: review.review_digest },
      metadata: { source: actor.source },
    });
    return Object.freeze({ registration_id: registrationId, binding_id: bindingId,
      app_version_id: version.id, grant_snapshot_id: grant.id,
      action_key: action.action_key, review_digest: review.review_digest });
  });
}

export async function issueRuntimeOperatorSession(actor: ModuleActor, bindingId: string) {
  if (actor.kind !== 'human' || (actor.source !== 'ui' && actor.source !== 'rest')) denied();
  if (!appRuntimeChannelEnabled()) {
    throw new AppError('App Runtime channel is disabled', 'APP_FEATURE_DISABLED', 503);
  }
  const issued = await issueAppRuntimeSession({ org_id: actor.org_id,
    runtime_binding_id: Id.parse(bindingId), operator_user_id: actor.actor_id });
  if (!issued) denied();
  return issued;
}

export async function revokeRuntimeBinding(actor: ModuleActor, bindingId: string) {
  manager(actor);
  return db.transaction(async (tx) => {
    await assertManager(tx, actor);
    const [locator] = await tx.select({ installation_id: appRuntimeBindings.app_installation_id,
      registration_id: appRuntimeBindings.runtime_registration_id })
      .from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id, actor.org_id),
        eq(appRuntimeBindings.id, Id.parse(bindingId)))).limit(1);
    if (!locator) throw new AppError('App Runtime binding not found', 'APP_NOT_FOUND', 404);
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
      AND id = ${locator.installation_id} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${actor.org_id}
      AND id = ${locator.registration_id} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM app_runtime_bindings WHERE org_id = ${actor.org_id}
      AND id = ${bindingId} FOR UPDATE`);
    const [binding] = await tx.select().from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.id, bindingId))).limit(1);
    if (!binding || binding.runtime_registration_id !== locator.registration_id
      || binding.app_installation_id !== locator.installation_id) stale();
    if (binding.state !== 'active') return { revoked: binding.state === 'revoked' };
    const now = new Date();
    await tx.update(appRuntimeBindings).set({ state: 'revoked', updated_at: now }).where(and(
      eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.id, bindingId)));
    await tx.update(appRuntimeSessions).set({ revoked_at: now, updated_at: now }).where(and(
      eq(appRuntimeSessions.org_id, actor.org_id), eq(appRuntimeSessions.runtime_binding_id, bindingId),
      sql`${appRuntimeSessions.revoked_at} IS NULL`));
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
      actor_id: actor.actor_id, action: 'app.runtime_binding_revoke',
      entity_type: 'app_runtime_binding', entity_id: bindingId,
      before_state: { state: binding.state }, after_state: { state: 'revoked' },
      metadata: { source: actor.source } });
    return { revoked: true };
  });
}

export async function revokeRuntimeRegistration(actor: ModuleActor, registrationId: string) {
  manager(actor);
  return db.transaction(async (tx) => {
    await assertManager(tx, actor);
    const [locator] = await tx.select({ installation_id: appRuntimeRegistrations.app_installation_id,
      contract_version: appRuntimeRegistrations.contract_version })
      .from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, actor.org_id),
        eq(appRuntimeRegistrations.id, Id.parse(registrationId)))).limit(1);
    if (!locator || locator.contract_version !== 'deft.app_runtime_channel.v1') {
      throw new AppError('App Runtime registration not found', 'APP_NOT_FOUND', 404);
    }
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
      AND id = ${locator.installation_id} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${actor.org_id}
      AND id = ${registrationId} FOR UPDATE`);
    const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
      eq(appRuntimeRegistrations.org_id, actor.org_id), eq(appRuntimeRegistrations.id, registrationId))).limit(1);
    if (!registration || registration.contract_version !== 'deft.app_runtime_channel.v1'
      || registration.app_installation_id !== locator.installation_id) stale();
    if (registration.state !== 'active') return { revoked: registration.state === 'revoked' };
    const now = new Date();
    await tx.update(appRuntimeRegistrations).set({ state: 'revoked',
      runtime_epoch: registration.runtime_epoch + 1, updated_at: now }).where(and(
      eq(appRuntimeRegistrations.org_id, actor.org_id), eq(appRuntimeRegistrations.id, registrationId)));
    await tx.update(appRuntimeBindings).set({ state: 'revoked', updated_at: now }).where(and(
      eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.runtime_registration_id, registrationId),
      eq(appRuntimeBindings.state, 'active')));
    await tx.update(appRuntimeSessions).set({ revoked_at: now, updated_at: now }).where(and(
      eq(appRuntimeSessions.org_id, actor.org_id), eq(appRuntimeSessions.runtime_registration_id, registrationId),
      sql`${appRuntimeSessions.revoked_at} IS NULL`));
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
      actor_id: actor.actor_id, action: 'app.runtime_registration_revoke',
      entity_type: 'app_runtime_registration', entity_id: registrationId,
      before_state: { state: registration.state, runtime_epoch: registration.runtime_epoch },
      after_state: { state: 'revoked', runtime_epoch: registration.runtime_epoch + 1 },
      metadata: { source: actor.source } });
    return { revoked: true };
  });
}

export async function revokeRuntimeSession(actor: ModuleActor, sessionId: string) {
  if (actor.kind !== 'human') denied();
  return db.transaction(async (tx) => {
    const [locator] = await tx.select({ operator_user_id: appRuntimeSessions.operator_user_id,
      registration_id: appRuntimeSessions.runtime_registration_id,
      binding_id: appRuntimeSessions.runtime_binding_id,
      audience: appRuntimeSessions.audience,
      resource_binding_id: appRuntimeSessions.resource_binding_id })
      .from(appRuntimeSessions).where(and(eq(appRuntimeSessions.org_id, actor.org_id),
        eq(appRuntimeSessions.id, Id.parse(sessionId)))).limit(1);
    if (!locator || locator.audience !== 'app_runtime' || !locator.binding_id
      || locator.resource_binding_id !== null) {
      throw new AppError('App Runtime session not found', 'APP_NOT_FOUND', 404);
    }
    if (locator.operator_user_id !== actor.actor_id) await assertManager(tx, actor);
    else await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${actor.org_id}
      AND user_id = ${actor.actor_id} FOR UPDATE`);
    const [registration] = await tx.select({ installation_id: appRuntimeRegistrations.app_installation_id })
      .from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, actor.org_id),
        eq(appRuntimeRegistrations.id, locator.registration_id))).limit(1);
    if (!registration) stale();
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
      AND id = ${registration.installation_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${actor.org_id}
      AND id = ${locator.registration_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_runtime_bindings WHERE org_id = ${actor.org_id}
      AND id = ${locator.binding_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_runtime_sessions WHERE org_id = ${actor.org_id}
      AND id = ${sessionId} FOR UPDATE`);
    const [session] = await tx.select().from(appRuntimeSessions).where(and(
      eq(appRuntimeSessions.org_id, actor.org_id), eq(appRuntimeSessions.id, sessionId))).limit(1);
    if (!session || session.audience !== 'app_runtime' || session.resource_binding_id !== null
      || session.operator_user_id !== locator.operator_user_id
      || session.runtime_binding_id !== locator.binding_id) stale();
    if (session.revoked_at) return { revoked: true };
    const now = new Date();
    await tx.update(appRuntimeSessions).set({ revoked_at: now, updated_at: now }).where(and(
      eq(appRuntimeSessions.org_id, actor.org_id), eq(appRuntimeSessions.id, sessionId)));
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human',
      actor_id: actor.actor_id, action: 'app.runtime_session_revoke',
      entity_type: 'app_runtime_session', entity_id: sessionId,
      before_state: { revoked: false }, after_state: { revoked: true },
      metadata: { source: actor.source } });
    return { revoked: true };
  });
}

/** Safe operator dashboard: no token hashes, input, output or claim tokens. */
export async function inspectRuntimeBinding(actor: ModuleActor, bindingId: string) {
  if (actor.kind !== 'human') denied();
  return db.transaction(async (tx) => {
    const [binding] = await tx.select().from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, actor.org_id), eq(appRuntimeBindings.id, Id.parse(bindingId)))).limit(1);
    if (!binding) throw new AppError('App Runtime binding not found', 'APP_NOT_FOUND', 404);
    const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
      eq(appRuntimeRegistrations.org_id, actor.org_id), eq(appRuntimeRegistrations.id, binding.runtime_registration_id))).limit(1);
    if (!registration) stale();
    if (registration.operator_user_id !== actor.actor_id) await assertManager(tx, actor);
    else {
      const [member] = await tx.select({ is_active: orgMembers.is_active }).from(orgMembers).where(and(
        eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id))).limit(1);
      if (!member?.is_active) denied();
    }
    const sessions = await tx.select({ id: appRuntimeSessions.id,
      expires_at: appRuntimeSessions.expires_at, revoked_at: appRuntimeSessions.revoked_at })
      .from(appRuntimeSessions).where(and(eq(appRuntimeSessions.org_id, actor.org_id),
        eq(appRuntimeSessions.runtime_binding_id, binding.id)))
      .orderBy(desc(appRuntimeSessions.created_at)).limit(20);
    const runs = await tx.select({ id: appRuns.id, state: appRuns.state,
      created_at: appRuns.created_at, updated_at: appRuns.updated_at })
      .from(appRuns).where(and(eq(appRuns.org_id, actor.org_id),
        eq(appRuns.origin_runtime_binding_id, binding.id)))
      .orderBy(desc(appRuns.created_at)).limit(50);
    const runCounts = await tx.select({ state: appRuns.state,
      count: sql<number>`count(*)::int` }).from(appRuns).where(and(
        eq(appRuns.org_id, actor.org_id),
        eq(appRuns.origin_runtime_binding_id, binding.id),
      )).groupBy(appRuns.state);
    const outstanding = runCounts.filter((row) => ['pending', 'pending_approval',
      'running', 'waiting_external', 'unknown_outcome'].includes(row.state))
      .reduce((sum, row) => sum + row.count, 0);
    return { binding: { id: binding.id, registration_id: registration.id,
      installation_id: binding.app_installation_id,
      app_version_id: binding.app_version_id, grant_snapshot_id: binding.grant_snapshot_id,
      action_key: binding.action_key, state: binding.state,
      registration_state: registration.state, runtime_epoch: registration.runtime_epoch,
      operator_user_id: registration.operator_user_id },
      sessions: sessions.map((session) => ({ id: session.id,
        expires_at: session.expires_at.toISOString(), revoked: session.revoked_at !== null })),
      drain: { drained: outstanding === 0, outstanding,
        run_state_counts: Object.fromEntries(runCounts.map((row) => [row.state, row.count])) },
      runs: runs.map((run) => ({ ...run, created_at: run.created_at.toISOString(),
        updated_at: run.updated_at.toISOString() })) };
  });
}
