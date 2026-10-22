import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appResourceBindings, appRuntimeRegistrations, appInstallations, auditLog } from '@deft/db/schema';
import { db } from './db.js';
import { appConsentDeadline } from '@deft/app-kit/core';
import { assertContinuityProof, readContinuityProof, UPGRADE_ALIAS_ACTION, type UpgradeTx } from './app-upgrade-trust-continuity.js';
import { AppConnectionSessionRegistryConfigSchema, connectionProfileDigest, connectionTransportEntryDigest } from './app-connection-session-registry.js';

const id = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const UpgradeRegistrationAliasSchema = z.strictObject({ schema_version: z.literal('deft.app_upgrade_registration.v1'), proof_id: id,
  org_id: id, installation_id: id, registration_id: id, binding_id: id, runtime_epoch: z.number().int().positive(),
  source_registration_id: id, source_runtime_epoch: z.number().int().positive(), profile_digest: digest, transport_digest: digest });
type Entry = z.infer<typeof AppConnectionSessionRegistryConfigSchema>['entries'][number];
type Alias = z.infer<typeof UpgradeRegistrationAliasSchema>;
const key = (org: string, registration: string, epoch: number) => `${org}:${registration}:${epoch}`;
async function checked(tx: UpgradeTx, alias: Alias, current: boolean) {
  const proof = await readContinuityProof(tx, alias.org_id, alias.proof_id);
  await assertContinuityProof(tx, proof, current, false);
  const [rows] = await tx.select({ binding: appResourceBindings, registration: appRuntimeRegistrations }).from(appResourceBindings)
    .leftJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, alias.org_id),
      eq(appRuntimeRegistrations.id, alias.registration_id)))
    .where(and(eq(appResourceBindings.org_id, alias.org_id), eq(appResourceBindings.id, alias.binding_id))).limit(1);
  const { binding, registration } = rows ?? {};
  if (!binding || !registration || binding.state !== 'active' || registration.state !== 'active'
    || proof.org_id !== alias.org_id || proof.installation_id !== alias.installation_id
    || binding.app_installation_id !== proof.installation_id || binding.app_version_id !== proof.version_id || binding.grant_snapshot_id !== proof.grant_id
    || binding.runtime_registration_id !== alias.registration_id || registration.runtime_epoch !== alias.runtime_epoch
    || registration.app_version_id !== proof.version_id || registration.grant_snapshot_id !== proof.grant_id
    || binding.owner_user_id !== proof.owner_id || registration.operator_user_id !== proof.operator_id
    || alias.source_registration_id !== proof.source_scope.runtime_registration_id || alias.source_runtime_epoch !== proof.source_scope.runtime_epoch
    || alias.profile_digest !== proof.source_scope.profile_digest || alias.transport_digest !== proof.transport_digest
    || (binding.consent_expires_at?.toISOString() ?? null) !== proof.source_scope.consent_expires_at
    || (binding.consent_lifetime ?? undefined) !== proof.source_scope.consent_lifetime
    || appConsentDeadline(binding.consent_expires_at, binding.consent_lifetime ?? undefined) <= Date.now()) throw Error('UPGRADE_REGISTRATION_STALE');
  return proof;
}
/** Only installation-specific server-authored lineage may nominate a successor.
 * No endpoint, profile, credential, origin or epoch is inferred from app input.
 * The original deployment file remains the transport root of trust. */
export async function trustedUpgradeRegistryEntries(entries: readonly Entry[], transaction?: UpgradeTx): Promise<Entry[]> {
  if (!entries.length) return [];
  const read = async (tx: UpgradeTx) => {
    // Bound current owners, not historical upgrade count. The server-authored
    // proof already pins the live prior approval and its exact reviewed transport.
    const rows = await tx.select({ metadata: auditLog.metadata }).from(auditLog)
      .innerJoin(appResourceBindings, and(eq(appResourceBindings.org_id, auditLog.org_id),
        eq(appResourceBindings.runtime_registration_id, auditLog.entity_id)))
      .innerJoin(appInstallations, and(eq(appInstallations.org_id, appResourceBindings.org_id),
        eq(appInstallations.id, appResourceBindings.app_installation_id), eq(appInstallations.active_version_id, appResourceBindings.app_version_id)))
      .where(and(inArray(auditLog.org_id, [...new Set(entries.map(entry => entry.org_id))]),
        eq(auditLog.action, UPGRADE_ALIAS_ACTION), eq(auditLog.actor_type, 'system'), eq(auditLog.entity_type, 'app_runtime_registration'))).limit(257);
    if (rows.length > 256) return [];
    const aliases = rows.map(row => UpgradeRegistrationAliasSchema.parse(row.metadata));
    if (new Set(aliases.map(alias => key(alias.org_id, alias.registration_id, alias.runtime_epoch))).size !== aliases.length) return [];
    const output: Entry[] = [];
    for (const alias of aliases) {
      if (entries.some(entry => key(entry.org_id, entry.runtime_registration_id, entry.runtime_epoch) === key(alias.org_id, alias.registration_id, alias.runtime_epoch))) continue;
      try {
        const proof = await checked(tx, alias, true);
        const roots = entries.filter(entry => entry.org_id === alias.org_id && entry.installation_id === alias.installation_id
          && entry.profile.operator_user_id === proof.operator_id && connectionProfileDigest(entry.profile) === alias.profile_digest
          && connectionTransportEntryDigest(entry) === alias.transport_digest && (entry.connection_protocol ?? 'v1') === proof.connection_protocol);
        // Profile/transport/protocol ambiguity remains closed in the ordinary
        // registry constructor. Only the exact audited registration ID changes.
        if (!roots.length) throw Error('UPGRADE_TRANSPORT_CHANGED');
        const root = roots[0]!;
        if (roots.some(entry => entry.connection_protocol !== root.connection_protocol)) throw Error('UPGRADE_PROTOCOL_CHANGED');
        output.push({ ...root, runtime_registration_id: alias.registration_id, runtime_epoch: alias.runtime_epoch });
      } catch { /* A failed trust proof never changes an explicitly enrolled entry. */ }
    }
    return output;
  };
  return transaction ? read(transaction) : db.transaction(read);
}
