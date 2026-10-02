import { and, desc, eq } from 'drizzle-orm';
import { parseNativeCalendarInput, parseNativeCalendarResult } from '@deft/app-kit';
import { AppRunRetainedProviderResultSchema, parseAppRunReceiptEnvelope } from '@deft/shared';
import { appGrantSnapshots, appRunAttempts, appRunReceipts, appRuns, appVersions, nativeCreateRequests } from '@deft/db/schema';
import { nativeStale } from './app-native-authority.js';
import { nativeCreateIdentity, nativeCreateRequestHash } from './native-create.js';
import { PostgresAppRunReceiptReader } from './app-run-receipts.js';
import { HistoricalCreatePolicySchema, historicalCreateIsExplicitlyConsented } from './app-public-cancellation-contract.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunSecretRepository } from './app-run-secret-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';

/** A tuple names retained ancestry, not an active grant or an executable owner. */
export async function validateHistoricalCreatePolicy(tx: AppRunTransaction, identity: {
  org_id: string; installation_id: string; owner_user_id: string;
}, value: unknown) {
  if (value == null) return;
  const policy = HistoricalCreatePolicySchema.parse(value);
  for (const pin of policy.creates) {
    const [version] = await tx.select({ package_digest: appVersions.package_digest }).from(appVersions).where(and(
      eq(appVersions.org_id, identity.org_id), eq(appVersions.installation_id, identity.installation_id),
      eq(appVersions.id, pin.app_version_id))).limit(1);
    const [grant] = await tx.select({ digest: appGrantSnapshots.snapshot_digest }).from(appGrantSnapshots).where(and(
      eq(appGrantSnapshots.org_id, identity.org_id), eq(appGrantSnapshots.app_installation_id, identity.installation_id),
      eq(appGrantSnapshots.app_version_id, pin.app_version_id), eq(appGrantSnapshots.id, pin.grant_snapshot_id),
      eq(appGrantSnapshots.snapshot_kind, 'effective'))).limit(1);
    const [create] = await tx.select({ id: appRuns.id }).from(appRuns).where(and(eq(appRuns.org_id, identity.org_id),
      eq(appRuns.origin_app_installation_id, identity.installation_id), eq(appRuns.origin_app_version_id, pin.app_version_id),
      eq(appRuns.origin_app_grant_snapshot_id, pin.grant_snapshot_id), eq(appRuns.origin_kind, 'app'),
      eq(appRuns.provider_kind, 'native'), eq(appRuns.operation_name, 'calendar.events.create.v1'),
      eq(appRuns.execution_actor_type, 'human'), eq(appRuns.execution_actor_id, identity.owner_user_id),
      eq(appRuns.state, 'succeeded'))).limit(1);
    if (!version || version.package_digest !== pin.package_digest || grant?.digest !== pin.grant_snapshot_digest || !create) throw nativeStale();
  }
}

/** Terminal create rows are retained reads: never lock the old Run after App.
 * Only certified result/receipt/native-create identity can supply cancel input. */
export async function loadCertifiedPublicCreate(tx: AppRunTransaction, options: {
  org_id: string; create_run_id: string; installation_id: string; owner_user_id: string;
  current_version_id: string; current_grant_id: string; historical_create_policy: unknown;
  secretRepository: AppRunSecretRepository; secrets: AppRunSecretService; now: Date;
}) {
  const [run] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, options.org_id),
    eq(appRuns.id, options.create_run_id))).limit(1);
  if (!run || run.state !== 'succeeded' || run.origin_kind !== 'app' || run.provider_kind !== 'native'
    || run.operation_name !== 'calendar.events.create.v1' || !run.origin_native_binding_id
    || run.execution_actor_type !== 'human' || run.execution_actor_id !== options.owner_user_id
    || run.provider_instance_id !== `calendar:${options.owner_user_id}`
    || run.origin_app_installation_id !== options.installation_id || !run.origin_app_version_id
    || !run.origin_app_grant_snapshot_id || run.result_purged_at || run.result_expires_at <= options.now) throw nativeStale();
  const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, options.org_id),
    eq(appVersions.installation_id, options.installation_id), eq(appVersions.id, run.origin_app_version_id))).limit(1);
  const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, options.org_id),
    eq(appGrantSnapshots.app_installation_id, options.installation_id), eq(appGrantSnapshots.id, run.origin_app_grant_snapshot_id),
    eq(appGrantSnapshots.app_version_id, run.origin_app_version_id), eq(appGrantSnapshots.snapshot_kind, 'effective'))).limit(1);
  if (!version || !grant || grant.package_digest !== version.package_digest) throw nativeStale();
  const pin = { app_version_id: version.id, package_digest: version.package_digest,
    grant_snapshot_id: grant.id, grant_snapshot_digest: grant.snapshot_digest };
  if ((version.id !== options.current_version_id || grant.id !== options.current_grant_id)
    && !historicalCreateIsExplicitlyConsented(options.historical_create_policy, pin)) throw nativeStale();
  const [attempt] = await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id, options.org_id),
    eq(appRunAttempts.run_id, run.id), eq(appRunAttempts.state, 'succeeded')))
    .orderBy(desc(appRunAttempts.attempt_number)).limit(1);
  if (!attempt) throw nativeStale();
  const rows = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, options.org_id),
    eq(appRunReceipts.run_id, run.id), eq(appRunReceipts.attempt_id, attempt.id), eq(appRunReceipts.receipt_kind, 'attempt_terminal')));
  const verified = await new PostgresAppRunReceiptReader(options.secrets, { async list() { return rows; } }).readVerified(options.org_id, run.id);
  const outputDigest = await options.secretRepository.outputEnvelopeDigest(tx, options.org_id, run.id, attempt.id);
  if (!verified.some(item => item.run_state === 'succeeded') || !rows.some(row => {
    const receipt = parseAppRunReceiptEnvelope(row.envelope);
    return receipt.run_state === 'succeeded' && receipt.output_envelope_digest === outputDigest;
  })) throw nativeStale();
  const retained = AppRunRetainedProviderResultSchema.parse(await options.secretRepository.readOutput(options.org_id, run.id, attempt.id, tx));
  const result = parseNativeCalendarResult('calendar.events.create.v1', retained.output);
  if (!retained.provider_succeeded || run.input_purged_at || run.input_expires_at <= options.now) throw nativeStale();
  const createInput = parseNativeCalendarInput('calendar.events.create.v1', await options.secretRepository.readInput(options.org_id, run.id, tx));
  const [identity] = await tx.select().from(nativeCreateRequests).where(and(
    eq(nativeCreateRequests.id, nativeCreateIdentity(options.org_id, options.owner_user_id, 'app-native:calendar.events.create.v1', `app-run:${run.id}`)),
    eq(nativeCreateRequests.org_id, options.org_id), eq(nativeCreateRequests.user_id, options.owner_user_id),
    eq(nativeCreateRequests.operation, 'app-native:calendar.events.create.v1'), eq(nativeCreateRequests.resource_id, result.event_ref.resource_id))).limit(1);
  if (!identity || identity.request_hash !== nativeCreateRequestHash(createInput)) throw nativeStale();
  return { run, pin, output_digest: outputDigest, input: { create_run_id: run.id, event_ref: result.event_ref } };
}
