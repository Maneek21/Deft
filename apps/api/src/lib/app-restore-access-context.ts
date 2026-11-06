import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appConnectionSessions, appDataConsents, appResourceObservationConsents, appIntegrationCapturePolicies, appVersions } from '@deft/db/schema';
import { AppDataConsentSnapshotSchema, ResourceObservationSnapshotSchema, AppIntegrationToolsDeclarationSchema } from '@deft/app-kit/core';
import { createHash } from 'node:crypto';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { db } from './db.js';

/** Structural database port so restore can be exercised against a dedicated
 * disposable database without the full app-platform authority chain. */
export type RestoreAccessDatabase = typeof db;
export type RestoreAccessTransaction = Parameters<Parameters<RestoreAccessDatabase['transaction']>[0]>[0];

export const RESTORE_GRANT_KINDS = ['record_consent', 'observation_consent', 'action_consent', 'capture_policy', 'agent_policy_default', 'defty_read_grant'] as const;
export type RestoreGrantKind = (typeof RESTORE_GRANT_KINDS)[number];

export const RestoreLifetimeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('duration'), seconds: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('until_revoked') }),
]);
export type RestoreLifetime = z.infer<typeof RestoreLifetimeSchema>;

export const RestoreGrantSchema = z.strictObject({
  grant_id: z.string().uuid(),
  kind: z.enum(RESTORE_GRANT_KINDS),
  store_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).optional(),
  resource_binding_id: z.string().uuid().optional(),
  interval_seconds: z.number().int().positive().optional(),
  action_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).optional(),
  state: z.enum(['active', 'expired', 'revoked']),
  lifetime: RestoreLifetimeSchema,
  restorable: z.boolean(),
  preselected: z.boolean(),
});
export type RestoreGrant = z.infer<typeof RestoreGrantSchema>;

export type RestoreAccessEnumeration = {
  installation_id: string;
  target_key: string;
  current_session_id: string | null;
  current_account_ref: string | null;
  prior_account_ref: string | null;
  grants: RestoreGrant[];
};

type ParsedSession = {
  session_id: string;
  created_at: string;
  account_ref: string | null;
  record: AppConnectionSessionRecord;
};

function toSession(row: typeof appConnectionSessions.$inferSelect): ParsedSession {
  const record = AppConnectionSessionRecordSchema.parse(row.record);
  return {
    session_id: row.session_id,
    created_at: record.created_at,
    account_ref: record.account?.account_ref ?? null,
    record,
  };
}

/** Same provider account only (§5.1). The Host record pins the provider's
 * opaque stable account reference; an unknown prior or current identity is
 * treated as a mismatch rather than silently inheriting prior grants. */
export function restoreAccountMatches(enumeration: RestoreAccessEnumeration): boolean {
  return Boolean(enumeration.current_account_ref && enumeration.prior_account_ref
    && enumeration.current_account_ref === enumeration.prior_account_ref);
}

/** Original lifetime is a read-only echo. `until_revoked` only when the stored
 * consent itself was indefinite; otherwise the finite duration between grant
 * creation and expiry is preserved, never recomputed from caller input. */
export function deriveRestoreLifetime(
  expiresAt: Date | string | null,
  consentedAt: Date | string,
  consentLifetime?: string | null,
): RestoreLifetime {
  if (expiresAt === null || consentLifetime === 'until_revoked') return { kind: 'until_revoked' };
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  const started = consentedAt instanceof Date ? consentedAt.getTime() : Date.parse(consentedAt);
  return { kind: 'duration', seconds: Math.max(0, Math.round((expiry - started) / 1000)) };
}

function grantState(expiresAt: Date | string | null, state: string, now: number): RestoreGrant['state'] {
  if (state === 'revoked') return 'revoked';
  if (expiresAt === null) return 'active';
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return expiry > now ? 'active' : 'expired';
}

function grant(input: Omit<RestoreGrant, 'restorable' | 'preselected'>, preselectedOverride?: boolean): RestoreGrant {
  return RestoreGrantSchema.parse({
    ...input,
    restorable: input.state !== 'revoked',
    preselected: preselectedOverride ?? (input.state === 'active'),
  });
}

/** One grant identity per kind. Older duplicates are history; only the newest
 * prior grant for a given store/binding/action can be re-issued. */
function grantIdentity(value: RestoreGrant): string {
  switch (value.kind) {
    case 'record_consent': return `record:${value.store_key}`;
    case 'observation_consent': return `observation:${value.resource_binding_id}`;
    case 'action_consent': return `action:${value.action_key}`;
    case 'capture_policy': return `capture:${value.store_key}`;
    case 'agent_policy_default': return `agent_policy:${value.action_key}`;
    case 'defty_read_grant': return `defty_read:${value.store_key}`;
  }
}

/** Deterministic, version-4-shaped UUID for a synthetic grant identity. The two
 * review-time default kinds have no prior row to borrow an id from, so their
 * grant_id is derived from the identity so it stays stable between review and
 * activate (the digest never carries a raw id). */
function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A default's lifetime mirrors the reconnected session consent, never a wider
 * one. Deterministic from stored consent/created values so review and activate
 * agree on the digest. An indefinite session consent narrows to a conservative
 * finite default (the read delegation table requires a finite expiry). */
function sessionConsentLifetime(scope: AppConnectionSessionRecord['scope'], createdAt: string): RestoreLifetime {
  if (scope.consent_expires_at) {
    return { kind: 'duration', seconds: Math.max(0, Math.round((Date.parse(scope.consent_expires_at) - Date.parse(createdAt)) / 1000)) };
  }
  return { kind: 'duration', seconds: 90 * 86400 };
}

/** Whether a read-only Defty delegation already existed for a store on this
 * account (so the default is pre-selected, never silently widened). Absent or
 * unknown prior state defaults to unselected. */
async function priorDeftyReadStores(
  database: RestoreAccessDatabase | RestoreAccessTransaction,
  actor: ExperienceCaller,
  installationId: string,
  storeKeys: readonly string[],
  accountRefs: readonly string[],
): Promise<Set<string>> {
  if (!storeKeys.length || !accountRefs.length) return new Set();
  const present = await database.execute(sql`SELECT to_regclass('app_integration_principal_grants') IS NOT NULL AS present`);
  if (present.rows[0]?.present !== true) return new Set();
  const rows = await database.execute(sql`SELECT DISTINCT store_key FROM app_integration_principal_grants
    WHERE org_id=${actor.org_id} AND owner_user_id=${actor.user_id} AND installation_id=${installationId}
      AND principal_kind='defty' AND principal_id=${actor.user_id} AND revoked_at IS NULL
      AND store_key = ANY(${sql.param(storeKeys)}::text[]) AND account_ref = ANY(${sql.param(accountRefs)}::text[])`);
  return new Set(rows.rows.map((row) => String((row as { store_key: unknown }).store_key)));
}

/** Whether an agent runtime-action policy already existed for a nominated action
 * key (so the require_approval default is pre-selected). Absent/unknown defaults
 * to unselected. */
async function priorAgentPolicyKeys(
  database: RestoreAccessDatabase | RestoreAccessTransaction,
  actor: ExperienceCaller,
  installationId: string,
  actionKeys: readonly string[],
): Promise<Set<string>> {
  if (!actionKeys.length) return new Set();
  const present = await database.execute(sql`SELECT to_regclass('app_runtime_agent_policies') IS NOT NULL
    AND to_regclass('app_runtime_bindings') IS NOT NULL AS present`);
  if (present.rows[0]?.present !== true) return new Set();
  const rows = await database.execute(sql`SELECT DISTINCT b.action_key FROM app_runtime_agent_policies p
    JOIN app_runtime_bindings b ON b.org_id=p.org_id AND b.id=p.runtime_binding_id
    WHERE p.org_id=${actor.org_id} AND p.owner_user_id=${actor.user_id} AND b.app_installation_id=${installationId}
      AND b.action_key = ANY(${sql.param(actionKeys)}::text[])`);
  return new Set(rows.rows.map((row) => String((row as { action_key: unknown }).action_key)));
}

/** Builds a synthetic review-time default grant with a stable id and explicit
 * preselected flag. Always restorable (a default is offered, never resurrected). */
function defaultGrant(identity: string, input: Omit<RestoreGrant, 'grant_id' | 'state' | 'restorable' | 'preselected'>, preselected: boolean): RestoreGrant {
  return RestoreGrantSchema.parse({
    ...input, grant_id: deterministicUuid(identity), state: 'active', restorable: true, preselected,
  });
}

/** Read-only enumeration of every prior grant under one reconnected account.
 * Scoped strictly to the authenticated actor's org + owner; no ids are taken
 * from any caller-supplied body. */
export async function enumerateRestoreAccess(
  database: RestoreAccessDatabase | RestoreAccessTransaction,
  actor: ExperienceCaller,
  nomination: { installation_id: string; target_key: string },
  now: () => number = Date.now,
): Promise<RestoreAccessEnumeration> {
  const rows = await database.select().from(appConnectionSessions).where(and(
    eq(appConnectionSessions.org_id, actor.org_id),
    eq(appConnectionSessions.owner_user_id, actor.user_id),
    sql`${appConnectionSessions.record}->'scope'->>'installation_id' = ${nomination.installation_id}`,
    sql`${appConnectionSessions.record}->'scope'->>'target_key' = ${nomination.target_key}`,
  )).orderBy(desc(appConnectionSessions.created_at)).limit(64);

  const sessions = rows.map(toSession);
  // The reconnected account is the newest session that is actually connected.
  const current = sessions.find((session) => session.record.state === 'connected'
    && session.record.account !== null && session.record.runtime_session_ref !== null) ?? null;
  if (!current) return {
    installation_id: nomination.installation_id, target_key: nomination.target_key,
    current_session_id: null, current_account_ref: null, prior_account_ref: null, grants: [],
  };

  const prior = sessions.filter((session) => session.session_id !== current.session_id
    && Date.parse(session.created_at) <= Date.parse(current.created_at));
  const priorAccount = prior.find((session) => session.account_ref !== null);
  const priorSessionIds = prior.map((session) => session.session_id);
  const timestamp = now();
  const grants = new Map<string, RestoreGrant>();

  const remember = (value: RestoreGrant) => {
    const identity = grantIdentity(value);
    if (!grants.has(identity)) grants.set(identity, value);
  };

  if (priorSessionIds.length) {
    // app_data_consents — one record consent per store_key.
    const consentRows = await database.select().from(appDataConsents).where(and(
      eq(appDataConsents.org_id, actor.org_id),
      eq(appDataConsents.owner_user_id, actor.user_id),
      inArray(appDataConsents.connection_session_id, priorSessionIds),
    )).orderBy(desc(appDataConsents.created_at));
    for (const row of consentRows) {
      // A `proposed` row was never granted by the owner; it must never be
      // offered for restore. Leave it out of the enumeration entirely.
      if (row.state === 'proposed') continue;
      const snapshot = AppDataConsentSnapshotSchema.parse(row.snapshot);
      remember(grant({
        grant_id: row.consent_id, kind: 'record_consent', store_key: row.store_key,
        state: grantState(row.expires_at, row.state, timestamp),
        lifetime: deriveRestoreLifetime(row.expires_at, row.created_at, snapshot.consent_lifetime ?? null),
      }));
    }

    // app_resource_observation_consents — one observation consent per binding.
    const observationRows = await database.select().from(appResourceObservationConsents).where(and(
      eq(appResourceObservationConsents.org_id, actor.org_id),
      eq(appResourceObservationConsents.owner_user_id, actor.user_id),
      inArray(appResourceObservationConsents.connection_session_id, priorSessionIds),
    )).orderBy(desc(appResourceObservationConsents.created_at));
    for (const row of observationRows) {
      if (row.state === 'proposed') continue;
      const snapshot = ResourceObservationSnapshotSchema.parse(row.snapshot);
      remember(grant({
        grant_id: row.consent_id, kind: 'observation_consent',
        resource_binding_id: row.resource_binding_id, interval_seconds: snapshot.interval_seconds,
        state: grantState(row.expires_at, row.state, timestamp),
        lifetime: deriveRestoreLifetime(row.expires_at, row.created_at, snapshot.consent_lifetime ?? null),
      }));
    }
  }

  // action_consents live on each prior session record. A prior session is almost
  // never `connected` after a reconnect (it is normally `disconnected`,
  // `not_connected` or expired) — that is exactly the case Restore access exists
  // for, so session state alone must NOT make an action consent non-restorable.
  // Only an owner-initiated disconnect does; no durable owner-disconnect signal
  // is persisted by the connection lifecycle today, so every prior non-current
  // session's action consent is treated as restorable here, with preselection
  // following its own expiry (active => preselected, expired => offered but not
  // preselected). See report for the fallback note.
  // An action already rebuilt on the current connection (e.g. by background
  // access after a reconnect) must not be offered again: re-issuing it would
  // collide with the reserved action key and fail the whole restore. Skip any
  // prior action consent whose key is already present on the current session.
  const currentActionKeys = new Set((current.record.action_consents ?? []).map((consent) => consent.action_key));
  for (const session of prior) {
    for (const consent of session.record.action_consents ?? []) {
      if (currentActionKeys.has(consent.action_key)) continue;
      remember(grant({
        grant_id: consent.consent_id, kind: 'action_consent', action_key: consent.action_key,
        state: grantState(consent.expires_at, 'active', timestamp),
        lifetime: deriveRestoreLifetime(consent.expires_at, session.created_at, consent.consent_lifetime ?? null),
      }, false));
    }
  }

  // Capture policies are bound to the connected account's opaque reference, not
  // to a consent row. A policy retired because its grant ended (§3.2) is still
  // restorable and pre-selected; a policy the owner disabled on purpose is
  // listed as non-restorable.
  const restoreAccountRefs = [...new Set([current.account_ref, priorAccount?.account_ref].filter((value): value is string => Boolean(value)))];
  if (restoreAccountRefs.length) {
    const captureRows = await database.select().from(appIntegrationCapturePolicies).where(and(
      eq(appIntegrationCapturePolicies.org_id, actor.org_id),
      eq(appIntegrationCapturePolicies.owner_user_id, actor.user_id),
      eq(appIntegrationCapturePolicies.installation_id, nomination.installation_id),
      inArray(appIntegrationCapturePolicies.account_ref, restoreAccountRefs),
    )).orderBy(desc(appIntegrationCapturePolicies.created_at));
    for (const row of captureRows) {
      const restorable = row.enabled || row.retired_reason === 'grant_ended';
      remember(grant({
        grant_id: row.id, kind: 'capture_policy', store_key: row.store_key,
        state: restorable ? 'active' : 'revoked',
        lifetime: { kind: 'until_revoked' },
      }));
    }
  }

  // Review-time defaults (§P1-wire): the installed manifest's agent-nominable
  // action keys and their stores are offered as opt-in defaults, never widened
  // beyond a read-only delegation and require_approval policies.
  const [version] = await database.select({ manifest: appVersions.manifest }).from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id), eq(appVersions.id, current.record.scope.app_version_id))).limit(1);
  const tools = version ? AppIntegrationToolsDeclarationSchema.safeParse((version.manifest as Record<string, unknown> | undefined)?.integration_tools) : null;
  if (tools?.success) {
    const delegated = tools.data.filter((tool) => tool.visibility === 'delegated_tools');
    const storeKeys = [...new Set(delegated.map((tool) => tool.store_key))].sort();
    const actionKeys = [...new Set(delegated.map((tool) => tool.action_key).filter((key): key is string => Boolean(key)))].sort();
    const lifetime = sessionConsentLifetime(current.record.scope, current.created_at);
    const accountRef = current.account_ref ?? priorAccount?.account_ref ?? '';
    const deftyPrior = await priorDeftyReadStores(database, actor, nomination.installation_id, storeKeys, restoreAccountRefs);
    const policyPrior = await priorAgentPolicyKeys(database, actor, nomination.installation_id, actionKeys);
    for (const storeKey of storeKeys) {
      remember(defaultGrant(`defty_read:${nomination.installation_id}:${accountRef}:${storeKey}`,
        { kind: 'defty_read_grant', store_key: storeKey, lifetime }, deftyPrior.has(storeKey)));
    }
    for (const actionKey of actionKeys) {
      remember(defaultGrant(`agent_policy:${nomination.installation_id}:${accountRef}:${actionKey}`,
        { kind: 'agent_policy_default', action_key: actionKey, lifetime }, policyPrior.has(actionKey)));
    }
  }

  return {
    installation_id: nomination.installation_id, target_key: nomination.target_key,
    current_session_id: current.session_id, current_account_ref: current.account_ref,
    prior_account_ref: priorAccount?.account_ref ?? null, grants: [...grants.values()],
  };
}
