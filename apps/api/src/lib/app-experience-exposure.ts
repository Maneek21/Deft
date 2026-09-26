import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appExperienceSessions, appExperienceResourceExposures, appExperienceResourceExposureResources,
  appExperienceResourceExposureAudit, appInstallations, appVersions, appGrantSnapshots, appResourceBindings,
  appRuntimeRegistrations, appSyncCheckpoints, appResourceProjections, users } from '@deft/db/schema';
import { parseSyncPage } from '@deft/app-kit/experimental/resource-sync';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { loadLiveResourceSyncBindingAuthority, resourceSyncParticipantsAreHuman } from './app-resource-sync-authority.js';
import { verifiedExperienceBundle, assertExperienceWeb, type ExperienceCaller } from './app-experience-service.js';
import { experienceExposureDatabase, type ExperienceExposureTransaction } from './app-experience-exposure-db.js';
import { isAppExperienceResourceExposureEnabled } from './env.js';
import { EXPOSURE_VERSION, PAYLOAD_VERSION, EXPOSURE_LIMITS, ExposureSnapshotSchema, ExposureAcceptSchema,
  ExposureCursorSchema, ResourceRequestSchema, ExperienceExposureError, exposureUnavailable, exposureStale,
  exposureDigest, sealExposureToken, openExposureToken, exposurePayloadData, type ExposureSnapshot } from './app-experience-exposure-contract.js';

type Tx = ExperienceExposureTransaction;
type BindingAuthority = NonNullable<Awaited<ReturnType<typeof loadLiveResourceSyncBindingAuthority>>>;
type Repository = Pick<ReturnType<typeof experienceExposureDatabase>, 'transaction'>;
const uuid = z.string().uuid();
const resourceKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const label = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200);

/** Exact host-owned disclosure, never a general private-reader endpoint. Every
 * request rederives App/artifact/resource/session authority in one transaction. */
export class AppExperienceExposureService {
  private readonly secrets: AppResourceSyncSecretService;
  constructor(private readonly keys: AppRunKeyProvider,
    private readonly repository: Repository = experienceExposureDatabase(),
    private readonly clock: () => Date = () => new Date()) { this.secrets = new AppResourceSyncSecretService(keys); }

  private enabled(caller: ExperienceCaller, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!isAppExperienceResourceExposureEnabled()) throw new ExperienceExposureError('APP_EXPERIENCE_EXPOSURE_DISABLED', 503);
    if (!Number.isFinite(caller.access_expires_at)) throw exposureUnavailable();
  }

  private async locked(tx: Tx, caller: ExperienceCaller, sessionId: string, write: boolean, signal?: AbortSignal) {
    uuid.parse(sessionId); signal?.throwIfAborted();
    const [locator] = await tx.select().from(appExperienceSessions).where(and(
      eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId))).limit(1);
    if (!locator || locator.user_id !== caller.user_id || locator.web_session_id !== caller.sid) throw exposureUnavailable();
    // Locator reads nominate rows. Only the globally phased locks below grant authority.
    const [versionLocator] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, caller.org_id),
      eq(appVersions.id, locator.app_version_id), eq(appVersions.installation_id, locator.app_installation_id))).limit(1);
    if (!versionLocator) throw exposureUnavailable();
    const earlyBundle = await verifiedExperienceBundle(versionLocator, locator.experience_key);
    if (versionLocator.protocol_version !== '5' || earlyBundle.bundle.action_keys.length || !earlyBundle.bundle.resource_keys.length) throw exposureUnavailable();
    const bindingLocators = await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id, caller.org_id),
      eq(appResourceBindings.app_installation_id, locator.app_installation_id), eq(appResourceBindings.app_version_id, locator.app_version_id),
      eq(appResourceBindings.grant_snapshot_id, locator.grant_snapshot_id), eq(appResourceBindings.owner_user_id, caller.user_id),
      eq(appResourceBindings.state, 'active'), inArray(appResourceBindings.resource_key, [...earlyBundle.bundle.resource_keys])));
    if (bindingLocators.length !== earlyBundle.bundle.resource_keys.length
      || new Set(bindingLocators.map(b => b.resource_key)).size !== bindingLocators.length) throw exposureUnavailable();
    const registrationIds = [...new Set(bindingLocators.map(b => b.runtime_registration_id))].sort();
    const registrationLocators = await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, caller.org_id),
      inArray(appRuntimeRegistrations.id, registrationIds)));
    if (registrationLocators.length !== registrationIds.length) throw exposureUnavailable();
    const participantIds = [...new Set([caller.user_id, ...registrationLocators.map(r => r.operator_user_id)])].sort();
    for (const id of participantIds) await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${caller.org_id} AND user_id=${id} FOR SHARE`);
    const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, caller.org_id),
      eq(appInstallations.id, locator.app_installation_id))).limit(1).for('share');
    const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, caller.org_id),
      eq(appVersions.id, locator.app_version_id))).limit(1).for('share');
    const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, caller.org_id),
      eq(appGrantSnapshots.id, locator.grant_snapshot_id))).limit(1).for('share');
    if (!installation || !version || !grant || installation.state !== 'active' || version.state !== 'active'
      || installation.active_version_id !== locator.app_version_id || installation.active_grant_snapshot_id !== locator.grant_snapshot_id
      || installation.lifecycle_epoch !== locator.lifecycle_epoch || installation.grant_epoch !== locator.grant_epoch
      || grant.snapshot_kind !== 'effective' || grant.app_installation_id !== installation.id || grant.app_version_id !== version.id) throw exposureUnavailable();
    for (const id of registrationIds) await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id=${caller.org_id} AND id=${id} FOR SHARE`);
    const bindingIds = bindingLocators.map(b => b.id).sort();
    for (const id of bindingIds) await tx.execute(sql`SELECT id FROM app_resource_bindings WHERE org_id=${caller.org_id} AND id=${id} FOR SHARE`);
    const checkpointLocators = await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id, caller.org_id),
      inArray(appSyncCheckpoints.resource_binding_id, bindingIds), eq(appSyncCheckpoints.state, 'active'))).orderBy(asc(appSyncCheckpoints.id));
    if (checkpointLocators.length !== bindingIds.length || new Set(checkpointLocators.map(c => c.resource_binding_id)).size !== bindingIds.length) throw exposureUnavailable();
    for (const checkpoint of checkpointLocators) await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id=${caller.org_id} AND id=${checkpoint.id} FOR SHARE`);
    const [session] = await tx.select().from(appExperienceSessions).where(and(eq(appExperienceSessions.org_id, caller.org_id),
      eq(appExperienceSessions.id, sessionId))).limit(1).for(write ? 'update' : 'share');
    if (!session || session.revoked_at || exposureDigest(session) !== exposureDigest(locator)) throw exposureUnavailable();
    const [exposure] = await tx.select().from(appExperienceResourceExposures).where(and(eq(appExperienceResourceExposures.org_id, caller.org_id),
      eq(appExperienceResourceExposures.experience_session_id, sessionId), isNull(appExperienceResourceExposures.revoked_at))).limit(1).for(write ? 'update' : 'share');
    const children = exposure ? await tx.select().from(appExperienceResourceExposureResources).where(and(
      eq(appExperienceResourceExposureResources.org_id, caller.org_id), eq(appExperienceResourceExposureResources.exposure_id, exposure.id)))
      .orderBy(asc(appExperienceResourceExposureResources.resource_key)).for('share') : [];
    const lockedBindings = await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id, caller.org_id),
      inArray(appResourceBindings.id, bindingIds)));
    const lockedRegistrations = await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, caller.org_id),
      inArray(appRuntimeRegistrations.id, registrationIds)));
    for (const old of bindingLocators) {
      const current = lockedBindings.find(b => b.id === old.id);
      if (!current || current.owner_user_id !== old.owner_user_id || current.runtime_registration_id !== old.runtime_registration_id
        || current.app_installation_id !== old.app_installation_id || current.app_version_id !== old.app_version_id
        || current.grant_snapshot_id !== old.grant_snapshot_id || current.resource_key !== old.resource_key) throw exposureUnavailable();
    }
    for (const old of registrationLocators) {
      const current = lockedRegistrations.find(r => r.id === old.id);
      if (!current || current.operator_user_id !== old.operator_user_id || current.app_installation_id !== old.app_installation_id
        || current.app_version_id !== old.app_version_id || current.grant_snapshot_id !== old.grant_snapshot_id) throw exposureUnavailable();
    }
    // Every resource/helper phase is prelocked. Helper locks are reentrant and
    // cannot add a late membership/App/registration edge after a checkpoint.
    const authorities: BindingAuthority[] = [];
    for (const binding of [...bindingLocators].sort((a, b) => a.resource_key.localeCompare(b.resource_key))) {
      const authority = await loadLiveResourceSyncBindingAuthority(tx, { org_id: caller.org_id, resource_binding_id: binding.id, clock: this.clock });
      if (!authority || authority.binding.owner_user_id !== caller.user_id || authority.version.id !== session.app_version_id
        || authority.grant.id !== session.grant_snapshot_id
        || !participantIds.includes(authority.registration.operator_user_id)) throw exposureUnavailable();
      authorities.push(authority);
    }
    const verified = await verifiedExperienceBundle(version, session.experience_key);
    if (verified.reference.artifact_digest !== session.artifact_digest || exposureDigest(verified.bundle) !== exposureDigest(earlyBundle.bundle)) throw exposureUnavailable();
    const checkpoints = await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id, caller.org_id),
      inArray(appSyncCheckpoints.resource_binding_id, bindingIds), eq(appSyncCheckpoints.state, 'active')));
    if (checkpoints.length !== bindingIds.length || checkpoints.some(c => !checkpointLocators.some(old => old.id === c.id))) throw exposureUnavailable();
    const web = await assertExperienceWeb(tx, caller); // exact SID is the LAST new lock
    const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, caller.user_id));
    const context = { session, installation, version, grant, verified, authorities, checkpoints, exposure, children, web, owner_label: label(owner?.name ?? 'You') };
    await this.final(tx, caller, context, signal);
    return context;
  }

  private async final(tx: Tx, caller: ExperienceCaller, context: Context, signal?: AbortSignal) {
    this.enabled(caller, signal);
    await assertExperienceWeb(tx, caller);
    this.enabled(caller, signal);
    for (const a of context.authorities) if (!await resourceSyncParticipantsAreHuman(tx, caller.user_id, a.registration.operator_user_id)) throw exposureUnavailable();
    const now = this.clock().getTime();
    if (!Number.isFinite(now) || context.session.expires_at.getTime() <= now || caller.access_expires_at! <= now
      || context.authorities.some(a => !a.binding.consent_expires_at || a.binding.consent_expires_at.getTime() <= now)) throw exposureUnavailable();
    signal?.throwIfAborted();
  }

  private snapshot(caller: ExperienceCaller, context: Context, preparedAt: Date, accessExpiry: Date): ExposureSnapshot {
    const resources = context.authorities.map(a => {
      const fields = Object.keys(a.descriptor.record_schema.properties).sort();
      if (!fields.length || fields.length > 32 || fields.some(field => field.length > 48)) throw exposureUnavailable();
      return { resource_key: a.binding.resource_key, binding_id: a.binding.id, registration_id: a.registration.id,
        runtime_epoch: a.registration.runtime_epoch, descriptor_digest: a.descriptor_digest, resource_type: a.descriptor.resource_type,
        label: label(a.descriptor.key), allowed_operations: ['list_summary', 'read_one'] as ['list_summary', 'read_one'], allowed_fields: fields,
        consent_expires_at: a.binding.consent_expires_at!.toISOString() };
    });
    const expiry = Math.min(preparedAt.getTime() + EXPOSURE_LIMITS.exposure_ms, accessExpiry.getTime(), context.web.expires_at.getTime(),
      context.session.expires_at.getTime(), ...context.authorities.map(a => a.binding.consent_expires_at!.getTime()));
    return ExposureSnapshotSchema.parse({ schema_version: EXPOSURE_VERSION, payload_policy_version: PAYLOAD_VERSION,
      visibility: 'user_private', destination: 'verified_installed_experience_worker', org_id: caller.org_id, owner_user_id: caller.user_id,
      owner_label: context.owner_label, web_session_id: caller.sid, experience_session_id: context.session.id,
      installation_id: context.installation.id, app_version_id: context.version.id, app_name: label(context.verified.manifest.name),
      app_version: context.version.version, package_digest: context.version.package_digest, manifest_digest: context.version.manifest_digest,
      grant_snapshot_id: context.grant.id, grant_snapshot_digest: context.grant.snapshot_digest,
      lifecycle_epoch: context.installation.lifecycle_epoch, grant_epoch: context.installation.grant_epoch,
      experience_key: context.session.experience_key, experience_label: label(context.verified.reference.label),
      artifact_digest: context.session.artifact_digest, bridge_version: context.verified.reference.bridge_version,
      renderer_version: context.verified.reference.renderer_version, resources,
      limits: { items: 10, fields: 32, string_chars: 4096, envelope_bytes: 61440 }, prepared_at: preparedAt.toISOString(),
      review_expires_at: new Date(Math.min(preparedAt.getTime() + EXPOSURE_LIMITS.review_ms, expiry)).toISOString(),
      web_access_expires_at: accessExpiry.toISOString(), expires_at: new Date(expiry).toISOString() });
  }

  async prepare(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {
    this.enabled(caller, signal);
    const result = await this.repository.transaction(async tx => {
      const context = await this.locked(tx, caller, sessionId, false, signal);
      if (context.exposure) throw exposureStale();
      const snapshot = this.snapshot(caller, context, this.clock(), new Date(caller.access_expires_at!));
      if (new Date(snapshot.expires_at) <= this.clock()) throw exposureUnavailable();
      const review_digest = exposureDigest(snapshot);
      await this.final(tx, caller, context, signal);
      return { snapshot, review_digest, review_token: sealExposureToken(this.keys, 'review', snapshot) };
    }, signal);
    signal?.throwIfAborted(); return result;
  }

  async accept(caller: ExperienceCaller, sessionId: string, raw: unknown, signal?: AbortSignal) {
    this.enabled(caller, signal); const input = ExposureAcceptSchema.parse(raw);
    const snapshot = ExposureSnapshotSchema.parse(openExposureToken(this.keys, 'review', input.review_token));
    if (input.review_digest !== exposureDigest(snapshot)) throw exposureStale();
    const result = await this.repository.transaction(async tx => {
      const context = await this.locked(tx, caller, sessionId, true, signal);
      const expected = this.snapshot(caller, context, new Date(snapshot.prepared_at), new Date(snapshot.web_access_expires_at));
      if (exposureDigest(expected) !== input.review_digest || snapshot.experience_session_id !== sessionId
        || new Date(snapshot.expires_at) <= this.clock() || caller.access_expires_at! < new Date(snapshot.expires_at).getTime()) throw exposureStale();
      if (context.exposure) {
        if (context.exposure.expires_at <= this.clock()) throw exposureStale();
        if (context.exposure.review_digest !== input.review_digest) throw exposureStale();
        this.assertStored(context, expected);
        await this.final(tx, caller, context, signal);
        return this.statusValue(context.exposure);
      }
      if (new Date(snapshot.review_expires_at) <= this.clock() || new Date(snapshot.prepared_at) > this.clock()) throw exposureStale();
      // A revoked same digest may never be resurrected through an idempotent path.
      const [previous] = await tx.select({ id: appExperienceResourceExposures.id }).from(appExperienceResourceExposures).where(and(
        eq(appExperienceResourceExposures.org_id, caller.org_id), eq(appExperienceResourceExposures.experience_session_id, sessionId),
        eq(appExperienceResourceExposures.review_digest, input.review_digest))).limit(1);
      if (previous) throw exposureStale();
      const id = randomUUID();
      const [exposure] = await tx.insert(appExperienceResourceExposures).values({ id, org_id: caller.org_id,
        experience_session_id: sessionId, owner_user_id: caller.user_id, web_session_id: caller.sid,
        review_digest: input.review_digest, snapshot, payload_policy_version: PAYLOAD_VERSION,
        created_at: this.clock(), expires_at: new Date(snapshot.expires_at) }).returning();
      await tx.insert(appExperienceResourceExposureResources).values(snapshot.resources.map(r => ({ org_id: caller.org_id,
        exposure_id: id, resource_key: r.resource_key, resource_binding_id: r.binding_id, runtime_registration_id: r.registration_id,
        runtime_epoch: r.runtime_epoch, descriptor_digest: r.descriptor_digest, resource_type: r.resource_type,
        allowed_operations: r.allowed_operations, allowed_fields: r.allowed_fields })));
      await tx.insert(appExperienceResourceExposureAudit).values({ org_id: caller.org_id, exposure_id: id,
        experience_session_id: sessionId, owner_user_id: caller.user_id, review_digest: input.review_digest,
        event: 'accepted', safe_snapshot: snapshot });
      await this.final(tx, caller, context, signal);
      if (new Date(snapshot.expires_at) <= this.clock()) throw exposureUnavailable();
      return this.statusValue(exposure!);
    }, signal);
    signal?.throwIfAborted(); return result;
  }

  private statusValue(exposure: typeof appExperienceResourceExposures.$inferSelect) {
    return { exposure_id: exposure.id, exposure_epoch: exposure.exposure_epoch, review_digest: exposure.review_digest,
      expires_at: exposure.expires_at.toISOString(), active: !exposure.revoked_at && exposure.expires_at > this.clock() };
  }
  private assertStored(context: Context, expected?: ExposureSnapshot) {
    const exposure = context.exposure;
    if (!exposure || exposure.revoked_at || exposure.expires_at <= this.clock()) throw exposureUnavailable();
    const snapshot = ExposureSnapshotSchema.parse(exposure.snapshot);
    const current = expected ?? this.snapshot({ org_id: context.session.org_id, user_id: context.session.user_id,
      sid: context.session.web_session_id }, context, new Date(snapshot.prepared_at), new Date(snapshot.web_access_expires_at));
    if (exposure.review_digest !== exposureDigest(snapshot) || exposureDigest(current) !== exposure.review_digest
      || exposure.expires_at.toISOString() !== snapshot.expires_at || context.children.length !== snapshot.resources.length) throw exposureUnavailable();
    for (const r of snapshot.resources) {
      const child = context.children.find(c => c.resource_key === r.resource_key);
      if (!child || child.resource_binding_id !== r.binding_id || child.runtime_registration_id !== r.registration_id
        || child.runtime_epoch !== r.runtime_epoch || child.descriptor_digest !== r.descriptor_digest || child.resource_type !== r.resource_type
        || exposureDigest(child.allowed_operations) !== exposureDigest(r.allowed_operations) || exposureDigest(child.allowed_fields) !== exposureDigest(r.allowed_fields)) throw exposureUnavailable();
    }
    return snapshot;
  }
  async status(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {
    this.enabled(caller, signal);
    return this.repository.transaction(async tx => {
      const context = await this.locked(tx, caller, sessionId, false, signal);
      if (!context.exposure) return { active: false as const };
      this.assertStored(context); await this.final(tx, caller, context, signal);
      return this.statusValue(context.exposure);
    }, signal);
  }
  private async revokeRow(tx: Tx, exposure: typeof appExperienceResourceExposures.$inferSelect) {
    await tx.update(appExperienceResourceExposures).set({ revoked_at: this.clock(), exposure_epoch: exposure.exposure_epoch + 1 })
      .where(and(eq(appExperienceResourceExposures.org_id, exposure.org_id), eq(appExperienceResourceExposures.id, exposure.id),
        isNull(appExperienceResourceExposures.revoked_at)));
    await tx.insert(appExperienceResourceExposureAudit).values({ org_id: exposure.org_id, exposure_id: exposure.id,
      experience_session_id: exposure.experience_session_id, owner_user_id: exposure.owner_user_id,
      review_digest: exposure.review_digest, event: 'revoked', safe_snapshot: exposure.snapshot }).onConflictDoNothing();
  }
  async revoke(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {
    this.enabled(caller, signal);
    return this.repository.transaction(async tx => {
      const context = await this.locked(tx, caller, sessionId, true, signal);
      if (context.exposure) await this.revokeRow(tx, context.exposure);
      await tx.update(appExperienceSessions).set({ revoked_at: this.clock() }).where(and(eq(appExperienceSessions.org_id, caller.org_id),
        eq(appExperienceSessions.id, sessionId), isNull(appExperienceSessions.revoked_at)));
      await this.final(tx, caller, context, signal);
      return { revoked: true as const };
    }, signal);
  }

  async read(caller: ExperienceCaller, sessionId: string, key: string, raw: unknown, signal?: AbortSignal) {
    this.enabled(caller, signal); resourceKey.parse(key); const input = ResourceRequestSchema.parse(raw);
    const result = await this.repository.transaction(async tx => {
      const context = await this.locked(tx, caller, sessionId, false, signal);
      const snapshot = this.assertStored(context);
      const resource = snapshot.resources.find(r => r.resource_key === key);
      const authority = context.authorities.find(a => a.binding.resource_key === key);
      const checkpoint = authority && context.checkpoints.find(c => c.resource_binding_id === authority.binding.id);
      if (!resource || !authority || !checkpoint) throw exposureUnavailable();
      const exposure = context.exposure!;
      const identity_scope_digest = exposureDigest({ org_id: caller.org_id, owner_user_id: caller.user_id,
        web_session_id: caller.sid, experience_session_id: sessionId, exposure_id: exposure.id,
        exposure_epoch: exposure.exposure_epoch, resource_key: key, binding_id: authority.binding.id,
        expires_at: exposure.expires_at.toISOString() });
      const checkpoint_scope_digest = exposureDigest({ checkpoint_id: checkpoint.id,
        generation: checkpoint.generation, cursor_sequence: checkpoint.cursor_sequence });
      const cursor = input.operation === 'list_summary' && input.cursor
        ? ExposureCursorSchema.parse(openExposureToken(this.keys, 'cursor', input.cursor)) : null;
      if (cursor && (cursor.identity_scope_digest !== identity_scope_digest || cursor.expires_at !== exposure.expires_at.toISOString())) throw exposureUnavailable();
      if (cursor && cursor.checkpoint_scope_digest !== checkpoint_scope_digest) {
        throw new ExperienceExposureError('RESOURCE_CURSOR_STALE', 409);
      }
      const rows = await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id, caller.org_id),
        eq(appResourceProjections.resource_binding_id, authority.binding.id), eq(appResourceProjections.checkpoint_id, checkpoint.id),
        eq(appResourceProjections.generation, checkpoint.generation), eq(appResourceProjections.state, 'live'),
        input.operation === 'read_one' ? eq(appResourceProjections.id, input.record_id) : cursor ? gt(appResourceProjections.id, cursor.after) : undefined))
        .orderBy(asc(appResourceProjections.id)).limit(input.operation === 'read_one' ? 1 : (input.limit ?? 10) + 1);
      if (input.operation === 'read_one' && !rows[0]) throw exposureUnavailable();
      const decode = (row: typeof appResourceProjections.$inferSelect) => {
        signal?.throwIfAborted();
        const body = z.strictObject({ revision: z.string(), data: z.unknown() }).parse(this.secrets.openJson({
          schema_version: row.body_envelope_version, algorithm: row.body_algorithm, key_version: row.body_key_version,
          nonce_b64: row.body_nonce_b64, ciphertext_b64: row.body_ciphertext_b64, auth_tag_b64: row.body_auth_tag_b64 }, {
          org_id: caller.org_id, resource_binding_id: authority.binding.id, checkpoint_id: checkpoint.id,
          payload_kind: 'projection', generation: row.generation, projection_id: row.id, slot: 'record' }));
        const parsed = parseSyncPage(authority.descriptor, { schema_version: 'deft.app_sync_request.v1', cursor: null, max_items: 1 }, {
          schema_version: 'deft.app_sync_page.v1', upserts: [{ id: 'x', ...body }], tombstones: [], next_cursor: null, has_more: false }).upserts[0]!;
        return { record_id: row.id, label: label(String(parsed.data[authority.descriptor.label_field] ?? '')), data: parsed.data };
      };
      let output: unknown;
      if (input.operation === 'read_one') {
        const item = decode(rows[0]!);
        output = { schema_version: PAYLOAD_VERSION, operation: 'read_one', item: { ...item,
          data: exposurePayloadData(item.data, resource.allowed_fields), freshness: 'unknown' } };
      } else {
        const limit = input.limit ?? 10;
        const items = rows.slice(0, limit).map(row => { const item = decode(row); return { record_id: item.record_id, label: item.label }; });
        const last = rows[Math.min(rows.length, limit) - 1];
        const next_cursor = rows.length > limit && last ? sealExposureToken(this.keys, 'cursor', {
          schema_version: 'deft.experience_resource_cursor.v1', identity_scope_digest, checkpoint_scope_digest,
          after: last.id, expires_at: exposure.expires_at.toISOString() }) : null;
        output = { schema_version: PAYLOAD_VERSION, operation: 'list_summary', items, next_cursor, freshness: 'unknown' };
      }
      // Reserve the full bridge overhead with maximal allowed request/session IDs.
      const envelope = { version: 'deft.experience_bridge.v1', kind: 'response', session_id: sessionId,
        request_id: `request_${'9'.repeat(56)}`, ok: true, output };
      if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > EXPOSURE_LIMITS.envelope_bytes) throw new ExperienceExposureError('RESOURCE_PAYLOAD_TOO_LARGE', 413);
      await this.final(tx, caller, context, signal);
      if (exposure.expires_at <= this.clock()) throw exposureUnavailable();
      return { exposure_id: exposure.id, exposure_epoch: exposure.exposure_epoch, output };
    }, signal);
    signal?.throwIfAborted(); return result;
  }
}
type Context = Awaited<ReturnType<AppExperienceExposureService['locked']>>;
