import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appConnectionSessions, appDataConsents, appResourceObservationConsents, appIntegrationCapturePolicies } from '@deft/db/schema';
import { AppDataConsentSnapshotSchema, ResourceObservationSnapshotSchema } from '@deft/app-kit/core';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { db } from './db.js';

/** Structural database port so restore can be exercised against a dedicated
 * disposable database without the full app-platform authority chain. */
export type RestoreAccessDatabase = typeof db;
export type RestoreAccessTransaction = Parameters<Parameters<RestoreAccessDatabase['transaction']>[0]>[0];

export const RESTORE_GRANT_KINDS = ['record_consent', 'observation_consent', 'action_consent', 'capture_policy'] as const;
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

function grant(input: Omit<RestoreGrant, 'restorable' | 'preselected'>): RestoreGrant {
  return RestoreGrantSchema.parse({
    ...input,
    restorable: input.state !== 'revoked',
    preselected: input.state === 'active',
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
  }
}

/** Read-only enumeration of every prior grant under one reconnected account.
 * Scoped strictly to the authenticated actor's org + owner; no ids are taken
 * from any caller-supplied body. */
export async function enumerateRestoreAccess(
  database: RestoreAccessDatabase,
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
      const snapshot = ResourceObservationSnapshotSchema.parse(row.snapshot);
      remember(grant({
        grant_id: row.consent_id, kind: 'observation_consent',
        resource_binding_id: row.resource_binding_id, interval_seconds: snapshot.interval_seconds,
        state: grantState(row.expires_at, row.state, timestamp),
        lifetime: deriveRestoreLifetime(row.expires_at, row.created_at, snapshot.consent_lifetime ?? null),
      }));
    }
  }

  // action_consents live on each prior session record.
  for (const session of prior) {
    for (const consent of session.record.action_consents ?? []) {
      remember(grant({
        grant_id: consent.consent_id, kind: 'action_consent', action_key: consent.action_key,
        state: grantState(consent.expires_at, 'active', timestamp),
        lifetime: deriveRestoreLifetime(consent.expires_at, session.created_at, consent.consent_lifetime ?? null),
      }));
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

  return {
    installation_id: nomination.installation_id, target_key: nomination.target_key,
    current_session_id: current.session_id, current_account_ref: current.account_ref,
    prior_account_ref: priorAccount?.account_ref ?? null, grants: [...grants.values()],
  };
}
