import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appInstallations, appVersions, appGrantSnapshots, appPrivateStateRecords } from '@deft/db/schema';
import { canonicalCapabilityJson } from '@deft/shared';
import { parseAttachmentAppManifest } from '@deft/app-kit';
import { AppExperienceExposureService } from './app-experience-exposure.js';
import { verifiedExperienceBundle, type ExperienceCaller } from './app-experience-service.js';
import { exposureDigest } from './app-experience-exposure-contract.js';
import { buildAttachmentAppReviewedAuthority, ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION } from './app-attachment-authority.js';
import { buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';
import { AppPrivateStateSecrets } from './app-private-state-secrets.js';
import { privateStateValue, assertPrivateStateQuota } from './app-private-state-contract.js';
import { samplePrivateAccessClock } from './app-private-access-clock.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppError } from './app-errors.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PrivateStateAdoptionReviewRequest = z.strictObject({ source_artifact_digest: digest });
export const PrivateStateAdoptionActivateRequest = PrivateStateAdoptionReviewRequest.extend({
  review_token: z.string().min(1).max(24000), accept_owner_adoption: z.literal(true) });
const stale = () => new AppError('Private state adoption changed or is unavailable', 'APP_STALE', 409);

/** Host-only, explicit adoption. The author bridge never receives this authority. */
export class AppPrivateStateAdoptionService {
  private readonly secrets: AppPrivateStateSecrets;
  constructor(private readonly keys: AppRunKeyProvider, private readonly exposure = new AppExperienceExposureService(keys),
    private readonly clock: () => Date = () => new Date()) { this.secrets = new AppPrivateStateSecrets(keys); }
  private sign(value: unknown, keyId?: string) {
    const key = keyId ? this.keys.read('receipt_signing', keyId) : this.keys.current('receipt_signing');
    if (!key) throw stale();
    try { return { key_id: key.key_id, mac: createHmac('sha256', key.key)
      .update(canonicalCapabilityJson(['deft.private_state.adoption_review.v1', value])).digest('base64url') }; }
    finally { key.key.fill(0); }
  }
  async request(caller: ExperienceCaller, sessionId: string, stateKey: string, operation: 'context' | 'review' | 'activate',
    raw: unknown, signal?: AbortSignal) {
    const request = operation === 'context' ? z.strictObject({}).parse(raw) : operation === 'review'
      ? PrivateStateAdoptionReviewRequest.parse(raw) : PrivateStateAdoptionActivateRequest.parse(raw);
    return this.exposure.withPrivateState(caller, sessionId, stateKey, async (tx, authority) => {
      const initialClock = await samplePrivateAccessClock(tx, this.clock), now = initialClock.current();
      const declarationDigest = exposureDigest(authority.declaration);
      const scope = and(eq(appPrivateStateRecords.org_id, caller.org_id), eq(appPrivateStateRecords.owner_user_id, caller.user_id),
        eq(appPrivateStateRecords.installation_id, authority.installation_id), eq(appPrivateStateRecords.state_key, stateKey));
      const rows = await tx.select().from(appPrivateStateRecords).where(and(scope,
        sql`${appPrivateStateRecords.deleted_at} IS NULL AND ${appPrivateStateRecords.expires_at}>${now}`))
        .orderBy(asc(appPrivateStateRecords.record_id)).limit(33);
      if (rows.length > 32) throw stale();
      const session = authority.session;
      const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, caller.org_id),
        eq(appInstallations.id, authority.installation_id))).limit(1);
      const exposure = authority.exposure;
      if (!session || !installation || !exposure) throw stale();
      let deadline = Math.min(session.expires_at.getTime(), exposure.expires_at.getTime(), caller.access_expires_at ?? Infinity,
        now.getTime() + 300000, ...rows.map(row => row.expires_at.getTime()));
      authority.onFinalCheck(async () => { const finalClock = await samplePrivateAccessClock(tx, this.clock);
        if (Math.max(finalClock.current().getTime(), initialClock.current().getTime()) >= deadline) throw stale(); });
      authority.onDeliveryCheck(() => { if (initialClock.current().getTime() >= deadline) throw stale(); });
      const sources = [...new Set(rows.filter(row => row.artifact_digest !== authority.artifact_digest
        && row.declaration_digest === declarationDigest).map(row => row.artifact_digest))];
      const groups = [];
      for (const source of sources) {
        // Bounded candidate lookup by declared artifact, never a full version history read.
        const candidates = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, caller.org_id),
          eq(appVersions.installation_id, authority.installation_id), eq(appVersions.protocol_version, '7'),
          sql`${appVersions.state} IN ('active','superseded')`,
          sql`${appVersions.manifest}->'experiences' @> ${JSON.stringify([{ artifact_digest: source }])}::jsonb`)).limit(2);
        const version = candidates[0];
        if (!version) continue;
        const manifest = parseAttachmentAppManifest(version.manifest);
        if (!manifest.private_state?.some(item => item.key === stateKey && exposureDigest(item) === declarationDigest)) continue;
        const reference = manifest.experiences.find(item => item.artifact_digest === source);
        if (!reference) continue;
        await verifiedExperienceBundle(version, reference.key);
        const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, caller.org_id),
          eq(appGrantSnapshots.app_installation_id, authority.installation_id), eq(appGrantSnapshots.app_version_id, version.id),
          eq(appGrantSnapshots.snapshot_kind, 'effective'))).limit(1);
        const expected = buildAttachmentAppReviewedAuthority(manifest, { lineage_key: installation.lineage_key,
          package_digest: version.package_digest, manifest_digest: version.manifest_digest }, true);
        const [requested] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, caller.org_id),
          eq(appGrantSnapshots.app_installation_id, authority.installation_id), eq(appGrantSnapshots.app_version_id, version.id),
          eq(appGrantSnapshots.id, version.requested_grant_snapshot_id ?? ''), eq(appGrantSnapshots.snapshot_kind, 'requested'))).limit(1);
        if (!grant || !requested || grant.requested_snapshot_id !== requested.id) continue;
        const projection = buildRequestedAppGrantProjection({ organization_id: caller.org_id, app_installation_id: authority.installation_id,
          app_version_id: version.id, manifest, manifest_digest: version.manifest_digest, package_digest: version.package_digest });
        const canonical = { ...expected, organization_id: caller.org_id, app_installation_id: authority.installation_id,
          app_version_id: version.id, requested_snapshot_id: requested.id, requested_snapshot_digest: requested.snapshot_digest,
          classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, review_digest: grant.canonical_snapshot.review_digest };
        if (digestAppGrantValue(projection.canonical_snapshot) !== requested.snapshot_digest
          || digestAppGrantValue(requested.canonical_snapshot) !== requested.snapshot_digest
          || digestAppGrantValue(canonical) !== grant.snapshot_digest || digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest) continue;
        const records = rows.filter(row => row.artifact_digest === source && row.declaration_digest === declarationDigest);
        groups.push({ source_artifact_digest: source, source_app_version_id: version.id, source_version: manifest.version, count: records.length,
          records: records.map(row => ({ record_id: row.record_id, revision: row.revision, byte_length: row.byte_length,
            created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString() })) });
      }
      if (operation === 'context') return { schema_version: 'deft.private_state.adoption_context.v1', groups };
      if (!('source_artifact_digest' in request)) throw stale();
      const group = groups.find(item => item.source_artifact_digest === request.source_artifact_digest);
      if (!group) throw stale();
      const pins = { organization_id: caller.org_id, owner_user_id: caller.user_id, web_session_id: caller.sid,
        experience_session_id: sessionId, installation_id: authority.installation_id, state_key: stateKey,
        app_version_id: session.app_version_id, grant_snapshot_id: session.grant_snapshot_id,
        exposure_id: exposure.id, exposure_epoch: exposure.exposure_epoch, exposure_review_digest: exposure.review_digest,
        lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch,
        target_artifact_digest: authority.artifact_digest, declaration_digest: declarationDigest, ...group };
      if (operation === 'review') {
        deadline = Math.min(deadline, ...group.records.map(item => Date.parse(item.expires_at)));
        const value = { pins, expires_at: new Date(deadline).toISOString() }, signature = this.sign(value);
        const review_token = Buffer.from(JSON.stringify({ value, ...signature })).toString('base64url');
        return { schema_version: 'deft.private_state.adoption_review.v1', ...pins, expires_at: value.expires_at, review_token };
      }
      if (!('review_token' in request)) throw stale();
      const decoded = Buffer.from(request.review_token, 'base64url');
      if (decoded.toString('base64url') !== request.review_token) throw stale();
      let token: { value: { pins: unknown; expires_at: string }; key_id: string; mac: string };
      try { token = z.strictObject({ value: z.strictObject({ pins: z.unknown(), expires_at: z.string().datetime() }),
        key_id: z.string().max(128), mac: z.string().max(128) }).parse(JSON.parse(decoded.toString('utf8'))); }
      catch { throw stale(); }
      const actual = Buffer.from(token.mac), expected = Buffer.from(this.sign(token.value, token.key_id).mac);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
        || exposureDigest(token.value.pins) !== exposureDigest(pins)) throw stale();
      deadline = Math.min(deadline, Date.parse(token.value.expires_at), ...group.records.map(item => Date.parse(item.expires_at)));
      if (now.getTime() >= deadline) throw stale();
      let totalBytes = rows.reduce((total, row) => total + row.byte_length, 0);
      for (const metadata of group.records) {
        const row = rows.find(item => item.record_id === metadata.record_id)!;
        const context = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: authority.installation_id,
          state_key: stateKey, record_id: row.record_id, artifact_digest: row.artifact_digest,
          declaration_digest: declarationDigest, revision: row.revision };
        let checked: ReturnType<typeof privateStateValue>;
        try { checked = privateStateValue(authority.declaration, this.secrets.open(context, row.body)); } catch { throw stale(); }
        if (row.revision >= 2147483647) throw stale();
        totalBytes = totalBytes - row.byte_length + checked.bytes;
        assertPrivateStateQuota(rows.length, totalBytes, authority.declaration);
        const revision = row.revision + 1;
        const body = this.secrets.seal({ ...context, artifact_digest: authority.artifact_digest, revision }, checked.value);
        await tx.update(appPrivateStateRecords).set({ artifact_digest: authority.artifact_digest, revision, body,
          key_version: body.key_version, byte_length: checked.bytes, updated_at: now })
          .where(and(scope, eq(appPrivateStateRecords.record_id, row.record_id), eq(appPrivateStateRecords.revision, row.revision)));
      }
      return { schema_version: 'deft.private_state.adoption_activated.v1', adopted_count: group.count };
    }, signal);
  }
}
