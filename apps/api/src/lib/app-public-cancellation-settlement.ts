import { and, desc, eq, sql } from 'drizzle-orm';
import { parseNativeCalendarInput, parseNativeCalendarResult } from '@deft/app-kit';
import { AppRunRetainedProviderResultSchema, parseAppRunReceiptEnvelope } from '@deft/shared';
import { appCanonicalClaims, appNativeBindings, appPublicCancellations, appPublicCancellationSelections,
  appRunAttempts, appRunReceipts, appRuns, nativeCreateRequests } from '@deft/db/schema';
import { AppRunSecretService } from './app-run-secrets.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import { PostgresAppRunReceiptReader } from './app-run-receipts.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { nativeCreateIdentity, nativeCreateRequestHash } from './native-create.js';
import { nativeStale } from './app-native-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { HistoricalCreatePinSchema } from './app-public-cancellation-contract.js';

/** Caller holds retained App budget/claim fences. Terminal proof is historical;
 * it never executes an effect, needs live old grants, or locks a Run after App. */
export async function settlePublicCancellation(tx: AppRunTransaction, orgId: string, cancellationId: string,
  receiptSecrets?: AppRunSecretService) {
  const [selection] = await tx.select().from(appPublicCancellationSelections).where(and(
    eq(appPublicCancellationSelections.org_id, orgId), eq(appPublicCancellationSelections.cancellation_id, cancellationId))).limit(1).for('share');
  if (!selection?.cancel_run_id) return;
  const [run] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, selection.cancel_run_id))).limit(1);
  const [binding] = await tx.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, orgId),
    eq(appNativeBindings.id, selection.native_binding_id))).limit(1);
  const [request] = await tx.select().from(appPublicCancellations).where(and(eq(appPublicCancellations.org_id, orgId),
    eq(appPublicCancellations.id, cancellationId))).limit(1).for('update');
  if (!request || !run || !binding || request.original_run_id !== selection.original_run_id
    || request.app_installation_id !== selection.app_installation_id || run.origin_kind !== 'app' || run.provider_kind !== 'native'
    || run.operation_name !== 'calendar.events.cancel.v1' || run.origin_app_installation_id !== selection.app_installation_id
    || run.origin_app_version_id !== binding.app_version_id || run.origin_app_grant_snapshot_id !== binding.grant_snapshot_id
    || run.origin_native_binding_id !== binding.id || run.origin_runtime_binding_id !== null
    || run.origin_public_endpoint_id !== null || run.origin_public_ingress_id !== null
    || run.provider_instance_id !== `calendar:${selection.owner_user_id}`
    || run.initiating_actor_type !== 'human' || run.initiating_actor_id !== selection.owner_user_id
    || run.execution_actor_type !== 'human' || run.execution_actor_id !== selection.owner_user_id) throw nativeStale();
  if (request.state === 'cancelled') return;
  const time = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const now = new Date((time.rows[0] as { now: string | Date }).now);
  if (run.state === 'unknown_outcome') {
    await tx.update(appPublicCancellations).set({ state: 'unknown_outcome', settled_at: null }).where(and(
      eq(appPublicCancellations.org_id, orgId), eq(appPublicCancellations.id, cancellationId)));
    return;
  }
  if (['failed', 'expired', 'cancelled'].includes(run.state)) {
    await tx.update(appPublicCancellations).set({ state: 'cancel_failed', settled_at: now }).where(and(
      eq(appPublicCancellations.org_id, orgId), eq(appPublicCancellations.id, cancellationId)));
    return;
  }
  if (run.state !== 'succeeded') return;
  const secrets = receiptSecrets ?? new AppRunSecretService((await (await import('./app-run-runtime.js')).getAppRunRuntime()).keys);
  const pin = HistoricalCreatePinSchema.parse(selection.historical_create_pin);
  const [original] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, selection.original_run_id))).limit(1);
  const [claim] = await tx.select().from(appCanonicalClaims).where(and(eq(appCanonicalClaims.org_id, orgId),
    eq(appCanonicalClaims.id, request.claim_id))).limit(1);
  if (!original || !claim || original.state !== 'succeeded' || original.provider_kind !== 'native' || original.origin_kind !== 'app'
    || original.operation_name !== 'calendar.events.create.v1' || original.execution_actor_type !== 'human'
    || original.execution_actor_id !== selection.owner_user_id || original.provider_instance_id !== run.provider_instance_id
    || original.origin_app_installation_id !== selection.app_installation_id || original.origin_app_version_id !== pin.app_version_id
    || original.origin_app_grant_snapshot_id !== pin.grant_snapshot_id || !original.origin_native_binding_id
    || original.origin_runtime_binding_id !== null || original.origin_public_endpoint_id !== request.endpoint_id
    || original.origin_public_ingress_id !== claim.ingress_id || original.initiating_actor_type !== 'app_public'
    || original.initiating_actor_id !== claim.ingress_id) throw nativeStale();
  const originalRows = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, orgId),
    eq(appRunReceipts.run_id, original.id), eq(appRunReceipts.receipt_kind, 'attempt_terminal')));
  const originalVerified = await new PostgresAppRunReceiptReader(secrets, { async list() { return originalRows; } }).readVerified(orgId, original.id);
  if (!originalVerified.some(item => item.run_state === 'succeeded') || !originalRows.some(row => {
    const receipt = parseAppRunReceiptEnvelope(row.envelope);
    return receipt.run_state === 'succeeded' && receipt.output_envelope_digest === selection.original_output_digest
      && receipt.input_fingerprint.fingerprint === original.input_fingerprint
      && receipt.input_fingerprint.key_version === original.input_fingerprint_key_version;
  })) throw nativeStale();
  const [attempt] = await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id, orgId),
    eq(appRunAttempts.run_id, run.id), eq(appRunAttempts.state, 'succeeded'))).orderBy(desc(appRunAttempts.attempt_number)).limit(1);
  if (!attempt) throw nativeStale();
  const rows = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, orgId), eq(appRunReceipts.run_id, run.id),
    eq(appRunReceipts.attempt_id, attempt.id), eq(appRunReceipts.receipt_kind, 'attempt_terminal')));
  const verified = await new PostgresAppRunReceiptReader(secrets, { async list() { return rows; } }).readVerified(orgId, run.id);
  if (!verified.some(item => item.run_state === 'succeeded') || !rows.some(row => {
    const receipt = parseAppRunReceiptEnvelope(row.envelope);
    return receipt.run_state === 'succeeded' && !!receipt.output_envelope_digest
      && receipt.operation.provider.org_id === orgId && receipt.operation.provider.provider_kind === 'native'
      && receipt.operation.provider.provider_instance_id === run.provider_instance_id
      && receipt.operation.operation_name === 'calendar.events.cancel.v1';
  })) throw nativeStale();
  const identities = [];
  for (const [operation, runId] of [['calendar.events.create.v1', selection.original_run_id], ['calendar.events.cancel.v1', run.id]] as const) {
    const [identity] = await tx.select().from(nativeCreateRequests).where(and(
      eq(nativeCreateRequests.id, nativeCreateIdentity(orgId, selection.owner_user_id, `app-native:${operation}`, `app-run:${runId}`)),
      eq(nativeCreateRequests.org_id, orgId), eq(nativeCreateRequests.user_id, selection.owner_user_id),
      eq(nativeCreateRequests.operation, `app-native:${operation}`))).limit(1);
    if (!identity) throw nativeStale();
    identities.push(identity);
  }
  // The native cancel ledger commits atomically with the effect, Run and signed
  // output receipt. Reconstruct only its closed input; never decrypt expired
  // capsules or return a retained private body during settlement.
  const input = parseNativeCalendarInput('calendar.events.cancel.v1', { create_run_id: selection.original_run_id,
    event_ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'core', provider_instance_id: 'calendar_events' },
      resource_type: 'calendar_event', resource_id: identities[0]!.resource_id } });
  if (identities[0]!.resource_id !== identities[1]!.resource_id || digestAppGrantValue(input) !== selection.input_digest
    || nativeCreateRequestHash(input) !== identities[1]!.request_hash) throw nativeStale();
  const liveTime = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const liveNow = new Date((liveTime.rows[0] as { now: string | Date }).now);
  if (!run.input_purged_at && !run.result_purged_at && run.input_expires_at > liveNow && run.result_expires_at > liveNow) {
    // Keep the stronger live-capsule proof. This repository uses the injected
    // receipt keyring and does not bootstrap Runtime or dispatch a provider.
    const payloads = new AppRunSecretRepository(secrets);
    const exact = parseNativeCalendarInput('calendar.events.cancel.v1', await payloads.readInput(orgId, run.id, tx));
    const retained = AppRunRetainedProviderResultSchema.parse(await payloads.readOutput(orgId, run.id, attempt.id, tx));
    const output = parseNativeCalendarResult('calendar.events.cancel.v1', retained.output);
    const outputDigest = await payloads.outputEnvelopeDigest(tx, orgId, run.id, attempt.id);
    if (!retained.provider_succeeded || digestAppGrantValue(exact) !== selection.input_digest
      || output.event_ref.resource_id !== input.event_ref.resource_id || !rows.some(row =>
        parseAppRunReceiptEnvelope(row.envelope).output_envelope_digest === outputDigest)) throw nativeStale();
  }
  const finalTime = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const settled = new Date((finalTime.rows[0] as { now: string | Date }).now);
  await tx.update(appCanonicalClaims).set({ released_at: settled }).where(and(eq(appCanonicalClaims.org_id, orgId),
    eq(appCanonicalClaims.id, request.claim_id), eq(appCanonicalClaims.endpoint_id, request.endpoint_id)));
  await tx.update(appPublicCancellations).set({ state: 'cancelled', settled_at: settled }).where(and(
    eq(appPublicCancellations.org_id, orgId), eq(appPublicCancellations.id, cancellationId)));
}
