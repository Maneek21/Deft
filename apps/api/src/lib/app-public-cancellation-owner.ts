import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { ModuleActor } from '@deft/shared/modules';
import { appPublicCancellations, appPublicCancellationSelections, appRuns } from '@deft/db/schema';
import { db } from './db.js';
import { assertNativeCalendarEnabled, nativeStale } from './app-native-authority.js';
import { nativeFinalAuthorityIsCurrent } from './app-native-final-authority.js';
import { captureReviewedNativeInTransaction } from './app-native-run-authorization.js';
import { acquirePublicBudgetAdmission, assertPublicCancellationPendingCapacity } from './app-public-budgets.js';
import { AppRunSecretService } from './app-run-secrets.js';
import { safeRunSelection, type AppRunTransaction } from './app-run-repository.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { acquireRetainedCancellationMutex, certifyRetainedCancellation } from './app-public-cancellation-authority.js';
import { PublicCancellationOwnerReviewSchema, PublicCancellationOwnerSubmitSchema, PUBLIC_CANCELLATION_OWNER_REVIEW_MS,
  sealPublicCancellationReview, openPublicCancellationReview, type PublicCancellationReviewToken } from './app-public-cancellation-contract.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';

type OwnerOptions = { guard: WebAuthorityGuard; sid: string };
const scope = (actor: ModuleActor, sid: string) => `sha256:${createHash('sha256')
  .update(JSON.stringify(['deft.app_public_cancellation.owner_session.v1', actor.org_id, actor.actor_id, sid])).digest('hex')}`;
async function clock(tx: AppRunTransaction) {
  const row = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const value = new Date((row.rows[0] as { now: string | Date }).now);
  if (!Number.isFinite(value.getTime())) throw nativeStale();
  return value;
}
async function final(tx: AppRunTransaction, participants: readonly string[], options: OwnerOptions, deadlines: readonly Date[]) {
  // Fresh SQL time after all writes, extended conservatively by monotonic
  // elapsed time through the exact SID guard and final human read. No awaited
  // operation follows the final human/gate/deadline fence.
  const pg = await clock(tx), sampled = performance.now();
  if (!await nativeFinalAuthorityIsCurrent(tx, participants, { guard: options.guard, expires_at: deadlines,
    clock: () => new Date(Math.max(Date.now(), pg.getTime() + performance.now() - sampled)) })) throw nativeStale();
}
function human(actor: ModuleActor) {
  assertNativeCalendarEnabled();
  if (actor.kind !== 'human' || !['rest', 'ui'].includes(actor.source)) throw nativeStale();
}

export async function reviewPublicCancellationOwner(actor: ModuleActor, cancellationId: string, raw: unknown, options: OwnerOptions) {
  human(actor);
  const input = PublicCancellationOwnerReviewSchema.parse(raw);
  const runtime = await (await import('./app-run-runtime.js')).getAppRunRuntime();
  const secrets = new AppRunSecretService(runtime.keys);
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout=5000`);
    await tx.execute(sql`SET LOCAL lock_timeout=1000`);
    await acquireRetainedCancellationMutex(tx, actor.org_id, cancellationId);
    const capture = await captureReviewedNativeInTransaction(tx, { org_id: actor.org_id, user_id: actor.actor_id,
      native_binding_id: input.native_binding_id });
    if (capture.binding.consent_digest !== input.expected_consent_digest) throw nativeStale();
    const certified = await certifyRetainedCancellation(tx, capture, cancellationId, secrets, runtime.secretRepository, await clock(tx));
    if (certified.claim.released_at) throw nativeStale();
    await options.guard(tx);
    const now = await clock(tx), expires = new Date(Math.min(now.getTime() + PUBLIC_CANCELLATION_OWNER_REVIEW_MS,
      options.guard.current_web_session_expires_at().getTime(),
      certified.certified.run.result_expires_at.getTime()));
    const snapshot: PublicCancellationReviewToken = {
      schema_version: 'deft.app_public_cancellation_owner_review_token.v1',
      org_id: actor.org_id, cancellation_id: cancellationId, original_run_id: certified.certified.run.id, owner_user_id: actor.actor_id,
      native_binding_id: capture.binding.id, consent_digest: capture.binding.consent_digest!, proposal_digest: capture.binding.proposal_digest,
      app_version_id: capture.version.id, grant_snapshot_id: capture.grant.id,
      input_digest: digestAppGrantValue(certified.certified.input), output_digest: certified.certified.output_digest!,
      session_scope_digest: scope(actor, options.sid), issued_at: now.toISOString(), expires_at: expires.toISOString(),
    };
    const review_digest = digestAppGrantValue(snapshot), review_token = sealPublicCancellationReview(runtime.keys, snapshot);
    await final(tx, capture.participants, options, [expires]);
    return { schema_version: 'deft.app_public_cancellation_owner_review.v1', cancellation_id: cancellationId,
      request: input, original_create_pin: certified.certified.pin,
      current_app_version_id: capture.version.id, native_binding_id: capture.binding.id,
      historical_create_policy: capture.binding.historical_create_policy ?? null,
      input: certified.certified.input, review_digest, review_token, expires_at: expires.toISOString(),
      host_policy: { normal_owner_approval_required: true, old_grant_execution: false, automatic_rebinding: false } };
  });
}

export async function submitPublicCancellationOwner(actor: ModuleActor, cancellationId: string, raw: unknown, options: OwnerOptions) {
  human(actor);
  const input = PublicCancellationOwnerSubmitSchema.parse(raw);
  const runtime = await (await import('./app-run-runtime.js')).getAppRunRuntime();
  const secrets = new AppRunSecretService(runtime.keys);
  let snapshot: PublicCancellationReviewToken;
  try { snapshot = openPublicCancellationReview(runtime.keys, input.review_token); } catch { throw nativeStale(); }
  if (snapshot.org_id !== actor.org_id || snapshot.cancellation_id !== cancellationId || snapshot.owner_user_id !== actor.actor_id
    || snapshot.session_scope_digest !== scope(actor, options.sid) || snapshot.native_binding_id !== input.native_binding_id
    || snapshot.consent_digest !== input.expected_consent_digest || digestAppGrantValue(snapshot) !== input.expected_review_digest) throw nativeStale();
  const expires = new Date(snapshot.expires_at);
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout=5000`);
    await tx.execute(sql`SET LOCAL lock_timeout=1000`);
    await acquireRetainedCancellationMutex(tx, actor.org_id, cancellationId);
    const capture = await captureReviewedNativeInTransaction(tx, { org_id: actor.org_id, user_id: actor.actor_id,
      native_binding_id: input.native_binding_id });
    if (capture.binding.consent_digest !== snapshot.consent_digest || capture.binding.proposal_digest !== snapshot.proposal_digest
      || capture.version.id !== snapshot.app_version_id || capture.grant.id !== snapshot.grant_snapshot_id) throw nativeStale();
    await acquirePublicBudgetAdmission(tx, actor.org_id, capture.installation.id);
    const certified = await certifyRetainedCancellation(tx, capture, cancellationId, secrets, runtime.secretRepository, await clock(tx));
    if (certified.certified.run.id !== snapshot.original_run_id || digestAppGrantValue(certified.certified.input) !== snapshot.input_digest
      || certified.certified.output_digest !== snapshot.output_digest) throw nativeStale();
    const [prior] = await tx.select().from(appPublicCancellationSelections).where(and(
      eq(appPublicCancellationSelections.org_id, actor.org_id), eq(appPublicCancellationSelections.cancellation_id, cancellationId)))
      .limit(1).for('update');
    if (prior) {
      if (!prior.cancel_run_id || prior.native_binding_id !== input.native_binding_id || prior.consent_digest !== input.expected_consent_digest
        || prior.owner_user_id !== actor.actor_id) throw nativeStale();
      // Retained replay is a read, never an existing Run UPDATE behind App.
      const [run] = await tx.select(safeRunSelection).from(appRuns).where(and(eq(appRuns.org_id, actor.org_id), eq(appRuns.id, prior.cancel_run_id))).limit(1);
      if (!run) throw nativeStale();
      await final(tx, capture.participants, options, [expires]);
      return { run, replayed: true };
    }
    if (certified.claim.released_at) throw nativeStale();
    await assertPublicCancellationPendingCapacity(tx, certified.endpoint, certified.claim.id);
    const selection_digest = digestAppGrantValue({ schema_version: 'deft.app_public_cancellation_selection.v1',
      cancellation_id: cancellationId, original_run_id: certified.certified.run.id,
      native_binding_id: capture.binding.id, consent_digest: capture.binding.consent_digest,
      owner_user_id: actor.actor_id, historical_create_pin: certified.certified.pin,
      input_digest: snapshot.input_digest, output_digest: snapshot.output_digest });
    await tx.insert(appPublicCancellationSelections).values({ id: randomUUID(), org_id: actor.org_id,
      cancellation_id: cancellationId, app_installation_id: capture.installation.id,
      original_run_id: certified.certified.run.id, owner_user_id: actor.actor_id,
      native_binding_id: capture.binding.id, consent_digest: capture.binding.consent_digest!, selection_digest,
      historical_create_pin: certified.certified.pin, input_digest: snapshot.input_digest, original_output_digest: snapshot.output_digest,
      cancel_run_id: null, created_at: await clock(tx) });
    const run = await runtime.service.submitReviewedPublicCancellationInTransaction(tx, {
      org_id: actor.org_id, cancellation_id: cancellationId, owner_user_id: actor.actor_id });
    await tx.update(appPublicCancellationSelections).set({ cancel_run_id: run.id }).where(and(
      eq(appPublicCancellationSelections.org_id, actor.org_id), eq(appPublicCancellationSelections.cancellation_id, cancellationId)));
    await tx.update(appPublicCancellations).set({ state: 'cancel_run_pending', settled_at: null }).where(and(
      eq(appPublicCancellations.org_id, actor.org_id), eq(appPublicCancellations.id, cancellationId)));
    await final(tx, capture.participants, options, [expires, run.input_expires_at, run.result_expires_at]);
    return { run, replayed: false };
  });
  if (result.run.state === 'pending_approval') {
    const { PostgresAppRunAttentionProjector } = await import('./app-run-attention.js');
    await new PostgresAppRunAttentionProjector().projectApprovalRequested(actor.org_id, result.run.id);
  }
  return { schema_version: 'deft.app_public_cancellation_owner_submit_result.v1', ...result };
}
