import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appCanonicalClaims, appPublicCancellations, appPublicEndpoints, appPublicIngress,
  appInstallations, appRuns, appRunAttempts } from '@deft/db/schema';
import { db } from './db.js';
import { AppPublicError } from './app-public-service.js';
import { acquirePublicBudgetAdmission } from './app-public-budgets.js';
import { PublicControlInputSchema, PublicCancelInputSchema, publicControlMatches,
  type PublicControlState } from './app-public-control-contract.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function clock(tx: Tx) {
  const row = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const now = new Date((row.rows[0] as { now: Date | string }).now);
  if (!Number.isFinite(now.getTime())) throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
  return now;
}
const absent = () => new AppPublicError('PUBLIC_NOT_FOUND', 404);

function exactRun(run: typeof appRuns.$inferSelect, endpoint: typeof appPublicEndpoints.$inferSelect, ingressId: string) {
  return run.org_id === endpoint.org_id && run.origin_kind === 'app' && run.provider_kind === 'native'
    && run.operation_name === 'calendar.events.create.v1' && run.origin_native_binding_id === endpoint.native_binding_id
    && run.origin_runtime_binding_id === null && run.origin_app_installation_id === endpoint.app_installation_id
    && run.origin_app_version_id === endpoint.app_version_id && run.origin_app_grant_snapshot_id === endpoint.grant_snapshot_id
    && run.origin_public_endpoint_id === endpoint.id && run.origin_public_ingress_id === ingressId
    && run.initiating_actor_type === 'app_public' && run.initiating_actor_id === ingressId
    && run.execution_actor_type === 'human' && run.execution_actor_id === endpoint.approver_user_id;
}

/** Historical control authorizes only its retained canonical work. It never
 * borrows current membership, the old grant or a native effect capability. */
export async function publicClaimControl(slug: string, claimId: string, raw: Uint8Array, cancel: boolean) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(slug) || !z.string().uuid().safeParse(claimId).success) throw absent();
  if (raw.byteLength > 1024) throw new AppPublicError('PUBLIC_PAYLOAD_TOO_LARGE', 413);
  let input: z.infer<typeof PublicControlInputSchema> | z.infer<typeof PublicCancelInputSchema>;
  try { input = (cancel ? PublicCancelInputSchema : PublicControlInputSchema).parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
  catch { throw new AppPublicError('PUBLIC_INVALID_INPUT', 400); }
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = 5000`);
      await tx.execute(sql`SET LOCAL lock_timeout = 1000`);
      const [locator] = await tx.select({ claim: appCanonicalClaims, endpoint: appPublicEndpoints }).from(appCanonicalClaims)
        .innerJoin(appPublicEndpoints, and(eq(appPublicEndpoints.org_id, appCanonicalClaims.org_id),
          eq(appPublicEndpoints.id, appCanonicalClaims.endpoint_id))).where(and(eq(appPublicEndpoints.slug_digest, hash(slug)),
          eq(appCanonicalClaims.id, claimId))).limit(1);
      if (!locator || !locator.endpoint.native_binding_id || !publicControlMatches(locator.claim.control_digest,
        locator.claim.org_id, locator.endpoint.id, claimId, input.control_secret)) throw absent();
      const org = locator.claim.org_id;
      if (cancel) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${`app-public-ingress:${org}:${locator.claim.ingress_id}`}, 0))`);
      const runtime = cancel ? await (await import('./app-run-runtime.js')).getAppRunRuntime() : null;
      const [runLocator] = cancel ? await tx.select({ id: appRuns.id }).from(appRuns).where(and(
        eq(appRuns.org_id, org),
        eq(appRuns.origin_public_ingress_id, locator.claim.ingress_id))).limit(1) : [];
      const run = runLocator ? await runtime!.repository.lockRun(tx, org, runLocator.id) : null;
      const [runAncestry] = run ? await tx.select().from(appRuns).where(and(eq(appRuns.org_id, org), eq(appRuns.id, run.id))).limit(1) : [];
      if (cancel) {
        const [app] = await tx.select({ id: appInstallations.id }).from(appInstallations).where(and(
          eq(appInstallations.org_id, org), eq(appInstallations.id, locator.endpoint.app_installation_id))).limit(1).for('share');
        if (!app) throw absent();
        await acquirePublicBudgetAdmission(tx, org, app.id);
      }
      const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, org),
        eq(appPublicEndpoints.id, locator.endpoint.id))).limit(1).for('share');
      const claimQuery = tx.select().from(appCanonicalClaims).where(and(eq(appCanonicalClaims.org_id, org),
        eq(appCanonicalClaims.id, claimId), eq(appCanonicalClaims.endpoint_id, locator.endpoint.id))).limit(1);
      const [claim] = cancel ? await claimQuery.for('update') : await claimQuery;
      if (!endpoint || endpoint.app_installation_id !== locator.endpoint.app_installation_id || !claim
        || !publicControlMatches(claim.control_digest, org, endpoint.id, claim.id, input.control_secret)) throw absent();
      // Take insert table locks before the charge clock. A held table must not
      // charge the pre-wait UTC day or admit an expired customer control.
      if (cancel) await tx.execute(sql`LOCK TABLE app_public_cancellations IN ROW EXCLUSIVE MODE`);
      const [prior] = await tx.select().from(appPublicCancellations).where(and(eq(appPublicCancellations.org_id, org),
        eq(appPublicCancellations.claim_id, claim.id))).limit(1);
      const now = await clock(tx);
      if (!claim.control_expires_at || claim.control_expires_at <= now) throw absent();
      const result = (state: PublicControlState, id: string | null, replayed: boolean) => ({
        schema_version: 'deft.app_public_control_result.v1' as const, claim_id: claim.id,
        cancellation_id: id, state, control_expires_at: claim.control_expires_at!.toISOString(), replayed,
      });
      if (!cancel) return result(prior?.state ?? (claim.released_at ? 'released_before_effect' : 'reserved'), prior?.id ?? null, false);
      if (prior && prior.state !== 'withdrawal_requested') return result(prior.state, prior.id, true);
      const [ingress] = await tx.select().from(appPublicIngress).where(and(eq(appPublicIngress.org_id, org),
        eq(appPublicIngress.endpoint_id, endpoint.id), eq(appPublicIngress.id, claim.ingress_id))).limit(1).for('update');
      if (!ingress || ingress.state !== 'confirmed' || (run && (!runAncestry || !exactRun(runAncestry, endpoint, ingress.id)))
        || (ingress.follow_up_state === 'run_created' && !run)) throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
      // The runner locks this Run before claiming or starting its attempt. An
      // entirely untouched pending attempt may remain as retained audit work;
      // any claim, lease, start, finish or outcome evidence fails closed.
      const unsafeAttempts = run ? await tx.select({ id: appRunAttempts.id }).from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, org), eq(appRunAttempts.run_id, run.id),
        sql`(${appRunAttempts.state} <> 'pending' OR ${appRunAttempts.claim_owner} IS NOT NULL
          OR ${appRunAttempts.claim_token} IS NOT NULL OR ${appRunAttempts.claimed_at} IS NOT NULL
          OR ${appRunAttempts.lease_expires_at} IS NOT NULL OR ${appRunAttempts.provider_call_started_at} IS NOT NULL
          OR ${appRunAttempts.provider_call_finished_at} IS NOT NULL OR ${appRunAttempts.safe_outcome} IS NOT NULL
          OR ${appRunAttempts.error_code} IS NOT NULL)`)).limit(1) : [];
      const noEffect = !run || (!run.started_at && unsafeAttempts.length === 0 && (
        ['pending', 'pending_approval'].includes(run.state)
        || (['cancelled', 'expired', 'failed'].includes(run.state) && run.safe_outcome?.provider_call_attempted === false)));
      const state: Exclude<PublicControlState, 'reserved'> = noEffect ? 'released_before_effect'
        : run && ['running', 'waiting_external', 'unknown_outcome'].includes(run.state)
          ? 'withdrawal_requested' : 'cancellation_unavailable';
      if (!prior) {
        const [dayStart, dayEnd] = [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
          new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))].map(d => d.toISOString().slice(0, -1));
        const rows = await tx.execute(sql`SELECT id FROM app_public_cancellations WHERE org_id=${org}
          AND app_installation_id=${endpoint.app_installation_id} LIMIT 4097`);
        const daily = await tx.execute(sql`SELECT id FROM app_public_cancellations WHERE org_id=${org}
          AND app_installation_id=${endpoint.app_installation_id}
          AND accepted_at>=${dayStart}::timestamp AND accepted_at<${dayEnd}::timestamp LIMIT 101`);
        if (rows.rows.length >= 4096 || daily.rows.length >= 100) throw new AppPublicError('PUBLIC_RATE_LIMITED', 429);
      }
      let chargedAt = await clock(tx);
      if (claim.control_expires_at <= chargedAt) throw absent();
      // A rollover after the count awaits must re-count the freshly charged day.
      if (!prior && chargedAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
        const start = chargedAt.toISOString().slice(0, 10), next = new Date(Date.UTC(chargedAt.getUTCFullYear(),
          chargedAt.getUTCMonth(), chargedAt.getUTCDate() + 1)).toISOString().slice(0, 10);
        const freshDaily = await tx.execute(sql`SELECT id FROM app_public_cancellations WHERE org_id=${org}
          AND app_installation_id=${endpoint.app_installation_id} AND accepted_at>=${start}::timestamp
          AND accepted_at<${next}::timestamp LIMIT 101`);
        if (freshDaily.rows.length >= 100) throw new AppPublicError('PUBLIC_RATE_LIMITED', 429);
      }
      if (noEffect) {
        if (run && ['pending', 'pending_approval'].includes(run.state)) await runtime!.repository.transition(tx, {
          run, state: 'cancelled', now: chargedAt, error_code: 'APP_RUN_CANCELLED',
          actor: { actor_type: 'app_public', endpoint_id: endpoint.id, ingress_id: ingress.id },
          safe_outcome: { success: false, provider_call_attempted: false, result_status: 'unavailable', error_code: 'APP_RUN_CANCELLED' },
        });
        await tx.update(appCanonicalClaims).set({ released_at: claim.released_at ?? chargedAt }).where(and(
          eq(appCanonicalClaims.org_id, org), eq(appCanonicalClaims.id, claim.id)));
        if (ingress.follow_up_state === 'pending') await tx.update(appPublicIngress).set({
          follow_up_state: 'unsupported', follow_up_code: 'PUBLIC_WITHDRAWN', handled_at: chargedAt,
        }).where(and(eq(appPublicIngress.org_id, org), eq(appPublicIngress.id, ingress.id)));
      } else if (run && ['running', 'waiting_external'].includes(run.state)) await runtime!.repository.requestCancellation(tx,
        run, { actor_type: 'app_public', endpoint_id: endpoint.id, ingress_id: ingress.id }, chargedAt);
      const finalCharge = await clock(tx);
      if (claim.control_expires_at <= finalCharge) throw absent();
      if (!prior && finalCharge.toISOString().slice(0, 10) !== chargedAt.toISOString().slice(0, 10)) {
        const start = finalCharge.toISOString().slice(0, 10), next = new Date(Date.UTC(finalCharge.getUTCFullYear(),
          finalCharge.getUTCMonth(), finalCharge.getUTCDate() + 1)).toISOString().slice(0, 10);
        const finalDaily = await tx.execute(sql`SELECT id FROM app_public_cancellations WHERE org_id=${org}
          AND app_installation_id=${endpoint.app_installation_id} AND accepted_at>=${start}::timestamp
          AND accepted_at<${next}::timestamp LIMIT 101`);
        if (finalDaily.rows.length >= 100) throw new AppPublicError('PUBLIC_RATE_LIMITED', 429);
      }
      chargedAt = finalCharge;
      const id = prior?.id ?? randomUUID();
      if (prior) await tx.update(appPublicCancellations).set({ state,
        settled_at: state === 'withdrawal_requested' ? null : chargedAt }).where(and(
        eq(appPublicCancellations.org_id, org), eq(appPublicCancellations.id, id)));
      else await tx.insert(appPublicCancellations).values({ id, org_id: org, app_installation_id: endpoint.app_installation_id,
        endpoint_id: endpoint.id, claim_id: claim.id, original_run_id: run?.id ?? null,
        request_key_digest: hash(JSON.stringify(['deft.app_public_cancel.v1', org, claim.id,
          'idempotency_key' in input ? input.idempotency_key : ''])),
        state, accepted_at: chargedAt, settled_at: state === 'withdrawal_requested' ? null : chargedAt });
      if (claim.control_expires_at <= await clock(tx)) throw absent();
      return result(state, id, Boolean(prior));
    });
  } catch (error) {
    if (error instanceof AppPublicError) throw error;
    throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
  }
}
