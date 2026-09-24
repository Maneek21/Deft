import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  appCanonicalClaims, appGrantSnapshots, appInstallations, appPublicEndpoints,
  appPublicIngress, appVersions, jobQueue, moduleInstallations,
} from '@deft/db/schema';
import type { JobHandler } from '../workers/types.js';
import { db } from './db.js';
import { QUEUE_NAMES } from './queues.js';
import { publicEndpointReviewDigest } from './app-public-service.js';

const PayloadSchema = z.strictObject({
  organization_id: z.string().uuid(),
  endpoint_id: z.string().uuid(),
  ingress_id: z.string().uuid(),
  endpoint_epoch: z.number().int().positive(),
});

/** A validated queue handoff has no generic business callback yet. Persist a
 * terminal unsupported result so the queue cannot silently imply delivery. */
export const handleAppPublicIngress: JobHandler = async (job) => {
  if (job.name !== 'app-public-ingress' || job.signal?.aborted) throw new Error('Invalid public ingress job');
  const payload = PayloadSchema.parse(job.data);
  await db.transaction(async (tx) => {
    const [queued] = await tx.select().from(jobQueue).where(eq(jobQueue.id, job.id)).limit(1);
    const queuedData = queued?.data;
    const fields = queuedData as Record<string, unknown> | undefined;
    if (!queued || queued.org_id !== payload.organization_id || queued.queue !== QUEUE_NAMES.AGENT_JOBS
      || queued.name !== 'app-public-ingress' || queued.dedupe_key !== `app-public-ingress:${payload.ingress_id}`
      || !queuedData || typeof queuedData !== 'object' || Array.isArray(queuedData)
      || Object.keys(queuedData).length !== 4
      || fields?.organization_id !== payload.organization_id || fields?.endpoint_id !== payload.endpoint_id
      || fields?.ingress_id !== payload.ingress_id || fields?.endpoint_epoch !== payload.endpoint_epoch) {
      throw new Error('Invalid public ingress queue identity');
    }
    // Locator only. Preserve App -> endpoint lock order used by the claim and
    // lifecycle paths; no caller supplied principal or cookie enters here.
    const [locator] = await tx.select({ app_installation_id: appPublicEndpoints.app_installation_id })
      .from(appPublicEndpoints).where(and(
        eq(appPublicEndpoints.org_id, payload.organization_id), eq(appPublicEndpoints.id, payload.endpoint_id),
      )).limit(1);
    if (!locator) throw new Error('Public ingress endpoint is missing');
    const [app] = await tx.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, payload.organization_id), eq(appInstallations.id, locator.app_installation_id),
    )).limit(1).for('share');
    if (!app) throw new Error('Public ingress app is missing');
    const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(
      eq(appPublicEndpoints.org_id, payload.organization_id), eq(appPublicEndpoints.id, payload.endpoint_id),
    )).limit(1).for('share');
    if (!endpoint || endpoint.app_installation_id !== app.id) throw new Error('Public ingress endpoint changed');
    const [version] = await tx.select({ id: appVersions.id }).from(appVersions).where(and(
      eq(appVersions.org_id, payload.organization_id), eq(appVersions.id, endpoint.app_version_id),
      eq(appVersions.installation_id, app.id), eq(appVersions.state, 'active'),
    )).limit(1);
    const [grant] = await tx.select({ id: appGrantSnapshots.id }).from(appGrantSnapshots).where(and(
      eq(appGrantSnapshots.org_id, payload.organization_id), eq(appGrantSnapshots.id, endpoint.grant_snapshot_id),
      eq(appGrantSnapshots.app_installation_id, app.id), eq(appGrantSnapshots.app_version_id, endpoint.app_version_id),
      eq(appGrantSnapshots.snapshot_kind, 'effective'),
    )).limit(1);
    const [module] = await tx.select().from(moduleInstallations).where(and(
      eq(moduleInstallations.org_id, payload.organization_id), eq(moduleInstallations.id, endpoint.module_installation_id),
    )).limit(1).for('share');
    const [ingress] = await tx.select().from(appPublicIngress).where(and(
      eq(appPublicIngress.org_id, payload.organization_id), eq(appPublicIngress.endpoint_id, endpoint.id),
      eq(appPublicIngress.id, payload.ingress_id),
    )).limit(1).for('update');
    if (!ingress || ingress.endpoint_epoch !== payload.endpoint_epoch || ingress.state !== 'confirmed') {
      throw new Error('Public ingress receipt is not confirmed');
    }
    const [claim] = await tx.select().from(appCanonicalClaims).where(and(
      eq(appCanonicalClaims.org_id, payload.organization_id), eq(appCanonicalClaims.endpoint_id, endpoint.id),
      eq(appCanonicalClaims.ingress_id, ingress.id),
    )).limit(1);
    if (!claim || claim.provider_kind !== 'module' || claim.provider_instance_id !== endpoint.module_installation_id
      || claim.resource_type !== endpoint.collection_key || claim.claim_kind !== 'exclusive') {
      throw new Error('Public ingress claim is missing');
    }
    if (ingress.follow_up_state === 'unsupported') return;
    if (ingress.follow_up_state !== 'pending') throw new Error('Invalid public follow-up state');
    const live = endpoint.state === 'enabled' && endpoint.endpoint_epoch === payload.endpoint_epoch
      && endpoint.review_digest === publicEndpointReviewDigest(endpoint)
      && app.state === 'active' && app.active_version_id === endpoint.app_version_id
      && app.active_grant_snapshot_id === endpoint.grant_snapshot_id
      && app.lifecycle_epoch === endpoint.installation_lifecycle_epoch
      && app.grant_epoch === endpoint.installation_grant_epoch
      && Boolean(version && grant && module?.is_enabled && !module.is_deleted);
    if (job.signal?.aborted) throw new Error('Public ingress job aborted');
    await tx.update(appPublicIngress).set({
      follow_up_state: 'unsupported',
      follow_up_code: live ? 'APP_HANDLER_UNAVAILABLE' : 'ENDPOINT_REVOKED',
      handled_at: new Date(),
    }).where(eq(appPublicIngress.id, ingress.id));
  });
};
