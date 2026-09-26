import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseRuntimeAppManifest, PublicBudgetPolicySchema, PublicHmacPolicySchema } from '@deft/app-kit';
import { appModuleBindings, appPublicEndpoints, appPublicHmacKeys, appVersions, moduleInstallations,
  moduleVersions } from '@deft/db/schema';
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

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ActionKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
export const StagePublicEndpointSchema = z.strictObject({
  installation_id: Id, public_action_key: ActionKey, runtime_binding_id: Id,
  approver_user_id: Id, public_label: z.string().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f<>]+$/),
  max_body_bytes: z.number().int().min(128).max(8192),
  budget_policy: PublicBudgetPolicySchema.optional(),
  authentication_policy: PublicHmacPolicySchema.optional(),
  expected_app_version_id: Id, expected_grant_snapshot_id: Id,
  expected_lifecycle_epoch: z.number().int().nonnegative(),
  expected_grant_epoch: z.number().int().positive(),
});
export const ActivatePublicEndpointSchema = z.strictObject({
  expected_review_digest: Digest, expected_endpoint_epoch: z.number().int().positive(),
  accept_host_policy: z.literal(true),
});
export const RotatePublicHmacKeySchema = z.strictObject({
  expected_review_digest: Digest, expected_endpoint_epoch: z.number().int().positive(),
});
const stale = () => new AppError('Public endpoint authority changed', 'APP_STALE', 409);
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const liveAuthorizer = new PostgresAppRunLiveAuthorization();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  if (!version || version.protocol_version !== '4') throw stale();
  const manifest = parseRuntimeAppManifest(version.manifest);
  if (manifest.schema_version !== '4') throw stale();
  const declaration = manifest.public_actions.find((item) => item.key === input.public_action_key);
  if (!declaration || declaration.action_key !== runtime.action.action_key) throw stale();
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
  return { runtime, declaration, moduleBinding, availabilityPolicy };
}

export async function stagePublicEndpoint(actor: ModuleActor, raw: unknown) {
  manager(actor);
  if (!appRuntimeChannelEnabled()) throw new AppError('App Runtime unavailable', 'APP_FEATURE_DISABLED', 503);
  const input = StagePublicEndpointSchema.parse(raw);
  const endpointId = randomUUID();
  const slug = randomBytes(32).toString('base64url');
  const slugDigest = hash(slug);
  return db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const { runtime, declaration, moduleBinding, availabilityPolicy } = await reviewedSetup(tx, {
      org_id: actor.org_id, installation_id: input.installation_id,
      public_action_key: input.public_action_key,
      runtime_binding_id: input.runtime_binding_id,
      approver_user_id: input.approver_user_id,
    });
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
      runtime_binding_id: runtime.binding.id,
      approver_user_id: input.approver_user_id,
      input_mapping: declaration.input_mapping,
      mapping_digest: digestAppGrantValue(declaration.input_mapping),
      availability_policy: availabilityPolicy,
      budget_policy: input.budget_policy ?? null,
      authentication_policy: input.authentication_policy ?? null, hmac_key_id: keyId,
      state: 'disabled' as const, endpoint_epoch: 1,
      public_label: input.public_label, max_body_bytes: input.max_body_bytes,
      reviewed_by_user_id: actor.actor_id, reviewed_at: now };
    const reviewDigest = publicEndpointReviewDigest(fields);
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
      grant_snapshot_id: runtime.binding.grant_snapshot_id };
  });
}

export async function activatePublicEndpoint(actor: ModuleActor, endpointId: string, raw: unknown) {
  manager(actor);
  const request = ActivatePublicEndpointSchema.parse(raw);
  return db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const [locator] = await tx.select({ org_id: appPublicEndpoints.org_id,
      app_installation_id: appPublicEndpoints.app_installation_id,
      public_action_key: appPublicEndpoints.public_action_key,
      runtime_binding_id: appPublicEndpoints.runtime_binding_id,
      approver_user_id: appPublicEndpoints.approver_user_id,
    }).from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id),
      eq(appPublicEndpoints.id, endpointId))).limit(1);
    if (!locator?.public_action_key || !locator.runtime_binding_id || !locator.approver_user_id) throw stale();
    const setup = await reviewedSetup(tx, { org_id: actor.org_id,
      installation_id: locator.app_installation_id,
      public_action_key: locator.public_action_key,
      runtime_binding_id: locator.runtime_binding_id,
      approver_user_id: locator.approver_user_id });
    const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
      eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId),
    )).limit(1).for('update');
    if (!endpoint || endpoint.state !== 'disabled'
      || endpoint.endpoint_epoch !== request.expected_endpoint_epoch
      || endpoint.review_digest !== request.expected_review_digest
      || endpoint.review_digest !== publicEndpointReviewDigest(endpoint)
      || endpoint.runtime_binding_id !== setup.runtime.binding.id
      || endpoint.approver_user_id !== locator.approver_user_id
      || endpoint.module_installation_id !== setup.moduleBinding.module_installation_id
      || endpoint.app_version_id !== setup.runtime.binding.app_version_id
      || endpoint.grant_snapshot_id !== setup.runtime.binding.grant_snapshot_id
      || endpoint.installation_lifecycle_epoch !== setup.runtime.installation_lifecycle_epoch
      || endpoint.installation_grant_epoch !== setup.runtime.installation_grant_epoch) throw stale();
    if (digestAppGrantValue(endpoint.availability_policy ?? null)
      !== digestAppGrantValue(setup.availabilityPolicy)) throw stale();
    try { publicEndpointBudget(endpoint.budget_policy); } catch { throw stale(); }
    try { publicAuthenticationPolicy(endpoint); } catch { throw stale(); }
    const epoch = endpoint.endpoint_epoch + 1;
    const reviewDigest = publicEndpointReviewDigest({ ...endpoint, endpoint_epoch: epoch });
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
export async function rotatePublicHmacKey(actor: ModuleActor, endpointId: string, raw: unknown) {
  manager(actor);
  if (!appRuntimeChannelEnabled()) throw new AppError('App Runtime unavailable', 'APP_FEATURE_DISABLED', 503);
  const request = RotatePublicHmacKeySchema.parse(raw);
  return db.transaction(async tx => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const [locator] = await tx.select({ app_installation_id: appPublicEndpoints.app_installation_id })
      .from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId))).limit(1);
    if (!locator) throw stale();
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

export async function disablePublicEndpoint(actor: ModuleActor, endpointId: string) {
  manager(actor);
  return db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const [locator] = await tx.select({ app_installation_id: appPublicEndpoints.app_installation_id })
      .from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, actor.org_id),
        eq(appPublicEndpoints.id, endpointId))).limit(1);
    if (!locator) throw stale();
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id}
      AND id = ${locator.app_installation_id} FOR SHARE`);
    const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
      eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId),
    )).limit(1).for('update');
    if (!endpoint) throw stale();
    if (endpoint.state === 'disabled') return { endpoint_id: endpointId,
      state: 'disabled' as const, endpoint_epoch: endpoint.endpoint_epoch };
    const epoch = endpoint.endpoint_epoch + 1;
    await tx.update(appPublicEndpoints).set({ state: 'disabled', endpoint_epoch: epoch,
      review_digest: publicEndpointReviewDigest({ ...endpoint, endpoint_epoch: epoch }) })
      .where(and(eq(appPublicEndpoints.org_id, actor.org_id), eq(appPublicEndpoints.id, endpointId)));
    return { endpoint_id: endpointId, state: 'disabled' as const, endpoint_epoch: epoch };
  });
}
