import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppConnectionProfileSchema, AppConnectionSessionScopeSchema, appConsentDeadline,
  AppDataConsentSnapshotSchema } from '@deft/app-kit';
import { appInstallations, appVersions, appResourceBindings, appRuntimeBindings,
  appRuntimeRegistrations, appOwnerConnectionAdmissions, appConnectionSessions, orgMembers, users, auditLog } from '@deft/db/schema';
import { appResourceObservationConsents } from '../../../../packages/db/src/resource-observation-schema.js';
import { appDataConsents } from '../../../../packages/db/src/app-data-schema.js';
import { ResourceObservationSnapshotSchema } from '../../../../packages/app-kit/src/resource-observation.js';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { readInstallationUpgradeTrust, upgradeContinuityDecision } from './app-upgrade-trust-policy.js';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import { getAppConnectionSessionRegistry } from './app-connection-session-registry.js';
import { currentConsentContinuationSourceLocators } from './app-connection-current-locators.js';
import { currentAppConnectionReadAuthority } from './app-connection-session-authority.js';
import { appConnectionUpgradeSourceIsAvailable } from './app-connection-upgrade-fence.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';

export type UpgradeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const denied = () => new AppError('Automatic upgrade continuity requires review', 'APP_REVIEW_REQUIRED', 409);
export const UPGRADE_PROOF_ACTION = 'app.upgrade_continuity.authorized';
export const UPGRADE_ALIAS_ACTION = 'app.upgrade_continuity.registration';
const id = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pin = z.strictObject({ id, digest });
export const UpgradeContinuityProofSchema = z.strictObject({ schema_version: z.literal('deft.app_upgrade_continuity.v1'),
  request_id: id, org_id: id, installation_id: id, prior_version_id: id, version_id: id, grant_id: id,
  lifecycle_epoch: z.number().int().nonnegative(), grant_epoch: z.number().int().nonnegative(), trust_revision: z.number().int().nonnegative(),
  owner_id: id, operator_id: id, owner_role: z.enum(['owner','admin','member']), operator_role: z.enum(['owner','admin','member']),
  source_session_id: id, source_revision: z.number().int().nonnegative(), source_scope: AppConnectionSessionScopeSchema,
  source_profile: AppConnectionProfileSchema, connection_protocol: z.enum(['v1','v2','credential_form.v1']), transport_digest: digest, source_binding: pin, source_registration: pin,
  source_admission: pin, source_actions: z.array(pin).max(8), source_observations: z.array(pin).max(1), source_data: z.array(pin).max(32),
  web_session_id: id, issuance_expires_at: z.iso.datetime() });
export type UpgradeContinuityProof = z.infer<typeof UpgradeContinuityProofSchema>;
export const rowDigest = (row: unknown) => digestAppGrantValue(JSON.parse(JSON.stringify(row)));
export type CapturedUpgradeApproval = { source: AppConnectionSessionRecord; web_session_id: string; binding: typeof appResourceBindings.$inferSelect;
  registration: typeof appRuntimeRegistrations.$inferSelect; admission: typeof appOwnerConnectionAdmissions.$inferSelect;
  actions: (typeof appRuntimeBindings.$inferSelect)[]; observations: (typeof appResourceObservationConsents.$inferSelect)[];
  data: (typeof appDataConsents.$inferSelect)[]; owner_role: 'owner'|'admin'|'member'; operator_role: 'owner'|'admin'|'member'; transport_digest: string; connection_protocol: 'v1'|'v2'|'credential_form.v1' };

/** Lock all nominated participants before the installation, matching revocation's
 * member -> installation order. Late new nominations are left for manual review. */
export async function upgradeContinuityParticipants(orgId: string, installationId: string, managerId: string) {
  const policy = await db.transaction(tx => readInstallationUpgradeTrust(tx, orgId, installationId));
  if (!policy.trusted) return null;
  const rows = await db.select({ owner: appResourceBindings.owner_user_id, operator: appRuntimeRegistrations.operator_user_id })
    .from(appResourceBindings).innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appResourceBindings.org_id),
      eq(appRuntimeRegistrations.id, appResourceBindings.runtime_registration_id)))
    .where(and(eq(appResourceBindings.org_id, orgId), eq(appResourceBindings.app_installation_id, installationId),
      eq(appResourceBindings.state, 'active'), eq(appRuntimeRegistrations.state, 'active'))).limit(257);
  if (rows.length > 256) return null;
  return [...new Set([managerId, ...rows.flatMap(row => [row.owner, row.operator])])].sort();
}
export async function captureUpgradeApprovals(tx: UpgradeTx, orgId: string, installationId: string, priorVersion: string,
  participants: readonly string[], guard: WebAuthorityGuard): Promise<CapturedUpgradeApproval[]> {
  const resources = await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id, orgId),
    eq(appResourceBindings.app_installation_id, installationId), eq(appResourceBindings.app_version_id, priorVersion),
    eq(appResourceBindings.state, 'active'))).orderBy(appResourceBindings.id).limit(257);
  if (resources.length > 256) throw denied();
  const output: CapturedUpgradeApproval[] = [];
  for (const binding of resources) {
    if (!participants.includes(binding.owner_user_id) || appConsentDeadline(binding.consent_expires_at, binding.consent_lifetime ?? undefined) <= Date.now()) continue;
    const sources = await currentConsentContinuationSourceLocators(tx,
      { org_id: orgId, user_id: binding.owner_user_id }, binding).limit(2);
    if (sources.length !== 1) continue;
    const stored = sources[0]!, source = AppConnectionSessionRecordSchema.parse(stored.record);
    if (source.scope.app_version_id !== priorVersion || !await appConnectionUpgradeSourceIsAvailable(tx, { org_id: orgId,
      owner_user_id: binding.owner_user_id, session_id: source.session_id })) continue;
    try {
      const current = await currentAppConnectionReadAuthority({ org_id: orgId, user_id: binding.owner_user_id, access_expires_at: Date.now() + 300000 },
        { installation_id: installationId, target_key: binding.target_key }, guard, undefined, tx);
      if (!isDeepStrictEqual(current.scope, source.scope) || !isDeepStrictEqual(current.profile, source.profile)
        || !isDeepStrictEqual((current.action_consents ?? []).map(a => a.action_key), (source.action_consents ?? []).map(a => a.action_key))) continue;
      const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, orgId),
        eq(appRuntimeRegistrations.id, binding.runtime_registration_id))).limit(1);
      if (!registration?.owner_connection_admission_id || !participants.includes(registration.operator_user_id)) continue;
      const [admission] = await tx.select().from(appOwnerConnectionAdmissions).where(and(eq(appOwnerConnectionAdmissions.org_id, orgId),
        eq(appOwnerConnectionAdmissions.id, registration.owner_connection_admission_id))).limit(1);
      if (!admission || !('connection_transport_digest' in admission.snapshot)) continue;
      const members = await tx.select({ id: orgMembers.user_id, role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.org_id, orgId),
        inArray(orgMembers.user_id, [binding.owner_user_id, registration.operator_user_id]), eq(orgMembers.is_active, true)));
      const ownerRole = members.find(m => m.id === binding.owner_user_id)?.role, operatorRole = members.find(m => m.id === registration.operator_user_id)?.role;
      if (!ownerRole || !operatorRole || ownerRole === 'guest' || operatorRole === 'guest') continue;
      const actions = current.action_consents?.length ? await tx.select().from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id, orgId),
        inArray(appRuntimeBindings.id, current.action_consents.map(a => a.action_binding_id)), eq(appRuntimeBindings.state, 'active'))) : [];
      const observations = await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id, orgId),
        eq(appResourceObservationConsents.resource_binding_id, binding.id), eq(appResourceObservationConsents.state, 'active'))).limit(2);
      const liveObservations = observations.filter(row => { const snapshot = ResourceObservationSnapshotSchema.parse(row.snapshot);
        return isDeepStrictEqual(snapshot.scope, source.scope) && snapshot.connection.session_id === source.session_id
          && row.consent_digest === digestAppGrantValue(snapshot) && appConsentDeadline(row.expires_at, snapshot.consent_lifetime) > Date.now(); });
      if (liveObservations.length > 1) throw denied();
      const data = await tx.select().from(appDataConsents).where(and(eq(appDataConsents.org_id, orgId),
        eq(appDataConsents.connection_session_id, source.session_id), eq(appDataConsents.state, 'active'))).limit(33);
      if (data.length > 32) throw denied();
      const liveData = data.filter(row => { const snapshot = AppDataConsentSnapshotSchema.parse(row.snapshot);
        return isDeepStrictEqual(snapshot.scope, source.scope) && row.consent_digest === digestAppGrantValue(snapshot)
          && appConsentDeadline(row.expires_at, snapshot.consent_lifetime) > Date.now(); });
      output.push({ source, web_session_id: stored.web_session_id, binding, registration, admission, actions,
        observations: liveObservations, data: liveData, owner_role: ownerRole as CapturedUpgradeApproval['owner_role'],
        operator_role: operatorRole as CapturedUpgradeApproval['operator_role'], transport_digest: String(admission.snapshot.connection_transport_digest),
        connection_protocol: (await getAppConnectionSessionRegistry(tx)).protocol(source.scope, source.profile) });
    } catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return output;
}
export function continuityProof(captured: CapturedUpgradeApproval, installation: typeof appInstallations.$inferSelect, trustRevision: number) {
  const source = captured.source;
  return UpgradeContinuityProofSchema.parse({ schema_version: 'deft.app_upgrade_continuity.v1', request_id: randomUUID(),
    org_id: installation.org_id, installation_id: installation.id, prior_version_id: source.scope.app_version_id, version_id: installation.active_version_id,
    grant_id: installation.active_grant_snapshot_id, lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch, trust_revision: trustRevision,
    owner_id: source.scope.owner_user_id, operator_id: source.scope.operator_user_id, owner_role: captured.owner_role, operator_role: captured.operator_role,
    source_session_id: source.session_id, source_revision: source.revision, source_scope: source.scope, source_profile: source.profile, connection_protocol: captured.connection_protocol,
    transport_digest: captured.transport_digest, source_binding: { id: captured.binding.id, digest: rowDigest(captured.binding) },
    source_registration: { id: captured.registration.id, digest: rowDigest(captured.registration) }, source_admission: { id: captured.admission.id, digest: rowDigest(captured.admission) },
    source_actions: captured.actions.map(row => ({ id: row.id, digest: rowDigest(row) })),
    source_observations: captured.observations.map(row => ({ id: row.consent_id, digest: rowDigest(row) })),
    source_data: captured.data.map(row => ({ id: row.consent_id, digest: rowDigest(row) })), web_session_id: captured.web_session_id,
    issuance_expires_at: new Date(Math.min(Date.now() + 300000, appConsentDeadline(source.scope.consent_expires_at, source.scope.consent_lifetime))).toISOString() });
}
export async function readContinuityProof(tx: UpgradeTx, orgId: string, requestId: string) {
  const rows = await tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.org_id, orgId),
    eq(auditLog.action, UPGRADE_PROOF_ACTION), eq(auditLog.actor_type, 'system'), eq(auditLog.entity_type, 'app_connection_session'), eq(auditLog.entity_id, requestId))).limit(2);
  if (rows.length !== 1) throw denied();
  return UpgradeContinuityProofSchema.parse(rows[0]!.metadata);
}
/** Validate continuing source approvals, not a historical browser login. Every
 * row pin is reread, so revoke/expiry/role/config changes cannot be resurrected. */
export async function assertContinuityProof(tx: UpgradeTx, proof: UpgradeContinuityProof, current = true, issuance = true) {
  if (issuance && Date.parse(proof.issuance_expires_at) <= Date.now()) throw denied();
  if (issuance) {
    for (const userId of [...new Set([proof.owner_id, proof.operator_id])].sort())
      await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${proof.org_id} AND user_id=${userId} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id=${proof.org_id} AND id=${proof.installation_id} FOR SHARE`);
  }
  const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, proof.org_id),
    eq(appInstallations.id, proof.installation_id))).limit(1);
  if (!installation || installation.state !== 'active' || (current && (installation.active_version_id !== proof.version_id
    || installation.active_grant_snapshot_id !== proof.grant_id || installation.lifecycle_epoch !== proof.lifecycle_epoch || installation.grant_epoch !== proof.grant_epoch))) throw denied();
  const trust = await readInstallationUpgradeTrust(tx, proof.org_id, proof.installation_id);
  const versions = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, proof.org_id), eq(appVersions.installation_id, proof.installation_id),
    inArray(appVersions.id, [proof.prior_version_id, proof.version_id])));
  const prior = versions.find(v => v.id === proof.prior_version_id), target = versions.find(v => v.id === proof.version_id);
  if (!prior || !target || !trust.trusted || trust.revision !== proof.trust_revision || !upgradeContinuityDecision(true, prior.manifest, target.manifest).eligible) throw denied();
  const [sourceRow] = await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id, proof.org_id),
    eq(appConnectionSessions.owner_user_id, proof.owner_id), eq(appConnectionSessions.session_id, proof.source_session_id))).limit(1);
  const source = sourceRow && AppConnectionSessionRecordSchema.parse(sourceRow.record);
  if (!source || source.state !== 'connected' || source.revision !== proof.source_revision || !isDeepStrictEqual(source.scope, proof.source_scope)
    || !isDeepStrictEqual(source.profile, proof.source_profile) || appConsentDeadline(source.scope.consent_expires_at, source.scope.consent_lifetime) <= Date.now()) throw denied();
  const check = async (table: any, field: any, pins: readonly { id: string; digest: string }[]) => {
    for (const pin of pins) {
      const query = tx.select().from(table).where(and(eq(table.org_id, proof.org_id), eq(field, pin.id))).limit(1);
      const [row] = await (issuance ? query.for('share') : query);
      if (!row || row.state !== 'active' || rowDigest(row) !== pin.digest
        || ('expires_at' in row && appConsentDeadline(row.expires_at, row.snapshot?.consent_lifetime) <= Date.now())) throw denied(); }
  };
  await check(appResourceBindings, appResourceBindings.id, [proof.source_binding]);
  await check(appRuntimeRegistrations, appRuntimeRegistrations.id, [proof.source_registration]);
  await check(appOwnerConnectionAdmissions, appOwnerConnectionAdmissions.id, [proof.source_admission]);
  await check(appRuntimeBindings, appRuntimeBindings.id, proof.source_actions);
  if (issuance) {
    await check(appResourceObservationConsents, appResourceObservationConsents.consent_id, proof.source_observations);
    await check(appDataConsents, appDataConsents.consent_id, proof.source_data);
  }
  const members = await tx.select({ id: orgMembers.user_id, role: orgMembers.role, active: orgMembers.is_active, kind: users.kind, agent: users.is_agent })
    .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, proof.org_id), inArray(orgMembers.user_id, [proof.owner_id, proof.operator_id])));
  if (![[proof.owner_id, proof.owner_role], [proof.operator_id, proof.operator_role]].every(([id, role]) => members.some(m => m.id === id
    && m.role === role && m.active && m.kind === 'human' && !m.agent))) throw denied();
  return { installation, source, prior, target };
}
export function continuityGuard(proof: UpgradeContinuityProof): WebAuthorityGuard {
  return Object.assign(async (tx: UpgradeTx) => { await assertContinuityProof(tx, proof); },
    { current_web_session_expires_at: () => new Date(proof.issuance_expires_at) });
}
export async function retainedContinuityGuard(orgId: string, sessionId: string): Promise<WebAuthorityGuard | null> {
  return db.transaction(async tx => {
    const rows = await tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.org_id, orgId), eq(auditLog.action, UPGRADE_PROOF_ACTION),
      eq(auditLog.entity_id, sessionId), eq(auditLog.actor_type, 'system'))).limit(2);
    if (!rows.length) return null;
    if (rows.length !== 1) throw denied();
    const proof = UpgradeContinuityProofSchema.parse(rows[0]!.metadata);
    if (proof.request_id !== sessionId || proof.org_id !== orgId) throw denied();
    await assertContinuityProof(tx, proof); return continuityGuard(proof);
  });
}
