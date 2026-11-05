import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { appConnectionSessions, appDataConsents, appResourceObservationConsents, appIntegrationCapturePolicies, auditLog, appRestoreAccessReviews } from '@deft/db/schema';
import { AppConnectionActionConsentSchema, AppDataConsentSnapshotSchema, ResourceObservationSnapshotSchema,
  type AppConnectionActionConsent } from '@deft/app-kit/core';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import { appDataDigest } from './app-data-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { appIntegrationSourceDigest } from './app-integration-source.js';
import { enqueueOrRearmFailed, QUEUE_NAMES } from './queues.js';
import { APP_INTEGRATION_CAPTURE_JOB } from './app-integration-capture-authority.js';
import { enumerateRestoreAccess, restoreAccountMatches, RestoreGrantSchema,
  type RestoreAccessDatabase, type RestoreAccessTransaction, type RestoreGrant,
  type RestoreGrantKind, type RestoreLifetime } from './app-restore-access-context.js';
import { restoreAccessReviewDigest, restoreAccessDenied, restoreAccessSameAccountRequired,
  restoreAccessReviewWindow, RESTORE_ACCESS_REVIEW_SCHEMA_VERSION, RESTORE_ACCESS_ACTIVATE_SCHEMA_VERSION,
  type AppRestoreAccessPorts } from './app-restore-access-authority.js';
import type { ExperienceCaller } from './app-experience-service.js';

const RESTORE_AUDIT_ACTION = 'app_restore_access_activate';
const REVIEW_EXPIRES_MS = 5 * 60_000;

const ReviewRequestSchema = z.strictObject({
  installation_id: z.string().uuid(),
  target_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
});
const ActivateRequestSchema = z.strictObject({
  review_id: z.string().uuid(),
  review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  review_expires_at: z.iso.datetime(),
  installation_id: z.string().uuid(),
  target_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
  /** §5.2 narrowing only: a chosen subset of the digest-bound restorable set.
   * Omission re-issues only the review's preselected items. */
  grant_ids: z.array(z.string().uuid()).max(64).optional(),
});

export type RestoreGrantHandler = (context: {
  transaction: RestoreAccessTransaction;
  actor: ExperienceCaller;
  record: AppConnectionSessionRecord;
  grant: RestoreGrant;
  now: number;
  reservedActionKeys: Set<string>;
}) => Promise<{ new_grant_id: string; action_consent?: AppConnectionActionConsent; outcome?: 'issued' | 'already_present' }>;

type ReissuedGrant = { kind: RestoreGrantKind; original_grant_id: string; new_grant_id: string; outcome?: 'issued' | 'already_present' };

/** Replay the original lifetime, never widened. `until_revoked` is preserved
 * only while the reconnected connection itself is still indefinite; otherwise
 * the grant narrows to the connection's remaining consent. */
function reissuedExpiry(lifetime: RestoreLifetime, scope: AppConnectionSessionRecord['scope'], now: number):
  { expires_at: Date | null; consent_lifetime?: 'until_revoked' } {
  const indefinite = scope.consent_lifetime === 'until_revoked' && scope.consent_expires_at === null;
  const ceiling = indefinite ? Infinity : (scope.consent_expires_at === null ? NaN : Date.parse(scope.consent_expires_at));
  if (!indefinite && Number.isNaN(ceiling)) throw restoreAccessDenied();
  if (lifetime.kind === 'until_revoked') {
    if (indefinite) return { expires_at: null, consent_lifetime: 'until_revoked' };
    return { expires_at: new Date(ceiling) };
  }
  return { expires_at: new Date(Math.min(now + lifetime.seconds * 1000, ceiling)) };
}

function reviewedSnapshotExpiry(expiry: { expires_at: Date | null; consent_lifetime?: 'until_revoked' }, now: number) {
  return expiry.consent_lifetime
    ? { expires_at: null, consent_lifetime: 'until_revoked' as const, review_expires_at: new Date(now + REVIEW_EXPIRES_MS).toISOString() }
    : { expires_at: expiry.expires_at!.toISOString() };
}

function reissuedConnection(record: AppConnectionSessionRecord) {
  return {
    session_id: record.session_id,
    session_revision: record.revision,
    runtime_session_ref: record.runtime_session_ref!,
    account_ref: record.account!.account_ref,
  };
}

/** App-neutral grant-kind registry (§5.5). Every enumerated kind has exactly one
 * handler; unknown kinds are refused rather than partially applied. */
export const RESTORE_GRANT_HANDLERS: ReadonlyMap<RestoreGrantKind, RestoreGrantHandler> = new Map([
  ['record_consent', async ({ transaction, actor, record, grant, now }) => {
    if (!grant.store_key) throw restoreAccessDenied();
    const [original] = await transaction.select().from(appDataConsents).where(and(
      eq(appDataConsents.org_id, actor.org_id), eq(appDataConsents.owner_user_id, actor.user_id),
      eq(appDataConsents.consent_id, grant.grant_id))).for('update').limit(1);
    if (!original) throw restoreAccessDenied();
    const originalSnapshot = AppDataConsentSnapshotSchema.parse(original.snapshot);
    // The reconnected account must still expose the same resource capability.
    if (originalSnapshot.store.resource_key !== record.scope.resource_key) throw restoreAccessDenied();
    const newId = randomUUID();
    const expiry = reissuedExpiry(grant.lifetime, record.scope, now);
    const snapshot = AppDataConsentSnapshotSchema.parse({
      schema_version: 'deft.app_data_consent.v1',
      consent_id: newId,
      scope: record.scope,
      connection: reissuedConnection(record),
      store: originalSnapshot.store,
      data_policy_digest: originalSnapshot.data_policy_digest,
      purpose: 'human_record_write',
      ...reviewedSnapshotExpiry(expiry, now),
    });
    await transaction.insert(appDataConsents).values({
      org_id: actor.org_id, owner_user_id: actor.user_id, consent_id: newId,
      connection_session_id: record.session_id, store_key: original.store_key, state: 'proposed',
      consent_digest: appDataDigest(snapshot), snapshot, expires_at: expiry.expires_at,
      created_at: new Date(now), updated_at: new Date(now),
    });
    // Review then activate through the same proposed -> active lifecycle the
    // normal consent flow uses; the database guard rejects a direct active insert.
    await transaction.update(appDataConsents).set({ state: 'active', updated_at: new Date(now) }).where(and(
      eq(appDataConsents.org_id, actor.org_id), eq(appDataConsents.owner_user_id, actor.user_id),
      eq(appDataConsents.consent_id, newId), eq(appDataConsents.state, 'proposed')));
    // Soft-transition the prior row; history stays queryable for audit.
    await transaction.update(appDataConsents).set({ state: 'revoked', updated_at: new Date(now) }).where(and(
      eq(appDataConsents.org_id, actor.org_id), eq(appDataConsents.owner_user_id, actor.user_id),
      eq(appDataConsents.consent_id, grant.grant_id)));
    return { new_grant_id: newId };
  }],
  ['observation_consent', async ({ transaction, actor, record, grant, now }) => {
    if (!grant.resource_binding_id) throw restoreAccessDenied();
    const [original] = await transaction.select().from(appResourceObservationConsents).where(and(
      eq(appResourceObservationConsents.org_id, actor.org_id),
      eq(appResourceObservationConsents.owner_user_id, actor.user_id),
      eq(appResourceObservationConsents.consent_id, grant.grant_id))).for('update').limit(1);
    if (!original) throw restoreAccessDenied();
    const originalSnapshot = ResourceObservationSnapshotSchema.parse(original.snapshot);
    if (original.resource_binding_id !== record.scope.resource_binding_id) throw restoreAccessDenied();
    // The unique-active index allows one active row per binding: revoke the
    // prior active rows BEFORE inserting the replacement.
    await transaction.update(appResourceObservationConsents).set({ state: 'revoked', updated_at: new Date(now) }).where(and(
      eq(appResourceObservationConsents.org_id, actor.org_id),
      eq(appResourceObservationConsents.owner_user_id, actor.user_id),
      eq(appResourceObservationConsents.resource_binding_id, original.resource_binding_id),
      eq(appResourceObservationConsents.state, 'active')));
    const newId = randomUUID();
    const expiry = reissuedExpiry(grant.lifetime, record.scope, now);
    const snapshot = ResourceObservationSnapshotSchema.parse({
      schema_version: 'deft.app_resource_observation_consent.v1',
      consent_id: newId,
      scope: record.scope,
      connection: {
        session_id: record.session_id,
        runtime_session_ref: record.runtime_session_ref,
        account_ref: record.account!.account_ref,
        expected_custody_generation: originalSnapshot.connection.expected_custody_generation,
        receipt_digest: originalSnapshot.connection.receipt_digest,
      },
      resource_policy_digest: originalSnapshot.resource_policy_digest,
      interval_seconds: originalSnapshot.interval_seconds,
      ...reviewedSnapshotExpiry(expiry, now),
    });
    await transaction.insert(appResourceObservationConsents).values({
      org_id: actor.org_id, owner_user_id: actor.user_id, consent_id: newId,
      resource_binding_id: original.resource_binding_id, connection_session_id: record.session_id, state: 'proposed',
      consent_digest: digestAppGrantValue(snapshot), snapshot, expires_at: expiry.expires_at,
      created_at: new Date(now), updated_at: new Date(now),
    });
    // Review then activate through the same proposed -> active lifecycle the
    // normal consent flow uses; the database guard rejects a direct active insert.
    await transaction.update(appResourceObservationConsents).set({ state: 'active', updated_at: new Date(now) }).where(and(
      eq(appResourceObservationConsents.org_id, actor.org_id), eq(appResourceObservationConsents.owner_user_id, actor.user_id),
      eq(appResourceObservationConsents.consent_id, newId), eq(appResourceObservationConsents.state, 'proposed')));
    return { new_grant_id: newId };
  }],
  ['action_consent', async ({ record, grant, now, reservedActionKeys }) => {
    if (!grant.action_key) throw restoreAccessDenied();
    // The reconnected provider must still carry the reviewed action capability.
    if (!record.profile.action_keys.includes(grant.action_key)) throw restoreAccessDenied();
    if (reservedActionKeys.has(grant.action_key)) throw restoreAccessDenied();
    reservedActionKeys.add(grant.action_key);
    const consentId = randomUUID();
    const expiry = reissuedExpiry(grant.lifetime, record.scope, now);
    const expiresAt = expiry.expires_at ? expiry.expires_at.toISOString() : null;
    const consent = AppConnectionActionConsentSchema.parse({
      action_binding_id: consentId,
      action_key: grant.action_key,
      authority_epoch: record.scope.lifecycle_epoch,
      consent_id: consentId,
      consent_digest: digestAppGrantValue({
        action_key: grant.action_key, authority_epoch: record.scope.lifecycle_epoch,
        consent_id: consentId, expires_at: expiresAt,
        ...(expiry.consent_lifetime ? { consent_lifetime: 'until_revoked' as const } : {}),
      }),
      expires_at: expiresAt,
      ...(expiry.consent_lifetime ? { consent_lifetime: 'until_revoked' as const } : {}),
    });
    return { new_grant_id: consentId, action_consent: consent };
  }],
  ['capture_policy', async ({ transaction, actor, grant, now }) => {
    if (!grant.store_key) throw restoreAccessDenied();
    const [original] = await transaction.select().from(appIntegrationCapturePolicies).where(and(
      eq(appIntegrationCapturePolicies.org_id, actor.org_id),
      eq(appIntegrationCapturePolicies.owner_user_id, actor.user_id),
      eq(appIntegrationCapturePolicies.id, grant.grant_id))).for('update').limit(1);
    if (!original) throw restoreAccessDenied();
    // §5.1 guarantees the reconnected account keeps its reference, so the
    // carried-over policy is re-enabled in place: clear the grant-ended
    // retirement, keep the input/history, and bump the revision so the next
    // delivery is a fresh, opted-in capture policy. The old row is never left
    // enabled under a stale reference — retirement (§3.2) already handled that.
    const revision = original.revision + 1;
    await transaction.update(appIntegrationCapturePolicies).set({
      enabled: true, revision, retired_at: null, retired_reason: null, last_error: null, updated_at: new Date(now),
    }).where(and(
      eq(appIntegrationCapturePolicies.org_id, actor.org_id),
      eq(appIntegrationCapturePolicies.owner_user_id, actor.user_id),
      eq(appIntegrationCapturePolicies.id, grant.grant_id)));
    await enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS, APP_INTEGRATION_CAPTURE_JOB, { policy_id: original.id, policy_revision: revision }, {
      orgId: actor.org_id, dedupeKey: appIntegrationSourceDigest([APP_INTEGRATION_CAPTURE_JOB, original.id, revision]), maxAttempts: 5, executor: transaction,
    });
    return { new_grant_id: original.id };
  }],
  ['agent_policy_default', async ({ transaction, actor, record, grant }) => {
    // Review-time default: seed require_approval (never auto-allow) for one
    // agent-nominable action key. Deny stays the implicit default; a prior human
    // choice is never overwritten, and no row is written for actions the
    // reconnected provider no longer exposes.
    if (!grant.action_key) throw restoreAccessDenied();
    const binding = await transaction.execute(sql`SELECT id FROM app_runtime_bindings
      WHERE org_id=${actor.org_id} AND app_installation_id=${record.scope.installation_id}
        AND owner_resource_binding_id=${record.scope.resource_binding_id} AND action_key=${grant.action_key} AND state='active'
      LIMIT 1 FOR UPDATE`);
    const bindingId = binding.rows[0]?.id;
    if (!bindingId) throw restoreAccessDenied();
    const inserted = await transaction.execute(sql`INSERT INTO app_runtime_agent_policies(org_id,owner_user_id,runtime_binding_id,mode,revision)
      VALUES(${actor.org_id},${actor.user_id},${bindingId},'require_approval',1)
      ON CONFLICT (org_id,owner_user_id,runtime_binding_id) DO NOTHING RETURNING runtime_binding_id`);
    const alreadyPresent = inserted.rows.length === 0;
    return { new_grant_id: String(bindingId), outcome: alreadyPresent ? 'already_present' : 'issued' };
  }],
  ['defty_read_grant', async ({ transaction, actor, record, grant, now }) => {
    // Review-time default: a read-only Defty delegation (never draft/send),
    // lifetime capped by the session consent like every other re-issued grant.
    if (!grant.store_key || !record.account) throw restoreAccessDenied();
    const expiry = reissuedExpiry(grant.lifetime, record.scope, now);
    if (!expiry.expires_at) throw restoreAccessDenied(); // the delegation is always finite
    const newId = randomUUID();
    const inserted = await transaction.execute(sql`INSERT INTO app_integration_principal_grants(id,org_id,owner_user_id,installation_id,resource_binding_id,account_ref,store_key,principal_kind,principal_id,operations,revision,expires_at)
      VALUES(${newId},${actor.org_id},${actor.user_id},${record.scope.installation_id},${record.scope.resource_binding_id},${record.account.account_ref},${grant.store_key},'defty',${actor.user_id},ARRAY['read']::text[],1,${expiry.expires_at})
      ON CONFLICT (org_id,owner_user_id,installation_id,account_ref,resource_binding_id,store_key,principal_kind,principal_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id`);
    if (inserted.rows.length === 0) {
      const existing = await transaction.execute(sql`SELECT id FROM app_integration_principal_grants
        WHERE org_id=${actor.org_id} AND owner_user_id=${actor.user_id} AND installation_id=${record.scope.installation_id}
          AND account_ref=${record.account.account_ref} AND resource_binding_id=${record.scope.resource_binding_id}
          AND store_key=${grant.store_key} AND principal_kind='defty' AND principal_id=${actor.user_id} AND revoked_at IS NULL
        LIMIT 1 FOR UPDATE`);
      const existingId = existing.rows[0]?.id;
      if (!existingId) throw restoreAccessDenied();
      return { new_grant_id: String(existingId), outcome: 'already_present' };
    }
    return { new_grant_id: newId, outcome: 'issued' };
  }],
]);

/** Two-phase restore review. `review` enumerates prior grants and returns a
 * signed, digest-bound envelope; `activate` re-issues the chosen subset in one
 * transaction, never widening any grant and soft-transitioning old rows. */
export class AppRestoreAccessService {
  constructor(private readonly ports: AppRestoreAccessPorts) {}

  private enumerate(actor: ExperienceCaller, nomination: { installation_id: string; target_key: string }) {
    return enumerateRestoreAccess(this.ports.database, actor, nomination, this.ports.now);
  }

  private assertAuthority(enumeration: Awaited<ReturnType<AppRestoreAccessService['enumerate']>>) {
    if (!enumeration.current_session_id) throw restoreAccessDenied();
    if (!restoreAccountMatches(enumeration)) {
      throw restoreAccessSameAccountRequired(enumeration.installation_id, enumeration.target_key);
    }
  }

  async review(actor: ExperienceCaller, raw: unknown) {
    const input = ReviewRequestSchema.parse(raw);
    const enumeration = await this.enumerate(actor, input);
    this.assertAuthority(enumeration);
    const issuedAt = this.ports.now();
    const review_id = randomUUID();
    const { review_expires_at } = restoreAccessReviewWindow(issuedAt);
    const review_digest = restoreAccessReviewDigest(enumeration, actor, review_expires_at);
    // The server stores the exact offered set. Activation resolves the review
    // by id and can never be revived by recomputing a caller-visible digest.
    await this.ports.database.insert(appRestoreAccessReviews).values({
      id: review_id, org_id: actor.org_id, owner_user_id: actor.user_id,
      installation_id: enumeration.installation_id, target_key: enumeration.target_key,
      session_id: enumeration.current_session_id!, account_ref: enumeration.current_account_ref!,
      offered_grants: enumeration.grants, review_digest,
      issued_at: new Date(issuedAt), expires_at: new Date(Date.parse(review_expires_at)),
      created_at: new Date(issuedAt), updated_at: new Date(issuedAt),
    });
    return {
      schema_version: RESTORE_ACCESS_REVIEW_SCHEMA_VERSION,
      review_id,
      review_digest,
      review_expires_at,
      installation_id: enumeration.installation_id,
      target_key: enumeration.target_key,
      account_ref: enumeration.current_account_ref,
      session_id: enumeration.current_session_id,
      grants: enumeration.grants,
    };
  }

  async activate(actor: ExperienceCaller, raw: unknown) {
    const input = ActivateRequestSchema.parse(raw);
    const activateNow = this.ports.now();

    // Resolve the stored review strictly within the authenticated tenant/owner.
    // An unknown, consumed, expired, or otherwise mismatched review is refused
    // before any grant is recomputed.
    const [stored] = await this.ports.database.select().from(appRestoreAccessReviews).where(and(
      eq(appRestoreAccessReviews.org_id, actor.org_id),
      eq(appRestoreAccessReviews.owner_user_id, actor.user_id),
      eq(appRestoreAccessReviews.id, input.review_id),
    )).limit(1);
    if (!stored || stored.consumed_at) throw restoreAccessDenied();
    if (stored.installation_id !== input.installation_id || stored.target_key !== input.target_key) throw restoreAccessDenied();
    if (stored.expires_at.getTime() !== Date.parse(input.review_expires_at)) throw restoreAccessDenied();
    if (stored.expires_at.getTime() <= activateNow) throw restoreAccessDenied();
    if (stored.review_digest !== input.review_digest) throw restoreAccessDenied();

    const enumeration = await this.enumerate(actor, { installation_id: input.installation_id, target_key: input.target_key });
    this.assertAuthority(enumeration);
    if (enumeration.current_session_id !== stored.session_id
      || enumeration.current_account_ref !== stored.account_ref) throw restoreAccessDenied();
    // Freshness: the current restorable set must still hash to the issued
    // digest, so a grant revoked or added after review cannot ride along.
    if (restoreAccessReviewDigest(enumeration, actor, stored.expires_at.toISOString()) !== stored.review_digest) {
      throw restoreAccessDenied();
    }

    const offered = RestoreGrantSchema.array().parse(stored.offered_grants);
    const offeredRestorable = new Map(offered.filter((grant) => grant.restorable).map((grant) => [grant.grant_id, grant]));
    const currentById = new Map(enumeration.grants.map((grant) => [grant.grant_id, grant]));
    // §5.2 narrowing only: every requested id must be in the digest-bound
    // restorable set. Omission means "the review's preselected items", never
    // the whole restorable set.
    const requested = new Set(input.grant_ids ?? offered
      .filter((grant) => grant.restorable && grant.preselected).map((grant) => grant.grant_id));
    for (const id of requested) {
      if (!offeredRestorable.has(id) || !currentById.get(id)?.restorable) throw restoreAccessDenied();
    }
    const selected = [...requested].map((id) => currentById.get(id)!);

    const reissued = await this.ports.database.transaction(async (transaction) => {
      // Re-run freshness inside the transaction, after the session row lock, so a
      // grant revoked between review and activate cannot be re-issued.
      const [currentRow] = await transaction.select().from(appConnectionSessions).where(and(
        eq(appConnectionSessions.org_id, actor.org_id),
        eq(appConnectionSessions.owner_user_id, actor.user_id),
        eq(appConnectionSessions.session_id, enumeration.current_session_id!),
      )).for('update').limit(1);
      if (!currentRow) throw restoreAccessDenied();
      const record = AppConnectionSessionRecordSchema.parse(currentRow.record);
      if (record.state !== 'connected' || !record.account || !record.runtime_session_ref) throw restoreAccessDenied();
      if (record.scope.installation_id !== stored.installation_id
        || record.scope.target_key !== stored.target_key
        || record.account.account_ref !== stored.account_ref) throw restoreAccessDenied();

      const freshEnumeration = await this.enumerate(actor, { installation_id: input.installation_id, target_key: input.target_key });
      this.assertAuthority(freshEnumeration);
      if (freshEnumeration.current_session_id !== stored.session_id
        || freshEnumeration.current_account_ref !== stored.account_ref) throw restoreAccessDenied();
      if (restoreAccessReviewDigest(freshEnumeration, actor, stored.expires_at.toISOString()) !== stored.review_digest) {
        throw restoreAccessDenied();
      }

      const freshCurrentById = new Map(freshEnumeration.grants.map((grant) => [grant.grant_id, grant]));
      const requestedNow = new Set(input.grant_ids ?? offered
        .filter((grant) => grant.restorable && grant.preselected).map((grant) => grant.grant_id));
      for (const id of requestedNow) {
        if (!offeredRestorable.has(id) || !freshCurrentById.get(id)?.restorable) throw restoreAccessDenied();
      }
      const selectedNow = [...requestedNow].map((id) => freshCurrentById.get(id)!);

      // Validate the scope before consuming the review.
      for (const grant of selectedNow) {
        if (grant.lifetime.kind === 'duration') {
          const indefinite = record.scope.consent_lifetime === 'until_revoked' && record.scope.consent_expires_at === null;
          if (!indefinite && (record.scope.consent_expires_at === null
            || Number.isNaN(Date.parse(record.scope.consent_expires_at)))) {
            throw restoreAccessDenied();
          }
        }
      }

      // Single use: consume the stored review exactly once. Done only after all
      // validation passes, so a refused activation leaves the review unconsumed.
      const consumed = await transaction.update(appRestoreAccessReviews).set({
        consumed_at: new Date(activateNow), updated_at: new Date(activateNow),
      }).where(and(
        eq(appRestoreAccessReviews.org_id, actor.org_id),
        eq(appRestoreAccessReviews.owner_user_id, actor.user_id),
        eq(appRestoreAccessReviews.id, stored.id),
        isNull(appRestoreAccessReviews.consumed_at),
      )).returning({ id: appRestoreAccessReviews.id });
      if (consumed.length !== 1) throw restoreAccessDenied();

      const now = this.ports.now();
      const reservedActionKeys = new Set((record.action_consents ?? []).map((consent) => consent.action_key));
      const issuedById = new Map<string, ReissuedGrant>();
      let workingRecord = record;

      const actionGrants = selectedNow.filter((grant) => grant.kind === 'action_consent');
      const actionConsents: AppConnectionActionConsent[] = [];
      for (const grant of actionGrants) {
        const handler = RESTORE_GRANT_HANDLERS.get(grant.kind);
        if (!handler) throw restoreAccessDenied();
        const issued = await handler({ transaction, actor, record, grant, now, reservedActionKeys });
        if (!issued.action_consent) throw restoreAccessDenied();
        actionConsents.push(issued.action_consent);
        issuedById.set(grant.grant_id, { kind: grant.kind, original_grant_id: grant.grant_id, new_grant_id: issued.new_grant_id, outcome: issued.outcome });
      }
      if (actionConsents.length) {
        workingRecord = await publishSuccessorSession(transaction, currentRow, record, actionConsents, now);
      }

      for (const grant of selectedNow) {
        if (grant.kind === 'action_consent') continue;
        const handler = RESTORE_GRANT_HANDLERS.get(grant.kind);
        if (!handler) throw restoreAccessDenied();
        const issued = await handler({ transaction, actor, record: workingRecord, grant, now, reservedActionKeys });
        issuedById.set(grant.grant_id, { kind: grant.kind, original_grant_id: grant.grant_id, new_grant_id: issued.new_grant_id, outcome: issued.outcome });
      }

      const result = selectedNow.map((grant) => issuedById.get(grant.grant_id)!);
      for (const item of result) {
        await transaction.insert(auditLog).values({
          id: randomUUID(), org_id: actor.org_id, actor_type: 'user', actor_id: actor.user_id,
          action: RESTORE_AUDIT_ACTION, entity_type: 'app_restore_access_grant', entity_id: item.new_grant_id,
          metadata: { restored_from_grant_id: item.original_grant_id, review_id: input.review_id, kind: item.kind, outcome: item.outcome ?? 'issued' },
          created_at: new Date(now),
        });
      }
      return { result, session_id: workingRecord.session_id };
    });

    return {
      schema_version: RESTORE_ACCESS_ACTIVATE_SCHEMA_VERSION,
      review_id: input.review_id,
      installation_id: enumeration.installation_id,
      target_key: enumeration.target_key,
      session_id: reissued.session_id,
      grants: reissued.result.map((item) => ({ kind: item.kind, original_grant_id: item.original_grant_id, grant_id: item.new_grant_id, outcome: item.outcome ?? 'issued' })),
    };

    return {
      schema_version: RESTORE_ACCESS_ACTIVATE_SCHEMA_VERSION,
      review_id: input.review_id,
      installation_id: enumeration.installation_id,
      target_key: enumeration.target_key,
      session_id: reissued.session_id,
      grants: reissued.result.map((item) => ({ kind: item.kind, original_grant_id: item.original_grant_id, grant_id: item.new_grant_id })),
    };
  }
}

/** Publish the successor session that carries restored action consents. The
 * original session's authority record is immutable, so the new authority is
 * admitted through the same `starting` -> `connected` lifecycle, with the
 * actions already present at admission and never rewritten afterwards. */
async function publishSuccessorSession(
  transaction: RestoreAccessTransaction,
  currentRow: typeof appConnectionSessions.$inferSelect,
  record: AppConnectionSessionRecord,
  actionConsents: readonly AppConnectionActionConsent[],
  now: number,
): Promise<AppConnectionSessionRecord> {
  const sessionId = randomUUID();
  const timestamp = new Date(now).toISOString();
  const combined = [...(record.action_consents ?? []), ...actionConsents]
    .sort((left, right) => left.action_key < right.action_key ? -1 : left.action_key > right.action_key ? 1 : 0);
  const restore = { schema_version: 'deft.app_connection_restore.v1' as const, source: { session_id: record.session_id } };
  const starting = AppConnectionSessionRecordSchema.parse({
    ...record, session_id: sessionId, revision: 0, state: 'starting', callback_consumed: false,
    action_consents: combined, created_at: timestamp, updated_at: timestamp,
    restore,
  });
  await transaction.insert(appConnectionSessions).values({
    org_id: currentRow.org_id, owner_user_id: currentRow.owner_user_id, session_id: sessionId,
    web_session_id: currentRow.web_session_id, access_expires_at: currentRow.access_expires_at,
    revision: 0, record: starting, created_at: new Date(now), updated_at: new Date(now),
  });
  const connected = AppConnectionSessionRecordSchema.parse({
    ...starting, revision: 1, state: 'connected', callback_consumed: true, updated_at: timestamp,
    restore,
  });
  await transaction.update(appConnectionSessions).set({
    revision: 1, record: connected, updated_at: new Date(now),
  }).where(and(
    eq(appConnectionSessions.org_id, currentRow.org_id),
    eq(appConnectionSessions.owner_user_id, currentRow.owner_user_id),
    eq(appConnectionSessions.session_id, sessionId),
  ));
  return connected;
}
