import { and, eq, sql } from 'drizzle-orm';
import { appCanonicalClaims, appPublicCancellations, appPublicCancellationSelections } from '@deft/db/schema';
import { acquirePublicBudgetAdmission } from './app-public-budgets.js';
import { settlePublicCancellation } from './app-public-cancellation-settlement.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';

/** A separate post-commit or maintenance transaction. No provider dispatch,
 * current membership capture, Run lock, Runtime bootstrap or private delivery. */
export async function reconcilePublicCancellationForRun(tx: AppRunTransaction, orgId: string, runId: string,
  secrets: AppRunSecretService): Promise<number> {
  const [locator] = await tx.select({ request: appPublicCancellations, claim: appCanonicalClaims })
    .from(appPublicCancellationSelections).innerJoin(appPublicCancellations, and(
      eq(appPublicCancellations.org_id, appPublicCancellationSelections.org_id),
      eq(appPublicCancellations.id, appPublicCancellationSelections.cancellation_id)))
    .innerJoin(appCanonicalClaims, and(eq(appCanonicalClaims.org_id, appPublicCancellations.org_id),
      eq(appCanonicalClaims.id, appPublicCancellations.claim_id)))
    .where(and(eq(appPublicCancellationSelections.org_id, orgId), eq(appPublicCancellationSelections.cancel_run_id, runId))).limit(1);
  if (!locator || !['cancel_run_pending', 'unknown_outcome'].includes(locator.request.state)) return 0;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app-public-ingress:${orgId}:${locator.claim.ingress_id}`},0))`);
  await tx.execute(sql`SELECT id FROM app_installations WHERE org_id=${orgId} AND id=${locator.request.app_installation_id} FOR SHARE`);
  await acquirePublicBudgetAdmission(tx, orgId, locator.request.app_installation_id);
  await tx.execute(sql`SELECT id FROM app_canonical_claims WHERE org_id=${orgId} AND id=${locator.claim.id} FOR UPDATE`);
  const [before] = await tx.select({ state: appPublicCancellations.state }).from(appPublicCancellations).where(and(
    eq(appPublicCancellations.org_id, orgId), eq(appPublicCancellations.id, locator.request.id))).limit(1);
  await settlePublicCancellation(tx, orgId, locator.request.id, secrets);
  const [after] = await tx.select({ state: appPublicCancellations.state }).from(appPublicCancellations).where(and(
    eq(appPublicCancellations.org_id, orgId), eq(appPublicCancellations.id, locator.request.id))).limit(1);
  return before?.state !== after?.state ? 1 : 0;
}
