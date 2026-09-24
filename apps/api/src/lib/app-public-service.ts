import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
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
  follow_up_state: 'pending' | 'unsupported';
  replayed: boolean;
}>;

export type AppPublicErrorCode =
  | 'PUBLIC_NOT_FOUND'
  | 'PUBLIC_INVALID_INPUT'
  | 'PUBLIC_PAYLOAD_TOO_LARGE'
  | 'PUBLIC_IDEMPOTENCY_CONFLICT'
  | 'PUBLIC_CLAIM_CONFLICT'
  | 'PUBLIC_UNAVAILABLE';

export class AppPublicError extends Error {
  constructor(readonly code: AppPublicErrorCode, readonly status: 400 | 404 | 409 | 413 | 503) {
    super(code === 'PUBLIC_NOT_FOUND' ? 'Public endpoint not found'
      : code === 'PUBLIC_INVALID_INPUT' ? 'Invalid public claim'
      : code === 'PUBLIC_PAYLOAD_TOO_LARGE' ? 'Public request is too large'
      : code === 'PUBLIC_IDEMPOTENCY_CONFLICT' ? 'Request key belongs to different input'
      : code === 'PUBLIC_CLAIM_CONFLICT' ? 'Resource is unavailable'
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
  | 'collection_key' | 'endpoint_epoch' | 'public_label' | 'max_body_bytes'>): string {
  return hash(JSON.stringify({
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

async function resolveEndpoint(tx: PublicTransaction, slug: string): Promise<{
  endpoint: Endpoint; principal: AppPublicPrincipal; app: AppInstallation;
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
  }).from(appPublicEndpoints).where(eq(appPublicEndpoints.slug_digest, slugDigest)).limit(1);
  if (!locator) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  const [app] = await tx.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, locator.org_id),
    eq(appInstallations.id, locator.app_installation_id),
  )).limit(1).for('share');
  if (!app) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
    eq(appPublicEndpoints.org_id, locator.org_id),
    eq(appPublicEndpoints.id, locator.id),
  )).limit(1).for('share');
  if (!endpoint || endpoint.slug_digest !== slugDigest
    || endpoint.app_installation_id !== app.id || endpoint.state !== 'enabled'
    || endpoint.review_digest !== publicEndpointReviewDigest(endpoint)) {
    throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  }
  return { endpoint, principal: principalFor(endpoint), app };
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

  const [version] = await tx.select({ id: appVersions.id }).from(appVersions).where(and(
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
  const [binding] = await tx.select({ module_version_id: appModuleBindings.module_version_id })
    .from(appModuleBindings).where(and(
      eq(appModuleBindings.org_id, principal.org_id),
      eq(appModuleBindings.app_installation_id, app.id),
      eq(appModuleBindings.app_version_id, endpoint.app_version_id),
      eq(appModuleBindings.module_installation_id, moduleInstallation.id),
      eq(appModuleBindings.module_id, moduleInstallation.module_id),
    )).limit(1);
  if (!binding) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
  const [moduleVersion] = await tx.select({ id: moduleVersions.id }).from(moduleVersions).where(and(
    eq(moduleVersions.org_id, principal.org_id),
    eq(moduleVersions.installation_id, moduleInstallation.id),
    eq(moduleVersions.id, binding.module_version_id),
    eq(moduleVersions.is_active, true),
  )).limit(1);
  if (!moduleVersion) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
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

  async claim(slug: string, rawBody: Uint8Array): Promise<PublicClaimResult> {
    if (!this.isEnabled()) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
    if (rawBody.byteLength > MAX_PUBLIC_BODY_BYTES) throw new AppPublicError('PUBLIC_PAYLOAD_TOO_LARGE', 413);
    let outcome: PublicClaimResult | 'conflict';
    try {
      outcome = await db.transaction(async (tx) => {
        const { endpoint, principal, app } = await resolveEndpoint(tx, slug);
        await assertLiveAuthority(tx, endpoint, principal, app);
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
          return outcomeFromReceipt(tx, receipt, fingerprint);
        }
        const [record] = await tx.select({ id: moduleRecords.id, revision: moduleRecords.revision })
          .from(moduleRecords).where(and(
            eq(moduleRecords.org_id, principal.org_id),
            eq(moduleRecords.installation_id, endpoint.module_installation_id),
            eq(moduleRecords.id, ref.resource_id),
            eq(moduleRecords.collection_key, endpoint.collection_key),
            eq(moduleRecords.is_deleted, false),
          )).limit(1).for('share');
        if (!record || record.revision !== input.expected_revision) {
          await tx.update(appPublicIngress).set({ state: 'conflict' }).where(eq(appPublicIngress.id, ingressId));
          return 'conflict';
        }
        const claimId = randomUUID();
        const [claimed] = await tx.insert(appCanonicalClaims).values({
          id: claimId, org_id: principal.org_id, endpoint_id: endpoint.id, ingress_id: ingressId,
          provider_kind: 'module', provider_instance_id: endpoint.module_installation_id,
          resource_type: endpoint.collection_key, resource_id: record.id,
          claim_kind: 'exclusive',
        }).onConflictDoNothing().returning({ id: appCanonicalClaims.id });
        if (!claimed) {
          await tx.update(appPublicIngress).set({ state: 'conflict' }).where(eq(appPublicIngress.id, ingressId));
          return 'conflict';
        }
        await (this.options.deliver ?? enqueueIngress)(tx, principal.org_id, endpoint.id, ingressId, endpoint.endpoint_epoch);
        await tx.update(appPublicIngress).set({ state: 'confirmed' }).where(eq(appPublicIngress.id, ingressId));
        return { claim_id: claimId, claim_state: 'confirmed', follow_up_state: 'pending', replayed: false };
      });
    } catch (error) {
      if (error instanceof AppPublicError) throw error;
      throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
    }
    if (outcome === 'conflict') throw new AppPublicError('PUBLIC_CLAIM_CONFLICT', 409);
    return outcome;
  }
}

// An explicit host decision is required before any public ingress can be served.
export const appPublicClaimService = new AppPublicClaimService();
