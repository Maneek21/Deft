import { and, eq, inArray, or, sql, type SQLWrapper } from 'drizzle-orm';
import { alias as tableAlias, type PgSelect } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { appResourceBindings, appRuntimeRegistrations, appInstallations, appVersions, appConnectionSessions,
  appOwnerConnectionAdmissions, appRuntimeBindings, orgMembers, users, auditLog } from '@deft/db/schema';
import { db } from './db.js';
import { createAppAuthorityContentCache } from './app-authority-content-cache.js';
import { appConsentDeadline } from '@deft/app-kit/core';
import { assertContinuityProof, UpgradeContinuityProofSchema, UPGRADE_ALIAS_ACTION, UPGRADE_PROOF_ACTION,
  type UpgradeContinuityProof, type ReadOnlyContinuityFacts, type AppContinuityDatabaseContentFingerprint, type UpgradeTx } from './app-upgrade-trust-continuity.js';
import { AppConnectionSessionRegistryConfigSchema, connectionProfileDigest, connectionTransportEntryDigest } from './app-connection-session-registry.js';

const id = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const UpgradeRegistrationAliasSchema = z.strictObject({ schema_version: z.literal('deft.app_upgrade_registration.v1'), proof_id: id,
  org_id: id, installation_id: id, registration_id: id, binding_id: id, runtime_epoch: z.number().int().positive(),
  source_registration_id: id, source_runtime_epoch: z.number().int().positive(), profile_digest: digest, transport_digest: digest });
type Entry = z.infer<typeof AppConnectionSessionRegistryConfigSchema>['entries'][number];
type Alias = z.infer<typeof UpgradeRegistrationAliasSchema>;
type SuccessorBinding = Pick<typeof appResourceBindings.$inferSelect,
  'id' | 'org_id' | 'state' | 'app_installation_id' | 'app_version_id' | 'grant_snapshot_id' |
  'runtime_registration_id' | 'owner_user_id' | 'consent_expires_at' | 'consent_lifetime'>;
type SuccessorRegistration = Pick<typeof appRuntimeRegistrations.$inferSelect,
  'id' | 'org_id' | 'state' | 'runtime_epoch' | 'app_version_id' | 'grant_snapshot_id' | 'operator_user_id'>;
const key = (org: string, registration: string, epoch: number) => `${org}:${registration}:${epoch}`;
function assertSuccessor(alias: Alias, proof: UpgradeContinuityProof,
  binding: SuccessorBinding | null, registration: SuccessorRegistration | null) {
  if (!binding || !registration || binding.org_id !== alias.org_id || registration.org_id !== alias.org_id
    || binding.id !== alias.binding_id || registration.id !== alias.registration_id
    || binding.state !== 'active' || registration.state !== 'active'
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

const proofAudit = tableAlias(auditLog, 'registry_proof_audit');
const trustAudit = tableAlias(auditLog, 'registry_trust_audit');
const priorVersion = tableAlias(appVersions, 'registry_prior_version');
const targetVersion = tableAlias(appVersions, 'registry_target_version');
const ownerMember = tableAlias(orgMembers, 'registry_owner_member');
const operatorMember = tableAlias(orgMembers, 'registry_operator_member');
const ownerUser = tableAlias(users, 'registry_owner_user');
const operatorUser = tableAlias(users, 'registry_operator_user');
const successorBinding = tableAlias(appResourceBindings, 'registry_successor_binding');
const successorRegistration = tableAlias(appRuntimeRegistrations, 'registry_successor_registration');
// Audit metadata is validated again in JS. Malformed IDs become absent joins,
// so malformed metadata cannot nominate an unrelated owner's proof.
const uuid = (value: ReturnType<typeof sql>) => sql<string>`CASE WHEN ${value} ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' THEN ${value} ELSE NULL END`;


const currentFactSelection = {
    installation: { id: appInstallations.id, org_id: appInstallations.org_id, state: appInstallations.state,
      active_version_id: appInstallations.active_version_id, active_grant_snapshot_id: appInstallations.active_grant_snapshot_id,
      lifecycle_epoch: appInstallations.lifecycle_epoch, grant_epoch: appInstallations.grant_epoch }, prior: { id: priorVersion.id, manifest: priorVersion.manifest },
    target: { id: targetVersion.id, manifest: targetVersion.manifest },
    source: { org_id: appConnectionSessions.org_id, owner_user_id: appConnectionSessions.owner_user_id,
      session_id: appConnectionSessions.session_id, record: appConnectionSessions.record },
    binding: appResourceBindings, registration: appRuntimeRegistrations, admission: appOwnerConnectionAdmissions,
    trust: { after_state: sql`"registry_trust"."after_state"` },
    owner: { id: ownerMember.user_id, role: ownerMember.role, active: ownerMember.is_active, kind: ownerUser.kind, agent: ownerUser.is_agent },
    operator: { id: operatorMember.user_id, role: operatorMember.role, active: operatorMember.is_active, kind: operatorUser.kind, agent: operatorUser.is_agent },
    // Successors are checked field-by-field, unlike the complete digest-bound
    // source rows above. Project only the exact current admission inputs.
    successor_binding: { id: successorBinding.id, org_id: successorBinding.org_id, state: successorBinding.state,
      app_installation_id: successorBinding.app_installation_id, app_version_id: successorBinding.app_version_id,
      grant_snapshot_id: successorBinding.grant_snapshot_id, runtime_registration_id: successorBinding.runtime_registration_id,
      owner_user_id: successorBinding.owner_user_id, consent_expires_at: successorBinding.consent_expires_at,
      consent_lifetime: successorBinding.consent_lifetime },
    successor_registration: { id: successorRegistration.id, org_id: successorRegistration.org_id, state: successorRegistration.state,
      runtime_epoch: successorRegistration.runtime_epoch, app_version_id: successorRegistration.app_version_id,
      grant_snapshot_id: successorRegistration.grant_snapshot_id, operator_user_id: successorRegistration.operator_user_id }
};
const jsonObject = (fields: Readonly<Record<string, SQLWrapper>>) => sql`jsonb_build_object(${sql.join(
  Object.entries(fields).flatMap(([label, value]) => [sql`${label}::text`, sql`${value}`]), sql`, `)})`;
// These are actual persisted bytes. Advertised package/grant digests never
// substitute for content, and version packages are neither hashed nor selected.
const currentFingerprint = sql<AppContinuityDatabaseContentFingerprint>`'sha256:' || encode(sha256(convert_to(${jsonObject({
  installation: jsonObject(currentFactSelection.installation), prior: jsonObject(currentFactSelection.prior),
  target: jsonObject(currentFactSelection.target), source: jsonObject(currentFactSelection.source),
  binding: sql`to_jsonb(${appResourceBindings})`, registration: sql`to_jsonb(${appRuntimeRegistrations})`,
  admission: sql`to_jsonb(${appOwnerConnectionAdmissions})`, trust: jsonObject(currentFactSelection.trust),
  owner: jsonObject(currentFactSelection.owner), operator: jsonObject(currentFactSelection.operator),
  successor_binding: jsonObject(currentFactSelection.successor_binding), successor_registration: jsonObject(currentFactSelection.successor_registration),
})}::text, 'UTF8')), 'hex')`;

function currentRegistryQuery(tx: UpgradeTx, entries: readonly Entry[]) {
  // Bound the original alias row set BEFORE any proof or point-fact joins.
  // Separate ordinals retain duplicate aliases independently of proof cardinality.
  const limited = tx.select({ org_id: auditLog.org_id, metadata: auditLog.metadata }).from(auditLog)
    .innerJoin(appResourceBindings, and(eq(appResourceBindings.org_id, auditLog.org_id),
      eq(appResourceBindings.runtime_registration_id, auditLog.entity_id)))
    .innerJoin(appInstallations, and(eq(appInstallations.org_id, appResourceBindings.org_id),
      eq(appInstallations.id, appResourceBindings.app_installation_id), eq(appInstallations.active_version_id, appResourceBindings.app_version_id)))
    .where(and(inArray(auditLog.org_id, [...new Set(entries.map(entry => entry.org_id))]),
      eq(auditLog.action, UPGRADE_ALIAS_ACTION), eq(auditLog.actor_type, 'system'), eq(auditLog.entity_type, 'app_runtime_registration')))
    .limit(257).as('registry_alias_limit');
  const aliases = tx.select({ org_id: limited.org_id, metadata: limited.metadata,
    ordinal: sql<number>`cast(row_number() over () as integer)`.as('alias_ordinal'),
    total: sql<number>`cast(count(*) over () as integer)`.as('alias_total') }).from(limited).as('registry_aliases');
  const aliasId = (field: string) => uuid(sql`${aliases.metadata}->>${field}`);
  const proof = tx.select({ audit_id: proofAudit.id, metadata: proofAudit.metadata }).from(proofAudit)
    .where(and(eq(proofAudit.org_id, aliases.org_id), eq(proofAudit.action, UPGRADE_PROOF_ACTION),
      eq(proofAudit.actor_type, 'system'), eq(proofAudit.entity_type, 'app_connection_session'),
      eq(proofAudit.entity_id, aliasId('proof_id')))).limit(2).as('registry_proof');
  const proofId = (field: string) => uuid(sql`${proof.metadata}->>${field}`);
  const pinId = (field: string) => uuid(sql`${proof.metadata}->${field}->>'id'`);
  // Valid current revisions sort as before. Malformed revisions sort first and
  // fail the shared strict decoder, without a batch-wide SQL cast exception.
  const revision = sql`CASE WHEN ${trustAudit.after_state}->>'revision' ~ '^(0|[1-9][0-9]{0,9})$'
    AND length(${trustAudit.after_state}->>'revision') <= 10
    THEN (${trustAudit.after_state}->>'revision')::bigint ELSE NULL END`;
  const trust = tx.select({ after_state: trustAudit.after_state }).from(trustAudit).where(and(
    eq(trustAudit.org_id, aliases.org_id), eq(trustAudit.entity_type, 'app_installation'),
    eq(trustAudit.entity_id, proofId('installation_id')), eq(trustAudit.action, 'app.upgrade_continuity_trust_changed'),
    eq(trustAudit.actor_type, 'human'))).orderBy(sql`${revision} DESC NULLS FIRST`).limit(1).as('registry_trust');
  // Probe immutable metadata by actual DB bytes too. Do not decode/walk the
  // entire retained proof merely to discover that the same content is cached.
  const probeHeader = { ordinal: aliases.ordinal, alias_total: aliases.total, alias_org_id: aliases.org_id,
    alias_registration_id: aliasId('registration_id'), target_version_id: proofId('version_id'),
    metadata_fingerprint: sql<string>`'sha256:' || encode(sha256(convert_to(to_jsonb(ROW(${aliases.metadata}, ${proof.audit_id}, ${proof.metadata}))::text, 'UTF8')), 'hex')`,
    content_fingerprint: currentFingerprint };
  const header = { ...probeHeader, alias_metadata: aliases.metadata, proof_audit_id: proof.audit_id, proof_metadata: proof.metadata };
  const join = <Query extends PgSelect>(query: Query) => query
    .leftJoinLateral(proof, sql`true`)
    .leftJoin(appInstallations, and(eq(appInstallations.org_id, aliases.org_id), eq(appInstallations.id, proofId('installation_id'))))
    .leftJoin(priorVersion, and(eq(priorVersion.org_id, aliases.org_id), eq(priorVersion.installation_id, proofId('installation_id')), eq(priorVersion.id, proofId('prior_version_id'))))
    .leftJoin(targetVersion, and(eq(targetVersion.org_id, aliases.org_id), eq(targetVersion.installation_id, proofId('installation_id')), eq(targetVersion.id, proofId('version_id'))))
    .leftJoin(appConnectionSessions, and(eq(appConnectionSessions.org_id, aliases.org_id), eq(appConnectionSessions.owner_user_id, proofId('owner_id')), eq(appConnectionSessions.session_id, proofId('source_session_id'))))
    .leftJoin(appResourceBindings, and(eq(appResourceBindings.org_id, aliases.org_id), eq(appResourceBindings.id, pinId('source_binding'))))
    .leftJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, aliases.org_id), eq(appRuntimeRegistrations.id, pinId('source_registration'))))
    .leftJoin(appOwnerConnectionAdmissions, and(eq(appOwnerConnectionAdmissions.org_id, aliases.org_id), eq(appOwnerConnectionAdmissions.id, pinId('source_admission'))))
    .leftJoin(ownerMember, and(eq(ownerMember.org_id, aliases.org_id), eq(ownerMember.user_id, proofId('owner_id'))))
    .leftJoin(ownerUser, eq(ownerUser.id, ownerMember.user_id))
    .leftJoin(operatorMember, and(eq(operatorMember.org_id, aliases.org_id), eq(operatorMember.user_id, proofId('operator_id'))))
    .leftJoin(operatorUser, eq(operatorUser.id, operatorMember.user_id))
    .leftJoinLateral(trust, sql`true`)
    .leftJoin(successorBinding, and(eq(successorBinding.org_id, aliases.org_id), eq(successorBinding.id, aliasId('binding_id'))))
    .leftJoin(successorRegistration, and(eq(successorRegistration.org_id, aliases.org_id), eq(successorRegistration.id, aliasId('registration_id'))))
    .where(sql`${aliases.total} <= 256`);
  // Prepare on this invocation's transaction session only. Never retain a
  // transaction-bound handle. Shape depends on mode and unique org count.
  const count = new Set(entries.map(entry => entry.org_id)).size;
  return { probe: () => join(tx.select(probeHeader).from(aliases).$dynamic()).prepare('deft_registry_probe_v2_o' + count).execute(),
    full: () => join(tx.select({ ...header, ...currentFactSelection }).from(aliases).$dynamic()).prepare('deft_registry_full_v2_o' + count).execute() };
}
type RegistryRows = Awaited<ReturnType<ReturnType<typeof currentRegistryQuery>['full']>>;
type RegistryHeader = Pick<RegistryRows[number], 'ordinal' | 'alias_total' | 'alias_org_id' |
  'alias_registration_id' | 'target_version_id' | 'metadata_fingerprint' | 'content_fingerprint'>;
const currentContent = createAppAuthorityContentCache<RegistryRows>({ maxEntries: 8, maxBytes: 16 * 1024 * 1024 });
const contentMiss = Symbol('registry-content-miss');
function contentIdentity(entries: readonly Entry[], rows: readonly RegistryHeader[]) {
  const orgs = new Set(entries.map(entry => entry.org_id));
  if (orgs.size !== 1 || !rows.length || rows.length > 512) return;
  const org = entries[0]!.org_id, versions = new Set<string>(), ordinals = new Set<number>(), aliases = new Set<string>();
  for (const row of rows) {
    if (row.alias_org_id !== org || row.alias_total !== rows.length || row.alias_total > 256 || ordinals.has(row.ordinal)
      || ![row.content_fingerprint, row.metadata_fingerprint].every(value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value))) return;
    // Both scalar IDs and all metadata bytes come from this statement snapshot.
    // Full B still strictly parses scope/identity/proof fields before seeding.
    const registration = id.safeParse(row.alias_registration_id), version = id.safeParse(row.target_version_id);
    if (!registration.success || !version.success || aliases.has(registration.data)) return;
    ordinals.add(row.ordinal); aliases.add(registration.data); versions.add(version.data);
  }
  if (versions.size !== 1) return;
  return { scope: { org_id: org, app_version_id: [...versions][0]! }, evidence: rows.map(row => ({
    ordinal: row.ordinal, alias_total: row.alias_total, alias_org_id: row.alias_org_id,
    alias_registration_id: row.alias_registration_id, target_version_id: row.target_version_id,
    metadata_fingerprint: row.metadata_fingerprint, content_fingerprint: row.content_fingerprint,
  })) };
}
/** Only installation-specific server-authored lineage may nominate a successor.
 * No endpoint, profile, credential, origin or epoch is inferred from app input.
 * The original deployment file remains the transport root of trust. */
export async function trustedUpgradeRegistryEntries(entries: readonly Entry[], transaction?: UpgradeTx): Promise<Entry[]> {
  if (!entries.length) return [];
  const read = async (tx: UpgradeTx) => {
    const query = currentRegistryQuery(tx, entries);
    let rows: RegistryRows | undefined, full = true;
    if (new Set(entries.map(entry => entry.org_id)).size === 1) {
      const probe = await query.probe(), identity = contentIdentity(entries, probe);
      if (identity) try { rows = currentContent(identity.scope, identity.evidence, () => { throw contentMiss; }); full = false; }
      catch (error) { if (error !== contentMiss) throw error; }
    }
    // A miss discards ALL probe facts. Metadata, cardinality, nominations,
    // action pins, validation and cache evidence now come solely from full B.
    rows ??= await query.full();
    const identity = full ? contentIdentity(entries, rows) : undefined;
    const groups = new Map<number, typeof rows>();
    for (const row of rows) {
      if (row.alias_total > 256) return [];
      const group = groups.get(row.ordinal) ?? []; group.push(row); groups.set(row.ordinal, group);
    }
    if (groups.size > 256) return [];
    const aliases = [...groups.values()].map(group => ({ alias: UpgradeRegistrationAliasSchema.parse(group[0]!.alias_metadata), group }));
    if (new Set(aliases.map(({ alias }) => key(alias.org_id, alias.registration_id, alias.runtime_epoch))).size !== aliases.length) return [];
    const nominated: { alias: Alias; proof: UpgradeContinuityProof; rows: typeof rows[number] }[] = [];
    for (const { alias, group } of aliases) {
      if (alias.org_id !== group[0]!.alias_org_id) continue;
      if (entries.some(entry => key(entry.org_id, entry.runtime_registration_id, entry.runtime_epoch) === key(alias.org_id, alias.registration_id, alias.runtime_epoch))) continue;
      if (group.length !== 1 || !group[0]!.proof_audit_id) continue;
      try {
        const proof = UpgradeContinuityProofSchema.parse(group[0]!.proof_metadata);
        if (proof.request_id !== alias.proof_id || proof.org_id !== alias.org_id || proof.installation_id !== alias.installation_id) continue;
        nominated.push({ alias, proof, rows: group[0]! });
      } catch { /* One missing/malformed/ambiguous proof cannot authorize its alias. */ }
    }
    const pins = nominated.flatMap(({ proof }) => proof.source_actions.map(pin => ({ org: proof.org_id, id: pin.id })));
    const actions = pins.length ? await tx.select().from(appRuntimeBindings).where(or(...pins.map(pin =>
      and(eq(appRuntimeBindings.org_id, pin.org), eq(appRuntimeBindings.id, pin.id))))).limit(pins.length) : [];
    const output: Entry[] = [];
    for (const { alias, proof, rows: current } of nominated) {
      try {
        const facts: ReadOnlyContinuityFacts = current;
        await assertContinuityProof(tx, proof, true, false, { rows: facts, content_fingerprint: current.content_fingerprint,
          actions: actions.filter(row => row.org_id === proof.org_id && proof.source_actions.some(pin => pin.id === row.id)) });
        assertSuccessor(alias, proof, current.successor_binding, current.successor_registration);
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
    // Store decoded content only after the complete full snapshot validates.
    // Root/config matching and allowed outcomes are never retained. A hit still
    // runs every validator above, fresh action reads and all live boundaries.
    if (identity && output.length > 0 && output.length === nominated.length && nominated.length === aliases.length)
      currentContent(identity.scope, identity.evidence, () => rows!);
    return output;
  };
  return transaction ? read(transaction) : db.transaction(read);
}
