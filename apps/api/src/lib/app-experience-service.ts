import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appExperienceSessions, appGrantSnapshots, appInstallations, appRuntimeBindings, appRuntimeRegistrations,
  appVersions, appNativeBindings, orgMembers, users, webSessions } from '@deft/db/schema';
import { parseRuntimeAppManifest, verifyDeftAppPackageJson,
  verifyDeftExperienceArtifact, parseResourceAppManifest, parseNativeAppManifest } from '@deft/app-kit';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { AppRuntimeActionService, appRuntimeActionService } from './app-runtime-action-service.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { isAppExperienceResourceExposureEnabled, isAppV5RuntimeActionsEnabled, isAppNativeCalendarEnabled } from './env.js';

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
  if (native ? !isAppNativeCalendarEnabled() : resource ? !isAppExperienceResourceExposureEnabled() : version.protocol_version !== '4') throw stale();
  const manifest = native ? parseNativeAppManifest(version.manifest) : resource ? parseResourceAppManifest(version.manifest) : parseRuntimeAppManifest(version.manifest);
  if (manifest.schema_version !== (native ? '6' : resource ? '5' : '4')) throw stale();
  const reference = manifest.experiences.find((item) => item.key === experienceKey);
  if (!reference) throw denied();
  const verified = await verifyDeftAppPackageJson(JSON.stringify(version.package));
  if (verified.digest !== version.package_digest
    || verified.package.manifest_digest !== version.manifest_digest
    || verified.package.manifest.schema_version !== (native ? '6' : resource ? '5' : '4')) throw stale();
  const artifact = verified.package.artifacts.find((item) => item.path === reference.artifact_path);
  if (!artifact) throw stale();
  const bundle = await verifyDeftExperienceArtifact({
    artifact_path: reference.artifact_path,
    artifact_digest: reference.artifact_digest,
    bridge_version: reference.bridge_version,
    renderer_version: reference.renderer_version,
  }, artifact);
  if (native) {
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
      const { reference, bundle } = await verifiedExperienceBundle(version, experienceKey);
      const now = new Date();
      await tx.delete(appExperienceSessions).where(and(
        eq(appExperienceSessions.org_id, caller.org_id),
        eq(appExperienceSessions.web_session_id, caller.sid),
        eq(appExperienceSessions.app_installation_id, installationId),
        or(lt(appExperienceSessions.expires_at, now),
          lt(appExperienceSessions.revoked_at, now)),
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
      return { pin: { org_id: caller.org_id, user_id: caller.user_id,
        app_installation_id: installation.id, app_version_id: version.id,
        grant_snapshot_id: grant.id, lifecycle_epoch: installation.lifecycle_epoch,
        grant_epoch: installation.grant_epoch, session_id: sessionId, session_epoch: 0 },
        experience: { key: experienceKey, label: reference.label,
          artifact_digest: reference.artifact_digest,
          bridge_version: reference.bridge_version, renderer_version: reference.renderer_version },
        bundle, expires_at: expiresAt.toISOString() };
    });
  }

  private async lockedLiveContext(tx: Executor, caller: ExperienceCaller, sessionId: string, sessionLock: 'share' | 'update' = 'share') {
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
      if (verified.reference.artifact_digest !== session.artifact_digest) throw stale();
      const [lockedSession] = await tx.select().from(appExperienceSessions).where(and(
        eq(appExperienceSessions.id, sessionId), eq(appExperienceSessions.org_id, caller.org_id))).limit(1).for(sessionLock);
      if (!lockedSession || lockedSession.revoked_at || lockedSession.user_id !== caller.user_id
        || lockedSession.web_session_id !== caller.sid
        || lockedSession.app_installation_id !== session.app_installation_id || lockedSession.app_version_id !== session.app_version_id
        || lockedSession.grant_snapshot_id !== session.grant_snapshot_id || lockedSession.grant_snapshot_kind !== session.grant_snapshot_kind
        || lockedSession.lifecycle_epoch !== session.lifecycle_epoch || lockedSession.grant_epoch !== session.grant_epoch
        || lockedSession.experience_key !== session.experience_key || lockedSession.artifact_digest !== session.artifact_digest
        || lockedSession.expires_at.getTime() !== session.expires_at.getTime()) throw stale();
      const web = await assertExperienceWeb(tx, caller);
      // The clock is read after every potentially blocking lock and digest.
      const checkedAt = new Date();
      if (web.expires_at <= checkedAt || lockedSession.expires_at <= checkedAt) throw stale();
      if (version.protocol_version === '5' && (!isAppExperienceResourceExposureEnabled()
        || (verified.bundle.action_keys.length > 0 && !isAppV5RuntimeActionsEnabled()))) throw stale();
      return { session: lockedSession, bundle: verified.bundle, manifest: verified.manifest };
  }

  private async liveContext(caller: ExperienceCaller, sessionId: string) {
    return db.transaction((tx) => this.lockedLiveContext(tx, caller, sessionId));
  }

  async live(caller: ExperienceCaller, sessionId: string) {
    const { session } = await this.liveContext(caller, sessionId);
    return { session_id: session.id, expires_at: session.expires_at.toISOString(), live: true as const };
  }

  async revoke(caller: ExperienceCaller, sessionId: string) {
    await db.transaction(async tx => {
      await this.lockedLiveContext(tx, caller, sessionId, 'update');
      await tx.update(appExperienceSessions).set({ revoked_at: new Date() }).where(and(
      eq(appExperienceSessions.id, sessionId), eq(appExperienceSessions.org_id, caller.org_id),
      eq(appExperienceSessions.user_id, caller.user_id),
      eq(appExperienceSessions.web_session_id, caller.sid),
      isNull(appExperienceSessions.revoked_at),
      ));
    });
    return { revoked: true as const };
  }

  async action(caller: ExperienceCaller, sessionId: string, actionKey: string, raw: unknown) {
    key.parse(actionKey);
    const request = actionRequest.parse(raw);
    const { session, bundle } = await this.liveContext(caller, sessionId);
    if (!bundle.action_keys.includes(actionKey)) throw denied();
    const [nativeBinding] = await db.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, caller.org_id),
      eq(appNativeBindings.app_installation_id, session.app_installation_id), eq(appNativeBindings.app_version_id, session.app_version_id),
      eq(appNativeBindings.grant_snapshot_id, session.grant_snapshot_id), eq(appNativeBindings.owner_user_id, caller.user_id),
      eq(appNativeBindings.action_key, actionKey), eq(appNativeBindings.state, 'active'))).limit(1);
    if (nativeBinding) {
      const { getAppRunRuntime } = await import('./app-run-runtime.js');
      const run = await (await getAppRunRuntime()).service.submitReviewedNative({ org_id: caller.org_id, user_id: caller.user_id }, {
        native_binding_id: nativeBinding.id, expected_consent_digest: nativeBinding.consent_digest!,
        idempotency_key: `experience:${session.id}:${request.request_id}`, input: request.input,
      }, async tx => {
        // Native capture has already locked the complete owner/manager set before App.
        const current = await this.lockedLiveContext(tx, caller, sessionId);
        if (current.manifest.schema_version !== '6' || !current.bundle.action_keys.includes(actionKey)
          || !current.manifest.native_actions.some(item => item.key === actionKey)
          || current.session.app_version_id !== nativeBinding.app_version_id
          || current.session.grant_snapshot_id !== nativeBinding.grant_snapshot_id) throw stale();
      });
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
    });
    await this.liveContext(caller, sessionId);
    return { run };
  }
}

export const appExperienceService = new AppExperienceService();
