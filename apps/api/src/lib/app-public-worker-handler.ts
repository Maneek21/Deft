import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  appCanonicalClaims, appGrantSnapshots, appInstallations, appPublicEndpoints,
  appPublicIngress, appVersions, jobQueue, moduleInstallations,
  appRuns,
} from '@deft/db/schema';
import type { JobHandler } from '../workers/types.js';
import { db } from './db.js';
import { QUEUE_NAMES } from './queues.js';
import { publicEndpointReviewDigest } from './app-public-service.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { AppRunError } from './app-run-errors.js';

const PayloadSchema = z.strictObject({
  organization_id: z.string().uuid(),
  endpoint_id: z.string().uuid(),
  ingress_id: z.string().uuid(),
  endpoint_epoch: z.number().int().positive(),
});

/** Only reviewed runtime/native mappings are executable follow-ups. Historical
 * unmapped ingress stays terminal unsupported; no package callback is invoked. */
export const handleAppPublicIngress: JobHandler = async (job) => {
  if (job.name !== 'app-public-ingress' || job.signal?.aborted) throw new Error('Invalid public ingress job');
  const payload = PayloadSchema.parse(job.data);
  let approvalToProject: string | null = null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 15000`);
    await tx.execute(sql`SET LOCAL lock_timeout = 5000`);
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
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`app-public-ingress:${payload.organization_id}:${payload.ingress_id}`}, 0))`);
    const [actionLocator] = await tx.select({ public_action_key: appPublicEndpoints.public_action_key,
      native_binding_id: appPublicEndpoints.native_binding_id })
      .from(appPublicEndpoints).where(and(
        eq(appPublicEndpoints.org_id, payload.organization_id),
        eq(appPublicEndpoints.id, payload.endpoint_id),
      )).limit(1);
    const [receiptLocator] = await tx.select({ follow_up_state: appPublicIngress.follow_up_state })
      .from(appPublicIngress).where(and(
        eq(appPublicIngress.org_id, payload.organization_id),
        eq(appPublicIngress.endpoint_id, payload.endpoint_id),
        eq(appPublicIngress.id, payload.ingress_id),
      )).limit(1);
    if (actionLocator?.public_action_key && receiptLocator?.follow_up_state === 'pending') {
      try {
        if (job.signal?.aborted) throw new Error('Public ingress job aborted');
        const service = (await getAppRunRuntime()).service;
        // Both helpers own their complete participant-before-App prefix. This
        // branch is deliberately before the fallback App/endpoint lock path.
        const run = await (actionLocator.native_binding_id
          ? service.submitReviewedPublicNativeInTransaction(tx, {
            org_id: payload.organization_id, endpoint_id: payload.endpoint_id, ingress_id: payload.ingress_id,
          }) : service.submitReviewedPublicRuntimeInTransaction(tx, {
          org_id: payload.organization_id, endpoint_id: payload.endpoint_id,
          ingress_id: payload.ingress_id,
        }));
        const [updated] = await tx.update(appPublicIngress).set({
          follow_up_state: 'run_created', handled_at: new Date(),
        }).where(and(eq(appPublicIngress.org_id, payload.organization_id),
          eq(appPublicIngress.endpoint_id, payload.endpoint_id),
          eq(appPublicIngress.id, payload.ingress_id),
          eq(appPublicIngress.follow_up_state, 'pending'))).returning({ id: appPublicIngress.id });
        if (!updated || run.initiating_actor_type !== 'app_public'
          || run.initiating_actor_id !== payload.ingress_id) throw new Error('Public Run link failed');
        if (job.signal?.aborted) throw new Error('Public ingress job aborted');
        if (run.state === 'pending_approval') approvalToProject = run.id;
        return;
      } catch (error) {
        if (!(error instanceof AppRunError)
          || !['APP_RUN_AUTHORIZATION_STALE', 'APP_RUN_ACCESS_DENIED'].includes(error.code)) throw error;
        // A stale/revoked mapping stays a terminal unsupported receipt. No
        // part of a failed Run submission is committed by this branch.
      }
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
    if (ingress.follow_up_state === 'run_created') {
      const [run] = await tx.select({ id: appRuns.id, state: appRuns.state }).from(appRuns).where(and(
        eq(appRuns.org_id, payload.organization_id),
        eq(appRuns.origin_public_endpoint_id, endpoint.id),
        eq(appRuns.origin_public_ingress_id, ingress.id),
        eq(appRuns.initiating_actor_type, 'app_public'),
      )).limit(1);
      if (!run) throw new Error('Public ingress Run link is missing');
      if (run.state === 'pending_approval') approvalToProject = run.id;
      return;
    }
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
  if (approvalToProject) {
    await (await getAppRunRuntime()).service.projectPendingApproval(payload.organization_id,
      approvalToProject);
  }
};
