import { and, desc, eq } from 'drizzle-orm';
import { parseNativeCalendarInput, parseNativeCalendarResult } from '@deft/app-kit';
import { AppRunRetainedProviderResultSchema, parseAppRunReceiptEnvelope } from '@deft/shared';
import { appRunAttempts, appRunReceipts, appRuns, nativeCreateRequests } from '@deft/db/schema';
import { createNativeCalendarEventInTransaction, cancelNativeCalendarEventInTransaction, loadNativeCalendarEventInTransaction } from './native-calendar.js';
import { nativeCreateIdentity, nativeCreateWithExecutor } from './native-create.js';
import { nativeStale } from './app-native-authority.js';
import { PostgresAppRunReceiptReader } from './app-run-receipts.js';
import type { ReviewedNativeCapture } from './app-native-run-authorization.js';
import type { AppRunSecretRepository } from './app-run-secret-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';
import type { AppRunSafeView, AppRunTransaction } from './app-run-repository.js';

export async function executeNativeCalendarInTransaction(tx: AppRunTransaction, options: {
  run: AppRunSafeView; authority: ReviewedNativeCapture; input: unknown;
  secretRepository: AppRunSecretRepository; secrets: AppRunSecretService; now: () => Date;
}) {
  const { run, authority, secretRepository, secrets } = options;
  const operation = authority.action.operation;
  const owner = authority.binding.owner_user_id;
  const input = parseNativeCalendarInput(operation, options.input);
  if (operation === 'calendar.events.cancel.v1') {
    const cancellation = parseNativeCalendarInput('calendar.events.cancel.v1', input);
    // Terminal create rows are immutable. Do not acquire an old Run lock after App.
    const [prior] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id, run.org_id),
      eq(appRuns.id, cancellation.create_run_id))).limit(1);
    if (!prior || prior.state !== 'succeeded' || prior.origin_kind !== 'app' || prior.provider_kind !== 'native'
      || prior.operation_name !== 'calendar.events.create.v1' || prior.execution_actor_type !== 'human'
      || prior.execution_actor_id !== owner || prior.provider_instance_id !== run.provider_instance_id
      || prior.origin_app_installation_id !== authority.installation.id || prior.origin_app_version_id !== authority.version.id
      || prior.origin_app_grant_snapshot_id !== authority.grant.id || !prior.origin_native_binding_id
      || prior.result_purged_at || prior.result_expires_at <= options.now()) throw nativeStale();
    const [attempt] = await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id, run.org_id),
      eq(appRunAttempts.run_id, prior.id), eq(appRunAttempts.state, 'succeeded'))).orderBy(desc(appRunAttempts.attempt_number)).limit(1);
    if (!attempt) throw nativeStale();
    const rows = await tx.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, run.org_id),
      eq(appRunReceipts.run_id, prior.id), eq(appRunReceipts.attempt_id, attempt.id), eq(appRunReceipts.receipt_kind, 'attempt_terminal')));
    const verified = await new PostgresAppRunReceiptReader(secrets, { async list() { return rows; } }).readVerified(run.org_id, prior.id);
    const outputDigest = await secretRepository.outputEnvelopeDigest(tx, run.org_id, prior.id, attempt.id);
    if (!verified.some(item => item.run_state === 'succeeded') || !rows.some(row => {
      const receipt = parseAppRunReceiptEnvelope(row.envelope);
      return receipt.run_state === 'succeeded' && receipt.output_envelope_digest === outputDigest;
    })) throw nativeStale();
    const retained = AppRunRetainedProviderResultSchema.parse(await secretRepository.readOutput(run.org_id, prior.id, attempt.id, tx));
    const result = parseNativeCalendarResult('calendar.events.create.v1', retained.output);
    if (!retained.provider_succeeded || result.event_ref.resource_id !== cancellation.event_ref.resource_id) throw nativeStale();
    const [identity] = await tx.select().from(nativeCreateRequests).where(and(
      eq(nativeCreateRequests.id, nativeCreateIdentity(run.org_id, owner, 'app-native:calendar.events.create.v1', `app-run:${prior.id}`)),
      eq(nativeCreateRequests.org_id, run.org_id), eq(nativeCreateRequests.user_id, owner),
      eq(nativeCreateRequests.operation, 'app-native:calendar.events.create.v1'), eq(nativeCreateRequests.resource_id, result.event_ref.resource_id))).limit(1);
    if (!identity) throw nativeStale();
  }
  const { value } = await nativeCreateWithExecutor(tx, {
    orgId: run.org_id, userId: owner, operation: `app-native:${operation}`, key: `app-run:${run.id}`, payload: input,
    create: async tx => {
      if (operation === 'calendar.events.create.v1') return createNativeCalendarEventInTransaction(tx, {
        orgId: run.org_id, userId: owner, email: authority.owner.email,
        input: parseNativeCalendarInput('calendar.events.create.v1', input) });
      const cancellation = parseNativeCalendarInput('calendar.events.cancel.v1', input);
      const event = await cancelNativeCalendarEventInTransaction(tx, { orgId: run.org_id, userId: owner, eventId: cancellation.event_ref.resource_id });
      if (!event) throw nativeStale();
      return event;
    },
    replay: (tx, eventId) => loadNativeCalendarEventInTransaction(tx, { orgId: run.org_id, userId: owner, eventId }),
  });
  return parseNativeCalendarResult(operation, {
    schema_version: operation === 'calendar.events.create.v1' ? 'deft.native_calendar_create_result.v1' : 'deft.native_calendar_cancel_result.v1',
    event_ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'core', provider_instance_id: 'calendar_events' },
      resource_type: 'calendar_event', resource_id: value.id }, status: operation === 'calendar.events.create.v1' ? 'created' : 'cancelled',
  });
}
