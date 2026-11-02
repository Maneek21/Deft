import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { appConnectionSessions, appDataConsents, appResourceObservationConsents, appIntegrationCapturePolicies, auditLog } from '@deft/db/schema';
import { AppConnectionActionConsentSchema, AppDataConsentSnapshotSchema, ResourceObservationSnapshotSchema,
  type AppConnectionActionConsent } from '@deft/app-kit/core';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import { appDataDigest } from './app-data-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { appIntegrationSourceDigest } from './app-integration-source.js';
import { enqueueOrRearmFailed, QUEUE_NAMES } from './queues.js';
import { APP_INTEGRATION_CAPTURE_JOB } from './app-integration-capture-authority.js';
import { enumerateRestoreAccess, restoreAccountMatches,
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
   * Omission re-issues every restorable prior grant. */
  grant_ids: z.array(z.string().uuid()).max(64).optional(),
});

export type RestoreGrantHandler = (context: {
  transaction: RestoreAccessTransaction;
  actor: ExperienceCaller;
  record: AppConnectionSessionRecord;
  grant: RestoreGrant;
  now: number;
  reservedActionKeys: Set<string>;
}) => Promise<{ new_grant_id: string; action_consent?: AppConnectionActionConsent }>;

type ReissuedGrant = { kind: RestoreGrantKind; original_grant_id: string; new_grant_id: string };

/** Replay the original lifetime, never widened. `until_revoked` is preserved
 * only while the reconnected connection itself is still indefinite; otherwise
 * the grant narrows to the connection's remaining consent. */
function reissuedExpiry(lifetime: RestoreLifetime, scope: AppConnectionSessionRecord['scope'], now: number):
  { expires_at: Date | null; consent_lifetime?: 'until_revoked' } {
  const indefinite = scope.consent_lifetime === 'until_revoked' && scope.consent_expires_at === null;
  const ceiling = indefinite ? Infinity : Date.parse(scope.consent_expires_at!);
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
      eq(appDataConsents.consent_id, grant.grant_id))).limit(1);
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
      connection_session_id: record.session_id, store_key: original.store_key, state: 'active',
      consent_digest: appDataDigest(snapshot), snapshot, expires_at: expiry.expires_at,
      created_at: new Date(now), updated_at: new Date(now),
    });
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
      eq(appResourceObservationConsents.consent_id, grant.grant_id))).limit(1);
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
      resource_binding_id: original.resource_binding_id, connection_session_id: record.session_id, state: 'active',
      consent_digest: digestAppGrantValue(snapshot), snapshot, expires_at: expiry.expires_at,
      created_at: new Date(now), updated_at: new Date(now),
    });
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
      eq(appIntegrationCapturePolicies.id, grant.grant_id))).limit(1);
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
    const review_expires_at = restoreAccessReviewWindow(this.ports.now()).review_expires_at;
    return {
      schema_version: RESTORE_ACCESS_REVIEW_SCHEMA_VERSION,
      review_id: randomUUID(),
      review_digest: restoreAccessReviewDigest(enumeration, actor, review_expires_at),
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
    if (Date.parse(input.review_expires_at) <= this.ports.now()) throw restoreAccessDenied();
    const enumeration = await this.enumerate(actor, { installation_id: input.installation_id, target_key: input.target_key });
    this.assertAuthority(enumeration);
    if (restoreAccessReviewDigest(enumeration, actor, input.review_expires_at) !== input.review_digest) {
      throw restoreAccessDenied();
    }

    // §5.2 narrowing only: every requested id must be in the digest-bound
    // restorable set. Nothing can be added; revoked grants are not restorable.
    const restorable = new Set(enumeration.grants.filter((grant) => grant.restorable).map((grant) => grant.grant_id));
    const requested = new Set(input.grant_ids ?? [...restorable]);
    for (const id of requested) if (!restorable.has(id)) throw restoreAccessDenied();
    const selected = enumeration.grants.filter((grant) => requested.has(grant.grant_id));

    const reissued = await this.ports.database.transaction(async (transaction) => {
      // One activation per session at a time; identity is re-read under lock.
      const [currentRow] = await transaction.select().from(appConnectionSessions).where(and(
        eq(appConnectionSessions.org_id, actor.org_id),
        eq(appConnectionSessions.owner_user_id, actor.user_id),
        eq(appConnectionSessions.session_id, enumeration.current_session_id!),
      )).for('update').limit(1);
      if (!currentRow) throw restoreAccessDenied();
      const record = AppConnectionSessionRecordSchema.parse(currentRow.record);
      if (record.state !== 'connected' || !record.account || !record.runtime_session_ref) throw restoreAccessDenied();

      const now = this.ports.now();
      const reservedActionKeys = new Set((record.action_consents ?? []).map((consent) => consent.action_key));
      const result: ReissuedGrant[] = [];
      const actionConsents: AppConnectionActionConsent[] = [];

      for (const grant of selected) {
        const handler = RESTORE_GRANT_HANDLERS.get(grant.kind);
        if (!handler) throw restoreAccessDenied();
        const issued = await handler({ transaction, actor, record, grant, now, reservedActionKeys });
        if (issued.action_consent) actionConsents.push(issued.action_consent);
        result.push({ kind: grant.kind, original_grant_id: grant.grant_id, new_grant_id: issued.new_grant_id });
      }

      if (actionConsents.length) {
        const nextRecord = AppConnectionSessionRecordSchema.parse({
          ...record,
          action_consents: [...(record.action_consents ?? []), ...actionConsents],
          revision: record.revision + 1,
          updated_at: new Date(now).toISOString(),
        });
        await transaction.update(appConnectionSessions).set({
          revision: nextRecord.revision, record: nextRecord, updated_at: new Date(now),
        }).where(and(eq(appConnectionSessions.org_id, actor.org_id),
          eq(appConnectionSessions.owner_user_id, actor.user_id),
          eq(appConnectionSessions.session_id, record.session_id)));
      }

      // §5.4 audit every re-issue with its restore lineage and review id.
      for (const item of result) {
        await transaction.insert(auditLog).values({
          id: randomUUID(), org_id: actor.org_id, actor_type: 'user', actor_id: actor.user_id,
          action: RESTORE_AUDIT_ACTION, entity_type: 'app_restore_access_grant', entity_id: item.new_grant_id,
          metadata: { restored_from_grant_id: item.original_grant_id, review_id: input.review_id, kind: item.kind },
          created_at: new Date(now),
        });
      }
      return result;
    });

    return {
      schema_version: RESTORE_ACCESS_ACTIVATE_SCHEMA_VERSION,
      review_id: input.review_id,
      installation_id: enumeration.installation_id,
      target_key: enumeration.target_key,
      session_id: enumeration.current_session_id,
      grants: reissued.map((item) => ({ kind: item.kind, original_grant_id: item.original_grant_id, grant_id: item.new_grant_id })),
    };
  }
}
