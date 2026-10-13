import { StoredPrivateSourceSchema, type StoredPrivateSource } from './app-private-state-secrets.js';

import {loadOwnerConnectionCleanup} from './app-connection-cleanup-authority.js';
import { assertLegacyOwnerConnectionResourcePolicies } from './app-owner-connection-contract.js';
import type { PrivateStateSourceReference } from './app-private-state-contract.js';

import { randomUUID } from 'node:crypto';

import { experienceProviderHandles, type ProviderSourceRecord } from './app-experience-provider-handles.js';

import { RuntimeObjectSchema, parseResourceRecordList, type PrivateStateDeclaration, type RuntimeObjectContract } from '@deft/app-kit';

import type { HumanActionSourceRecord } from './app-experience-human-action-service.js';

import { AppConnectionPinsSchema, AppConnectionPurposeSchema, type AppConnectionPins, type AppConnectionProjection, type AppConnectionPurpose } from './app-connection-contract.js';

import { samplePrivateAccessClock } from './app-private-access-clock.js';

import { AppError } from './app-errors.js';

import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import { z } from 'zod';

import { appExperienceSessions, appExperienceResourceExposures, appExperienceResourceExposureResources,

  appExperienceResourceExposureAudit, appInstallations, appVersions, appGrantSnapshots, appResourceBindings,

  appRuntimeRegistrations, appRuntimeBindings, appSyncCheckpoints, appResourceProjections, users, orgMembers, appExperienceConsentGrants } from '@deft/db/schema';

import { decodePrivateProjection } from './app-resource-private-projection.js';

import type { AppRunKeyProvider } from './app-run-keyrings.js';

import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';

import { loadLiveResourceSyncBindingAuthority, resourceSyncParticipantsAreHuman } from './app-resource-sync-authority.js';

import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';

import { verifiedExperienceBundle, assertExperienceWeb, type ExperienceCaller } from './app-experience-service.js';

import { experienceExposureDatabase, type ExperienceExposureTransaction } from './app-experience-exposure-db.js';

import { isAppExperienceResourceExposureEnabled, isAppV5RuntimeActionsEnabled, isAppNativeCalendarEnabled,

  isAppAttachmentBrokerEnabled, isAppPrivateStateEnabled } from './env.js';

import { scanPrivateResourceCheckpoint } from './app-resource-private-search-scan.js';

import { ExperienceConsentScopeSchema, ExperienceConsentReviewTokenSchema, ExperienceConsentAcceptSchema,

  experienceConsentScope, experienceConsentDigest } from './app-experience-consent-contract.js';

import { EXPOSURE_VERSION, SEARCH_EXPOSURE_VERSION, STATE_EXPOSURE_VERSION, ExposureSearchCursorSchema, PAYLOAD_VERSION, EXPOSURE_LIMITS, ExposureSnapshotSchema, ExposureAcceptSchema,

  ExposureCursorSchema, ResourceRequestSchema, ExperienceExposureError, exposureUnavailable, exposureStale,

  exposureDigest, sealExposureToken, openExposureToken, exposurePayloadData, type ExposureSnapshot } from './app-experience-exposure-contract.js';



export type BrowseAuthorityPhase = { locked_ms: number; package_verify_ms: number; package_verify_calls: number; projection_ms: number; final_ms: number; db_query_ms: number; db_query_count: number; db_acquisition_ms: number };



type Tx = ExperienceExposureTransaction;

type BindingAuthority = NonNullable<Awaited<ReturnType<typeof loadLiveResourceSyncBindingAuthority>>>

  | NonNullable<Awaited<ReturnType<typeof loadLiveAttachmentSyncBindingAuthority>>>;

type Repository = Pick<ReturnType<typeof experienceExposureDatabase>, 'transaction'>;

const uuid = z.string().uuid();

const resourceKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);

const label = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200);

export type HumanActionAuthority = Readonly<{ session: typeof appExperienceSessions.$inferSelect;

  resolveActionResources?: (schema: RuntimeObjectContract, input: Record<string, string | number | boolean>, savedSources?: readonly StoredPrivateSource[]) => Promise<Record<string, readonly HumanActionSourceRecord[]>>;

  draft_declaration?: PrivateStateDeclaration;

  action_payload_declaration?: Readonly<{ state_key: string; max_payload_bytes: number }>;

  draft_policy?: Readonly<{ draft_state_key: string; max_payload_bytes: number; files?: PrivateStateDeclaration['files'] }>;

  action_payload_sources?: readonly AppConnectionProjection[];

  runtime_binding_id: string; action_label: string; current_authority_expires_at: Date;

  authorization_identity: Readonly<{ consent_grant_id: string | null; consent_epoch: number | null;

    exposure_id: string; exposure_epoch: number }> }>;



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



  private async locked(tx: Tx, caller: ExperienceCaller, sessionId: string, write: boolean, signal?: AbortSignal, allowExpired = false, actionKey?: string, connectionActions = false, metrics?: BrowseAuthorityPhase) {

    uuid.parse(sessionId); signal?.throwIfAborted();

    const [locator] = await tx.select().from(appExperienceSessions).where(and(

      eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId))).limit(1);

    if (!locator || locator.user_id !== caller.user_id || locator.web_session_id !== caller.sid) throw exposureUnavailable();

    // Locator reads nominate rows. Only the globally phased locks below grant authority.

    const [versionLocator] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, caller.org_id),

      eq(appVersions.id, locator.app_version_id), eq(appVersions.installation_id, locator.app_installation_id))).limit(1);

    if (!versionLocator) throw exposureUnavailable();

    const earlyBundle = await this.verifyBundle(versionLocator, locator.experience_key, metrics);

    if (!['5', '6', '7'].includes(versionLocator.protocol_version) || (!earlyBundle.bundle.resource_keys.length && (earlyBundle.bundle.schema_version !== 'deft.experience_bundle.v3' && earlyBundle.bundle.schema_version !== 'deft.experience_bundle.v4'))) throw exposureUnavailable();

    const bindingLocators = await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id, caller.org_id),

      eq(appResourceBindings.app_installation_id, locator.app_installation_id), eq(appResourceBindings.app_version_id, locator.app_version_id),

      eq(appResourceBindings.grant_snapshot_id, locator.grant_snapshot_id), eq(appResourceBindings.owner_user_id, caller.user_id),

      eq(appResourceBindings.target_key, locator.resource_target_key),

      eq(appResourceBindings.state, 'active'), inArray(appResourceBindings.resource_key, [...earlyBundle.bundle.resource_keys])));

    if (bindingLocators.length !== earlyBundle.bundle.resource_keys.length

      || new Set(bindingLocators.map(b => b.resource_key)).size !== bindingLocators.length) throw exposureUnavailable();

    const actionLocators = actionKey ? await tx.select().from(appRuntimeBindings).where(and(

      eq(appRuntimeBindings.org_id, caller.org_id), eq(appRuntimeBindings.app_installation_id, locator.app_installation_id),

      eq(appRuntimeBindings.app_version_id, locator.app_version_id), eq(appRuntimeBindings.grant_snapshot_id, locator.grant_snapshot_id),

      eq(appRuntimeBindings.action_key, actionKey), eq(appRuntimeBindings.state, 'active'),

      locator.resource_target_key === 'primary'

        ? or(isNull(appRuntimeBindings.owner_resource_binding_id), inArray(appRuntimeBindings.owner_resource_binding_id, bindingLocators.map(b => b.id)))

        : inArray(appRuntimeBindings.owner_resource_binding_id, bindingLocators.map(b => b.id)))).limit(2) : [];

    // Locate all additional connection action edges before the globally phased

    // locks. Optional keys never promote a binding for another account or owner.

    const connectionActionBindings = connectionActions && earlyBundle.manifest.schema_version === '7'

      && isAppV5RuntimeActionsEnabled() && earlyBundle.bundle.action_keys.length

      ? await tx.select().from(appRuntimeBindings).where(and(

        eq(appRuntimeBindings.org_id, caller.org_id), eq(appRuntimeBindings.app_installation_id, locator.app_installation_id),

        eq(appRuntimeBindings.app_version_id, locator.app_version_id), eq(appRuntimeBindings.grant_snapshot_id, locator.grant_snapshot_id),

        eq(appRuntimeBindings.reviewed_by_user_id, caller.user_id), eq(appRuntimeBindings.state, 'active'),

        inArray(appRuntimeBindings.action_key, [...earlyBundle.bundle.action_keys]),

        inArray(appRuntimeBindings.owner_resource_binding_id, bindingLocators.map(b => b.id)))) : [];

    if (connectionActionBindings.length > 32) throw exposureUnavailable();

    const runtimeBinding = actionLocators[0];

    if (actionKey && (actionLocators.length !== 1 || !earlyBundle.bundle.action_keys.includes(actionKey)

      || earlyBundle.manifest.schema_version !== '7' || !isAppV5RuntimeActionsEnabled()

      || !earlyBundle.manifest.runtime_actions.some(action => action.key === actionKey))) throw exposureUnavailable();

    const registrationIds = [...new Set([...bindingLocators.map(b => b.runtime_registration_id),

      ...(runtimeBinding ? [runtimeBinding.runtime_registration_id] : []),

      ...connectionActionBindings.map(b => b.runtime_registration_id)])].sort();

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

    const allActionBindings = [...new Map([...connectionActionBindings, ...(runtimeBinding ? [runtimeBinding] : [])]

      .map(binding => [binding.id, binding])).values()].sort((a, b) => a.id.localeCompare(b.id));

    for (const binding of allActionBindings) {

      const [current] = await tx.select().from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id, caller.org_id),

        eq(appRuntimeBindings.id, binding.id))).limit(1).for('share');

      if (!current || exposureDigest(current) !== exposureDigest(binding)) throw exposureUnavailable();

    }

    const checkpointLocators = await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id, caller.org_id),

      inArray(appSyncCheckpoints.resource_binding_id, bindingIds), eq(appSyncCheckpoints.state, 'active'))).orderBy(asc(appSyncCheckpoints.id));

    if (checkpointLocators.length !== bindingIds.length || new Set(checkpointLocators.map(c => c.resource_binding_id)).size !== bindingIds.length) throw exposureUnavailable();

    for (const checkpoint of checkpointLocators) await tx.execute(sql`SELECT id FROM app_sync_checkpoints WHERE org_id=${caller.org_id} AND id=${checkpoint.id} FOR SHARE`);

    const [session] = await tx.select().from(appExperienceSessions).where(and(eq(appExperienceSessions.org_id, caller.org_id),

      eq(appExperienceSessions.id, sessionId))).limit(1).for(write ? 'update' : 'share');

    if (!session || session.revoked_at || exposureDigest(session) !== exposureDigest(locator)) throw exposureUnavailable();

    const [consentGrant] = session.consent_grant_id ? await tx.select().from(appExperienceConsentGrants).where(and(

      eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.id, session.consent_grant_id),

      eq(appExperienceConsentGrants.owner_user_id, caller.user_id))).limit(1).for(write ? 'update' : 'share') : [];

    if (session.consent_grant_id && (!consentGrant || consentGrant.revoked_at)) throw exposureUnavailable();

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

        || current.grant_snapshot_id !== old.grant_snapshot_id || current.resource_key !== old.resource_key

        || current.target_key !== old.target_key) throw exposureUnavailable();

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

      const authority = version.protocol_version === '7'

        ? await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: caller.org_id, resource_binding_id: binding.id, clock: this.clock,

          prelocked_participant_ids: participantIds })

        : await loadLiveResourceSyncBindingAuthority(tx, { org_id: caller.org_id, resource_binding_id: binding.id, clock: this.clock });

      if (!authority || authority.binding.owner_user_id !== caller.user_id || authority.version.id !== session.app_version_id

        || authority.grant.id !== session.grant_snapshot_id

        || !participantIds.includes(authority.registration.operator_user_id)) throw exposureUnavailable();

      authorities.push(authority);

    }

    const verified = await this.verifyBundle(version, session.experience_key, metrics);

    if (verified.reference.artifact_digest !== session.artifact_digest || exposureDigest(verified.bundle) !== exposureDigest(earlyBundle.bundle)) throw exposureUnavailable();

    const checkpoints = await tx.select().from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id, caller.org_id),

      inArray(appSyncCheckpoints.resource_binding_id, bindingIds), eq(appSyncCheckpoints.state, 'active')));

    if (checkpoints.length !== bindingIds.length || checkpoints.some(c => !checkpointLocators.some(old => old.id === c.id))) throw exposureUnavailable();

    const web = await assertExperienceWeb(tx, caller); // exact SID is the LAST new lock

    const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, caller.user_id));

    const context = { session, installation, version, grant, verified, authorities, checkpoints, exposure, children, web, consentGrant,

      runtimeBinding, connectionActionBindings, participantIds, owner_label: label(owner?.name ?? 'You') };

    if (consentGrant) this.materializeConsent(caller, context);

    await this.final(tx, caller, context, signal, allowExpired);

    return context;

  }



  private async verifyBundle(version: typeof appVersions.$inferSelect, key: string, metrics?: BrowseAuthorityPhase) {

    if (!metrics) return verifiedExperienceBundle(version, key);

    const at = performance.now();

    try { return await verifiedExperienceBundle(version, key); }

    finally { metrics.package_verify_calls++; metrics.package_verify_ms += performance.now() - at; }

  }



  private materializeConsent(caller: ExperienceCaller, context: Context): void {

    const grant = context.consentGrant!;

    const scope = ExperienceConsentScopeSchema.parse(grant.snapshot);

    const current = this.snapshot(caller, context, this.clock(), new Date(caller.access_expires_at!));

    if (grant.revoked_at || grant.scope_digest !== experienceConsentDigest(scope)

      || grant.scope_digest !== experienceConsentDigest(experienceConsentScope(current))) throw exposureUnavailable();

    context.exposure = { id: grant.id, org_id: caller.org_id, experience_session_id: context.session.id,

      owner_user_id: caller.user_id, web_session_id: caller.sid, review_digest: grant.scope_digest, snapshot: current,

      payload_policy_version: PAYLOAD_VERSION, exposure_epoch: grant.epoch, created_at: grant.created_at,

      expires_at: new Date(current.expires_at), revoked_at: grant.revoked_at };

    context.children = current.resources.map(resource => ({ org_id: caller.org_id, exposure_id: grant.id,

      resource_key: resource.resource_key, resource_binding_id: resource.binding_id, runtime_registration_id: resource.registration_id,

      runtime_epoch: resource.runtime_epoch, descriptor_digest: resource.descriptor_digest, resource_type: resource.resource_type,

      allowed_operations: resource.allowed_operations, allowed_fields: resource.allowed_fields }));

  }



  private async final(tx: Tx, caller: ExperienceCaller, context: Context, signal?: AbortSignal, allowExpired = false) {

    this.enabled(caller, signal);

    await assertExperienceWeb(tx, caller);

    this.enabled(caller, signal);

    for (const participant of context.participantIds) if (!await resourceSyncParticipantsAreHuman(tx, caller.user_id, participant)) throw exposureUnavailable();

    const now = this.clock().getTime();

    if (!Number.isFinite(now) || (!allowExpired && context.session.expires_at.getTime() <= now) || caller.access_expires_at! <= now || context.web.expires_at.getTime() <= now

      || context.authorities.some(a => !a.binding.consent_expires_at || a.binding.consent_expires_at.getTime() <= now)) throw exposureUnavailable();

    this.enabled(caller, signal);

    if (context.verified.manifest.schema_version === '7') {

      // Scalar exposure never confers an action or attachment read. Its own

      // reviewed resource gate survives independent action-plane withdrawal.

      if (!isAppAttachmentBrokerEnabled()) throw exposureUnavailable();

    } else if (context.verified.manifest.schema_version === '6') {

      if (!isAppNativeCalendarEnabled()) throw exposureUnavailable();

      const runtimeKeys = new Set(context.verified.manifest.runtime_actions.map(action => action.key));

      if (context.verified.bundle.action_keys.some(key => runtimeKeys.has(key)) && !isAppV5RuntimeActionsEnabled()) throw exposureUnavailable();

    } else if (context.verified.bundle.action_keys.length && !isAppV5RuntimeActionsEnabled()) throw exposureUnavailable();

  }



  private snapshot(caller: ExperienceCaller, context: Context, preparedAt: Date, accessExpiry: Date): ExposureSnapshot {

    const resources = context.authorities.map(a => {

      const fields = Object.keys(a.descriptor.record_schema.properties).sort();

      if (!fields.length || fields.length > 32 || fields.some(field => field.length > 48)) throw exposureUnavailable();

      const content = context.verified.manifest.schema_version === '7'

        ? context.verified.manifest.resource_content?.find(item => item.resource_key === a.binding.resource_key) : undefined;

      return { resource_key: a.binding.resource_key, binding_id: a.binding.id, registration_id: a.registration.id,

        runtime_epoch: a.registration.runtime_epoch, descriptor_digest: a.descriptor_digest, resource_type: a.descriptor.resource_type,

        label: label(a.descriptor.key), allowed_operations: (context.verified.bundle.schema_version === 'deft.experience_bundle.v2' || (context.verified.bundle.schema_version === 'deft.experience_bundle.v3' || context.verified.bundle.schema_version === 'deft.experience_bundle.v4'))

          && context.verified.bundle.search_resource_keys?.includes(a.binding.resource_key)

          ? ['list_summary', 'read_one', 'search'] as ['list_summary', 'read_one', 'search']

          : ['list_summary', 'read_one'] as ['list_summary', 'read_one'], allowed_fields: fields,

        ...(content ? { content_policy: { document: content.document, ...(content.source ? {source:content.source} : {}),...(content.triage_options?{triage_options:content.triage_options}:{}),...(content.search_filters?{search_filters:content.search_filters}:{}) } } : {}),

        consent_expires_at: a.binding.consent_expires_at!.toISOString() };

    });

    const expiry = Math.min(preparedAt.getTime() + EXPOSURE_LIMITS.exposure_ms, accessExpiry.getTime(), context.web.expires_at.getTime(),

      context.session.expires_at.getTime(), ...context.authorities.map(a => a.binding.consent_expires_at!.getTime()));

    return ExposureSnapshotSchema.parse({ schema_version: (context.verified.bundle.schema_version === 'deft.experience_bundle.v3' || context.verified.bundle.schema_version === 'deft.experience_bundle.v4') ? STATE_EXPOSURE_VERSION : context.verified.bundle.schema_version === 'deft.experience_bundle.v2' ? SEARCH_EXPOSURE_VERSION : EXPOSURE_VERSION, payload_policy_version: PAYLOAD_VERSION,

      visibility: 'user_private', destination: 'verified_installed_experience_worker', org_id: caller.org_id, owner_user_id: caller.user_id,

      owner_label: context.owner_label, web_session_id: caller.sid, experience_session_id: context.session.id,

      installation_id: context.installation.id, app_version_id: context.version.id, app_name: label(context.verified.manifest.name),

      app_version: context.version.version, package_digest: context.version.package_digest, manifest_digest: context.version.manifest_digest,

      grant_snapshot_id: context.grant.id, grant_snapshot_digest: context.grant.snapshot_digest,

      lifecycle_epoch: context.installation.lifecycle_epoch, grant_epoch: context.installation.grant_epoch,

      experience_key: context.session.experience_key, experience_label: label(context.verified.reference.label),

      ...((context.verified.bundle.schema_version === 'deft.experience_bundle.v3' || context.verified.bundle.schema_version === 'deft.experience_bundle.v4') && context.verified.manifest.schema_version === '7' && context.verified.bundle.state_keys.length > 0
        ? { private_state: context.verified.bundle.state_keys.map(key => {

          const declaration = context.verified.manifest.schema_version === '7' ? context.verified.manifest.private_state?.find(state => state.key === key) : undefined;

          if (!declaration || !isAppPrivateStateEnabled()) throw exposureUnavailable();

          const { schema: _schema, ...safe } = declaration;

          return { ...safe, declaration_digest: exposureDigest(declaration), allowed_operations: ['list', 'read', 'put', 'delete'] };

        }) } : {}),
      ...((context.verified.bundle.schema_version === 'deft.experience_bundle.v3' || context.verified.bundle.schema_version === 'deft.experience_bundle.v4') && context.verified.manifest.schema_version === '7' && context.verified.bundle.record_store_keys?.length
        ? { record_stores: context.verified.bundle.record_store_keys.map(key => {
          const declaration = context.verified.manifest.schema_version === '7' ? context.verified.manifest.record_stores?.find(store => store.key === key) : undefined;
          if (!declaration) throw exposureUnavailable();
          return { ...declaration, declaration_digest: exposureDigest(declaration) };
        }) } : {}),
      artifact_digest: context.session.artifact_digest, bridge_version: context.verified.reference.bridge_version,

      renderer_version: context.verified.reference.renderer_version,
      ...(context.verified.reference.capabilities === undefined ? {} : { capabilities: context.verified.reference.capabilities }), resources,
      limits: { items: 10, fields: 32, string_chars: 4096, envelope_bytes: 61440 }, prepared_at: preparedAt.toISOString(),

      review_expires_at: new Date(Math.min(preparedAt.getTime() + EXPOSURE_LIMITS.review_ms, expiry)).toISOString(),

      web_access_expires_at: accessExpiry.toISOString(), expires_at: new Date(expiry).toISOString() });

  }



  private accessValue(context: Context) {

    const grant = context.consentGrant;

    const private_state_labels = context.verified.manifest.schema_version === '7'

      ? (context.verified.manifest.private_state ?? []).filter(state => (context.verified.bundle.schema_version === 'deft.experience_bundle.v3' || context.verified.bundle.schema_version === 'deft.experience_bundle.v4')

        && context.verified.bundle.state_keys.includes(state.key)).map(({ key, label }) => ({ key, label })) : [];

    return grant ? { grant_status: 'active' as const,

      grant: { id: grant.id, epoch: grant.epoch, scope_digest: grant.scope_digest },

      exposure: this.statusValue(context.exposure!), private_state_labels }

      : { grant_status: 'review_required' as const, private_state_labels };

  }



  async acquire(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {

    this.enabled(caller, signal);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, true, signal);

      if (!context.consentGrant) {

        const scope = experienceConsentScope(this.snapshot(caller, context, this.clock(), new Date(caller.access_expires_at!)));

        const [grant] = await tx.select().from(appExperienceConsentGrants).where(and(

          eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.owner_user_id, caller.user_id),

          eq(appExperienceConsentGrants.app_installation_id, context.installation.id),

          eq(appExperienceConsentGrants.experience_key, context.session.experience_key),

          eq(appExperienceConsentGrants.scope_digest, experienceConsentDigest(scope)), isNull(appExperienceConsentGrants.revoked_at))).limit(1).for('share');

        if (grant) {

          await tx.update(appExperienceSessions).set({ consent_grant_id: grant.id }).where(and(eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId)));

          context.session.consent_grant_id = grant.id; context.consentGrant = grant;

          this.materializeConsent(caller, context);

        }

      }

      await this.final(tx, caller, context, signal);

      return this.accessValue(context);

    }, signal);

  }



  async reviewAccess(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {

    this.enabled(caller, signal);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, false, signal);

      const display = this.snapshot(caller, context, this.clock(), new Date(caller.access_expires_at!));

      const scope = experienceConsentScope(display);

      const review_expires_at = new Date(Math.min(this.clock().getTime() + EXPOSURE_LIMITS.review_ms,

        caller.access_expires_at!, context.web.expires_at.getTime(), context.session.expires_at.getTime())).toISOString();

      await this.final(tx, caller, context, signal);

      return { snapshot: { ...display, review_expires_at }, persistent: true as const, review_digest: experienceConsentDigest(scope), review_expires_at,

        review_token: sealExposureToken(this.keys, 'durable_review', { scope, web_session_id: caller.sid, experience_session_id: sessionId, prepared_at: display.prepared_at, review_expires_at }) };

    }, signal);

  }



  async acceptAccess(caller: ExperienceCaller, sessionId: string, raw: unknown, signal?: AbortSignal) {

    this.enabled(caller, signal);

    const input = ExperienceConsentAcceptSchema.parse(raw);

    const token = ExperienceConsentReviewTokenSchema.parse(openExposureToken(this.keys, 'durable_review', input.review_token));

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, true, signal);

      const current = experienceConsentScope(this.snapshot(caller, context, this.clock(), new Date(caller.access_expires_at!)));

      if (token.web_session_id !== caller.sid || token.experience_session_id !== sessionId

        || Date.parse(token.review_expires_at) <= this.clock().getTime()

        || input.review_digest !== experienceConsentDigest(token.scope) || input.review_digest !== experienceConsentDigest(current)) throw exposureStale();

      // A distinct fresh review may restore permission after explicit revocation;

      // replay of the old acceptance is never an acquisition path.

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['experience_consent', caller.org_id, caller.user_id, context.installation.id, context.session.experience_key])},0))`);

      const [revoked] = await tx.select().from(appExperienceConsentGrants).where(and(

        eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.owner_user_id, caller.user_id),

        eq(appExperienceConsentGrants.app_installation_id, context.installation.id),

        eq(appExperienceConsentGrants.experience_key, context.session.experience_key), eq(appExperienceConsentGrants.scope_digest, input.review_digest),

        sql`${appExperienceConsentGrants.revoked_at} IS NOT NULL`)).orderBy(sql`${appExperienceConsentGrants.revoked_at} DESC`).limit(1);

      if (revoked?.revoked_at && Date.parse(token.prepared_at) <= revoked.revoked_at.getTime()) throw exposureStale();

      const [inserted] = await tx.insert(appExperienceConsentGrants).values({ org_id: caller.org_id, owner_user_id: caller.user_id,

        app_installation_id: context.installation.id, app_version_id: context.version.id, experience_key: context.session.experience_key,

        scope_digest: input.review_digest, snapshot: current, created_at: this.clock() }).onConflictDoNothing().returning();

      const grant = inserted ?? (await tx.select().from(appExperienceConsentGrants).where(and(

        eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.owner_user_id, caller.user_id),

        eq(appExperienceConsentGrants.app_installation_id, context.installation.id),

        eq(appExperienceConsentGrants.experience_key, context.session.experience_key), eq(appExperienceConsentGrants.scope_digest, input.review_digest),

        isNull(appExperienceConsentGrants.revoked_at))).limit(1).for('share'))[0];

      if (!grant) throw exposureStale();

      await tx.update(appExperienceSessions).set({ consent_grant_id: grant.id }).where(and(eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId)));

      context.session.consent_grant_id = grant.id; context.consentGrant = grant;

      this.materializeConsent(caller, context); await this.final(tx, caller, context, signal);

      return this.accessValue(context);

    }, signal);

  }



  async refresh(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {

    this.enabled(caller, signal);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, true, signal, true);

      if (!context.consentGrant) throw exposureUnavailable();

      const expires_at = new Date(Math.min(this.clock().getTime() + EXPOSURE_LIMITS.exposure_ms,

        caller.access_expires_at!, context.web.expires_at.getTime(), ...context.authorities.map(a => a.binding.consent_expires_at!.getTime())));

      if (expires_at <= this.clock()) throw exposureUnavailable();

      await tx.update(appExperienceSessions).set({ expires_at }).where(and(eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId)));

      context.session.expires_at = expires_at; this.materializeConsent(caller, context);

      await this.final(tx, caller, context, signal);

      return { session_expires_at: expires_at.toISOString(), ...this.accessValue(context) };

    }, signal);

  }



  async revokeAccess(caller: ExperienceCaller, sessionId: string, signal?: AbortSignal) {

    this.enabled(caller, signal);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, true, signal, true);

      if (!context.consentGrant) throw exposureUnavailable();

      await tx.update(appExperienceConsentGrants).set({ revoked_at: this.clock(), epoch: context.consentGrant.epoch + 1 })

        .where(and(eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.id, context.consentGrant.id), isNull(appExperienceConsentGrants.revoked_at)));

      await this.final(tx, caller, context, signal, true);

      return { revoked: true as const, grant_id: context.consentGrant.id };

    }, signal);

  }



  /** Server-selected adapter pins nominate existing reviewed private custody.

   * This projection grants neither deployment admission nor an external write. */

  async connectionSetup(caller: ExperienceCaller, sessionId: string, rawPins: AppConnectionPins, signal?: AbortSignal,

    purpose: AppConnectionPurpose = 'connect'): Promise<AppConnectionProjection> {

    const pins = AppConnectionPinsSchema.parse(rawPins);

    AppConnectionPurposeSchema.parse(purpose);

    if (pins.org_id !== caller.org_id || pins.owner_user_id !== caller.user_id) throw exposureUnavailable();

    this.enabled(caller, signal);

    if(purpose==='status'||purpose==='disconnect')return this.connectionCleanup(caller,pins,signal,purpose);

    const prepared = await this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, false, signal, false, purpose === 'connect' ? pins.action_key ?? undefined : undefined, purpose === 'connect');

      return this.connectionProjection(tx, caller, sessionId, pins, purpose, context, signal);

    }, signal);

    prepared.checkDeadline();

    return Object.freeze({ ...prepared.output, checked_at: prepared.currentClock().getTime() });

  }



  private async connectionProjection(tx: Tx, caller: ExperienceCaller, sessionId: string, pins: AppConnectionPins,

    purpose: AppConnectionPurpose, context: Context, signal?: AbortSignal) {

    let checkDeadline: (() => void) | undefined;

    let currentClock: (() => Date) | undefined;

      this.assertStored(context);

      const resource = context.authorities.find(authority => authority.binding.id === pins.resource_binding_id);

      if (context.verified.manifest.schema_version !== '7' || !resource

        || context.installation.id !== pins.installation_id || context.version.id !== pins.app_version_id

        || context.grant.id !== pins.grant_snapshot_id || context.session.resource_target_key !== pins.target_key

        || resource.binding.resource_key !== pins.resource_key

        || (purpose === 'connect' && (context.runtimeBinding?.id ?? null) !== pins.action_binding_id)) throw exposureUnavailable();
      assertLegacyOwnerConnectionResourcePolicies(context.verified.manifest.owner_connections, pins.resource_key);
      // Member access requires the explicit current per-owner admission already

      // checked by the locked resource authority. Legacy rows retain their gate.

      const [member] = await tx.select({ role: orgMembers.role }).from(orgMembers).where(and(

        eq(orgMembers.org_id, caller.org_id), eq(orgMembers.user_id, caller.user_id))).limit(1);

      if (!member || !['owner', 'admin'].includes(member.role)

        && !(member.role === 'member' && resource.registration.owner_connection_admission_id)) throw exposureUnavailable();

      if (purpose === 'connect' && pins.action_binding_id) {

        const { getAppRunRuntime } = await import('./app-run-runtime.js');

        const current = await (await getAppRunRuntime()).liveAuthorization.captureReviewedRuntimeInTransaction(tx, {

          org_id: caller.org_id, user_id: caller.user_id, runtime_binding_id: pins.action_binding_id,

        });

        if (current.protocol_version !== '7' || current.binding.app_installation_id !== pins.installation_id

          || current.binding.app_version_id !== pins.app_version_id || current.binding.grant_snapshot_id !== pins.grant_snapshot_id) throw exposureUnavailable();

      }

      const reviewed_action_keys: string[] = [];

      const actionDeadlines: number[] = [];

      if (purpose === 'connect') {

        const { getAppRunRuntime } = await import('./app-run-runtime.js');

        const authorizer = (await getAppRunRuntime()).liveAuthorization;

        const candidates = context.connectionActionBindings.filter(binding => binding.owner_resource_binding_id === resource.binding.id);

        for (const binding of candidates) {

          // An ambiguous key is never connection permission, even if one row is valid.

          if (candidates.filter(row => row.action_key === binding.action_key).length !== 1) continue;

          try {

            const current = await authorizer.captureReviewedRuntimeInTransaction(tx, {

              org_id: caller.org_id, user_id: caller.user_id, runtime_binding_id: binding.id,

            });

            if (current.protocol_version !== '7' || current.binding.owner_resource_binding_id !== resource.binding.id

              || current.binding.reviewed_by_user_id !== caller.user_id || current.binding.app_installation_id !== pins.installation_id

              || current.binding.app_version_id !== pins.app_version_id || current.binding.grant_snapshot_id !== pins.grant_snapshot_id

              || current.installation_lifecycle_epoch !== context.installation.lifecycle_epoch

              || current.installation_grant_epoch !== context.installation.grant_epoch

              || !context.participantIds.includes(current.registration.operator_user_id)

              || !current.owner_target_consent_expires_at || current.owner_target_consent_expires_at.getTime() <= this.clock().getTime()) continue;

            reviewed_action_keys.push(binding.action_key);

            actionDeadlines.push(current.owner_target_consent_expires_at.getTime());

          } catch (error) {

            // Revoked/stale optional actions remove scope admission; they do not

            // disable an independently valid read/send connection.

            if (!(error instanceof Error) || error.message !== 'APP_RUN_AUTHORIZATION_STALE') throw error;

          }

        }

      }

      const snapshot = this.snapshot(caller, context, this.clock(), new Date(caller.access_expires_at!));

      const selected = snapshot.resources.find(item => item.binding_id === resource.binding.id);

      if (!selected) throw exposureUnavailable();

      if (purpose === 'read_document' && (!selected.allowed_operations.includes('read_one') || !selected.content_policy?.document)) throw exposureUnavailable();

      if (purpose === 'read_source' && (!selected.allowed_operations.includes('read_one') || !selected.content_policy?.source)) throw exposureUnavailable();

      if(purpose==='triage_options'&&(!selected.allowed_operations.includes('read_one')||!selected.content_policy?.triage_options))throw exposureUnavailable();

      const clock = await samplePrivateAccessClock(tx, this.clock);

      currentClock = clock.current;

      const expires_at = Math.min(Date.parse(snapshot.expires_at), context.exposure!.expires_at.getTime(),

        resource.binding.consent_expires_at!.getTime(), ...actionDeadlines);

      checkDeadline = () => {

        signal?.throwIfAborted();

        if (expires_at <= clock.current().getTime()) throw exposureUnavailable();

      };

      await this.final(tx, caller, context, signal); this.assertStored(context); checkDeadline();

      // Connect and reads use live private source authority. Retained owner

      // status/discard take the separate cleanup branch above.

      const output = Object.freeze({ ...pins, purpose, web_session_id: caller.sid, experience_session_id: sessionId,

        runtime_registration_id: resource.registration.id, descriptor_digest: resource.descriptor_digest,

        allowed_operations: selected.allowed_operations, ...(purpose === 'connect' ? { reviewed_action_keys: reviewed_action_keys.sort() } : {}), ...(selected.content_policy ? { content_policy: selected.content_policy } : {}), lifecycle_epoch: context.installation.lifecycle_epoch,

        grant_epoch: context.installation.grant_epoch, runtime_epoch: resource.registration.runtime_epoch, expires_at, checked_at: clock.current().getTime() });

      return { output, checkDeadline: checkDeadline!, currentClock: currentClock! };

  }



  /** Current owner cleanup is independent of an expired/revoked Experience or mailbox consent. */

  async connectionCleanup(caller:ExperienceCaller,pins:AppConnectionPins,signal?:AbortSignal,purpose:'status'|'disconnect'='status') {

    this.enabled(caller,signal);

    return this.repository.transaction(tx=>loadOwnerConnectionCleanup(tx,caller,pins,purpose,this.clock,signal),signal);

  }



  /** Host-only source nomination; browser values never supply a revision or provider locator. */

  async providerAuthority(caller: ExperienceCaller, sessionId: string, key: string, signal?: AbortSignal) {

    this.enabled(caller, signal); resourceKey.parse(key);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, false, signal);

      const output = this.providerNomination(caller, key, context);

      await this.final(tx, caller, context, signal); this.assertStored(context);

      return output;

    }, signal);

  }



  private providerNomination(caller: ExperienceCaller, key: string, context: Context) {

      const snapshot = this.assertStored(context), resource = snapshot.resources.find(item => item.resource_key === key);

      const source = context.authorities.find(item => item.binding.resource_key === key);

      if (!resource || !source || context.verified.manifest.schema_version !== '7') throw exposureUnavailable();

      return { installation_id: context.installation.id, target_key: context.session.resource_target_key,

        resource_binding_id: source.binding.id, exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch,

        allowed_fields: resource.allowed_fields, handle_scope: providerHandleScope(snapshot, context, key),

        record_schema: source.descriptor.record_schema,

        label_field: source.descriptor.label_field,

        handle_group: exposureDigest([caller.org_id, caller.user_id, context.installation.id]),

        max_records_per_page: source.binding.max_records_per_page, max_page_bytes: source.binding.max_page_bytes,

        expires_at: Math.min(context.exposure!.expires_at.getTime(), context.session.expires_at.getTime(),

          context.web.expires_at.getTime(), caller.access_expires_at!, source.binding.consent_expires_at!.getTime()) };

  }



  /** Both browse projections derive from one fresh phased-lock context; no authority cache. */

  async browseAuthority(caller: ExperienceCaller, sessionId: string, key: string, rawPins: AppConnectionPins, signal?: AbortSignal, observe?: (phase: Readonly<BrowseAuthorityPhase>) => void) {

    const pins = AppConnectionPinsSchema.parse(rawPins);

    this.enabled(caller, signal); resourceKey.parse(key);

    if (pins.org_id !== caller.org_id || pins.owner_user_id !== caller.user_id || pins.resource_key !== key) throw exposureUnavailable();

    const phase: BrowseAuthorityPhase = { locked_ms: 0, package_verify_ms: 0, package_verify_calls: 0, projection_ms: 0, final_ms: 0, db_query_ms: 0, db_query_count: 0, db_acquisition_ms: 0 };

    const measure = async <T>(key: 'locked_ms' | 'projection_ms' | 'final_ms', run: () => Promise<T>): Promise<T> => {

      const at = performance.now(); try { return await run(); } finally { phase[key] += performance.now() - at; }

    };

    try {

    const prepared = await this.repository.transaction(async tx => {

      const context = await measure('locked_ms', () => this.locked(tx, caller, sessionId, false, signal, false, undefined, false, phase));

      const connection = await measure('projection_ms', () => this.connectionProjection(tx, caller, sessionId, pins, 'browse_resource', context, signal));

      const nomination = this.providerNomination(caller, key, context);

      await measure('final_ms', () => this.final(tx, caller, context, signal)); this.assertStored(context); connection.checkDeadline();

      if (nomination.resource_binding_id !== pins.resource_binding_id || nomination.installation_id !== pins.installation_id

        || nomination.target_key !== pins.target_key || nomination.expires_at <= connection.currentClock().getTime()) throw exposureUnavailable();

      return { connection, nomination };

    }, signal, undefined, sample => { if (sample.kind === 'query') { phase.db_query_count++; phase.db_query_ms += sample.elapsed_ms; } else { phase.db_acquisition_ms += sample.elapsed_ms; } });

    prepared.connection.checkDeadline();

    if (prepared.nomination.expires_at <= prepared.connection.currentClock().getTime()) throw exposureUnavailable();

    return { projection: Object.freeze({ ...prepared.connection.output, checked_at: prepared.connection.currentClock().getTime() }), nomination: prepared.nomination };

    } finally { try { observe?.({ ...phase }); } catch { /* Diagnostics never affect disclosure. */ } }

  }



  async sourceRecord(caller: ExperienceCaller, sessionId: string, key: string, recordId: string, signal?: AbortSignal) {

    this.enabled(caller, signal); resourceKey.parse(key); uuid.parse(recordId);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, false, signal);

      const snapshot = this.assertStored(context), disclosed = snapshot.resources.find(item => item.resource_key === key);

      const source = context.authorities.find(item => item.binding.resource_key === key);

      const checkpoint = source && context.checkpoints.find(item => item.resource_binding_id === source.binding.id);

      if (!source || !checkpoint || !disclosed?.allowed_operations.includes('read_one')) throw exposureUnavailable();

      const [row] = await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id, caller.org_id),

        eq(appResourceProjections.resource_binding_id, source.binding.id), eq(appResourceProjections.checkpoint_id, checkpoint.id),

        eq(appResourceProjections.generation, checkpoint.generation), eq(appResourceProjections.state, 'live'), eq(appResourceProjections.id, recordId))).limit(1).for('share');

      if (!row) {

        const retained = experienceProviderHandles.read<ProviderSourceRecord>(this.keys, providerHandleScope(snapshot, context, key), 'source', recordId);

        if (!retained) throw exposureUnavailable();

        const data = exposurePayloadData(retained.data, disclosed.allowed_fields);

        await this.final(tx, caller, context, signal); this.assertStored(context);

        return { installation_id: context.session.app_installation_id, target_key: context.session.resource_target_key,

          resource_binding_id: source.binding.id, exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch,

          record: { ...retained, data, record_id: recordId } };

      }

      const descriptor = source.descriptor.schema_version === 'deft.app_sync_descriptor.v2'

        ? (() => { const { attachments: _policy, ...scalar } = source.descriptor; return { ...scalar, schema_version: 'deft.app_sync_descriptor.v1' as const }; })()

        : source.descriptor;

      const parsed = decodePrivateProjection(this.secrets, row, descriptor);

      await this.final(tx, caller, context, signal); this.assertStored(context);

      return { installation_id: context.session.app_installation_id, target_key: context.session.resource_target_key,

        resource_binding_id: source.binding.id, exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch,

        record: { record_id: row.id, revision: parsed.revision, label: label(String(parsed.data[descriptor.label_field] ?? '')),

          data: exposurePayloadData(parsed.data, disclosed.allowed_fields) } };

    }, signal);

  }



  async withHumanAction<T>(caller: ExperienceCaller, sessionId: string, actionKey: string,

    run: (tx: Tx, authority: HumanActionAuthority,

      finalGuard: (tx: Tx, additionalFinalCheck?: () => void) => Promise<void>) => Promise<T>, signal?: AbortSignal, draftStateKey?: string, suppliedTransaction?: Tx, transactionPurpose?: 'human_action_confirmation'): Promise<T> {

    this.enabled(caller, signal); resourceKey.parse(actionKey);

    if (draftStateKey !== undefined) resourceKey.parse(draftStateKey);

    const use = async (tx: Tx) => {

      // Match private-state lock order before taking phased authority locks.

      if (draftStateKey !== undefined) {

        const [locator] = await tx.select().from(appExperienceSessions).where(and(

          eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId),

          eq(appExperienceSessions.user_id, caller.user_id), eq(appExperienceSessions.web_session_id, caller.sid))).limit(1);

        if (!locator) throw exposureUnavailable();

        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['private_state', caller.org_id, caller.user_id, locator.app_installation_id, draftStateKey])},0))`);

      }

      const context = await this.locked(tx, caller, sessionId, false, signal, false, actionKey);

      const snapshot = this.assertStored(context);

      const manifest = context.verified.manifest, bundle = context.verified.bundle;

      const draftDeclaration = draftStateKey === undefined || manifest.schema_version !== '7' ? undefined

        : manifest.private_state?.find(state => state.key === draftStateKey);

      if (draftStateKey !== undefined && (!isAppPrivateStateEnabled() || !draftDeclaration

        || (bundle.schema_version !== 'deft.experience_bundle.v3' && bundle.schema_version !== 'deft.experience_bundle.v4') || !bundle.state_keys.includes(draftStateKey)

        || !snapshot.private_state?.some(state => state.key === draftStateKey && state.declaration_digest === exposureDigest(draftDeclaration)))) throw exposureUnavailable();

      const action = context.verified.manifest.schema_version === '7'

        ? context.verified.manifest.runtime_actions.find(action => action.key === actionKey) : undefined;

      if (!action || !context.runtimeBinding) throw exposureUnavailable();

      // Derive this from the reviewed manifest even when the caller omits a

      // draft. Otherwise omission could downgrade a payload action to scalar.

      const payloadStates = manifest.schema_version === '7' ? (manifest.private_state ?? [])

        .flatMap(state => (state.action_payloads ?? []).filter(item => item.action_key === actionKey)

          .map(policy => ({ state, policy }))) : [];

      if (payloadStates.length > 1) throw exposureUnavailable();

      const payloadState = payloadStates[0];

      if (payloadState && (!isAppPrivateStateEnabled() || (bundle.schema_version !== 'deft.experience_bundle.v3' && bundle.schema_version !== 'deft.experience_bundle.v4')

        || !bundle.state_keys.includes(payloadState.state.key) || !snapshot.private_state?.some(state =>

          state.key === payloadState.state.key && state.declaration_digest === exposureDigest(payloadState.state)))) throw exposureUnavailable();

      let additionalFinalCheck: (() => void) | undefined;

      const finalGuard = async (_executor: Tx, check?: () => void) => {

        if (check) additionalFinalCheck = check;

        await this.final(tx, caller, context, signal); this.assertStored(context);

        if (!isAppV5RuntimeActionsEnabled()) throw exposureUnavailable();

        if ((draftStateKey !== undefined || payloadState) && !isAppPrivateStateEnabled()) throw exposureUnavailable();

        // Caller-owned earlier deadlines remain armed through the outer final

        // authority wait. This check is synchronous: no new I/O follows it.

        additionalFinalCheck?.();

      };

      const resolveActionResources = async (schema: RuntimeObjectContract, input: Record<string, string | number | boolean>, savedSources: readonly StoredPrivateSource[] = []) => {

        const output: Record<string, readonly HumanActionSourceRecord[]> = {};

        for (const [key, definition] of Object.entries(schema.properties)) {

          if (definition.type !== 'string' || definition.format !== 'resource_record_list') continue;

          const value = input[key]; if (typeof value !== 'string') throw exposureUnavailable();

          const savedForField = savedSources.filter(item => item.action_key === actionKey && item.input_field === key);

          if (savedForField.some(item => item.record_id !== value)) throw exposureUnavailable();

          const ids = parseResourceRecordList(value, { maxItems: definition.maxItems, allowEmpty: (definition.minLength ?? 0) === 0 });

          if (!ids.length) { output[key] = []; continue; }

          const source = context.authorities.find(item => item.binding.resource_key === definition.resourceKey);

          const disclosed = snapshot.resources.find(item => item.resource_key === definition.resourceKey);

          const checkpoint = source && context.checkpoints.find(item => item.resource_binding_id === source.binding.id);

          if (!source || !checkpoint || !disclosed?.allowed_operations.includes('read_one')

            || context.runtimeBinding!.owner_resource_binding_id !== source.binding.id) throw exposureUnavailable();

          const rows = await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id, caller.org_id),

            eq(appResourceProjections.resource_binding_id, source.binding.id), eq(appResourceProjections.checkpoint_id, checkpoint.id),

            eq(appResourceProjections.generation, checkpoint.generation), eq(appResourceProjections.state, 'live'), inArray(appResourceProjections.id, [...ids])))

            .orderBy(asc(appResourceProjections.id)).for('share');

          const descriptor = source.descriptor.schema_version === 'deft.app_sync_descriptor.v2'

            ? (() => { const { attachments: _policy, ...scalar } = source.descriptor; return { ...scalar, schema_version: 'deft.app_sync_descriptor.v1' as const }; })()

            : source.descriptor;

          output[key] = ids.map(id => {

            const row = rows.find(candidate => candidate.id === id);

            if (!row) {

              const saved = savedSources.find(item => item.action_key === actionKey && item.input_field === key && item.record_id === id);

              if (saved && (saved.resource_key !== source.binding.resource_key

                || saved.scope !== privateSourceScope(snapshot,context,saved))) throw exposureUnavailable();

              const transient = saved?.record ?? experienceProviderHandles.read<ProviderSourceRecord>(this.keys,

                providerHandleScope(snapshot, context, source.binding.resource_key), 'source', id);

              if (!transient) throw exposureUnavailable();

              return { ...transient, data: exposurePayloadData(transient.data, disclosed.allowed_fields), record_id: id,

                resource_key: source.binding.resource_key, resource_binding_id: source.binding.id };

            }

            const parsed = decodePrivateProjection(this.secrets, row, descriptor);

            return { record_id: id, resource_key: source.binding.resource_key, resource_binding_id: source.binding.id,

              revision: parsed.revision, label: label(String(parsed.data[descriptor.label_field] ?? '')), data: exposurePayloadData(parsed.data, disclosed.allowed_fields) };

          });

        }

        if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 1_048_576) throw exposureUnavailable();

        await finalGuard(tx); return output;

      };

      const output = await run(tx, { session: context.session, runtime_binding_id: context.runtimeBinding.id, resolveActionResources,

        ...(draftDeclaration ? { draft_declaration: draftDeclaration } : {}),

        ...(payloadState ? { action_payload_declaration: { state_key: payloadState.state.key,

          max_payload_bytes: payloadState.policy.max_payload_bytes },

          draft_policy: { draft_state_key: payloadState.state.key, max_payload_bytes: payloadState.policy.max_payload_bytes,

            ...(payloadState.state.files ? { files: payloadState.state.files } : {}) },

          action_payload_sources: context.authorities.map(source => ({ purpose: 'connect' as const,

            org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: context.installation.id,

            app_version_id: context.version.id, grant_snapshot_id: context.grant.id,

            target_key: context.session.resource_target_key, resource_key: source.binding.resource_key,

            resource_binding_id: source.binding.id, action_key: actionKey, action_binding_id: context.runtimeBinding!.id,

            web_session_id: caller.sid!, experience_session_id: context.session.id,

            runtime_registration_id: source.registration.id, descriptor_digest: source.descriptor_digest,

            allowed_operations: snapshot.resources.find(resource => resource.resource_key === source.binding.resource_key)!.allowed_operations,

            lifecycle_epoch: context.installation.lifecycle_epoch, grant_epoch: context.installation.grant_epoch,

            runtime_epoch: source.registration.runtime_epoch, checked_at: this.clock().getTime(),

            expires_at: Math.min(context.session.expires_at.getTime(), context.exposure!.expires_at.getTime(),

              caller.access_expires_at!, context.web.expires_at.getTime(), source.binding.consent_expires_at!.getTime()),

          })) } : {}),

        authorization_identity: { consent_grant_id: context.consentGrant?.id ?? null, consent_epoch: context.consentGrant?.epoch ?? null,

          exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch },

        action_label: action.label, current_authority_expires_at: new Date(Math.min(context.session.expires_at.getTime(),

          context.exposure!.expires_at.getTime(), caller.access_expires_at!, context.web.expires_at.getTime())) }, finalGuard);

      await finalGuard(tx); return output;

    };

    return suppliedTransaction ? use(suppliedTransaction) : this.repository.transaction(use, signal, undefined, undefined, transactionPurpose);

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

      if (snapshot.resources.length) await tx.insert(appExperienceResourceExposureResources).values(snapshot.resources.map(r => ({ org_id: caller.org_id,

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

    if (context.consentGrant) {

      if (context.consentGrant.revoked_at || exposure.review_digest !== context.consentGrant.scope_digest

        || experienceConsentDigest(experienceConsentScope(snapshot)) !== context.consentGrant.scope_digest) throw exposureUnavailable();

      return snapshot;

    }

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

  /** No state authority exists outside the exact accepted owner session. */

  async withPrivateState<T>(caller: ExperienceCaller, sessionId: string, key: string,

    run: (tx: Tx, input: { declaration: PrivateStateDeclaration; artifact_digest: string; installation_id: string;

      session: typeof appExperienceSessions.$inferSelect; exposure: typeof appExperienceResourceExposures.$inferSelect;

      retainSources(refs: readonly PrivateStateSourceReference[] | undefined, value: Record<string,string|number|boolean>, previous: readonly StoredPrivateSource[]): Promise<StoredPrivateSource[]>;

      restoreSources(sources: readonly StoredPrivateSource[], value: Record<string,string|number|boolean>, expires: Date): void;

      onFinalCheck(check: () => void | Promise<void>): void; onDeliveryCheck(check: () => void): void }) => Promise<T>,

    signal?: AbortSignal): Promise<{ output: T; exposure_id: string; exposure_epoch: number }> {

    if (!isAppPrivateStateEnabled()) throw new AppError('Private App state is disabled', 'APP_FEATURE_DISABLED', 503);

    uuid.parse(sessionId); resourceKey.parse(key);

    return this.repository.transaction(async tx => {

      const [locator] = await tx.select().from(appExperienceSessions).where(and(

        eq(appExperienceSessions.org_id, caller.org_id), eq(appExperienceSessions.id, sessionId),

        eq(appExperienceSessions.user_id, caller.user_id), eq(appExperienceSessions.web_session_id, caller.sid))).limit(1);

      if (!locator) throw exposureUnavailable();

      // Serialize one owner/key quota before acquiring phased authority locks.

      // Every state operation follows this order; no other consumer locks state.

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['private_state', caller.org_id, caller.user_id, locator.app_installation_id, key])},0))`);

      const context = await this.locked(tx, caller, sessionId, false, signal);

      const snapshot = this.assertStored(context);

      const bundle = context.verified.bundle, manifest = context.verified.manifest;

      const declaration = manifest.schema_version === '7' ? manifest.private_state?.find(state => state.key === key) : undefined;

      if (!isAppPrivateStateEnabled() || (bundle.schema_version !== 'deft.experience_bundle.v3' && bundle.schema_version !== 'deft.experience_bundle.v4')

        || !bundle.state_keys.includes(key) || !declaration || !snapshot.private_state?.some(state =>

          state.key === key && state.declaration_digest === exposureDigest(declaration))) throw exposureUnavailable();

      const finalChecks: (() => void | Promise<void>)[] = [];

      const deliveryChecks: (() => void)[] = [];

      const validSource = (item: StoredPrivateSource, value: Record<string,string|number|boolean>) => {

        if (value[item.field] !== item.record_id || item.scope !== privateSourceScope(snapshot,context,item)) throw exposureUnavailable();

        return item;

      };

      const retainSources = async (refs: readonly PrivateStateSourceReference[] | undefined, value: Record<string,string|number|boolean>, previous: readonly StoredPrivateSource[]) => {

        const saved = new Map(previous.filter(item => value[item.field] === item.record_id).map(item => [item.field,validSource(item,value)]));

        for (const ref of refs ?? []) {

          const property = declaration.schema.properties[ref.field];

          if (!property || property.type !== 'string' || value[ref.field] !== ref.record_id) throw exposureUnavailable();

          const resource_key = privateSourceResource(context,ref);

          const prior = saved.get(ref.field);

          const record = prior && prior.action_key === ref.action_key && prior.input_field === ref.input_field && prior.record_id === ref.record_id

            ? prior.record : experienceProviderHandles.read<ProviderSourceRecord>(this.keys,providerHandleScope(snapshot,context,resource_key),'source',ref.record_id);

          // Retained projection UUIDs need no supplemental seal; their existing

          // durable lookup remains authoritative at read/snapshot time.

          if (!record) {

            const source = context.authorities.find(item => item.binding.resource_key === resource_key)!;

            const checkpoint = context.checkpoints.find(item => item.resource_binding_id === source.binding.id);

            if (!checkpoint) throw exposureUnavailable();

            const [row] = await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id,caller.org_id),

              eq(appResourceProjections.resource_binding_id,source.binding.id),eq(appResourceProjections.id,ref.record_id),

              eq(appResourceProjections.checkpoint_id,checkpoint.id),eq(appResourceProjections.generation,checkpoint.generation),eq(appResourceProjections.state,'live'))).limit(1).for('share');

            if (!row) throw exposureUnavailable();

            saved.delete(ref.field); continue;

          }

          saved.set(ref.field,StoredPrivateSourceSchema.parse({...ref,resource_key,scope:privateSourceScope(snapshot,context,{...ref,resource_key}),record}));

        }

        if (saved.size > 4) throw exposureUnavailable();

        return [...saved.values()];

      };

      const restoreSources = (sources: readonly StoredPrivateSource[], value: Record<string,string|number|boolean>, expires: Date) => {

        for (const source of sources) validSource(source,value);

        // A public read never receives source locators; rehydrate only after all

        // authority/deadline checks, and only from authenticated draft custody.

        deliveryChecks.push(() => {

          for (const source of sources) experienceProviderHandles.put(this.keys,providerHandleScope(snapshot,context,source.resource_key),

            exposureDigest([caller.org_id,caller.user_id,context.installation.id]),'source',source.record,

            Math.min(expires.getTime(),Date.parse(snapshot.expires_at)),source.record_id);

        });

      };

      const result = await run(tx, { declaration, session: context.session, exposure: context.exposure!,retainSources,restoreSources,

        onFinalCheck: check => finalChecks.push(check), onDeliveryCheck: check => deliveryChecks.push(check), artifact_digest: context.session.artifact_digest,

        installation_id: context.session.app_installation_id });

      for (const check of finalChecks) await check();

      await this.final(tx, caller, context, signal);

      this.assertStored(context);

      if (!isAppPrivateStateEnabled()) throw exposureUnavailable();

      for (const check of deliveryChecks) check();

      return { output: result, exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch };

    }, signal);

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

      if (context.consentGrant) {

        await tx.update(appExperienceConsentGrants).set({ revoked_at: this.clock(), epoch: context.consentGrant.epoch + 1 })

          .where(and(eq(appExperienceConsentGrants.org_id, caller.org_id), eq(appExperienceConsentGrants.id, context.consentGrant.id),

            isNull(appExperienceConsentGrants.revoked_at)));

      } else if (context.exposure) await this.revokeRow(tx, context.exposure);

      await tx.update(appExperienceSessions).set({ revoked_at: this.clock() }).where(and(eq(appExperienceSessions.org_id, caller.org_id),

        eq(appExperienceSessions.id, sessionId), isNull(appExperienceSessions.revoked_at)));

      await this.final(tx, caller, context, signal);

      return { revoked: true as const };

    }, signal);

  }



  /** Host-only locator for the existing owner viewer; never a Worker payload. */

  async resourceTarget(caller: ExperienceCaller, sessionId: string, key: string, raw: unknown, signal?: AbortSignal) {

    this.enabled(caller, signal); resourceKey.parse(key);

    const input = z.strictObject({ record_id: uuid }).parse(raw);

    return this.repository.transaction(async tx => {

      const context = await this.locked(tx, caller, sessionId, false, signal);

      const snapshot = this.assertStored(context);

      const resource = snapshot.resources.find(r => r.resource_key === key);

      const authority = context.authorities.find(a => a.binding.resource_key === key);

      const checkpoint = authority && context.checkpoints.find(c => c.resource_binding_id === authority.binding.id);

      if (!isAppAttachmentBrokerEnabled() || context.verified.manifest.schema_version !== '7'

        || !resource?.allowed_operations.includes('read_one') || !authority || !checkpoint

        || authority.descriptor.schema_version !== 'deft.app_sync_descriptor.v2') throw exposureUnavailable();

      const [projection] = await tx.select({ id: appResourceProjections.id }).from(appResourceProjections).where(and(

        eq(appResourceProjections.org_id, caller.org_id), eq(appResourceProjections.id, input.record_id),

        eq(appResourceProjections.resource_binding_id, authority.binding.id), eq(appResourceProjections.checkpoint_id, checkpoint.id),

        eq(appResourceProjections.generation, checkpoint.generation), eq(appResourceProjections.state, 'live'))).limit(1).for('share');

      if (!projection) throw exposureUnavailable();

      await this.final(tx, caller, context, signal); this.assertStored(context);

      if (!isAppAttachmentBrokerEnabled()) throw exposureUnavailable();

      return { schema_version: 'deft.experience_resource_target.v1' as const,

        exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch,

        binding_id: authority.binding.id, record_id: projection.id };

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

      if (!resource.allowed_operations.some(operation => operation === input.operation)) throw exposureUnavailable();

      const cursor = input.operation === 'list_summary' && input.cursor

        ? ExposureCursorSchema.parse(openExposureToken(this.keys, 'cursor', input.cursor)) : null;

      const searchCursor = input.operation === 'search' && input.cursor

        ? ExposureSearchCursorSchema.parse(openExposureToken(this.keys, 'search_cursor', input.cursor)) : null;

      const continuation = cursor ?? searchCursor;

      // A renewed durable lease preserves exact permission identity. Continue

      // only until the original authenticated cursor deadline; never extend it.

      const cursorExpiry = context.consentGrant && continuation ? continuation.expires_at : exposure.expires_at.toISOString();

      if (continuation && (Date.parse(continuation.expires_at) <= this.clock().getTime()

        || Date.parse(continuation.expires_at) > exposure.expires_at.getTime()

        || (!context.consentGrant && continuation.expires_at !== exposure.expires_at.toISOString()))) throw exposureUnavailable();

      const identity_scope_digest = exposureDigest({ org_id: caller.org_id, owner_user_id: caller.user_id,

        web_session_id: caller.sid, experience_session_id: sessionId, exposure_id: exposure.id,

        exposure_epoch: exposure.exposure_epoch, resource_key: key, binding_id: authority.binding.id,

        expires_at: cursorExpiry });

      const checkpoint_scope_digest = exposureDigest({ checkpoint_id: checkpoint.id,

        generation: checkpoint.generation, cursor_sequence: checkpoint.cursor_sequence });

      if (cursor && cursor.identity_scope_digest !== identity_scope_digest) throw exposureUnavailable();

      if (cursor && cursor.checkpoint_scope_digest !== checkpoint_scope_digest) {

        throw new ExperienceExposureError('RESOURCE_CURSOR_STALE', 409);

      }

      const rows = input.operation === 'search' ? [] : await tx.select().from(appResourceProjections).where(and(eq(appResourceProjections.org_id, caller.org_id),

        eq(appResourceProjections.resource_binding_id, authority.binding.id), eq(appResourceProjections.checkpoint_id, checkpoint.id),

        eq(appResourceProjections.generation, checkpoint.generation), eq(appResourceProjections.state, 'live'),

        input.operation === 'read_one' ? eq(appResourceProjections.id, input.record_id) : cursor ? gt(appResourceProjections.id, cursor.after) : undefined))

        .orderBy(asc(appResourceProjections.id)).limit(input.operation === 'read_one' ? 1 : (input.limit ?? 10) + 1);

      const decode = (row: typeof appResourceProjections.$inferSelect) => {

        signal?.throwIfAborted();

        const descriptor = authority.descriptor.schema_version === 'deft.app_sync_descriptor.v2'

          ? (() => { const { attachments: _policy, ...scalar } = authority.descriptor;

            return { ...scalar, schema_version: 'deft.app_sync_descriptor.v1' as const }; })()

          : authority.descriptor;

        const parsed = decodePrivateProjection(this.secrets, row, descriptor);

        return { record_id: row.id, label: label(String(parsed.data[authority.descriptor.label_field] ?? '')), data: parsed.data };

      };

      let output: unknown;

      if (input.operation === 'read_one') {

        const transient = !rows[0] ? experienceProviderHandles.read<ProviderSourceRecord>(this.keys,

          providerHandleScope(snapshot, context, key), 'source', input.record_id) : null;

        if (!rows[0] && !transient) throw exposureUnavailable();

        const item = rows[0] ? decode(rows[0]) : { record_id: input.record_id, label: transient!.label, data: transient!.data };

        output = { schema_version: PAYLOAD_VERSION, operation: 'read_one', item: { ...item,

          data: exposurePayloadData(item.data, resource.allowed_fields), freshness: 'unknown' } };

      } else if (input.operation === 'search') {

        if ((snapshot.schema_version !== SEARCH_EXPOSURE_VERSION && snapshot.schema_version !== STATE_EXPOSURE_VERSION) || context.verified.bundle.schema_version === 'deft.experience_bundle.v1'

          || !context.verified.bundle.search_resource_keys?.includes(key)) throw exposureUnavailable();

        const fields = [...input.field_keys].sort();

        if (fields.some(field => !resource.allowed_fields.includes(field))) throw exposureUnavailable();

        const query_fields_scope_digest = exposureDigest({ query: input.query, fields });

        const searchIdentity = exposureDigest({ identity_scope_digest, artifact_digest: context.session.artifact_digest, review_digest: exposure.review_digest });

        if (searchCursor && (searchCursor.identity_scope_digest !== searchIdentity

          || searchCursor.query_fields_scope_digest !== query_fields_scope_digest)) throw exposureUnavailable();

        if (searchCursor && searchCursor.checkpoint_scope_digest !== checkpoint_scope_digest)

          throw new ExperienceExposureError('RESOURCE_CURSOR_STALE', 409);

        const needle = input.query.toLowerCase(), deadline = performance.now() + 3000;

        const check = () => { signal?.throwIfAborted(); if (performance.now() >= deadline || Date.parse(cursorExpiry) <= this.clock().getTime()) throw exposureUnavailable(); };

        const scan = await scanPrivateResourceCheckpoint(tx,

          { org_id: caller.org_id, binding_id: authority.binding.id, checkpoint_id: checkpoint.id, generation: checkpoint.generation },

          { after: searchCursor?.after, max_items: 10, check, unavailable: exposureUnavailable,

            decodeMatch: row => {

              const item = decode(row);

              for (const field of fields) {

                const scalar = item.data[field];

                if (scalar === undefined) continue;

                const text = String(scalar), at = text.toLowerCase().indexOf(needle);

                if (at >= 0) return { record_id: item.record_id, label: item.label,

                  snippet: text.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 240), field_key: field };

              }

              return undefined;

            } });

        const next_cursor = !scan.complete && scan.after ? sealExposureToken(this.keys, 'search_cursor', {

          schema_version: 'deft.experience_resource_search_cursor.v1', identity_scope_digest: searchIdentity, checkpoint_scope_digest,

          query_fields_scope_digest, after: scan.after, expires_at: cursorExpiry }) : null;

        if (!scan.complete && !next_cursor) throw exposureUnavailable();

        output = { schema_version: 'deft.experience_resource_search_page.v1', operation: 'search', items: scan.items,

          scan: { records_scanned: scan.scanned, complete: scan.complete }, next_cursor, freshness: 'unknown' };

      } else {

        const limit = input.limit ?? 10;

        const items = rows.slice(0, limit).map(row => { const item = decode(row); return { record_id: item.record_id, label: item.label }; });

        const last = rows[Math.min(rows.length, limit) - 1];

        const next_cursor = rows.length > limit && last ? sealExposureToken(this.keys, 'cursor', {

          schema_version: 'deft.experience_resource_cursor.v1', identity_scope_digest, checkpoint_scope_digest,

          after: last.id, expires_at: cursorExpiry }) : null;

        output = { schema_version: PAYLOAD_VERSION, operation: 'list_summary', items, next_cursor, freshness: 'unknown' };

      }

      // Reserve the full bridge overhead with maximal allowed request/session IDs.

      const envelope = { version: 'deft.experience_bridge.v1', kind: 'response', session_id: sessionId,

        request_id: `request_${'9'.repeat(56)}`, ok: true, output };

      if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > EXPOSURE_LIMITS.envelope_bytes) throw new ExperienceExposureError('RESOURCE_PAYLOAD_TOO_LARGE', 413);

      await this.final(tx, caller, context, signal);

      if (Date.parse(cursorExpiry) <= this.clock().getTime()) throw exposureUnavailable();

      return { exposure_id: exposure.id, exposure_epoch: exposure.exposure_epoch, output };

    }, signal);

    signal?.throwIfAborted(); return result;

  }

}

type Context = Awaited<ReturnType<AppExperienceExposureService['locked']>>;

function providerHandleScope(snapshot: ExposureSnapshot, context: Context, key: string) {

  const resource = snapshot.resources.find(item => item.resource_key === key);

  if (!resource) throw exposureUnavailable();

  return exposureDigest({ org_id: snapshot.org_id, owner_user_id: snapshot.owner_user_id, web_session_id: snapshot.web_session_id,

    experience_session_id: snapshot.experience_session_id, installation_id: snapshot.installation_id,

    app_version_id: snapshot.app_version_id, grant_snapshot_id: snapshot.grant_snapshot_id, artifact_digest: snapshot.artifact_digest,

    lifecycle_epoch: snapshot.lifecycle_epoch, grant_epoch: snapshot.grant_epoch, target_key: context.session.resource_target_key,

    exposure_id: context.exposure!.id, exposure_epoch: context.exposure!.exposure_epoch, resource,

    consent_digest: context.authorities.find(item => item.binding.resource_key === key)?.binding.attachment_consent_digest,

    limits: (() => { const binding = context.authorities.find(item => item.binding.resource_key === key)!.binding;

      return [binding.max_records_per_page, binding.max_page_bytes, binding.max_retained_records, binding.max_retained_bytes]; })() });

}



function privateSourceResource(context: Context, ref: PrivateStateSourceReference) {

  const manifest = context.verified.manifest, bundle = context.verified.bundle;

  if (manifest.schema_version !== '7' || !bundle.action_keys.includes(ref.action_key)) throw exposureUnavailable();

  const action = manifest.runtime_actions.find(item => item.key === ref.action_key);

  const capability = action && manifest.private_capabilities.find(item => item.key === action.capability_key);

  const field = capability ? RuntimeObjectSchema.parse(capability.input_schema).properties[ref.input_field] : undefined;

  if (!field || field.type !== 'string' || field.format !== 'resource_record_list' || !field.readOnly || !field.resourceKey) throw exposureUnavailable();

  return field.resourceKey;

}

function privateSourceScope(snapshot: ExposureSnapshot, context: Context, ref: PrivateStateSourceReference & {resource_key: string}) {

  if (privateSourceResource(context,ref) !== ref.resource_key) throw exposureUnavailable();

  const resource = snapshot.resources.find(item => item.resource_key === ref.resource_key);

  const authority = context.authorities.find(item => item.binding.resource_key === ref.resource_key);

  if (!resource?.allowed_operations.includes('read_one') || !authority) throw exposureUnavailable();

  return exposureDigest({org_id:snapshot.org_id,owner_user_id:snapshot.owner_user_id,installation_id:snapshot.installation_id,

    app_version_id:snapshot.app_version_id,grant_snapshot_id:snapshot.grant_snapshot_id,artifact_digest:snapshot.artifact_digest,

    lifecycle_epoch:snapshot.lifecycle_epoch,grant_epoch:snapshot.grant_epoch,target_key:context.session.resource_target_key,

    resource,consent_digest:authority.binding.attachment_consent_digest,

    action_key:ref.action_key,input_field:ref.input_field,field:ref.field,record_id:ref.record_id});

}
