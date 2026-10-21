import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appRuntimeBindings, appResourceBindings, appRuntimeRegistrations, appRuntimeSessions, auditLog } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertContinuityProof, type UpgradeContinuityProof, continuityGuard } from './app-upgrade-trust-continuity.js';
import { hashAppRuntimeToken, loadLiveRuntimeAuthority } from './app-runtime-authority.js';
import { APP_RUNTIME_SESSION_MS } from './app-runtime-contract.js';
import { hashAppAttachmentSessionToken } from './app-attachment-policy.js';
import { loadLiveAttachmentSyncAuthority } from './app-attachment-sync-authority.js';
import { reestablishBackgroundAccess, productionBackgroundAccessPorts, backgroundChannelUrls, backgroundRenewalRequest, ChannelInstallResultSchema, CHANNEL_INSTALL_SCHEMA } from './app-runtime-background-access.js';

/** Same short-session record and final live authorizer as ordinary issuance.
 * Only a persistent consent may replace browser liveness with the exact,
 * bounded upgrade policy delegation. Finite renewal keeps its existing ceiling. */
async function issuePersistentUpgradeSession(proof: UpgradeContinuityProof, bindingId: string, kind: 'action'|'observation') {
  const session_id = randomUUID(), session_token = randomBytes(32).toString('base64url'), token_hash = kind === 'action' ? hashAppRuntimeToken(session_token) : hashAppAttachmentSessionToken(session_token);
  const expires_at = new Date(Date.now() + APP_RUNTIME_SESSION_MS - 1000);
  await db.transaction(async tx => {
    await assertContinuityProof(tx, proof);
    const table = kind === 'action' ? appRuntimeBindings : appResourceBindings;
    const [binding] = await tx.select().from(table).where(and(eq(table.org_id, proof.org_id), eq(table.id, bindingId))).limit(1);
    const [registration] = binding ? await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, proof.org_id), eq(appRuntimeRegistrations.id, binding.runtime_registration_id))).limit(1) : [];
    if (!binding || !registration || binding.app_version_id !== proof.version_id || binding.grant_snapshot_id !== proof.grant_id
      || registration.operator_user_id !== proof.operator_id || proof.source_scope.consent_lifetime !== 'until_revoked') throw new AppError('Upgrade session authority ended', 'APP_ACCESS_DENIED', 403);
    await tx.insert(appRuntimeSessions).values({ id: session_id, org_id: proof.org_id, runtime_registration_id: registration.id,
      runtime_binding_id: kind === 'action' ? binding.id : null,
      ...(kind === 'observation' ? { resource_binding_id: binding.id, audience: 'app_resource_sync' as const, session_epoch: 0 } : {}), operator_user_id: proof.operator_id, token_hash, runtime_epoch: registration.runtime_epoch,
      lifecycle_epoch: proof.lifecycle_epoch, grant_epoch: proof.grant_epoch, expires_at, renewal_lifetime: 'until_revoked',
      renewable_until: null, renewal_web_session_id: proof.web_session_id, renewal_operator_role: proof.operator_role });
    const live = kind === 'action' ? await loadLiveRuntimeAuthority(tx, proof.org_id, session_id, token_hash, () => new Date())
      : await loadLiveAttachmentSyncAuthority(tx, { org_id: proof.org_id, session_id, token_hash, clock: () => new Date() });
    if (!live) throw new AppError('Upgrade session authority ended', 'APP_ACCESS_DENIED', 403);
    await continuityGuard(proof)(tx);
    await tx.insert(auditLog).values({ org_id: proof.org_id, actor_type: 'system', actor_id: proof.operator_id,
      action: 'app.upgrade_continuity.session_issued', entity_type: 'app_runtime_session', entity_id: session_id,
      metadata: { kind, proof_id: proof.request_id, source_version_id: proof.prior_version_id, app_version_id: proof.version_id } });
  });
  return { session_id, session_token, expires_at, renewable_until: null, renewal_lifetime: 'until_revoked' as const };
}
export async function deliverUpgradeBackgroundAccess(proof: UpgradeContinuityProof) {
  const guard = continuityGuard(proof), ports = productionBackgroundAccessPorts();
  const actor: ModuleActor = { kind: 'human', actor_id: proof.owner_id, org_id: proof.org_id, role: proof.owner_role, source: 'rest', scopes: [] };
  const caller = { org_id: proof.org_id, user_id: proof.owner_id, sid: proof.web_session_id, access_expires_at: Date.parse(proof.issuance_expires_at) };
  const delegated = { ...ports,
    issueAction: async (...args: Parameters<typeof ports.issueAction>) => args[3].renewal_lifetime === 'until_revoked'
      ? issuePersistentUpgradeSession(proof, args[1], 'action') : ports.issueAction(...args),
    issueObservation: async (...args: Parameters<typeof ports.issueObservation>) => issuePersistentUpgradeSession(proof, args[1], 'observation') };
  const nomination = { installation_id: proof.installation_id, target_key: proof.source_scope.target_key };
  if (proof.owner_id === proof.operator_id) return reestablishBackgroundAccess(delegated, actor, caller, nomination, guard, AbortSignal.timeout(30000));
  // Shared deployments retain both principals. Resolve the owner scope through
  // the same live reader and issue each channel to its actual deployment operator.
  const { scope, profile } = await ports.currentAuthority(caller, nomination, guard);
  if (scope.owner_user_id !== proof.owner_id || scope.operator_user_id !== proof.operator_id) throw new AppError('Upgrade operator changed', 'APP_ACCESS_DENIED', 403);
  const operator: ModuleActor = { ...actor, actor_id: proof.operator_id, role: proof.operator_role };
  const urls = backgroundChannelUrls(), renewal = backgroundRenewalRequest(scope), channels: Record<string, unknown>[] = [];
  for (const binding of await ports.actionBindings(scope)) {
    const issued = await delegated.issueAction(operator, binding.id, guard, renewal, proof.web_session_id);
    if (!issued) throw new AppError('Upgrade session unavailable', 'APP_ACCESS_DENIED', 403);
    channels.push({ kind: 'action', channel: { channel_url: urls.action, credential: { session_id: issued.session_id, session_token: issued.session_token },
      registration: { org_id: scope.org_id, runtime_registration_id: binding.runtime_registration_id, runtime_epoch: binding.runtime_epoch },
      technical_renewal: { expires_at: new Date(issued.expires_at).toISOString(), renewable_until: issued.renewable_until ? new Date(issued.renewable_until).toISOString() : null,
        ...(issued.renewal_lifetime ? { renewal_lifetime: issued.renewal_lifetime } : {}) } } });
  }
  if (scope.consent_lifetime === 'until_revoked') {
    const issued = await delegated.issueObservation(operator, scope.resource_binding_id, guard, proof.web_session_id);
    channels.push({ kind: 'observation', channel: { channel_url: urls.observation, observation_authority_url: urls.observation_authority,
      credential: { session_id: issued.session_id, session_token: issued.session_token },
      registration: { org_id: scope.org_id, runtime_registration_id: scope.runtime_registration_id, operator_user_id: scope.operator_user_id,
        runtime_epoch: scope.runtime_epoch, profile_digest: scope.profile_digest, target_key: scope.target_key, resource_key: scope.resource_key },
      technical_renewal: { expires_at: issued.expires_at.toISOString(), renewable_until: null, renewal_lifetime: 'until_revoked' } } });
  }
  if (!channels.length) throw new AppError('Upgrade channels unavailable', 'APP_ACCESS_DENIED', 403);
  const result = ChannelInstallResultSchema.parse(await ports.install(scope, profile, { schema_version: CHANNEL_INSTALL_SCHEMA, scope, channels }, AbortSignal.timeout(30000)));
  const expected = new Set(channels.map(entry => (entry.channel as { credential: { session_id: string } }).credential.session_id));
  if (result.installed.length !== expected.size || result.installed.some(item => !expected.has(item.session_id))) throw new AppError('Upgrade delivery incomplete', 'APP_ACCESS_DENIED', 403);
  return { installed: result.installed, skipped: [] };
}
