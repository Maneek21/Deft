import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseRuntimeAppManifest, parseNativeAppManifest, PublicActionDeclarationSchema,
  NativePublicActionDeclarationSchema, PublicBudgetPolicySchema, PublicHmacPolicySchema } from '@deft/app-kit';
import { appModuleBindings, appNativeBindings, appPublicEndpoints, appPublicHmacKeys, appVersions, moduleInstallations,
  moduleVersions, users } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { PostgresAppRunLiveAuthorization } from './app-run-live-authorization.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { publicEndpointReviewDigest } from './app-public-service.js';
import { appRuntimeChannelEnabled } from './app-runtime-channel.js';
import { validatePublicAvailabilityPolicy, type PublicAvailabilityPolicy } from './app-public-availability.js';
import { publicEndpointBudget, PUBLIC_APP_BUDGET_CEILINGS } from './app-public-budgets.js';
import { sealPublicHmacSecret, publicAuthenticationPolicy } from './app-public-hmac.js';
import type { PublicManagementGuard } from './app-public-web-authority.js';
import { isAppNativeCalendarEnabled } from './env.js';
import { validatePublicNativeMapping } from './app-public-native-mapping.js';

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ActionKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const StagePublicEndpointFields = {
  installation_id: Id, public_action_key: ActionKey,
  approver_user_id: Id, public_label: z.string().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f<>]+$/),
  max_body_bytes: z.number().int().min(128).max(8192),
  budget_policy: PublicBudgetPolicySchema.optional(),
  authentication_policy: PublicHmacPolicySchema.optional(),
  expected_app_version_id: Id, expected_grant_snapshot_id: Id,
  expected_lifecycle_epoch: z.number().int().nonnegative(),
  expected_grant_epoch: z.number().int().positive(),
};
export const ActivatePublicEndpointSchema = z.strictObject({
  expected_review_digest: Digest, expected_endpoint_epoch: z.number().int().positive(),
  accept_host_policy: z.literal(true),
});
export const PublicBindingTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schema_version: z.literal('deft.app_public_binding_target.v2'), kind: z.literal('runtime'), runtime_binding_id: Id }),
  z.strictObject({ schema_version: z.literal('deft.app_public_binding_target.v2'), kind: z.literal('native'), native_binding_id: Id }),
]);
export const StagePublicEndpointSchema = z.union([
  z.strictObject({ ...StagePublicEndpointFields, runtime_binding_id: Id }),
  z.strictObject({ ...StagePublicEndpointFields, binding_target: PublicBindingTargetSchema }),
]);
export const RotatePublicHmacKeySchema = z.strictObject({
  expected_review_digest: Digest, expected_endpoint_epoch: z.number().int().positive(),
});
const stale = () => new AppError('Public endpoint authority changed', 'APP_STALE', 409);
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const liveAuthorizer = new PostgresAppRunLiveAuthorization();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function targetGate(native: boolean) {
  if (native ? !isAppNativeCalendarEnabled() : !appRuntimeChannelEnabled()) {
    throw new AppError(native ? 'Native Calendar unavailable' : 'App Runtime unavailable', 'APP_FEATURE_DISABLED', 503);
  }
}

async function nativeParticipants(tx: Tx, actor: ModuleActor, nativeBindingId: string): Promise<string[]> {
  const [locator] = await tx.select({ owner_user_id: appNativeBindings.owner_user_id,
    stage_manager_user_id: appNativeBindings.stage_manager_user_id }).from(appNativeBindings).where(and(
    eq(appNativeBindings.org_id, actor.org_id), eq(appNativeBindings.id, nativeBindingId))).limit(1);
  if (!locator) throw stale();
  const participants = [...new Set([actor.actor_id, locator.owner_user_id, locator.stage_manager_user_id])].sort();
  // The manager guard needs UPDATE, so take that mode in sorted order now.
  // Taking all SHARE then upgrading each caller could deadlock two managers.
  for (const userId of participants) {
    if (userId === actor.actor_id) await tx.execute(sql`SELECT id FROM org_members
      WHERE org_id=${actor.org_id} AND user_id=${userId} FOR UPDATE`);
    else await tx.execute(sql`SELECT id FROM org_members
      WHERE org_id=${actor.org_id} AND user_id=${userId} FOR SHARE`);
  }
  return participants;
}

async function finalManager(tx: Tx, actor: ModuleActor, guard?: PublicManagementGuard, nativeTarget = false,
  nativeParticipants?: readonly string[]) {
  const [human] = await tx.select({ kind: users.kind, is_agent: users.is_agent }).from(users).where(eq(users.id, actor.actor_id));
  if (!human || human.kind !== 'human' || human.is_agent) {
    throw new AppError('Public endpoint management access denied', 'APP_ACCESS_DENIED', 403);
  }
  if (nativeTarget && nativeParticipants) {
    const { nativeParticipantsAreHuman } = await import('./app-native-authority.js');
    if (!nativeParticipants.length || !await nativeParticipantsAreHuman(tx, nativeParticipants)) throw stale();
  }
  // The web guard rechecks the complete native human set after its final SID
  // wait, then samples the clock/gate. No awaited read follows that fence.
  if (guard) await guard(tx, nativeTarget ? 'native' : 'runtime', nativeParticipants);
  targetGate(nativeTarget);
}

function manager(actor: ModuleActor): void {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')
    || (actor.source !== 'ui' && actor.source !== 'rest')) {
    throw new AppError('Only interactive workspace owners and admins can review public endpoints',
      'APP_ACCESS_DENIED', 403);
  }
}

async function reviewedSetup(tx: Tx, input: Readonly<{
  org_id: string; installation_id: string; public_action_key: string;
  runtime_binding_id: string; approver_user_id: string;
}>) {
  targetGate(false);
  const runtime = await liveAuthorizer.captureReviewedRuntimeInTransaction(tx, {
    org_id: input.org_id, user_id: input.approver_user_id,
    runtime_binding_id: input.runtime_binding_id,
  });
  if (runtime.binding.app_installation_id !== input.installation_id
    || runtime.binding.risk_class !== 'external_write'
    || runtime.binding.review_requirement !== 'always'
    || runtime.binding.retry_class !== 'unsafe_or_unknown'
    || runtime.binding.retention_class !== 'standard'
    || runtime.action.host_policy.review_scope !== 'per_invocation') throw stale();
  const [version] = await tx.select({ manifest: appVersions.manifest,
    protocol_version: appVersions.protocol_version }).from(appVersions).where(and(
    eq(appVersions.org_id, input.org_id), eq(appVersions.id, runtime.binding.app_version_id),
  )).limit(1);
  if (!version || !['4', '6'].includes(version.protocol_version)) throw stale();
  const manifest = version.protocol_version === '6' ? parseNativeAppManifest(version.manifest) : parseRuntimeAppManifest(version.manifest);
  if (manifest.schema_version !== '4' && manifest.schema_version !== '6') throw stale();
  const found = manifest.public_actions.find((item) => item.key === input.public_action_key);
  if (!found || found.action_key !== runtime.action.action_key) throw stale();
  const declaration = PublicActionDeclarationSchema.parse(found);
  const [moduleBinding] = await tx.select().from(appModuleBindings).where(and(
    eq(appModuleBindings.org_id, input.org_id),
    eq(appModuleBindings.app_installation_id, input.installation_id),
    eq(appModuleBindings.app_version_id, runtime.binding.app_version_id),
    eq(appModuleBindings.module_id, declaration.module_id),
    eq(appModuleBindings.ownership, 'app'),
  )).limit(1);
  if (!moduleBinding) throw stale();
  const [module] = await tx.select().from(moduleInstallations).where(and(
    eq(moduleInstallations.org_id, input.org_id),
    eq(moduleInstallations.id, moduleBinding.module_installation_id),
  )).limit(1).for('share');
  const [moduleVersion] = await tx.select({ id: moduleVersions.id, manifest: moduleVersions.manifest }).from(moduleVersions).where(and(
    eq(moduleVersions.org_id, input.org_id),
    eq(moduleVersions.installation_id, moduleBinding.module_installation_id),
    eq(moduleVersions.id, moduleBinding.module_version_id),
    eq(moduleVersions.is_active, true),
  )).limit(1);
  if (!module || module.is_deleted || !module.is_enabled
    || module.module_id !== declaration.module_id || !moduleVersion) throw stale();
  let availabilityPolicy: PublicAvailabilityPolicy | null = null;
  if (declaration.availability) {
    try {
      availabilityPolicy = validatePublicAvailabilityPolicy({ ...declaration.availability,
        module_version_id: moduleVersion.id }, moduleVersion.manifest, declaration.collection_key, moduleVersion.id);
    } catch { throw stale(); }
  }
  return { kind: 'runtime' as const, runtime, declaration, moduleBinding, availabilityPolicy };
}

async function reviewedNativeSetup(tx: Tx, input: Readonly<{
  org_id: string; installation_id: string; public_action_key: string; native_binding_id: string;
  approver_user_id: string; prelocked_participant_ids: string[];
}>) {
  targetGate(true);
  const { loadLiveNativeAuthority } = await import('./app-native-authority.js');
  const native = await loadLiveNativeAuthority(tx, { org_id: input.org_id, native_binding_id: input.native_binding_id,
    prelocked_participant_ids: input.prelocked_participant_ids });
  if (native.binding.app_installation_id !== input.installation_id || native.binding.owner_user_id !== input.approver_user_id) throw stale();
  const found = native.manifest.public_actions.find(item => item.key === input.public_action_key);
  if (!found || found.action_key !== native.action.key) throw stale();
  const declaration = NativePublicActionDeclarationSchema.parse(found);
  const [moduleBinding] = await tx.select().from(appModuleBindings).where(and(
    eq(appModuleBindings.org_id, input.org_id), eq(appModuleBindings.app_installation_id, input.installation_id),
    eq(appModuleBindings.app_version_id, native.binding.app_version_id), eq(appModuleBindings.module_id, declaration.module_id),
    eq(appModuleBindings.ownership, 'app'))).limit(1);
  if (!moduleBinding) throw stale();
  const [module] = await tx.select().from(moduleInstallations).where(and(eq(moduleInstallations.org_id, input.org_id),
    eq(moduleInstallations.id, moduleBinding.module_installation_id))).limit(1).for('share');
  const [moduleVersion] = await tx.select({ id: moduleVersions.id, manifest: moduleVersions.manifest }).from(moduleVersions).where(and(
    eq(moduleVersions.org_id, input.org_id), eq(moduleVersions.installation_id, moduleBinding.module_installation_id),
    eq(moduleVersions.id, moduleBinding.module_version_id), eq(moduleVersions.is_active, true))).limit(1);
  if (!module || module.is_deleted || !module.is_enabled || module.module_id !== declaration.module_id || !moduleVersion) throw stale();
  let availabilityPolicy: PublicAvailabilityPolicy | null = null;
  try {
    validatePublicNativeMapping(declaration.input_mapping, moduleVersion.manifest, declaration.collection_key, native.action.operation);
    if (declaration.availability) availabilityPolicy = validatePublicAvailabilityPolicy({ ...declaration.availability,
      module_version_id: moduleVersion.id }, moduleVersion.manifest, declaration.collection_key, moduleVersion.id);
  } catch { throw stale(); }
  return { kind: 'native' as const, runtime: { binding: native.binding,
    installation_lifecycle_epoch: native.binding.installation_lifecycle_epoch,
    installation_grant_epoch: native.binding.installation_grant_epoch }, declaration, moduleBinding, availabilityPolicy };
}

export async function stagePublicEndpoint(actor: ModuleActor, raw: unknown, guard?: PublicManagementGuard) {
  manager(actor);
  const input = StagePublicEndpointSchema.parse(raw);
  const target = 'binding_target' in input ? input.binding_target : { kind: 'runtime' as const, runtime_binding_id: input.runtime_binding_id };
  targetGate(target.kind === 'native');
  const endpointId = randomUUID();
  const slug = randomBytes(32).toString('base64url');
  const slugDigest = hash(slug);
  return db.transaction(async (tx) => {
    const participants = target.kind === 'native' ? await nativeParticipants(tx, actor, target.native_binding_id) : [];
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const identity = {
      org_id: actor.org_id, installation_id: input.installation_id,
      public_action_key: input.public_action_key,
      approver_user_id: input.approver_user_id,
    };
    const setup = target.kind === 'native' ? await reviewedNativeSetup(tx, { ...identity,
      native_binding_id: target.native_binding_id, prelocked_participant_ids: participants })
      : await reviewedSetup(tx, { ...identity, runtime_binding_id: target.runtime_binding_id });
    const { runtime, declaration, moduleBinding, availabilityPolicy } = setup;
    if (runtime.binding.app_version_id !== input.expected_app_version_id
      || runtime.binding.grant_snapshot_id !== input.expected_grant_snapshot_id
      || runtime.installation_lifecycle_epoch !== input.expected_lifecycle_epoch
      || runtime.installation_grant_epoch !== input.expected_grant_epoch) throw stale();
    const now = new Date();
    const signingSecret = input.authentication_policy ? randomBytes(32) : null;
    const keyId = signingSecret ? randomUUID() : null;
    let sealed: string | null = null;
    let provisioning: { key_id: string; secret: string } | null = null;
    if (signingSecret && keyId) {
      try {
        const { getAppRunRuntime } = await import('./app-run-runtime.js');
        sealed = sealPublicHmacSecret((await getAppRunRuntime()).keys, actor.org_id, endpointId, keyId, signingSecret);
        provisioning = { key_id: keyId, secret: signingSecret.toString('base64url') };
      } finally { signingSecret.fill(0); }
    }
    const fields = { id: endpointId, org_id: actor.org_id, slug_digest: slugDigest,
      app_installation_id: input.installation_id,
      app_version_id: runtime.binding.app_version_id,
      grant_snapshot_id: runtime.binding.grant_snapshot_id,
      installation_lifecycle_epoch: runtime.installation_lifecycle_epoch,
      installation_grant_epoch: runtime.installation_grant_epoch,
      module_installation_id: moduleBinding.module_installation_id,
      collection_key: declaration.collection_key,
      public_action_key: declaration.key,
      runtime_binding_id: setup.kind === 'runtime' ? runtime.binding.id : null,
      native_binding_id: setup.kind === 'native' ? runtime.binding.id : null,
      approver_user_id: input.approver_user_id,
      input_mapping: setup.kind === 'runtime' ? setup.declaration.input_mapping : null,
      native_input_mapping: setup.kind === 'native' ? setup.declaration.input_mapping : null,
      mapping_digest: digestAppGrantValue(declaration.input_mapping),
      availability_policy: availabilityPolicy,
      budget_policy: input.budget_policy ?? null,
      authentication_policy: input.authentication_policy ?? null, hmac_key_id: keyId,
      state: 'disabled' as const, endpoint_epoch: 1,
      public_label: input.public_label, max_body_bytes: input.max_body_bytes,
      reviewed_by_user_id: actor.actor_id, reviewed_at: now };
    const reviewDigest = publicEndpointReviewDigest(fields);
    targetGate(setup.kind === 'native');
    await finalManager(tx, actor, guard, setup.kind === 'native', setup.kind === 'native' ? participants : undefined);
    await tx.insert(appPublicEndpoints).values({ ...fields, review_digest: reviewDigest });
    if (keyId && sealed) await tx.insert(appPublicHmacKeys).values({ id: keyId, org_id: actor.org_id,
      endpoint_id: endpointId, sealed_secret: sealed });
    return { endpoint_id: endpointId, slug, state: 'disabled' as const,
      review_digest: reviewDigest, endpoint_epoch: 1,
      budget_policy: input.budget_policy ?? null, host_budget_ceilings: PUBLIC_APP_BUDGET_CEILINGS,
      authentication_policy: input.authentication_policy ?? null, hmac_key_id: keyId,
      ...(provisioning ? { signing_key: provisioning } : {}),
      authentication_scope: input.authentication_policy ? 'claim_ingress_only' as const : null,
      app_version_id: runtime.binding.app_version_id,
      grant_snapshot_id: runtime.binding.grant_snapshot_id,
      ...(setup.kind === 'native' ? { binding_target: { schema_version: 'deft.app_public_binding_target.v2' as const,
        kind: 'native' as const, native_binding_id: runtime.binding.id },
        owner_user_id: input.approver_user_id, native_input_mapping: setup.declaration.input_mapping,
        mapping_digest: fields.mapping_digest, module_version_id: moduleBinding.module_version_id } : {}) };
  });
}

export async function activatePublicEndpoint(actor: ModuleActor, endpointId: string, raw: unknown, guard?: PublicManagementGuard) {
  manager(actor);
  const request = ActivatePublicEndpointSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [locator] = await tx.select({ org_id: appPublicEndpoints.org_id,
      app_installation_id: appPublicEndpoints.app_installation_id,
      public_action_key: appPublicEndpoints.public_action_key,
      runtime_binding_id: appPublicEndpoints.runtime_binding_id,
      native_binding_id: appPublicEndpoints.native_binding_id,
      approver_user_id: appPublicEndpoints.approver_user_id,
    }).from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id),
      eq(appPublicEndpoints.id, endpointId))).limit(1);
    if (!locator?.public_action_key || !locator.approver_user_id
      || Boolean(locator.runtime_binding_id) === Boolean(locator.native_binding_id)) throw stale();
    targetGate(Boolean(locator.native_binding_id));
    const participants = locator.native_binding_id ? await nativeParticipants(tx, actor, locator.native_binding_id) : [];
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const identity = { org_id: actor.org_id,
      installation_id: locator.app_installation_id,
      public_action_key: locator.public_action_key,
      approver_user_id: locator.approver_user_id };
    const setup = locator.native_binding_id ? await reviewedNativeSetup(tx, { ...identity,
      native_binding_id: locator.native_binding_id, prelocked_participant_ids: participants })
      : await reviewedSetup(tx, { ...identity, runtime_binding_id: locator.runtime_binding_id! });
    const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
      eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId),
    )).limit(1).for('update');
    if (!endpoint || endpoint.state !== 'disabled'
      || endpoint.endpoint_epoch !== request.expected_endpoint_epoch
      || endpoint.review_digest !== request.expected_review_digest
      || endpoint.review_digest !== publicEndpointReviewDigest(endpoint)
      || endpoint.runtime_binding_id !== (setup.kind === 'runtime' ? setup.runtime.binding.id : null)
      || endpoint.native_binding_id !== (setup.kind === 'native' ? setup.runtime.binding.id : null)
      || endpoint.approver_user_id !== locator.approver_user_id
      || endpoint.module_installation_id !== setup.moduleBinding.module_installation_id
      || endpoint.app_version_id !== setup.runtime.binding.app_version_id
      || endpoint.grant_snapshot_id !== setup.runtime.binding.grant_snapshot_id
      || endpoint.installation_lifecycle_epoch !== setup.runtime.installation_lifecycle_epoch
      || endpoint.installation_grant_epoch !== setup.runtime.installation_grant_epoch) throw stale();
    if (endpoint.mapping_digest !== digestAppGrantValue(setup.declaration.input_mapping)
      || digestAppGrantValue(setup.kind === 'native' ? endpoint.native_input_mapping : endpoint.input_mapping)
        !== endpoint.mapping_digest) throw stale();
    if (digestAppGrantValue(endpoint.availability_policy ?? null)
      !== digestAppGrantValue(setup.availabilityPolicy)) throw stale();
    try { publicEndpointBudget(endpoint.budget_policy); } catch { throw stale(); }
    try { publicAuthenticationPolicy(endpoint); } catch { throw stale(); }
    const epoch = endpoint.endpoint_epoch + 1;
    const reviewDigest = publicEndpointReviewDigest({ ...endpoint, endpoint_epoch: epoch });
    targetGate(setup.kind === 'native');
    await finalManager(tx, actor, guard, setup.kind === 'native', setup.kind === 'native' ? participants : undefined);
    await tx.update(appPublicEndpoints).set({ state: 'enabled', endpoint_epoch: epoch,
      review_digest: reviewDigest, reviewed_by_user_id: actor.actor_id,
      reviewed_at: new Date() }).where(and(eq(appPublicEndpoints.org_id, actor.org_id),
      eq(appPublicEndpoints.id, endpointId)));
    return { endpoint_id: endpointId, state: 'enabled' as const,
      endpoint_epoch: epoch, review_digest: reviewDigest, authentication_policy: endpoint.authentication_policy,
      hmac_key_id: endpoint.hmac_key_id, authentication_scope: endpoint.authentication_policy ? 'claim_ingress_only' as const : null };
  });
}

/** Rotation never changes signed policy or anonymously re-enables an endpoint. */
export async function rotatePublicHmacKey(actor: ModuleActor, endpointId: string, raw: unknown, guard?: PublicManagementGuard) {
  manager(actor);
  const request = RotatePublicHmacKeySchema.parse(raw);
  return db.transaction(async tx => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const [locator] = await tx.select({ app_installation_id: appPublicEndpoints.app_installation_id,
      native_binding_id: appPublicEndpoints.native_binding_id })
      .from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId))).limit(1);
    if (!locator) throw stale();
    targetGate(Boolean(locator.native_binding_id));
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id=${actor.org_id}
      AND id=${locator.app_installation_id} FOR SHARE`);
    const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id),
      eq(appPublicEndpoints.id, endpointId))).limit(1).for('update');
    if (!endpoint || endpoint.state !== 'disabled' || endpoint.endpoint_epoch !== request.expected_endpoint_epoch
      || endpoint.review_digest !== request.expected_review_digest || endpoint.review_digest !== publicEndpointReviewDigest(endpoint)) throw stale();
    try { if (!publicAuthenticationPolicy(endpoint)) throw stale(); } catch { throw stale(); }
    const keyId = randomUUID(); const secret = randomBytes(32); let sealed: string; let plaintext: string;
    try { const { getAppRunRuntime } = await import('./app-run-runtime.js');
      sealed = sealPublicHmacSecret((await getAppRunRuntime()).keys, actor.org_id, endpointId, keyId, secret);
      plaintext = secret.toString('base64url'); } finally { secret.fill(0); }
    targetGate(Boolean(endpoint.native_binding_id));
    await finalManager(tx, actor, guard, Boolean(endpoint.native_binding_id));
    await tx.insert(appPublicHmacKeys).values({ id: keyId, org_id: actor.org_id, endpoint_id: endpointId, sealed_secret: sealed });
    const epoch = endpoint.endpoint_epoch + 1;
    const reviewDigest = publicEndpointReviewDigest({ ...endpoint, hmac_key_id: keyId, endpoint_epoch: epoch });
    await tx.update(appPublicEndpoints).set({ hmac_key_id: keyId, endpoint_epoch: epoch, review_digest: reviewDigest,
      reviewed_by_user_id: actor.actor_id, reviewed_at: new Date() }).where(and(eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId)));
    return { endpoint_id: endpointId, state: 'disabled' as const, endpoint_epoch: epoch, review_digest: reviewDigest,
      authentication_policy: endpoint.authentication_policy, hmac_key_id: keyId, authentication_scope: 'claim_ingress_only' as const,
      signing_key: { key_id: keyId, secret: plaintext } };
  });
}

export async function disablePublicEndpoint(actor: ModuleActor, endpointId: string, guard?: PublicManagementGuard) {
  manager(actor);
  return db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const [locator] = await tx.select({ app_installation_id: appPublicEndpoints.app_installation_id,
      native_binding_id: appPublicEndpoints.native_binding_id })
      .from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id),
        eq(appPublicEndpoints.id, endpointId))).limit(1);
    if (!locator) throw stale();
    targetGate(Boolean(locator.native_binding_id));
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
      AND id = ${locator.app_installation_id} FOR SHARE`);
    const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
      eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId),
    )).limit(1).for('update');
    if (!endpoint) throw stale();
    targetGate(Boolean(endpoint.native_binding_id));
    await finalManager(tx, actor, guard, Boolean(endpoint.native_binding_id));
    if (endpoint.state === 'disabled') return { endpoint_id: endpointId,
      state: 'disabled' as const, endpoint_epoch: endpoint.endpoint_epoch };
    const epoch = endpoint.endpoint_epoch + 1;
    await tx.update(appPublicEndpoints).set({ state: 'disabled', endpoint_epoch: epoch,
      review_digest: publicEndpointReviewDigest({ ...endpoint, endpoint_epoch: epoch }) })
      .where(and(eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId)));
    return { endpoint_id: endpointId, state: 'disabled' as const, endpoint_epoch: epoch };
  });
}
