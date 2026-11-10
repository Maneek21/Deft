import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, sql } from 'drizzle-orm';
import { appConnectionSessions } from '@deft/db/schema';
import type { AppConnectionActionConsent } from '@deft/app-kit/core';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import { enumerateRestoreAccess, restoreAccountMatches,
  type RestoreAccessDatabase, type RestoreAccessTransaction, type RestoreAccessEnumeration, type RestoreGrant } from './app-restore-access-context.js';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';

export const RESTORE_ACCESS_REVIEW_SCHEMA_VERSION = 'deft.app_restore_access_review.v1';
export const RESTORE_ACCESS_CONTEXT_SCHEMA_VERSION = 'deft.app_restore_access_context.v1';
export const RESTORE_ACCESS_ACTIVATE_SCHEMA_VERSION = 'deft.app_restore_access_activate.v1';

export const REVIEW_WINDOW_MS = 10 * 60_000;

/** Current custody facts for the connection an observation consent is
 * re-issued onto, resolved from live authority (never copied from history). */
export type RestoreObservationConnection = Readonly<{
  receipt: Readonly<{ custody_generation: number; receipt_digest: string }> | null;
  resource_policy_digest: string;
  min_interval_seconds: number;
}>;

export type AppRestoreAccessPorts = Readonly<{
  database: RestoreAccessDatabase;
  guard: WebAuthorityGuard;
  now: () => number;
  /** Live runtime-authority reader for restored action consents. Defaults to
   * the production connection reader; never a synthetic pin. */
  liveActionConsents?: (transaction: RestoreAccessTransaction, actor: ExperienceCaller,
    record: AppConnectionSessionRecord, guard: WebAuthorityGuard) => Promise<readonly AppConnectionActionConsent[]>;
  /** Live observation custody reader. Defaults to the production observation
   * binding authority + connection receipt resolver. */
  observationConnection?: (transaction: RestoreAccessTransaction, actor: ExperienceCaller,
    record: AppConnectionSessionRecord, now: number) => Promise<RestoreObservationConnection>;
}>;

export const restoreAccessDenied = () => new AppError('Restore access review is no longer available', 'APP_ACCESS_DENIED', 403);

/** Action (and therefore successor-session) restoration needs the live runtime
 * authority and a connection whose custody can be carried without replaying a
 * completed protocol admission. When either is missing, the owner grants action
 * access again through the normal connection flow instead. */
export const restoreAccessActionUnavailable = (installationId: string, targetKey: string) =>
  new AppError('Action access cannot be restored on this connection. Grant action access again.',
    'APP_REVIEW_REQUIRED', 403, { next_step: { kind: 'reconnect', installation_id: installationId, target_key: targetKey } });

/** §5.1 same-provider-account gate. Restore may never inherit a different
 * account's grants: a mismatched or unknown prior identity refuses with a
 * concrete `reconnect` step rather than a bare denial. */
export const restoreAccessSameAccountRequired = (installationId: string, targetKey: string) =>
  new AppError('This account differs from the previously connected account. Grant access again for the current account.',
    'APP_REVIEW_REQUIRED', 403, { next_step: { kind: 'reconnect', installation_id: installationId, target_key: targetKey } });

function grantPin(grant: RestoreGrant): string {
  const identity = grant.kind === 'record_consent' ? `store:${grant.store_key}`
    : grant.kind === 'observation_consent' ? `binding:${grant.resource_binding_id}:interval:${grant.interval_seconds}`
      : grant.kind === 'capture_policy' ? `capture:${grant.store_key}`
        : grant.kind === 'defty_read_grant' ? `defty_read:${grant.store_key}`
          : grant.kind === 'agent_policy_default' ? `agent_policy:${grant.action_key}`
            : `action:${grant.action_key}`;
  const lifetime = grant.lifetime.kind === 'until_revoked' ? 'until_revoked' : `duration:${grant.lifetime.seconds}`;
  return `${grant.kind}|${identity}|${lifetime}`;
}

/** The review digest binds the full restorable grant set + original lifetimes +
 * actor + session + review window, so a review opened by one actor/session
 * cannot be activated against another tenant's rows or a widened grant set.
 * Deterministic: pins are sorted and lifetimes are replayed, never
 * caller-nominated. `reviewExpiresAt` is echoed by activate and must match. */
export function restoreAccessReviewDigest(enumeration: RestoreAccessEnumeration, actor: ExperienceCaller, reviewExpiresAt: string): string {
  const pins = enumeration.grants.filter((grant) => grant.restorable).map(grantPin).sort();
  const value = {
    schema_version: RESTORE_ACCESS_REVIEW_SCHEMA_VERSION,
    installation_id: enumeration.installation_id,
    target_key: enumeration.target_key,
    session_id: enumeration.current_session_id,
    account_ref: enumeration.current_account_ref,
    org_id: actor.org_id,
    owner_user_id: actor.user_id,
    review_expires_at: reviewExpiresAt,
    grants: pins,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Production live readers. Action consents come from the same reader normal
 * connection admission uses (actual runtime binding, registration epoch and
 * authorization snapshot); observation custody comes from the observation
 * binding authority and the current connection's receipt. */
export async function productionRestoreLiveActionConsents(transaction: RestoreAccessTransaction, actor: ExperienceCaller,
  record: AppConnectionSessionRecord, guard: WebAuthorityGuard): Promise<readonly AppConnectionActionConsent[]> {
  const { currentAppConnectionReadAuthority } = await import('./app-connection-session-authority.js');
  const authority = await currentAppConnectionReadAuthority(actor,
    { installation_id: record.scope.installation_id, target_key: record.scope.target_key }, guard, undefined, transaction as never);
  if (!isDeepStrictEqual(authority.scope, record.scope) || !isDeepStrictEqual(authority.profile, record.profile)) throw restoreAccessDenied();
  const value = authority as { action_consents?: readonly AppConnectionActionConsent[]; action_consent?: AppConnectionActionConsent };
  return value.action_consents ?? (value.action_consent ? [value.action_consent] : []);
}

export async function productionRestoreObservationConnection(transaction: RestoreAccessTransaction, actor: ExperienceCaller,
  record: AppConnectionSessionRecord, now: number): Promise<RestoreObservationConnection> {
  const { resourceObservationBindingAuthority, loadObservationConnection, observationPolicyDigest } = await import('./app-resource-observation-authority.js');
  const tx = transaction as never;
  const authority = await resourceObservationBindingAuthority(tx, actor.org_id, record.scope.resource_binding_id, () => new Date(now));
  if (authority.binding.owner_user_id !== actor.user_id) throw restoreAccessDenied();
  const connection = await loadObservationConnection(tx, authority, record.session_id);
  const receipt = connection.connection_receipt;
  return {
    receipt: receipt ? { custody_generation: receipt.custody_generation, receipt_digest: receipt.receipt_digest } : null,
    resource_policy_digest: await observationPolicyDigest(authority),
    min_interval_seconds: authority.binding.min_interval_seconds,
  };
}

export function productionAppRestoreAccessPorts(_caller: ExperienceCaller, guard: WebAuthorityGuard): AppRestoreAccessPorts {
  return { database: db, guard, now: Date.now,
    liveActionConsents: productionRestoreLiveActionConsents, observationConnection: productionRestoreObservationConnection };
}

/** Resolve the reconnected account's target_key for a read-only context fetch.
 * Only the most recent connected session under this installation nominates the
 * account being restored; earlier disconnected/indeterminate rows are history. */
async function resolveReconnectedTargetKey(database: RestoreAccessDatabase, caller: ExperienceCaller, installationId: string): Promise<string | null> {
  const rows = await database.select().from(appConnectionSessions).where(and(
    eq(appConnectionSessions.org_id, caller.org_id),
    eq(appConnectionSessions.owner_user_id, caller.user_id),
    sql`${appConnectionSessions.record}->'scope'->>'installation_id' = ${installationId}`,
    sql`${appConnectionSessions.record}->>'state' = 'connected'`,
  )).orderBy(desc(appConnectionSessions.created_at)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const record = AppConnectionSessionRecordSchema.parse(row.record);
  return record.scope.target_key;
}

/** GET /installations/:id/restore-context — read-only enumeration scoped to the
 * owner. Tenant isolation is enforced by deriving org/owner from the caller and
 * re-verifying the web session before any disclosure. */
export async function appRestoreAccessContext(caller: ExperienceCaller, installationId: string, guard: WebAuthorityGuard, requestedTargetKey?: string) {
  await db.transaction((tx) => guard(tx));
  // An explicitly selected target is reviewed as-is: the installation-wide
  // newest connection must never substitute a different account (PR424-F03).
  const targetKey = requestedTargetKey ?? await resolveReconnectedTargetKey(db, caller, installationId);
  if (!targetKey) {
    return { schema_version: RESTORE_ACCESS_CONTEXT_SCHEMA_VERSION, installation_id: installationId,
      target_key: null, account_ref: null, session_id: null, same_account: false, grants: [] };
  }
  const enumeration = await enumerateRestoreAccess(db, caller, { installation_id: installationId, target_key: targetKey });
  if (!enumeration.current_session_id) {
    return { schema_version: RESTORE_ACCESS_CONTEXT_SCHEMA_VERSION, installation_id: installationId,
      target_key: targetKey, account_ref: null, session_id: null, same_account: false,
      next_step: { kind: 'reconnect', installation_id: installationId, target_key: targetKey }, grants: [] };
  }
  const sameAccount = restoreAccountMatches(enumeration);
  return {
    schema_version: RESTORE_ACCESS_CONTEXT_SCHEMA_VERSION, installation_id: installationId,
    target_key: enumeration.target_key, account_ref: enumeration.current_account_ref,
    session_id: enumeration.current_session_id, same_account: sameAccount,
    ...(sameAccount ? {} : { next_step: { kind: 'reconnect', installation_id: installationId, target_key: targetKey } }),
    grants: enumeration.grants,
  };
}

export function restoreAccessReviewWindow(now: number): { review_expires_at: string } {
  return { review_expires_at: new Date(now + REVIEW_WINDOW_MS).toISOString() };
}
