import { and, eq, sql } from 'drizzle-orm';
import { appRuns, appRunAttempts, appSyncIntents, appSyncCheckpoints } from '@deft/db/schema';
import { AppRunAuthorizationSnapshotSchema, canonicalCapabilityJson } from '@deft/shared';
import type { AttachmentStageHeader } from '@deft/app-kit';
import type { AppRunTransaction } from './app-run-repository.js';
import { buildResourceSyncAuthorizationSnapshot } from './app-resource-sync-authorization.js';
import { loadLiveAttachmentSyncAuthority, type LiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { attachmentFinalAuthorityIsCurrent, attachmentStale } from './app-attachment-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { appAttachmentClaimMatches } from './app-attachment-policy.js';

/** Existing Run authorization carrier; channel3 separately binds owner-selected
 * attachment policy without reinterpreting a channel2 consent hash. */
export function buildAttachmentSyncAuthorizationSnapshot(authority: LiveAttachmentSyncBindingAuthority) {
  const base = buildResourceSyncAuthorizationSnapshot(authority);
  return AppRunAuthorizationSnapshotSchema.parse({ ...base, authority_refs: base.authority_refs.map(ref =>
    ref.authority_kind === 'policy' ? { ...ref, version: digestAppGrantValue({
      schema_version: 'deft.app_attachment.consent_pin.v1', scalar_policy: ref.version,
      attachment_consent_digest: authority.binding.attachment_consent_digest,
      channel_version: 'deft.app_runtime_channel.v3' }) } : ref) });
}

/** The service caller owns this transaction through reserve/finalize/link.
 * Identity is never read globally except the scoped credential locator used
 * before entry. Run -> sorted members -> App/grant -> registration/binding ->
 * session -> attempt -> checkpoint; no reversed membership acquisition. */
export async function loadAttachmentStageAuthority(tx: AppRunTransaction, input: {
  org_id: string; token_hash: string; header: AttachmentStageHeader; clock: () => Date;
}) {
  const h = input.header;
  await tx.execute(sql`SELECT id FROM app_runs WHERE org_id=${input.org_id} AND id=${h.run_id} FOR UPDATE`);
  const [run] = await tx.select().from(appRuns).where(and(eq(appRuns.org_id,input.org_id), eq(appRuns.id,h.run_id))).limit(1);
  if (!run || run.state !== 'running' || !run.execution_released_at || run.cancel_requested_at) throw attachmentStale();
  const authority = await loadLiveAttachmentSyncAuthority(tx, { org_id: input.org_id, session_id: h.session_id,
    token_hash: input.token_hash, clock: input.clock });
  if (!authority) throw attachmentStale();
  const { binding, registration, installation, version, grant } = authority;
  if (run.origin_kind !== 'app' || run.provider_kind !== 'app_runtime' || run.origin_resource_binding_id !== binding.id
    || run.origin_runtime_binding_id !== null || run.origin_app_installation_id !== installation.id
    || run.origin_app_version_id !== version.id || run.origin_app_grant_snapshot_id !== grant.id
    || run.provider_snapshot_id !== binding.provider_snapshot_id || run.provider_instance_id !== registration.id
    || run.initiating_actor_type !== 'system' || run.execution_actor_type !== 'system'
    || run.initiating_actor_id !== binding.id || run.execution_actor_id !== binding.id
    || run.operation_name !== binding.operation_name || run.review_scope !== binding.review_scope
    || run.risk_class !== binding.risk_class || run.review_requirement !== binding.review_requirement
    || run.retry_class !== binding.retry_class || run.retention_class !== binding.retention_class
    || canonicalCapabilityJson(run.authorization_snapshot) !== canonicalCapabilityJson(buildAttachmentSyncAuthorizationSnapshot(authority))) throw attachmentStale();
  const [intent] = await tx.select().from(appSyncIntents).where(and(eq(appSyncIntents.org_id,input.org_id),eq(appSyncIntents.run_id,run.id))).limit(1);
  if (!intent || intent.resource_binding_id !== binding.id || intent.app_installation_id !== installation.id
    || intent.app_version_id !== version.id || intent.grant_snapshot_id !== grant.id
    || intent.owner_user_id !== binding.owner_user_id || intent.provider_snapshot_id !== binding.provider_snapshot_id
    || intent.descriptor_digest !== authority.descriptor_digest) throw attachmentStale();
  await tx.execute(sql`SELECT id FROM app_run_attempts WHERE org_id=${input.org_id} AND id=${h.attempt_id} FOR UPDATE`);
  const [attempt] = await tx.select().from(appRunAttempts).where(and(eq(appRunAttempts.org_id,input.org_id),eq(appRunAttempts.id,h.attempt_id),eq(appRunAttempts.run_id,run.id))).limit(1);
  if (!attempt || attempt.runtime_session_id !== authority.session.id || attempt.resource_binding_id !== binding.id
    || attempt.runtime_binding_id !== null || attempt.runtime_epoch !== registration.runtime_epoch
    || attempt.runtime_session_epoch !== authority.session.session_epoch || attempt.runtime_result_hmac
    || attempt.provider_call_finished_at || !appAttachmentClaimMatches(h, attempt, input.clock())) throw attachmentStale();
  await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id=${input.org_id} AND id=${intent.checkpoint_id}
    AND resource_binding_id=${binding.id} FOR UPDATE`);
  const [checkpoint] = await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,input.org_id),eq(appSyncCheckpoints.id,intent.checkpoint_id),eq(appSyncCheckpoints.resource_binding_id,binding.id))).limit(1);
  if (!checkpoint || checkpoint.state !== 'active' || checkpoint.generation !== intent.generation
    || checkpoint.cursor_sequence !== intent.expected_cursor_sequence
    || checkpoint.cursor_hmac_key_version !== intent.expected_cursor_hmac_key_version
    || checkpoint.cursor_hmac !== intent.expected_cursor_hmac) throw attachmentStale();
  await assertAttachmentStageFinalAuthority(tx, { run, attempt, authority }, input.clock);
  return { run, attempt, authority, checkpoint, intent };
}
export async function assertAttachmentStageFinalAuthority(tx: AppRunTransaction, context: {
  run: typeof appRuns.$inferSelect; attempt: typeof appRunAttempts.$inferSelect;
  authority: Awaited<ReturnType<typeof loadLiveAttachmentSyncAuthority>>;
}, clock: () => Date, signal?: AbortSignal, extraDeadlines: readonly Date[] = []) {
  const { run, attempt, authority } = context;
  if (!authority || !attempt.lease_expires_at || !authority.binding.consent_expires_at
    || !await attachmentFinalAuthorityIsCurrent(tx, [authority.binding.owner_user_id,authority.registration.operator_user_id],
      { clock, signal, expires_at: [run.input_expires_at,run.result_expires_at,attempt.lease_expires_at,
        authority.session.expires_at,authority.binding.consent_expires_at,...extraDeadlines] })) throw attachmentStale();
}
