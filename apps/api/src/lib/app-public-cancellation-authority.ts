import { and, eq, sql } from 'drizzle-orm';
import { AppRunAuthorizationSnapshotSchema } from '@deft/shared';
import { appCanonicalClaims, appPublicCancellations, appPublicCancellationSelections, appPublicEndpoints, appRuns } from '@deft/db/schema';
import { parseNativeCalendarInput } from '@deft/app-kit';
import { nativeStale } from './app-native-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { loadCertifiedPublicCreate } from './app-public-cancellation-ancestry.js';
import { HistoricalCreatePinSchema, historicalCreateIsExplicitlyConsented } from './app-public-cancellation-contract.js';
import type { ReviewedNativeCapture } from './app-native-run-authorization.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunSecretRepository } from './app-run-secret-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';

export async function retainedPublicCancellation(tx: AppRunTransaction, orgId: string, cancellationId: string) {
  const [row] = await tx.select({ cancellation: appPublicCancellations, claim: appCanonicalClaims, endpoint: appPublicEndpoints })
    .from(appPublicCancellations).innerJoin(appCanonicalClaims, and(eq(appCanonicalClaims.org_id, appPublicCancellations.org_id),
      eq(appCanonicalClaims.id, appPublicCancellations.claim_id), eq(appCanonicalClaims.endpoint_id, appPublicCancellations.endpoint_id)))
    .innerJoin(appPublicEndpoints, and(eq(appPublicEndpoints.org_id, appPublicCancellations.org_id),
      eq(appPublicEndpoints.id, appPublicCancellations.endpoint_id),
      eq(appPublicEndpoints.app_installation_id, appPublicCancellations.app_installation_id)))
    .where(and(eq(appPublicCancellations.org_id, orgId), eq(appPublicCancellations.id, cancellationId))).limit(1);
  if (!row || !row.cancellation.original_run_id || !row.endpoint.native_binding_id || !row.claim.control_digest
    || !row.claim.control_expires_at) throw nativeStale();
  return row;
}
export async function acquireRetainedCancellationMutex(tx: AppRunTransaction, orgId: string, cancellationId: string) {
  const locator = await retainedPublicCancellation(tx, orgId, cancellationId);
  // Always before current membership locks: the ingress worker uses this prefix.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${`app-public-ingress:${orgId}:${locator.claim.ingress_id}`}, 0))`);
  return locator;
}

export async function certifyRetainedCancellation(tx: AppRunTransaction, capture: ReviewedNativeCapture,
  cancellationId: string, secrets: AppRunSecretService, secretRepository: AppRunSecretRepository, now: Date) {
  const retained = await retainedPublicCancellation(tx, capture.binding.org_id, cancellationId);
  if (capture.action.operation !== 'calendar.events.cancel.v1'
    || retained.cancellation.app_installation_id !== capture.installation.id
    || retained.endpoint.approver_user_id !== capture.binding.owner_user_id) throw nativeStale();
  const certified = await loadCertifiedPublicCreate(tx, {
    org_id: capture.binding.org_id, create_run_id: retained.cancellation.original_run_id!,
    installation_id: capture.installation.id, owner_user_id: capture.binding.owner_user_id,
    current_version_id: capture.version.id, current_grant_id: capture.grant.id,
    historical_create_policy: capture.binding.historical_create_policy, secrets, secretRepository, now,
  });
  const original = certified.run;
  if (original.origin_public_endpoint_id !== retained.endpoint.id || original.origin_public_ingress_id !== retained.claim.ingress_id
    || original.origin_app_version_id !== retained.endpoint.app_version_id
    || original.origin_app_grant_snapshot_id !== retained.endpoint.grant_snapshot_id
    || original.origin_native_binding_id !== retained.endpoint.native_binding_id
    || original.initiating_actor_type !== 'app_public' || original.initiating_actor_id !== retained.claim.ingress_id) throw nativeStale();
  return { ...retained, certified };
}

export type ReviewedPublicCancellationCapture = ReviewedNativeCapture & {
  public_cancellation: { id: string; selection_digest: string; input: { create_run_id: string; event_ref: unknown } };
};

/** Internal selection association is the sole locator; public/direct native
 * submissions cannot supply this policy ref or acquire historical authority. */
export async function decoratePublicCancellationCapture(tx: AppRunTransaction, capture: ReviewedNativeCapture,
  identity: { cancellation_id: string; run_id?: string }, secrets: AppRunSecretService,
  secretRepository: AppRunSecretRepository, now: Date): Promise<ReviewedPublicCancellationCapture> {
  const [selection] = await tx.select().from(appPublicCancellationSelections).where(and(
    eq(appPublicCancellationSelections.org_id, capture.binding.org_id),
    eq(appPublicCancellationSelections.cancellation_id, identity.cancellation_id))).limit(1).for('share');
  if (!selection || selection.native_binding_id !== capture.binding.id || selection.owner_user_id !== capture.binding.owner_user_id
    || selection.consent_digest !== capture.binding.consent_digest || selection.app_installation_id !== capture.installation.id
    || (identity.run_id ? selection.cancel_run_id !== identity.run_id : selection.cancel_run_id !== null)) throw nativeStale();
  let certifiedInput: { create_run_id: string; event_ref: unknown };
  if (identity.run_id) {
    // After admission the current binding and immutable association govern the
    // captured capsule. Do not recompute input or borrow the retired endpoint.
    const retained = await retainedPublicCancellation(tx, capture.binding.org_id, identity.cancellation_id);
    const [original] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, capture.binding.org_id),
      eq(appRuns.id, selection.original_run_id))).limit(1);
    const pin = HistoricalCreatePinSchema.parse(selection.historical_create_pin);
    certifiedInput = parseNativeCalendarInput('calendar.events.cancel.v1', await secretRepository.readInput(capture.binding.org_id, identity.run_id, tx));
    if (!original || original.state !== 'succeeded' || original.provider_kind !== 'native' || original.origin_kind !== 'app'
      || original.operation_name !== 'calendar.events.create.v1' || original.origin_app_installation_id !== capture.installation.id
      || original.origin_app_version_id !== pin.app_version_id || original.origin_app_grant_snapshot_id !== pin.grant_snapshot_id
      || retained.cancellation.original_run_id !== original.id || retained.cancellation.app_installation_id !== capture.installation.id
      || original.origin_native_binding_id !== retained.endpoint.native_binding_id || original.origin_runtime_binding_id !== null
      || original.execution_actor_type !== 'human' || original.execution_actor_id !== capture.binding.owner_user_id
      || original.provider_instance_id !== `calendar:${capture.binding.owner_user_id}`
      || original.origin_public_endpoint_id !== retained.endpoint.id || original.origin_public_ingress_id !== retained.claim.ingress_id
      || original.initiating_actor_type !== 'app_public' || original.initiating_actor_id !== retained.claim.ingress_id
      || certifiedInput.create_run_id !== original.id || digestAppGrantValue(certifiedInput) !== selection.input_digest
      || ((pin.app_version_id !== capture.version.id || pin.grant_snapshot_id !== capture.grant.id)
        && !historicalCreateIsExplicitlyConsented(capture.binding.historical_create_policy, pin))) throw nativeStale();
  } else {
    const current = await certifyRetainedCancellation(tx, capture, identity.cancellation_id, secrets, secretRepository, now);
    if (digestAppGrantValue(current.certified.pin) !== digestAppGrantValue(selection.historical_create_pin)
      || current.certified.output_digest !== selection.original_output_digest) throw nativeStale();
    certifiedInput = current.certified.input;
  }
  const expected = digestAppGrantValue({ schema_version: 'deft.app_public_cancellation_selection.v1',
    cancellation_id: selection.cancellation_id, original_run_id: selection.original_run_id,
    native_binding_id: capture.binding.id, consent_digest: capture.binding.consent_digest,
    owner_user_id: capture.binding.owner_user_id, historical_create_pin: HistoricalCreatePinSchema.parse(selection.historical_create_pin),
    input_digest: digestAppGrantValue(certifiedInput), output_digest: selection.original_output_digest });
  if (selection.selection_digest !== expected) throw nativeStale();
  const authorization_snapshot = AppRunAuthorizationSnapshotSchema.parse({ ...capture.authorization_snapshot,
    authority_refs: [...capture.authorization_snapshot.authority_refs,
      { authority_kind: 'policy', authority_id: `public-cancellation:${selection.cancellation_id}`, version: expected }]
      .sort((a, b) => `${a.authority_kind}\0${a.authority_id}`.localeCompare(`${b.authority_kind}\0${b.authority_id}`)),
  });
  return { ...capture, authorization_snapshot, public_cancellation: {
    id: selection.cancellation_id, selection_digest: expected, input: certifiedInput,
  } };
}
