import { sql, eq, and } from 'drizzle-orm';
import { PublicBudgetPolicySchema } from '@deft/app-kit';
import { APP_RUN_TERMINAL_STATES } from '@deft/shared';
import { appCanonicalClaims, appPublicEndpoints } from '@deft/db/schema';
import type { db } from './db.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Endpoint = typeof appPublicEndpoints.$inferSelect;
export const PUBLIC_APP_BUDGET_CEILINGS = Object.freeze({ max_pending: 25, max_confirmed_per_utc_day: 100 });
export class PublicBudgetExceededError extends Error {}

export function publicEndpointBudget(value: unknown) {
  return value == null ? PUBLIC_APP_BUDGET_CEILINGS : PublicBudgetPolicySchema.parse(value);
}

export async function acquirePublicBudgetAdmission(tx: Transaction, orgId: string, appId: string) {
  // Called after App SHARE and before endpoint/Module/record locks. Workers
  // take their per-ingress submission mutex but never take this mutex.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${`app-public-budget:${orgId}:${appId}`}, 0))`);
}

async function clock(tx: Transaction): Promise<Date> {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const value = new Date((result.rows[0] as { now: Date | string }).now);
  if (!Number.isFinite(value.getTime())) throw new Error('Public budget clock unavailable');
  return value;
}
function utcDay(now: Date) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // These columns store UTC-naive timestamps, so explicit timestamp casts
  // below must not introduce the PostgreSQL session timezone.
  return [new Date(start).toISOString().slice(0, -1), new Date(start + 86_400_000).toISOString().slice(0, -1)] as const;
}

async function assertCounts(tx: Transaction, endpoint: Endpoint, ownClaimId: string, now: Date, dailyOnly = false) {
  const [dayStart, dayEnd] = utcDay(now);
  const endpointLimit = publicEndpointBudget(endpoint.budget_policy);
  for (const scope of [
    { filter: sql`e.app_installation_id = ${endpoint.app_installation_id}`, limits: PUBLIC_APP_BUDGET_CEILINGS },
    { filter: sql`e.id = ${endpoint.id}`, limits: endpointLimit },
  ]) {
    if (!dailyOnly) {
      const pending = await tx.execute(sql`SELECT c.id FROM app_canonical_claims c
        JOIN app_public_ingress i ON i.org_id = c.org_id AND i.endpoint_id = c.endpoint_id AND i.id = c.ingress_id
        JOIN app_public_endpoints e ON e.org_id = c.org_id AND e.id = c.endpoint_id
        WHERE c.org_id = ${endpoint.org_id} AND ${scope.filter}
          AND (i.state = 'confirmed' OR c.id = ${ownClaimId})
          AND (c.id = ${ownClaimId} OR (c.released_at IS NULL AND (i.follow_up_state = 'pending'
            OR EXISTS (SELECT 1 FROM app_public_cancellations x WHERE x.org_id=c.org_id AND x.claim_id=c.id
              AND x.state IN ('withdrawal_requested','cancel_run_pending','unknown_outcome'))
            OR (i.follow_up_state = 'run_created' AND NOT EXISTS (
              SELECT 1 FROM app_runs r WHERE r.org_id = c.org_id AND r.origin_kind = 'app'
                AND r.origin_app_installation_id = e.app_installation_id
                AND r.origin_app_version_id = e.app_version_id
                AND r.origin_app_grant_snapshot_id = e.grant_snapshot_id
                AND ((e.native_binding_id IS NULL AND r.provider_kind = 'app_runtime'
                    AND r.origin_runtime_binding_id = e.runtime_binding_id)
                  OR (e.native_binding_id IS NOT NULL AND e.runtime_binding_id IS NULL
                    AND r.provider_kind = 'native' AND r.origin_native_binding_id = e.native_binding_id
                    AND r.origin_runtime_binding_id IS NULL))
                AND r.origin_public_endpoint_id = e.id AND r.origin_public_ingress_id = i.id
                AND r.initiating_actor_type = 'app_public' AND r.initiating_actor_id = i.id
                AND r.execution_actor_type = 'human' AND r.execution_actor_id = e.approver_user_id
                AND r.state IN (${sql.join(APP_RUN_TERMINAL_STATES.map(state => sql`${state}`), sql`, `)})
            ))))) LIMIT ${scope.limits.max_pending + 1}`);
      if (pending.rows.length > scope.limits.max_pending) throw new PublicBudgetExceededError();
    }
    const daily = await tx.execute(sql`SELECT c.id FROM app_canonical_claims c
      JOIN app_public_ingress i ON i.org_id = c.org_id AND i.endpoint_id = c.endpoint_id AND i.id = c.ingress_id
      JOIN app_public_endpoints e ON e.org_id = c.org_id AND e.id = c.endpoint_id
      WHERE c.org_id = ${endpoint.org_id} AND ${scope.filter}
        AND (i.state = 'confirmed' OR c.id = ${ownClaimId})
        AND COALESCE(c.budget_reserved_at, c.created_at) >= ${dayStart}::timestamp
        AND COALESCE(c.budget_reserved_at, c.created_at) < ${dayEnd}::timestamp
      LIMIT ${scope.limits.max_confirmed_per_utc_day + 1}`);
    if (daily.rows.length > scope.limits.max_confirmed_per_utc_day) throw new PublicBudgetExceededError();
  }
}

/** A selected cancellation is another pending use of its existing claim,
 * never a second booking charge or a reset of the booking's UTC day. */
export async function assertPublicCancellationPendingCapacity(tx: Transaction, endpoint: Endpoint, claimId: string) {
  for (const scope of [
    { filter: sql`e.app_installation_id=${endpoint.app_installation_id}`, limit: PUBLIC_APP_BUDGET_CEILINGS.max_pending },
    { filter: sql`e.id=${endpoint.id}`, limit: publicEndpointBudget(endpoint.budget_policy).max_pending },
  ]) {
    const rows = await tx.execute(sql`SELECT c.id FROM app_canonical_claims c
      JOIN app_public_endpoints e ON e.org_id=c.org_id AND e.id=c.endpoint_id
      JOIN app_public_ingress i ON i.org_id=c.org_id AND i.endpoint_id=c.endpoint_id AND i.id=c.ingress_id
      WHERE c.org_id=${endpoint.org_id} AND ${scope.filter} AND c.released_at IS NULL
      AND (c.id=${claimId} OR EXISTS (SELECT 1 FROM app_public_cancellations x
        WHERE x.org_id=c.org_id AND x.claim_id=c.id AND x.state IN ('withdrawal_requested','cancel_run_pending','unknown_outcome'))
        OR i.follow_up_state='pending' OR (i.follow_up_state='run_created' AND NOT EXISTS (
          SELECT 1 FROM app_runs r WHERE r.org_id=c.org_id AND r.origin_kind='app'
            AND r.origin_app_installation_id=e.app_installation_id AND r.origin_app_version_id=e.app_version_id
            AND r.origin_app_grant_snapshot_id=e.grant_snapshot_id
            AND ((e.native_binding_id IS NULL AND r.provider_kind='app_runtime' AND r.origin_runtime_binding_id=e.runtime_binding_id)
              OR (e.native_binding_id IS NOT NULL AND e.runtime_binding_id IS NULL AND r.provider_kind='native'
                AND r.origin_native_binding_id=e.native_binding_id AND r.origin_runtime_binding_id IS NULL))
            AND r.origin_public_endpoint_id=e.id AND r.origin_public_ingress_id=i.id
            AND r.initiating_actor_type='app_public' AND r.initiating_actor_id=i.id
            AND r.execution_actor_type='human' AND r.execution_actor_id=e.approver_user_id
            AND r.state IN (${sql.join(APP_RUN_TERMINAL_STATES.map(state => sql`${state}`), sql`, `)})
        ))) LIMIT ${scope.limit + 1}`);
    if (rows.rows.length > scope.limit) throw new PublicBudgetExceededError();
  }
}

/** The existing canonical claim is the charge identity; this update and all
 * counts commit or roll back with its ingress/outbox, never as a second ledger. */
export async function reservePublicBudget(tx: Transaction, endpoint: Endpoint, ownClaimId: string) {
  const initial = await clock(tx);
  await tx.update(appCanonicalClaims).set({ budget_reserved_at: initial }).where(and(
    eq(appCanonicalClaims.org_id, endpoint.org_id), eq(appCanonicalClaims.id, ownClaimId)));
  await assertCounts(tx, endpoint, ownClaimId, initial);
  const final = await clock(tx);
  await tx.update(appCanonicalClaims).set({ budget_reserved_at: final }).where(and(
    eq(appCanonicalClaims.org_id, endpoint.org_id), eq(appCanonicalClaims.id, ownClaimId)));
  if (utcDay(initial)[0] !== utcDay(final)[0]) await assertCounts(tx, endpoint, ownClaimId, final, true);
  return final;
}
