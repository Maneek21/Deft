import { APP_RUN_TERMINAL_STATES } from '@deft/shared';
import { experienceRunState } from './app-experience-run-presentation.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appExperienceSessions, appGrantSnapshots, appInstallations, appRuntimeBindings, appRuntimeRegistrations,
  appVersions, appNativeBindings, appRuns, agentActions, orgMembers, users, webSessions, appExperienceConsentGrants } from '@deft/db/schema';
import { parseRuntimeAppManifest, verifyDeftAppPackageJson,
  verifyDeftExperienceArtifact, parseResourceAppManifest, parseNativeAppManifest, parseAttachmentAppManifest } from '@deft/app-kit';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { AppRuntimeActionService, appRuntimeActionService } from './app-runtime-action-service.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { isAppExperienceResourceExposureEnabled, isAppV5RuntimeActionsEnabled, isAppNativeCalendarEnabled, isAppAttachmentBrokerEnabled, isAppPrivateStateEnabled } from './env.js';
import { nativeFinalAuthorityIsCurrent } from './app-native-final-authority.js';
import { experienceExposureDatabase } from './app-experience-exposure-db.js';
import { ExperienceConsentScopeSchema, experienceConsentDigest } from './app-experience-consent-contract.js';

const SESSION_MS = 15 * 60_000;
const MAX_ACTIVE_PER_WEB_APP = 8;
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const actionRequest = z.strictObject({
  request_id: z.string().regex(/^request_[1-9][0-9]{0,8}$/),
  input: z.unknown(),
});
export type ExperienceCaller = Readonly<{ org_id: string; user_id: string; sid: string; access_expires_at?: number }>;
type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
const denied = () => new AppError('Experience access denied', 'APP_ACCESS_DENIED', 403);
const stale = () => new AppError('Experience session is no longer current', 'APP_STALE', 409);

export async function assertExperienceMember(tx: Executor, caller: ExperienceCaller) {
  const [member] = await tx.select({ is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, caller.org_id), eq(orgMembers.user_id, caller.user_id))).limit(1).for('share');
  const [user] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, caller.user_id)).limit(1);
  if (user?.kind !== 'human' || !member?.is_active) throw denied();
}
export async function assertExperienceWeb(tx: Executor, caller: ExperienceCaller) {
  const [web] = await tx.select().from(webSessions).where(and(
    eq(webSessions.id, caller.sid), eq(webSessions.org_id, caller.org_id),
    eq(webSessions.user_id, caller.user_id),
  )).limit(1).for('share');
  if (!web || web.revoked_at) throw denied();
  const [user] = await tx.select({ kind: users.kind }).from(users)
    .where(eq(users.id, caller.user_id)).limit(1);
  const [member] = await tx.select({ is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, caller.org_id),
      eq(orgMembers.user_id, caller.user_id))).limit(1);
  if (user?.kind !== 'human' || !member?.is_active || web.expires_at <= new Date()
    || (caller.access_expires_at !== undefined && caller.access_expires_at <= Date.now())) throw denied();
  return web;
}

export async function verifiedExperienceBundle(version: typeof appVersions.$inferSelect, experienceKey: string) {
  const native = version.protocol_version === '6';
  const resource = version.protocol_version === '5';
  const attachment = version.protocol_version === '7';
  if (attachment ? !isAppAttachmentBrokerEnabled() || !isAppExperienceResourceExposureEnabled()
    : native ? !isAppNativeCalendarEnabled() : resource ? !isAppExperienceResourceExposureEnabled() : version.protocol_version !== '4') throw stale();
  const manifest = attachment ? parseAttachmentAppManifest(version.manifest) : native ? parseNativeAppManifest(version.manifest)
    : resource ? parseResourceAppManifest(version.manifest) : parseRuntimeAppManifest(version.manifest);
  if (manifest.schema_version !== (attachment ? '7' : native ? '6' : resource ? '5' : '4')) throw stale();
  const reference = manifest.experiences.find((item) => item.key === experienceKey);
  if (!reference) throw denied();
  const verified = await verifyDeftAppPackageJson(JSON.stringify(version.package));
  if (verified.digest !== version.package_digest
    || verified.package.manifest_digest !== version.manifest_digest
    || verified.package.manifest.schema_version !== (attachment ? '7' : native ? '6' : resource ? '5' : '4')) throw stale();
  const artifact = verified.package.artifacts.find((item) => item.path === reference.artifact_path);
  if (!artifact) throw stale();
  const bundle = await verifyDeftExperienceArtifact({
    artifact_path: reference.artifact_path,
    artifact_digest: reference.artifact_digest,
    bridge_version: reference.bridge_version,
    renderer_version: reference.renderer_version,
  }, artifact);
  if (attachment) {
    if (manifest.schema_version !== '7' || !['deft.experience_bundle.v2', 'deft.experience_bundle.v3'].includes(bundle.schema_version)
      || manifest.native_actions.length || manifest.public_actions.length
      || bundle.resource_keys.some(key => !manifest.sync_descriptors.some(item => item.key === key))
      || bundle.action_keys.some(key => !manifest.runtime_actions.some(item => item.key === key))) throw stale();
  } else if (native) {
    if ((bundle.resource_keys.length && !isAppExperienceResourceExposureEnabled())
      || manifest.schema_version !== '6'
      || bundle.resource_keys.some(resourceKey => !manifest.sync_descriptors.some(item => item.key === resourceKey))
      || bundle.action_keys.some(actionKey => !manifest.native_actions.some(item => item.key === actionKey)
        && (!isAppV5RuntimeActionsEnabled() || !manifest.runtime_actions.some(item => item.key === actionKey)))) throw stale();
  } else if ((!resource && bundle.resource_keys.length !== 0)
    || (resource && ((bundle.action_keys.length > 0 && !isAppV5RuntimeActionsEnabled()) || manifest.schema_version !== '5'
      || bundle.resource_keys.some(resourceKey => !manifest.sync_descriptors.some(d => d.key === resourceKey))))
    || bundle.action_keys.some((action) => !manifest.runtime_actions.some((item) => item.key === action))) {
    throw stale();
  }
  if (bundle.schema_version === 'deft.experience_bundle.v3'
    && (manifest.schema_version !== '7' || !isAppPrivateStateEnabled()
      || bundle.state_keys.some(key => !manifest.private_state?.some(state => state.key === key)))) throw stale();
  return { manifest, reference, bundle };
}

export class AppExperienceService {
  constructor(private readonly runtime: AppRuntimeActionService = appRuntimeActionService) {}

  async create(caller: ExperienceCaller, installationId: string, experienceKey: string) {
    uuid.parse(installationId); key.parse(experienceKey);
    return db.transaction(async (tx) => {
      await assertExperienceMember(tx, caller);
      // The cap is serialized across API processes, including parallel tabs.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${`experience:${caller.org_id}:${caller.sid}:${installationId}`}, 0))`);
      const [installation] = await tx.select().from(appInstallations).where(and(
        eq(appInstallations.org_id, caller.org_id), eq(appInstallations.id, installationId),
      )).limit(1).for('share');
      if (!installation || installation.state !== 'active' || !installation.active_version_id
        || !installation.active_grant_snapshot_id || installation.active_grant_snapshot_kind !== 'effective') throw stale();
      const [version] = await tx.select().from(appVersions).where(and(
        eq(appVersions.org_id, caller.org_id), eq(appVersions.installation_id, installationId),
        eq(appVersions.id, installation.active_version_id), eq(appVersions.state, 'active'),
      )).limit(1).for('share');
      const [grant] = await tx.select().from(appGrantSnapshots).where(and(
        eq(appGrantSnapshots.org_id, caller.org_id),
        eq(appGrantSnapshots.app_installation_id, installationId),
        eq(appGrantSnapshots.app_version_id, installation.active_version_id),
        eq(appGrantSnapshots.id, installation.active_grant_snapshot_id),
        eq(appGrantSnapshots.snapshot_kind, 'effective'),
      )).limit(1).for('share');
      if (!version || !grant || grant.package_digest !== version.package_digest
        || grant.manifest_digest !== version.manifest_digest) throw stale();
      if (version.protocol_version === '7') {
        const { loadReviewedAttachmentApp } = await import('./app-attachment-authority.js');
        const current = await loadReviewedAttachmentApp(tx, caller.org_id, installationId);
        if (!current.composition || current.version.id !== version.id || current.grant.id !== grant.id) throw stale();
      }
      const { reference, bundle } = await verifiedExperienceBundle(version, experienceKey);
      const now = new Date();
      await tx.delete(appExperienceSessions).where(and(
        eq(appExperienceSessions.org_id, caller.org_id),
        eq(appExperienceSessions.web_session_id, caller.sid),
        eq(appExperienceSessions.app_installation_id, installationId),
        or(and(lt(appExperienceSessions.expires_at, now), isNull(appExperienceSessions.consent_grant_id)),
          lt(appExperienceSessions.revoked_at, now)),
        // Retained human Run authorization may reference a legacy exposure.
        // Its history must not be cascade-deleted by opening another tab.
        sql`NOT EXISTS (SELECT 1 FROM app_experience_resource_exposures e
          JOIN app_run_human_authorizations h ON h.org_id=e.org_id AND h.exposure_id=e.id
          WHERE e.org_id=${appExperienceSessions.org_id} AND e.experience_session_id=${appExperienceSessions.id})`,
      ));
      const active = await tx.select({ id: appExperienceSessions.id }).from(appExperienceSessions)
        .where(and(eq(appExperienceSessions.org_id, caller.org_id),
          eq(appExperienceSessions.web_session_id, caller.sid),
          eq(appExperienceSessions.app_installation_id, installationId),
          gt(appExperienceSessions.expires_at, now),
          isNull(appExperienceSessions.revoked_at))).limit(MAX_ACTIVE_PER_WEB_APP);
      if (active.length >= MAX_ACTIVE_PER_WEB_APP) {
        throw new AppError('Too many open Experience sessions', 'APP_STATE_CONFLICT', 409);
      }
      const web = await assertExperienceWeb(tx, caller);
      const sessionId = randomUUID();
      const expiresAt = new Date(Math.min(Date.now() + SESSION_MS, web.expires_at.getTime(), caller.access_expires_at ?? Infinity));
      await tx.insert(appExperienceSessions).values({
        id: sessionId, org_id: caller.org_id, user_id: caller.user_id,
        web_session_id: caller.sid, app_installation_id: installation.id,
        app_version_id: version.id, grant_snapshot_id: grant.id,
        experience_key: experienceKey, artifact_digest: reference.artifact_digest,
        lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch,
        created_at: now, expires_at: expiresAt,
      });
      if (version.protocol_version === '6' && !await nativeFinalAuthorityIsCurrent(tx, [caller.user_id],
        { expires_at: [expiresAt] })) throw stale();
      if (version.protocol_version === '7') {
        const { attachmentFinalAuthorityIsCurrent } = await import('./app-attachment-authority.js');
        if (!await attachmentFinalAuthorityIsCurrent(tx, [caller.user_id], { expires_at: [expiresAt] })
          || !isAppExperienceResourceExposureEnabled()) throw stale();
      }
      return { pin: { org_id: caller.org_id, user_id: caller.user_id,
        app_installation_id: installation.id, app_version_id: version.id,
        grant_snapshot_id: grant.id, lifecycle_epoch: installation.lifecycle_epoch,
        grant_epoch: installation.grant_epoch, session_id: sessionId, session_epoch: 0 },
        experience: { key: experienceKey, label: reference.label,
          artifact_digest: reference.artifact_digest,
          bridge_version: reference.bridge_version, renderer_version: reference.renderer_version },
        bundle, ...(version.protocol_version === '7' ? { protocol_version: '7' as const } : {}), expires_at: expiresAt.toISOString() };
    });
  }

  private async lockedLiveContext(tx: AppRunTransaction, caller: ExperienceCaller, sessionId: string, sessionLock: 'share' | 'update' = 'share') {
    uuid.parse(sessionId);
      const [locator] = await tx.select().from(appExperienceSessions).where(and(
        eq(appExperienceSessions.id, sessionId), eq(appExperienceSessions.org_id, caller.org_id),
      )).limit(1);
      if (!locator || locator.user_id !== caller.user_id || locator.web_session_id !== caller.sid) throw denied();
      await assertExperienceMember(tx, caller);
      const session = locator;
      const [installation] = await tx.select().from(appInstallations).where(and(
        eq(appInstallations.org_id, caller.org_id),
        eq(appInstallations.id, session.app_installation_id),
      )).limit(1).for('share');
      if (!installation || installation.state !== 'active'
        || installation.active_version_id !== session.app_version_id
        || installation.active_grant_snapshot_id !== session.grant_snapshot_id
        || installation.active_grant_snapshot_kind !== 'effective'
        || installation.lifecycle_epoch !== session.lifecycle_epoch
        || installation.grant_epoch !== session.grant_epoch) throw stale();
      const [version] = await tx.select().from(appVersions).where(and(
        eq(appVersions.org_id, caller.org_id),
        eq(appVersions.installation_id, session.app_installation_id),
        eq(appVersions.id, session.app_version_id),
        eq(appVersions.state, 'active'),
      )).limit(1).for('share');
      const [grant] = await tx.select().from(appGrantSnapshots).where(and(
        eq(appGrantSnapshots.org_id, caller.org_id),
        eq(appGrantSnapshots.app_installation_id, session.app_installation_id),
        eq(appGrantSnapshots.app_version_id, session.app_version_id),
        eq(appGrantSnapshots.id, session.grant_snapshot_id),
        eq(appGrantSnapshots.snapshot_kind, 'effective'),
      )).limit(1).for('share');
      if (!version || !grant || grant.package_digest !== version.package_digest
        || grant.manifest_digest !== version.manifest_digest) throw stale();
      const verified = await verifiedExperienceBundle(version, session.experience_key);
      if (version.protocol_version === '7') {
        const { loadReviewedAttachmentApp } = await import('./app-attachment-authority.js');
        const current = await loadReviewedAttachmentApp(tx, caller.org_id, session.app_installation_id);
        if (!current.composition || current.version.id !== version.id || current.grant.id !== grant.id) throw stale();
      }
      if (verified.reference.artifact_digest !== session.artifact_digest) throw stale();
      const [lockedSession] = await tx.select().from(appExperienceSessions).where(and(
        eq(appExperienceSessions.id, sessionId), eq(appExperienceSessions.org_id, caller.org_id))).limit(1).for(sessionLock);
      if (!lockedSession || lockedSession.revoked_at || lockedSession.user_id !== caller.user_id
        || lockedSession.web_session_id !== caller.sid
        || lockedSession.app_installation_id !== session.app_installation_id || lockedSession.app_version_id !== session.app_version_id
        || lockedSession.grant_snapshot_id !== session.grant_snapshot_id || lockedSession.grant_snapshot_kind !== session.grant_snapshot_kind
        || lockedSession.lifecycle_epoch !== session.lifecycle_epoch || lockedSession.grant_epoch !== session.grant_epoch
        || lockedSession.experience_key !== session.experience_key || lockedSession.artifact_digest !== session.artifact_digest
        || lockedSession.consent_grant_id !== session.consent_grant_id
        || lockedSession.expires_at.getTime() !== session.expires_at.getTime()) throw stale();
      if (lockedSession.consent_grant_id) {
        const [consent] = await tx.select().from(appExperienceConsentGrants).where(and(
          eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.id, lockedSession.consent_grant_id),
          eq(appExperienceConsentGrants.owner_user_id, caller.user_id))).limit(1).for('share');
        if (!consent || consent.revoked_at) throw stale();
        const scope = ExperienceConsentScopeSchema.parse(consent.snapshot);
        if (consent.scope_digest !== experienceConsentDigest(scope) || scope.org_id !== caller.org_id
          || scope.owner_user_id !== caller.user_id || scope.installation_id !== installation.id || scope.app_version_id !== version.id
          || scope.grant_snapshot_id !== grant.id || scope.grant_snapshot_digest !== grant.snapshot_digest
          || scope.lifecycle_epoch !== installation.lifecycle_epoch || scope.grant_epoch !== installation.grant_epoch
          || scope.experience_key !== lockedSession.experience_key || scope.artifact_digest !== lockedSession.artifact_digest) throw stale();
      }
      const web = await assertExperienceWeb(tx, caller);
      // The clock is read after every potentially blocking lock and digest.
      const checkedAt = new Date();
      if (web.expires_at <= checkedAt || lockedSession.expires_at <= checkedAt) throw stale();
      if (version.protocol_version === '5' && (!isAppExperienceResourceExposureEnabled()
        || (verified.bundle.action_keys.length > 0 && !isAppV5RuntimeActionsEnabled()))) throw stale();
      const currentAuthorityExpiresAt = new Date(Math.min(web.expires_at.getTime(), lockedSession.expires_at.getTime(),
        caller.access_expires_at ?? Infinity));
      if (version.protocol_version === '6' && !await nativeFinalAuthorityIsCurrent(tx, [caller.user_id],
        { expires_at: [currentAuthorityExpiresAt] })) throw stale();
      if (version.protocol_version === '7') {
        const { attachmentFinalAuthorityIsCurrent } = await import('./app-attachment-authority.js');
        if (!await attachmentFinalAuthorityIsCurrent(tx, [caller.user_id], { expires_at: [currentAuthorityExpiresAt] })
          || !isAppExperienceResourceExposureEnabled()) throw stale();
      }
      return { session: lockedSession, bundle: verified.bundle, manifest: verified.manifest,
        current_authority_expires_at: currentAuthorityExpiresAt };
  }

  private async liveContext(caller: ExperienceCaller, sessionId: string) {
    return db.transaction((tx) => this.lockedLiveContext(tx, caller, sessionId));
  }

  async live(caller: ExperienceCaller, sessionId: string) {
    const { session } = await this.liveContext(caller, sessionId);
    return { session_id: session.id, expires_at: session.expires_at.toISOString(), live: true as const };
  }

  /** A restored private ID discloses only metadata under the current reviewed App. */
  async runStatus(caller: ExperienceCaller, sessionId: string, runId: string, signal?: AbortSignal) {
    const { run } = await this.readRunContext(caller, sessionId, runId, false, signal);
    return { run };
  }

  /** Host-only navigation metadata; never released through the author status broker. */
  async runReviewTarget(caller: ExperienceCaller, sessionId: string, runId: string, signal?: AbortSignal) {
    const { target } = await this.readRunContext(caller, sessionId, runId, true, signal);
    if (!target) throw denied();
    return target;
  }

  private async readRunContext(caller: ExperienceCaller, sessionId: string, runId: string, includeTarget: boolean, signal?: AbortSignal) {
    uuid.parse(runId);
    return experienceExposureDatabase().transaction(async tx => {
      signal?.throwIfAborted();
      const current = await this.lockedLiveContext(tx, caller, sessionId);
      if (current.manifest.schema_version !== '7' || !isAppV5RuntimeActionsEnabled()) throw denied();
      // Historical terminal metadata is not execution authority. Require current
      // durable consent, preserve the original Runtime lineage, and disclose no payload.
      const historicalTerminal = !includeTarget && current.session.consent_grant_id ? and(
        inArray(appRuns.state, [...APP_RUN_TERMINAL_STATES]),
        or(ne(appRuns.origin_app_version_id, current.session.app_version_id),
          ne(appRuns.origin_app_grant_snapshot_id, current.session.grant_snapshot_id)),
      ) : undefined;
      const [run] = await tx.select({ id: appRuns.id, state: appRuns.state, execution_release_kind: appRuns.execution_release_kind, created_at: appRuns.created_at,
        updated_at: appRuns.updated_at, started_at: appRuns.started_at, terminal_at: appRuns.terminal_at,
        action_key: appRuntimeBindings.action_key, binding_id: appRuntimeBindings.id }).from(appRuns).innerJoin(appRuntimeBindings, and(
          eq(appRuntimeBindings.org_id, appRuns.org_id), eq(appRuntimeBindings.id, appRuns.origin_runtime_binding_id),
          eq(appRuntimeBindings.app_installation_id, appRuns.origin_app_installation_id),
          eq(appRuntimeBindings.app_version_id, appRuns.origin_app_version_id),
          eq(appRuntimeBindings.grant_snapshot_id, appRuns.origin_app_grant_snapshot_id),
          eq(appRuntimeBindings.provider_instance_id, appRuns.provider_instance_id),
          eq(appRuntimeBindings.provider_snapshot_id, appRuns.provider_snapshot_id),
          eq(appRuntimeBindings.operation_name, appRuns.operation_name), or(eq(appRuntimeBindings.state, 'active'), historicalTerminal),
        )).where(and(eq(appRuns.org_id, caller.org_id), eq(appRuns.id, runId),
          eq(appRuns.initiating_actor_type, 'human'), eq(appRuns.initiating_actor_id, caller.user_id),
          eq(appRuns.execution_actor_type, 'human'), eq(appRuns.execution_actor_id, caller.user_id),
          eq(appRuns.provider_kind, 'app_runtime'), eq(appRuns.origin_kind, 'app'),
          eq(appRuns.origin_app_installation_id, current.session.app_installation_id),
          or(and(eq(appRuns.origin_app_version_id, current.session.app_version_id),
            eq(appRuns.origin_app_grant_snapshot_id, current.session.grant_snapshot_id)), historicalTerminal),
          isNull(appRuns.origin_app_binding_key), isNull(appRuns.origin_resource_binding_id),
          isNull(appRuns.origin_native_binding_id), isNull(appRuns.origin_public_endpoint_id),
          isNull(appRuns.origin_public_ingress_id), isNull(appRuns.origin_app_automation_definition_id),
          isNull(appRuns.origin_app_automation_fire_id))).limit(1);
      if (!run || !current.bundle.action_keys.includes(run.action_key)
        || !current.manifest.runtime_actions.some(action => action.key === run.action_key)) throw denied();
      const approvals = includeTarget ? await tx.select({ id: agentActions.id, status: agentActions.approval_status }).from(agentActions)
        .where(and(eq(agentActions.org_id, caller.org_id), eq(agentActions.app_run_id, run.id), eq(agentActions.action, 'app_run_invoke'))).limit(2) : [];
      const publicState = experienceRunState(run.state, run.execution_release_kind);
      if (approvals.length > 1 || includeTarget && publicState === 'pending_approval' && approvals[0]?.status !== 'pending') throw stale();
      const target = includeTarget ? { schema_version: 'deft.experience_run_review_target.v1' as const,
        run_id: run.id, run_state: publicState, runtime_binding_id: run.binding_id,
        approval_id: publicState === 'pending_approval' ? approvals[0]!.id : null } : undefined;
      signal?.throwIfAborted();
      const final = await this.lockedLiveContext(tx, caller, sessionId);
      if (final.manifest.schema_version !== '7' || !final.bundle.action_keys.includes(run.action_key)
        || !isAppV5RuntimeActionsEnabled()) throw stale();
      signal?.throwIfAborted();
      return { run: { id: run.id, state: publicState, created_at: run.created_at.toISOString(), updated_at: run.updated_at.toISOString(),
        started_at: run.started_at?.toISOString() ?? null, terminal_at: run.terminal_at?.toISOString() ?? null }, target };
    }, signal);
  }

  async revoke(caller: ExperienceCaller, sessionId: string) {
    await db.transaction(async tx => {
      const current = await this.lockedLiveContext(tx, caller, sessionId, 'update');
      await tx.update(appExperienceSessions).set({ revoked_at: new Date() }).where(and(
      eq(appExperienceSessions.id, sessionId), eq(appExperienceSessions.org_id, caller.org_id),
      eq(appExperienceSessions.user_id, caller.user_id),
      eq(appExperienceSessions.web_session_id, caller.sid),
      isNull(appExperienceSessions.revoked_at),
      ));
      if (current.manifest.schema_version === '6' && !await nativeFinalAuthorityIsCurrent(tx, [caller.user_id],
        { expires_at: [current.current_authority_expires_at] })) throw stale();
    });
    return { revoked: true as const };
  }

  async action(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown) {
    key.parse(actionKey);
    const request = actionRequest.parse(raw);
    const { session, bundle, manifest } = await this.liveContext(caller, sessionId);
    if (!bundle.action_keys.includes(actionKey)) throw denied();
    const [nativeBinding] = await db.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, caller.org_id),
      eq(appNativeBindings.app_installation_id, session.app_installation_id), eq(appNativeBindings.app_version_id, session.app_version_id),
      eq(appNativeBindings.grant_snapshot_id, session.grant_snapshot_id), eq(appNativeBindings.owner_user_id, caller.user_id),
      eq(appNativeBindings.action_key, actionKey), eq(appNativeBindings.state, 'active'))).limit(1);
    if (nativeBinding) {
      const { getAppRunRuntime } = await import('./app-run-runtime.js');
      let currentAuthorityExpiresAt = new Date(0);
      const guard = Object.assign(async (tx: AppRunTransaction) => {
        // Native capture has already locked the complete owner/manager set before App.
        const current = await this.lockedLiveContext(tx, caller, sessionId);
        if (current.manifest.schema_version !== '6' || !current.bundle.action_keys.includes(actionKey)
          || !current.manifest.native_actions.some(item => item.key === actionKey)
          || current.session.app_version_id !== nativeBinding.app_version_id
          || current.session.grant_snapshot_id !== nativeBinding.grant_snapshot_id) throw stale();
        currentAuthorityExpiresAt = current.current_authority_expires_at;
      }, { current_web_session_expires_at: () => currentAuthorityExpiresAt });
      const run = await (await getAppRunRuntime()).service.submitReviewedNative({ org_id: caller.org_id, user_id: caller.user_id }, {
        native_binding_id: nativeBinding.id, expected_consent_digest: nativeBinding.consent_digest!,
        idempotency_key: `experience:${session.id}:${request.request_id}`, input: request.input,
      }, guard);
      await this.liveContext(caller, sessionId);
      return { run };
    }
    const [binding] = await db.select().from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, caller.org_id),
      eq(appRuntimeBindings.app_installation_id, session.app_installation_id),
      eq(appRuntimeBindings.app_version_id, session.app_version_id),
      eq(appRuntimeBindings.grant_snapshot_id, session.grant_snapshot_id),
      eq(appRuntimeBindings.action_key, actionKey),
      eq(appRuntimeBindings.state, 'active'),
    )).limit(1);
    if (!binding) throw new AppError('Experience action unavailable', 'APP_ACTION_UNAVAILABLE', 409);
    const run = await this.runtime.invokeFromExperience({ org_id: caller.org_id, user_id: caller.user_id }, {
      runtime_binding_id: binding.id,
      idempotency_key: `experience:${session.id}:${request.request_id}`,
      input: request.input,
    }, async (tx: AppRunTransaction) => {
      const [registrationLocator] = await tx.select().from(appRuntimeRegistrations).where(and(
        eq(appRuntimeRegistrations.org_id, caller.org_id),
        eq(appRuntimeRegistrations.id, binding.runtime_registration_id))).limit(1);
      if (!registrationLocator) throw stale();
      // Runtime capture reuses these locks. Acquire every participant before
      // App locks so a different operator cannot introduce a late member lock.
      for (const participant of [...new Set([caller.user_id, registrationLocator.operator_user_id])].sort()) {
        await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${caller.org_id} AND user_id=${participant} FOR SHARE`);
      }
      await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, caller.org_id),
        eq(appInstallations.id, binding.app_installation_id))).for('share');
      await tx.select().from(appVersions).where(and(eq(appVersions.org_id, caller.org_id),
        eq(appVersions.id, binding.app_version_id))).for('share');
      await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, caller.org_id),
        eq(appGrantSnapshots.id, binding.grant_snapshot_id))).for('share');
      const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
        eq(appRuntimeRegistrations.org_id, caller.org_id), eq(appRuntimeRegistrations.id, binding.runtime_registration_id))).limit(1).for('share');
      const [bindingPin] = await tx.select().from(appRuntimeBindings).where(and(
        eq(appRuntimeBindings.org_id, caller.org_id), eq(appRuntimeBindings.id, binding.id))).limit(1).for('share');
      if (!registration || registration.operator_user_id !== registrationLocator.operator_user_id
        || registration.app_installation_id !== binding.app_installation_id || registration.app_version_id !== binding.app_version_id
        || registration.grant_snapshot_id !== binding.grant_snapshot_id || !bindingPin
        || bindingPin.runtime_registration_id !== binding.runtime_registration_id
        || bindingPin.app_installation_id !== binding.app_installation_id || bindingPin.app_version_id !== binding.app_version_id
        || bindingPin.grant_snapshot_id !== binding.grant_snapshot_id || bindingPin.action_key !== actionKey
        || bindingPin.state !== 'active') throw stale();
      const current = await this.lockedLiveContext(tx, caller, sessionId);
      if (current.session.app_version_id === binding.app_version_id
        && current.manifest.schema_version === '5' && !isAppV5RuntimeActionsEnabled()) throw stale();
      if (!current.bundle.action_keys.includes(actionKey)
        || current.session.app_version_id !== binding.app_version_id
        || current.session.grant_snapshot_id !== binding.grant_snapshot_id) throw stale();
      const [lockedBinding] = await tx.select().from(appRuntimeBindings).where(and(
        eq(appRuntimeBindings.org_id, caller.org_id),
        eq(appRuntimeBindings.id, binding.id),
        eq(appRuntimeBindings.app_installation_id, current.session.app_installation_id),
        eq(appRuntimeBindings.app_version_id, current.session.app_version_id),
        eq(appRuntimeBindings.grant_snapshot_id, current.session.grant_snapshot_id),
        eq(appRuntimeBindings.action_key, actionKey),
        eq(appRuntimeBindings.state, 'active'),
      )).limit(1).for('share');
      if (!lockedBinding) throw stale();
    },manifest.schema_version==='7'?async(tx:AppRunTransaction)=>{
      const current=await this.lockedLiveContext(tx,caller,sessionId);
      const [registration]=await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id,caller.org_id),
        eq(appRuntimeRegistrations.id,binding.runtime_registration_id))).limit(1);
      const {attachmentFinalAuthorityIsCurrent}=await import('./app-attachment-authority.js');
      if(current.manifest.schema_version!=='7'||!current.bundle.action_keys.includes(actionKey)
        ||current.session.app_version_id!==binding.app_version_id||current.session.grant_snapshot_id!==binding.grant_snapshot_id
        ||!registration||!await attachmentFinalAuthorityIsCurrent(tx,[caller.user_id,registration.operator_user_id],
          {expires_at:[current.current_authority_expires_at]})||!isAppV5RuntimeActionsEnabled())throw stale();
    }:undefined);
    await this.liveContext(caller, sessionId);
    return { run };
  }
}

export const appExperienceService = new AppExperienceService();
