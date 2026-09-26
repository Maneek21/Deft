import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseRuntimeAppManifest, parseNativeAppManifest, PublicAvailabilityPolicySchema } from '@deft/app-kit';
import {
  AppInstallationAuthoritySchema,
  AppPublicPrincipalSchema,
  ModuleResourceRefV1Schema,
  isSameAppInstallationAuthority,
  type AppPublicPrincipal,
} from '@deft/shared';
import {
  appCanonicalClaims,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appPublicEndpoints,
  appPublicIngress,
  appVersions,
  jobQueue,
  moduleInstallations,
  moduleRecords,
  moduleVersions,
} from '@deft/db/schema';
import { db } from './db.js';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { openPublicAvailabilityCursor, sealPublicAvailabilityCursor, publicClaimDeadline,
  projectPublicAvailability, validatePublicAvailabilityPolicy, canClaimPublicAvailability, type PublicAvailabilityPolicy } from './app-public-availability.js';
import { acquirePublicBudgetAdmission, publicEndpointBudget, reservePublicBudget,
  PublicBudgetExceededError, PUBLIC_APP_BUDGET_CEILINGS } from './app-public-budgets.js';
import { publicAuthenticationPolicy, verifyPublicSignature, acceptPublicSignature, assertPublicSignatureFresh,
  PublicSignatureInvalid, PublicSignatureReplay, PublicSignatureCapacity, type PublicSignedRequest } from './app-public-hmac.js';
import { validatePublicNativeMapping } from './app-public-native-mapping.js';

type PublicTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Endpoint = typeof appPublicEndpoints.$inferSelect;
type Ingress = typeof appPublicIngress.$inferSelect;
type AppInstallation = typeof appInstallations.$inferSelect;

export const PublicClaimInputSchema = z.strictObject({
  resource_ref: ModuleResourceRefV1Schema,
  expected_revision: z.number().int().positive().max(2_147_483_647),
  idempotency_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
});
export type PublicClaimInput = z.infer<typeof PublicClaimInputSchema>;

export type PublicClaimResult = Readonly<{
  claim_id: string;
  claim_state: 'confirmed';
  follow_up_state: 'pending' | 'unsupported' | 'run_created';
  replayed: boolean;
}>;

export type AppPublicErrorCode =
  | 'PUBLIC_NOT_FOUND'
  | 'PUBLIC_INVALID_INPUT'
  | 'PUBLIC_PAYLOAD_TOO_LARGE'
  | 'PUBLIC_IDEMPOTENCY_CONFLICT'
  | 'PUBLIC_CLAIM_CONFLICT'
  | 'PUBLIC_BUDGET_EXCEEDED'
  | 'PUBLIC_SIGNATURE_INVALID' | 'PUBLIC_SIGNATURE_REPLAY' | 'PUBLIC_RATE_LIMITED'
  | 'PUBLIC_UNAVAILABLE';

export class AppPublicError extends Error {
  constructor(readonly code: AppPublicErrorCode, readonly status: 400 | 401 | 404 | 409 | 413 | 429 | 503) {
    super(code === 'PUBLIC_NOT_FOUND' ? 'Public endpoint not found'
      : code === 'PUBLIC_INVALID_INPUT' ? 'Invalid public claim'
      : code === 'PUBLIC_PAYLOAD_TOO_LARGE' ? 'Public request is too large'
      : code === 'PUBLIC_IDEMPOTENCY_CONFLICT' ? 'Request key belongs to different input'
      : code === 'PUBLIC_CLAIM_CONFLICT' ? 'Resource is unavailable'
      : code === 'PUBLIC_BUDGET_EXCEEDED' ? 'Public reservation budget is exhausted'
      : code === 'PUBLIC_SIGNATURE_INVALID' ? 'Invalid public signature'
      : code === 'PUBLIC_SIGNATURE_REPLAY' ? 'Public signature has already been accepted'
      : code === 'PUBLIC_RATE_LIMITED' ? 'Public request limit is exhausted'
      : 'Public claim is temporarily unavailable');
    this.name = 'AppPublicError';
  }
}

const MAX_PUBLIC_BODY_BYTES = 8192;
const slugPattern = /^[A-Za-z0-9_-]{32,128}$/;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function publicEndpointReviewDigest(endpoint: Pick<Endpoint,
  'id' | 'org_id' | 'slug_digest' | 'app_installation_id' | 'app_version_id' | 'grant_snapshot_id'
  | 'installation_lifecycle_epoch' | 'installation_grant_epoch' | 'module_installation_id'
  | 'collection_key' | 'endpoint_epoch' | 'public_label' | 'max_body_bytes'>
  & Partial<Pick<Endpoint, 'public_action_key' | 'runtime_binding_id' | 'approver_user_id'
    | 'input_mapping' | 'mapping_digest' | 'availability_policy' | 'budget_policy'
    | 'authentication_policy' | 'hmac_key_id' | 'native_binding_id' | 'native_input_mapping'>>): string {
  const core = {
    review_version: 'deft.app_public_review.v1',
    endpoint_id: endpoint.id,
    org_id: endpoint.org_id,
    slug_digest: endpoint.slug_digest,
    app_installation_id: endpoint.app_installation_id,
    app_version_id: endpoint.app_version_id,
    grant_snapshot_id: endpoint.grant_snapshot_id,
    installation_lifecycle_epoch: endpoint.installation_lifecycle_epoch,
    installation_grant_epoch: endpoint.installation_grant_epoch,
    module_installation_id: endpoint.module_installation_id,
    collection_key: endpoint.collection_key,
    endpoint_epoch: endpoint.endpoint_epoch,
    public_label: endpoint.public_label,
    max_body_bytes: endpoint.max_body_bytes,
  };
  if (!endpoint.public_action_key) return hash(JSON.stringify(core));
  if (endpoint.native_binding_id) return hash(JSON.stringify({ ...core,
    review_version: 'deft.app_public_review.v6', public_action_key: endpoint.public_action_key,
    binding_target: { schema_version: 'deft.app_public_binding_target.v2', kind: 'native',
      native_binding_id: endpoint.native_binding_id },
    approver_user_id: endpoint.approver_user_id, native_input_mapping: endpoint.native_input_mapping,
    mapping_digest: endpoint.mapping_digest,
    ...(endpoint.availability_policy ? { availability_policy: digestAppGrantValue(endpoint.availability_policy) } : {}),
    ...(endpoint.budget_policy ? { budget_policy: digestAppGrantValue(endpoint.budget_policy),
      host_budget_ceilings: PUBLIC_APP_BUDGET_CEILINGS } : {}),
    ...(endpoint.authentication_policy ? { authentication_policy: digestAppGrantValue(endpoint.authentication_policy),
      hmac_key_id: endpoint.hmac_key_id } : {}),
  }));
  return hash(JSON.stringify({ ...core,
    review_version: endpoint.authentication_policy ? 'deft.app_public_review.v5'
      : endpoint.budget_policy ? 'deft.app_public_review.v4'
      : endpoint.availability_policy ? 'deft.app_public_review.v3' : 'deft.app_public_review.v2',
    public_action_key: endpoint.public_action_key,
    runtime_binding_id: endpoint.runtime_binding_id,
    approver_user_id: endpoint.approver_user_id,
    input_mapping: endpoint.input_mapping,
    mapping_digest: endpoint.mapping_digest,
    ...(endpoint.availability_policy ? { availability_policy: digestAppGrantValue(endpoint.availability_policy) } : {}),
    ...(endpoint.budget_policy ? { budget_policy: digestAppGrantValue(endpoint.budget_policy),
      host_budget_ceilings: PUBLIC_APP_BUDGET_CEILINGS } : {}),
    ...(endpoint.authentication_policy ? { authentication_policy: digestAppGrantValue(endpoint.authentication_policy),
      hmac_key_id: endpoint.hmac_key_id } : {}),
  }));
}

function parseBody(rawBody: Uint8Array, maxBodyBytes: number): PublicClaimInput {
  if (rawBody.byteLength > MAX_PUBLIC_BODY_BYTES || rawBody.byteLength > maxBodyBytes) {
    throw new AppPublicError('PUBLIC_PAYLOAD_TOO_LARGE', 413);
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    return PublicClaimInputSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppPublicError('PUBLIC_INVALID_INPUT', 400);
  }
}

function inputDigest(input: PublicClaimInput): string {
  return hash(JSON.stringify({ resource_ref: input.resource_ref, expected_revision: input.expected_revision }));
}

function principalFor(endpoint: Endpoint): AppPublicPrincipal {
  return AppPublicPrincipalSchema.parse({
    audience: 'app_public',
    org_id: endpoint.org_id,
    app_installation_id: endpoint.app_installation_id,
    app_version_id: endpoint.app_version_id,
    lifecycle_epoch: endpoint.installation_lifecycle_epoch,
    grant_epoch: endpoint.installation_grant_epoch,
    endpoint_id: endpoint.id,
    endpoint_epoch: endpoint.endpoint_epoch,
  });
}

async function resolveEndpoint(tx: PublicTransaction, slug: string, admission = false): Promise<{
  endpoint: Endpoint; principal: AppPublicPrincipal; app: AppInstallation; native_participant_ids: readonly string[];
}> {
  if (!slugPattern.test(slug)) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  const slugDigest = hash(slug);
  // The first lookup is only a locator. Lock the owning App before the
  // endpoint, matching lifecycle's App -> Module lock hierarchy. A changed
  // mapping is detected under the endpoint lock and denied.
  const [locator] = await tx.select({
    id: appPublicEndpoints.id,
    org_id: appPublicEndpoints.org_id,
    app_installation_id: appPublicEndpoints.app_installation_id,
    native_binding_id: appPublicEndpoints.native_binding_id,
  }).from(appPublicEndpoints).where(eq(appPublicEndpoints.slug_digest, slugDigest)).limit(1);
  if (!locator) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  // Native participants must be collected and locked before any App lock.
  // The helper owns that prefix; later App SHARE is reentrant. Never discover
  // a Calendar owner from behind the public admission mutex/endpoint locks.
  let native: Awaited<ReturnType<typeof import('./app-native-authority.js')['loadLiveNativeAuthority']>> | null = null;
  if (locator.native_binding_id) {
    try {
      const { loadLiveNativeAuthority } = await import('./app-native-authority.js');
      native = await loadLiveNativeAuthority(tx, { org_id: locator.org_id, native_binding_id: locator.native_binding_id });
    } catch { throw new AppPublicError('PUBLIC_NOT_FOUND', 404); }
  }
  const [app] = await tx.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, locator.org_id),
    eq(appInstallations.id, locator.app_installation_id),
  )).limit(1).for('share');
  if (!app) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  if (admission) await acquirePublicBudgetAdmission(tx, app.org_id, app.id);
  const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
    eq(appPublicEndpoints.org_id, locator.org_id),
    eq(appPublicEndpoints.id, locator.id),
  )).limit(1).for('share');
  if (!endpoint || endpoint.slug_digest !== slugDigest
    || endpoint.app_installation_id !== app.id || endpoint.state !== 'enabled'
    || endpoint.native_binding_id !== locator.native_binding_id
    || endpoint.review_digest !== publicEndpointReviewDigest(endpoint)) {
    throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  }
  if (native && (endpoint.runtime_binding_id !== null || endpoint.input_mapping !== null
    || endpoint.native_binding_id !== native.binding.id || endpoint.approver_user_id !== native.binding.owner_user_id
    || endpoint.app_installation_id !== native.binding.app_installation_id
    || endpoint.app_version_id !== native.binding.app_version_id
    || endpoint.grant_snapshot_id !== native.binding.grant_snapshot_id
    || endpoint.installation_lifecycle_epoch !== native.binding.installation_lifecycle_epoch
    || endpoint.installation_grant_epoch !== native.binding.installation_grant_epoch)) {
    throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  }
  if (native) {
    const declaration = native.manifest.public_actions.find(item => item.key === endpoint.public_action_key);
    if (!declaration || declaration.action_key !== native.action.key
      || digestAppGrantValue(declaration.input_mapping) !== endpoint.mapping_digest
      || digestAppGrantValue(endpoint.native_input_mapping) !== endpoint.mapping_digest) {
      throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
    }
  }
  try { publicEndpointBudget(endpoint.budget_policy); }
  catch { throw new AppPublicError('PUBLIC_NOT_FOUND', 404); }
  try { publicAuthenticationPolicy(endpoint); }
  catch { throw new AppPublicError('PUBLIC_NOT_FOUND', 404); }
  return { endpoint, principal: principalFor(endpoint), app, native_participant_ids: native?.participants ?? [] };
}

/** Recheck only the already locked native participants after later endpoint,
 * record, uniqueness or delivery waits. Never discover/lock users behind App. */
async function assertFinalNativeAuthority(tx: PublicTransaction, endpoint: Endpoint, participantIds: readonly string[]) {
  if (!endpoint.native_binding_id) return;
  try {
    const { assertNativeCalendarEnabled, nativeParticipantsAreHuman } = await import('./app-native-authority.js');
    assertNativeCalendarEnabled();
    if (participantIds.length === 0 || !await nativeParticipantsAreHuman(tx, participantIds)) throw new Error('Native authority changed');
    assertNativeCalendarEnabled();
  } catch { throw new AppPublicError('PUBLIC_NOT_FOUND', 404); }
}

async function assertLiveAuthority(tx: PublicTransaction, endpoint: Endpoint, principal: AppPublicPrincipal, app: AppInstallation) {
  // Order follows lifecycle and Module mutation: App, endpoint, Module
  // installation, then canonical record. The App row lock is already held.
  if (app.state !== 'active' || app.active_version_id !== endpoint.app_version_id
    || app.active_grant_snapshot_id !== endpoint.grant_snapshot_id
    || !isSameAppInstallationAuthority(principal, AppInstallationAuthoritySchema.parse({
      org_id: app.org_id,
      app_installation_id: app.id,
      app_version_id: app.active_version_id,
      lifecycle_epoch: app.lifecycle_epoch,
      grant_epoch: app.grant_epoch,
    }))) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);

  const [version] = await tx.select({ id: appVersions.id, manifest: appVersions.manifest,
    protocol_version: appVersions.protocol_version }).from(appVersions).where(and(
    eq(appVersions.org_id, principal.org_id),
    eq(appVersions.installation_id, app.id),
    eq(appVersions.id, endpoint.app_version_id),
    eq(appVersions.state, 'active'),
  )).limit(1);
  const [grant] = await tx.select({ id: appGrantSnapshots.id }).from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, principal.org_id),
    eq(appGrantSnapshots.app_installation_id, app.id),
    eq(appGrantSnapshots.app_version_id, endpoint.app_version_id),
    eq(appGrantSnapshots.id, endpoint.grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  )).limit(1);
  if (!version || !grant) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);

  const [moduleInstallation] = await tx.select().from(moduleInstallations).where(and(
    eq(moduleInstallations.org_id, principal.org_id),
    eq(moduleInstallations.id, endpoint.module_installation_id),
  )).limit(1).for('share');
  if (!moduleInstallation || !moduleInstallation.is_enabled || moduleInstallation.is_deleted) {
    throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  }
  const [binding] = await tx.select({ module_version_id: appModuleBindings.module_version_id,
    ownership: appModuleBindings.ownership })
    .from(appModuleBindings).where(and(
      eq(appModuleBindings.org_id, principal.org_id),
      eq(appModuleBindings.app_installation_id, app.id),
      eq(appModuleBindings.app_version_id, endpoint.app_version_id),
      eq(appModuleBindings.module_installation_id, moduleInstallation.id),
      eq(appModuleBindings.module_id, moduleInstallation.module_id),
    )).limit(1);
  if (!binding) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  const [moduleVersion] = await tx.select({ id: moduleVersions.id, manifest: moduleVersions.manifest }).from(moduleVersions).where(and(
    eq(moduleVersions.org_id, principal.org_id),
    eq(moduleVersions.installation_id, moduleInstallation.id),
    eq(moduleVersions.id, binding.module_version_id),
    eq(moduleVersions.is_active, true),
  )).limit(1);
  if (!moduleVersion) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  if (endpoint.native_binding_id) {
    try {
      if (binding.ownership !== 'app' || version.protocol_version !== '6') throw new Error('Native public Module is not owned');
      const manifest = parseNativeAppManifest(version.manifest);
      const declaration = manifest.public_actions.find(item => item.key === endpoint.public_action_key);
      const action = manifest.native_actions.find(item => item.key === declaration?.action_key);
      if (!declaration || !action || declaration.module_id !== moduleInstallation.module_id
        || declaration.collection_key !== endpoint.collection_key) throw new Error('Native public declaration changed');
      validatePublicNativeMapping(endpoint.native_input_mapping, moduleVersion.manifest, endpoint.collection_key, action.operation);
    } catch { throw new AppPublicError('PUBLIC_NOT_FOUND', 404); }
  }
  if (!endpoint.availability_policy) return null;
  try {
    if (binding.ownership !== 'app') throw new Error('Public Module is not owned');
    const policy = validatePublicAvailabilityPolicy(endpoint.availability_policy, moduleVersion.manifest,
      endpoint.collection_key, moduleVersion.id);
    const manifest = version.protocol_version === '6' ? parseNativeAppManifest(version.manifest) : parseRuntimeAppManifest(version.manifest);
    if (manifest.schema_version !== '4' && manifest.schema_version !== '6') throw new Error('Public declaration unavailable');
    const declaration = manifest.public_actions.find(item => item.key === endpoint.public_action_key);
    const { module_version_id: _version, ...authorPolicy } = policy;
    if (!declaration?.availability || declaration.module_id !== moduleInstallation.module_id
      || declaration.collection_key !== endpoint.collection_key
      || JSON.stringify(PublicAvailabilityPolicySchema.parse(declaration.availability)) !== JSON.stringify(authorPolicy)) {
      throw new Error('Public policy differs from authored declaration');
    }
    return policy;
  } catch { throw new AppPublicError('PUBLIC_NOT_FOUND', 404); }
}

async function freshPublicClock(tx: PublicTransaction): Promise<Date> {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  return new Date((result.rows[0] as { now: Date | string }).now);
}

async function assertClaimDeadline(tx: PublicTransaction, policy: PublicAvailabilityPolicy | null, data: unknown) {
  if (!policy) return;
  if (!canClaimPublicAvailability(policy, data, await freshPublicClock(tx))) throw new AppPublicError('PUBLIC_CLAIM_CONFLICT', 409);
}

async function outcomeFromReceipt(tx: PublicTransaction, receipt: Ingress, inputFingerprint: string): Promise<PublicClaimResult | 'conflict'> {
  if (receipt.input_digest !== inputFingerprint) throw new AppPublicError('PUBLIC_IDEMPOTENCY_CONFLICT', 409);
  if (receipt.state === 'conflict') return 'conflict';
  if (receipt.state !== 'confirmed') throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
  const [claim] = await tx.select({ id: appCanonicalClaims.id }).from(appCanonicalClaims).where(and(
    eq(appCanonicalClaims.org_id, receipt.org_id),
    eq(appCanonicalClaims.endpoint_id, receipt.endpoint_id),
    eq(appCanonicalClaims.ingress_id, receipt.id),
  )).limit(1);
  if (!claim) throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
  return { claim_id: claim.id, claim_state: 'confirmed', follow_up_state: receipt.follow_up_state, replayed: true };
}

async function enqueueIngress(tx: PublicTransaction, orgId: string, endpointId: string, ingressId: string, endpointEpoch: number) {
  const payload = { organization_id: orgId, endpoint_id: endpointId, ingress_id: ingressId, endpoint_epoch: endpointEpoch };
  const dedupeKey = `app-public-ingress:${ingressId}`;
  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'app-public-ingress', payload,
    { executor: tx, orgId, dedupeKey, maxAttempts: 3 });
  // enqueue() deliberately uses ON CONFLICT DO NOTHING. Verify it did not
  // silently keep a different job under the same dedupe key.
  const [job] = await tx.select({ queue: jobQueue.queue, name: jobQueue.name, data: jobQueue.data })
    .from(jobQueue).where(and(eq(jobQueue.org_id, orgId), eq(jobQueue.dedupe_key, dedupeKey))).limit(1);
  const data = job?.data;
  const fields = data as Record<string, unknown> | undefined;
  if (!job || job.queue !== QUEUE_NAMES.AGENT_JOBS || job.name !== 'app-public-ingress'
    || !data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).length !== 4
    || fields?.organization_id !== payload.organization_id
    || fields?.endpoint_id !== payload.endpoint_id
    || fields?.ingress_id !== payload.ingress_id
    || fields?.endpoint_epoch !== payload.endpoint_epoch) {
    throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
  }
}

type Delivery = typeof enqueueIngress;

/** This service derives the public principal from one reviewed endpoint row.
 * Request cookies, Authorization and caller-supplied organization are absent
 * from its interface by design. No ModuleActor is constructed or borrowed. */
export class AppPublicClaimService {
  constructor(private readonly options: { enabled?: boolean; deliver?: Delivery } = {}) {}

  isEnabled(): boolean { return this.options.enabled === true; }

  async availability(slug: string, cursorToken?: string) {
    if (!this.isEnabled()) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
    try {
      return await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = 5000`);
        await tx.execute(sql`SET LOCAL lock_timeout = 1000`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = 6000`);
        const { endpoint, principal, app, native_participant_ids } = await resolveEndpoint(tx, slug);
        const policy = await assertLiveAuthority(tx, endpoint, principal, app);
        if (!policy) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
        let now = await freshPublicClock(tx);
        const { getAppRunRuntime } = await import('./app-run-runtime.js');
        const keys = (await getAppRunRuntime()).keys;
        let after: string | undefined;
        if (cursorToken !== undefined) {
          try {
            const cursor = openPublicAvailabilityCursor(keys, cursorToken);
            if (cursor.endpoint_id !== endpoint.id || cursor.endpoint_epoch !== endpoint.endpoint_epoch
              || cursor.review_digest !== endpoint.review_digest || cursor.module_version_id !== policy.module_version_id
              || cursor.expires_at <= now.getTime()) throw new Error('Stale cursor');
            after = cursor.after;
          } catch { throw new AppPublicError('PUBLIC_INVALID_INPUT', 400); }
        }
        // Scan cap is independent of emitted item cap. Expired or claimed
        // records still advance a continuation, including an empty page.
        const projectedKeys = [...new Set([...policy.fields, policy.claim_deadline_field])];
        const projectedData = sql<Record<string, unknown>>`jsonb_build_object(${sql.join(projectedKeys.map(key =>
          sql`${key}::text, ${moduleRecords.data}->${key}::text`), sql`, `)})`;
        const rows = await tx.select({ id: moduleRecords.id, revision: moduleRecords.revision,
          data: projectedData, claimed: sql<boolean>`EXISTS (SELECT 1 FROM app_canonical_claims c
            WHERE c.org_id = ${principal.org_id} AND c.provider_kind = 'module'
              AND c.provider_instance_id = ${endpoint.module_installation_id}
              AND c.resource_id = "module_records"."id" AND c.claim_kind = 'exclusive' AND c.released_at IS NULL)` })
          .from(moduleRecords).where(and(eq(moduleRecords.org_id, principal.org_id),
            eq(moduleRecords.installation_id, endpoint.module_installation_id),
            eq(moduleRecords.collection_key, endpoint.collection_key), eq(moduleRecords.is_deleted, false),
            after ? gt(moduleRecords.id, after) : undefined)).orderBy(moduleRecords.id).limit(101);
        now = await freshPublicClock(tx);
        if (cursorToken !== undefined && openPublicAvailabilityCursor(keys, cursorToken).expires_at <= now.getTime()) {
          throw new AppPublicError('PUBLIC_INVALID_INPUT', 400);
        }
        const items: Array<{ resource_ref: z.infer<typeof ModuleResourceRefV1Schema>; revision: number;
          fields: Record<string, string | number | boolean>; claim_deadline_utc: string }> = [];
        let last: string | undefined;
        let consumed = 0;
        for (const row of rows.slice(0, 100)) {
          const deadline = publicClaimDeadline(policy, row.data);
          const fields = projectPublicAvailability(policy, row.data);
          if (!row.claimed && deadline && canClaimPublicAvailability(policy, row.data, now) && fields) {
            const candidate = {
            resource_ref: ModuleResourceRefV1Schema.parse({ schema_version: 'deft.resource_ref.v1',
              provider: { kind: 'module', provider_instance_id: endpoint.module_installation_id },
              resource_type: endpoint.collection_key, resource_id: row.id }),
            revision: row.revision, fields, claim_deadline_utc: deadline.toISOString() };
            // Include the response wrapper and reserve the maximum cursor size
            // before consuming this row. A large valid page continues safely.
            if (Buffer.byteLength(JSON.stringify({ result: { schema_version: 'deft.app_public_availability.v1',
              items: [...items, candidate], next_cursor: 'x'.repeat(2048) } })) > 32_768) break;
            items.push(candidate);
          }
          consumed++; last = row.id;
          if (items.length >= policy.page_size) break;
        }
        const next_cursor = last && rows.length > consumed ? sealPublicAvailabilityCursor(keys, {
          schema_version: 'deft.app_public_availability_cursor.v1', endpoint_id: endpoint.id,
          endpoint_epoch: endpoint.endpoint_epoch, review_digest: endpoint.review_digest,
          module_version_id: policy.module_version_id, after: last, expires_at: now.getTime() + 300_000 }) : null;
        const result = { schema_version: 'deft.app_public_availability.v1' as const, items, next_cursor };
        if (Buffer.byteLength(JSON.stringify({ result })) > 32_768) throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
        await assertFinalNativeAuthority(tx, endpoint, native_participant_ids);
        return result;
      });
    } catch (error) {
      if (error instanceof AppPublicError) throw error;
      throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
    }
  }

  async claim(slug: string, rawBody: Uint8Array, signedRequest?: PublicSignedRequest): Promise<PublicClaimResult> {
    if (!this.isEnabled()) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
    if (rawBody.byteLength > MAX_PUBLIC_BODY_BYTES) throw new AppPublicError('PUBLIC_PAYLOAD_TOO_LARGE', 413);
    let outcome: PublicClaimResult | 'conflict';
    try {
      outcome = await db.transaction(async (tx) => {
        // Anonymous work never waits indefinitely for a lock or a statement.
        // These settings are transaction-local and cannot leak to pooled users.
        await tx.execute(sql`SET LOCAL statement_timeout = 5000`);
        await tx.execute(sql`SET LOCAL lock_timeout = 1000`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = 6000`);
        const { endpoint, principal, app, native_participant_ids } = await resolveEndpoint(tx, slug, true);
        const policy = await assertLiveAuthority(tx, endpoint, principal, app);
        const verified = endpoint.authentication_policy
          ? await verifyPublicSignature(tx, (await (await import('./app-run-runtime.js')).getAppRunRuntime()).keys,
            endpoint, slug, rawBody, signedRequest) : null;
        const input = parseBody(rawBody, endpoint.max_body_bytes);
        const ref = input.resource_ref;
        if (ref.provider.provider_instance_id !== endpoint.module_installation_id
          || ref.resource_type !== endpoint.collection_key) {
          throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
        }
        const fingerprint = inputDigest(input);
        const keyDigest = hash(`${endpoint.id}\0${input.idempotency_key}`);
        const ingressId = randomUUID();
        const [inserted] = await tx.insert(appPublicIngress).values({
          id: ingressId, org_id: principal.org_id, endpoint_id: endpoint.id,
          endpoint_epoch: endpoint.endpoint_epoch, request_key_digest: keyDigest,
          input_digest: fingerprint, state: 'processing',
        }).onConflictDoNothing().returning({ id: appPublicIngress.id });
        if (!inserted) {
          const [receipt] = await tx.select().from(appPublicIngress).where(and(
            eq(appPublicIngress.org_id, principal.org_id),
            eq(appPublicIngress.endpoint_id, endpoint.id),
            eq(appPublicIngress.endpoint_epoch, endpoint.endpoint_epoch),
            eq(appPublicIngress.request_key_digest, keyDigest),
          )).limit(1);
          if (!receipt) throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
          const prior = await outcomeFromReceipt(tx, receipt, fingerprint);
          if (prior !== 'conflict') await acceptPublicSignature(tx, endpoint, verified);
          await assertFinalNativeAuthority(tx, endpoint, native_participant_ids);
          return prior;
        }
        const deadlineData = policy ? sql<Record<string, unknown>>`jsonb_build_object(
          ${policy.claim_deadline_field}::text, ${moduleRecords.data}->${policy.claim_deadline_field}::text)`
          : sql<Record<string, unknown>>`'{}'::jsonb`;
        const [record] = await tx.select({ id: moduleRecords.id, revision: moduleRecords.revision, data: deadlineData })
          .from(moduleRecords).where(and(
            eq(moduleRecords.org_id, principal.org_id),
            eq(moduleRecords.installation_id, endpoint.module_installation_id),
            eq(moduleRecords.id, ref.resource_id),
            eq(moduleRecords.collection_key, endpoint.collection_key),
            eq(moduleRecords.is_deleted, false),
          )).limit(1).for('share');
        await assertPublicSignatureFresh(tx, verified);
        if (!record || record.revision !== input.expected_revision) {
          await tx.update(appPublicIngress).set({ state: 'conflict' }).where(eq(appPublicIngress.id, ingressId));
          await assertFinalNativeAuthority(tx, endpoint, native_participant_ids);
          return 'conflict';
        }
        await assertClaimDeadline(tx, policy, record.data);
        const claimId = randomUUID();
        const [claimed] = await tx.insert(appCanonicalClaims).values({
          id: claimId, org_id: principal.org_id, endpoint_id: endpoint.id, ingress_id: ingressId,
          provider_kind: 'module', provider_instance_id: endpoint.module_installation_id,
          resource_type: endpoint.collection_key, resource_id: record.id,
          claim_kind: 'exclusive',
          ...(endpoint.native_binding_id ? { claimed_resource_revision: record.revision } : {}),
        }).onConflictDoNothing().returning({ id: appCanonicalClaims.id });
        await assertPublicSignatureFresh(tx, verified);
        if (!claimed) {
          await tx.update(appPublicIngress).set({ state: 'conflict' }).where(eq(appPublicIngress.id, ingressId));
          await assertFinalNativeAuthority(tx, endpoint, native_participant_ids);
          return 'conflict';
        }
        const reservedAt = await reservePublicBudget(tx, endpoint, claimId);
        if (policy && !canClaimPublicAvailability(policy, record.data, reservedAt)) {
          throw new AppPublicError('PUBLIC_CLAIM_CONFLICT', 409);
        }
        await acceptPublicSignature(tx, endpoint, verified);
        await (this.options.deliver ?? enqueueIngress)(tx, principal.org_id, endpoint.id, ingressId, endpoint.endpoint_epoch);
        await tx.update(appPublicIngress).set({ state: 'confirmed' }).where(eq(appPublicIngress.id, ingressId));
        await assertFinalNativeAuthority(tx, endpoint, native_participant_ids);
        return { claim_id: claimId, claim_state: 'confirmed', follow_up_state: 'pending', replayed: false };
      });
    } catch (error) {
      if (error instanceof AppPublicError) throw error;
      if (error instanceof PublicBudgetExceededError) throw new AppPublicError('PUBLIC_BUDGET_EXCEEDED', 429);
      if (error instanceof PublicSignatureInvalid) throw new AppPublicError('PUBLIC_SIGNATURE_INVALID', 401);
      if (error instanceof PublicSignatureReplay) throw new AppPublicError('PUBLIC_SIGNATURE_REPLAY', 409);
      if (error instanceof PublicSignatureCapacity) throw new AppPublicError('PUBLIC_RATE_LIMITED', 429);
      throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
    }
    if (outcome === 'conflict') throw new AppPublicError('PUBLIC_CLAIM_CONFLICT', 409);
    return outcome;
  }
}

// An explicit host decision is required before any public ingress can be served.
export const appPublicClaimService = new AppPublicClaimService();
