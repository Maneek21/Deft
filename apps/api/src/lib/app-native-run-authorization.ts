import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { NativePublicActionDeclarationSchema, NATIVE_ACTION_HOST_POLICY } from '@deft/app-kit';
import { APP_RUN_CONTRACT_VERSIONS, AppRunAuthorizationSnapshotSchema, canonicalCapabilityJson,
  type AppRunAuthorizationSnapshot } from '@deft/shared';
import { appCanonicalClaims, appModuleBindings, appPublicEndpoints, appPublicIngress,
  moduleInstallations, moduleRecords, moduleVersions } from '@deft/db/schema';
import { loadLiveNativeAuthority, nativeStale } from './app-native-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { acquirePublicBudgetAdmission } from './app-public-budgets.js';
import { publicNativeRecordFields, projectPublicNativeInput, validatePublicNativeMapping } from './app-public-native-mapping.js';
import type { AppRunTransaction } from './app-run-repository.js';

type Ref = AppRunAuthorizationSnapshot['authority_refs'][number];
const version = (domain: string, value: unknown) => `sha256:${createHash('sha256')
  .update(`deft.app_run.authority.v1\0${domain}\0`).update(canonicalCapabilityJson(value)).digest('hex')}`;
const ref = (authority_kind: Ref['authority_kind'], authority_id: string, value: unknown): Ref =>
  ({ authority_kind, authority_id, version: version(authority_kind, value) });

export async function captureReviewedNativeInTransaction(tx: AppRunTransaction, input: Readonly<{
  org_id: string; user_id: string; native_binding_id: string;
}>) {
  const current = await loadLiveNativeAuthority(tx, input);
  if (current.owner.member.user_id !== input.user_id) throw nativeStale();
  const { binding, installation, version: appVersion, grant, provider_snapshot, action } = current;
  const refs: Ref[] = [
    ...[current.owner.member, current.manager.member].filter((member, index, members) =>
      members.findIndex(other => other.user_id === member.user_id) === index).map(member =>
      ref('membership', member.user_id, { id: member.id, authority_version: member.app_run_authorization_version })),
    ref('app_surface', 'human:ui', { surface: 'human:ui', provider_kind: 'native' }),
    ref('app_installation', installation.id, { lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch }),
    ref('app_version', appVersion.id, { manifest_digest: appVersion.manifest_digest, package_digest: appVersion.package_digest }),
    ref('app_grant', grant.id, { snapshot_digest: grant.snapshot_digest }),
    ref('app_native_binding', binding.id, { proposal_digest: binding.proposal_digest, state: binding.state }),
    ref('app_native_owner_consent', binding.id, { owner_user_id: binding.owner_user_id, consent_digest: binding.consent_digest }),
    ref('provider_schema', `${binding.provider_instance_id}:${binding.operation_name}`,
      { snapshot_id: provider_snapshot.id, snapshot_digest: provider_snapshot.snapshot_digest, contract_digest: action.contract_digest }),
    ref('policy', `${binding.provider_instance_id}:${binding.operation_name}`,
      { host_policy_version: 'deft.native.calendar.host_policy.v1', policy: NATIVE_ACTION_HOST_POLICY }),
  ];
  const authorization_snapshot = AppRunAuthorizationSnapshotSchema.parse({
    schema_version: APP_RUN_CONTRACT_VERSIONS.run,
    authenticated_subject: { actor_type: 'human', user_id: input.user_id },
    authority_refs: refs.sort((a, b) => `${a.authority_kind}\0${a.authority_id}`.localeCompare(`${b.authority_kind}\0${b.authority_id}`)),
  });
  return { ...current, authorization_snapshot, provider_snapshot_digest: provider_snapshot.snapshot_digest };
}

/** Only admission projects the exact claimed record revision. Subsequent
 * approval/effect checks retain current authority without recomputing input. */
export async function captureReviewedPublicNativeInTransaction(tx: AppRunTransaction, input: Readonly<{
  org_id: string; endpoint_id: string; ingress_id: string; capture_input?: boolean;
}>) {
  const [locator] = await tx.select({ owner_id: appPublicEndpoints.approver_user_id,
    binding_id: appPublicEndpoints.native_binding_id }).from(appPublicEndpoints)
    .where(and(eq(appPublicEndpoints.org_id, input.org_id), eq(appPublicEndpoints.id, input.endpoint_id))).limit(1);
  if (!locator?.owner_id || !locator.binding_id) throw nativeStale();
  // The native helper discovers and locks every immutable participant before App.
  const native = await captureReviewedNativeInTransaction(tx, { org_id: input.org_id,
    user_id: locator.owner_id, native_binding_id: locator.binding_id });
  await acquirePublicBudgetAdmission(tx, input.org_id, native.installation.id);
  const [endpoint] = await tx.select().from(appPublicEndpoints).where(and(eq(appPublicEndpoints.org_id, input.org_id),
    eq(appPublicEndpoints.id, input.endpoint_id))).limit(1).for('share');
  const { publicEndpointReviewDigest } = await import('./app-public-service.js');
  if (!endpoint || endpoint.state !== 'enabled' || endpoint.approver_user_id !== locator.owner_id
    || endpoint.native_binding_id !== native.binding.id || endpoint.runtime_binding_id || endpoint.input_mapping
    || endpoint.app_installation_id !== native.installation.id || endpoint.app_version_id !== native.version.id
    || endpoint.grant_snapshot_id !== native.grant.id || endpoint.installation_lifecycle_epoch !== native.installation.lifecycle_epoch
    || endpoint.installation_grant_epoch !== native.installation.grant_epoch || endpoint.review_digest !== publicEndpointReviewDigest(endpoint)
    || !endpoint.public_action_key || !endpoint.native_input_mapping
    || endpoint.mapping_digest !== digestAppGrantValue(endpoint.native_input_mapping)) throw nativeStale();
  const declaration = NativePublicActionDeclarationSchema.parse(native.manifest.public_actions.find(item => item.key === endpoint.public_action_key));
  if (declaration.action_key !== native.action.key || declaration.collection_key !== endpoint.collection_key
    || canonicalCapabilityJson(declaration.input_mapping) !== canonicalCapabilityJson(endpoint.native_input_mapping)) throw nativeStale();
  const [module] = await tx.select().from(moduleInstallations).where(and(eq(moduleInstallations.org_id, input.org_id),
    eq(moduleInstallations.id, endpoint.module_installation_id))).limit(1).for('share');
  const [moduleBinding] = await tx.select().from(appModuleBindings).where(and(eq(appModuleBindings.org_id, input.org_id),
    eq(appModuleBindings.app_installation_id, native.installation.id), eq(appModuleBindings.app_version_id, native.version.id),
    eq(appModuleBindings.module_installation_id, endpoint.module_installation_id), eq(appModuleBindings.module_id, declaration.module_id))).limit(1);
  if (!module || module.is_deleted || !module.is_enabled || module.module_id !== declaration.module_id
    || !moduleBinding || moduleBinding.ownership !== 'app') throw nativeStale();
  const [moduleVersion] = await tx.select().from(moduleVersions).where(and(eq(moduleVersions.org_id, input.org_id),
    eq(moduleVersions.installation_id, module.id), eq(moduleVersions.id, moduleBinding.module_version_id), eq(moduleVersions.is_active, true))).limit(1);
  if (!moduleVersion) throw nativeStale();
  const mapping = validatePublicNativeMapping(endpoint.native_input_mapping, moduleVersion.manifest, endpoint.collection_key, native.action.operation);
  const [ingress] = await tx.select().from(appPublicIngress).where(and(eq(appPublicIngress.org_id, input.org_id),
    eq(appPublicIngress.endpoint_id, endpoint.id), eq(appPublicIngress.id, input.ingress_id))).limit(1).for('share');
  if (!ingress || ingress.endpoint_epoch !== endpoint.endpoint_epoch || ingress.state !== 'confirmed'
    || !['pending', 'run_created'].includes(ingress.follow_up_state)) throw nativeStale();
  const [claim] = await tx.select().from(appCanonicalClaims).where(and(eq(appCanonicalClaims.org_id, input.org_id),
    eq(appCanonicalClaims.endpoint_id, endpoint.id), eq(appCanonicalClaims.ingress_id, ingress.id))).limit(1).for('share');
  if (!claim || claim.released_at || claim.claim_kind !== 'exclusive' || claim.provider_kind !== 'module'
    || claim.provider_instance_id !== module.id || claim.resource_type !== endpoint.collection_key || !claim.claimed_resource_revision) throw nativeStale();
  let public_input;
  if (input.capture_input) {
    const fields = publicNativeRecordFields(mapping);
    const selected = sql<Record<string, unknown>>`jsonb_build_object(${sql.join(fields.flatMap(field =>
      [sql`${field}::text`, sql`${moduleRecords.data} -> ${field}::text`]), sql`, `)})`;
    const [record] = await tx.select({ revision: moduleRecords.revision, validated_version_id: moduleRecords.validated_version_id, data: selected })
      .from(moduleRecords).where(and(eq(moduleRecords.org_id, input.org_id), eq(moduleRecords.installation_id, module.id),
        eq(moduleRecords.collection_key, endpoint.collection_key), eq(moduleRecords.id, claim.resource_id), eq(moduleRecords.is_deleted, false))).limit(1).for('share');
    if (!record || record.revision !== claim.claimed_resource_revision || record.validated_version_id !== moduleVersion.id) throw nativeStale();
    public_input = projectPublicNativeInput({ mapping, resource_id: claim.resource_id, claim_id: claim.id, data: record.data, operation: native.action.operation });
  }
  const refs = native.authorization_snapshot.authority_refs.filter(item => item.authority_kind !== 'app_surface');
  refs.push(ref('app_surface', 'public:ingress', { surface: 'public:ingress', provider_kind: 'native' }),
    ref('app_public_endpoint', endpoint.id, { review_digest: endpoint.review_digest, endpoint_epoch: endpoint.endpoint_epoch, module_version_id: moduleVersion.id }),
    ref('app_public_ingress', ingress.id, { endpoint_epoch: ingress.endpoint_epoch, request_key_digest: ingress.request_key_digest, input_digest: ingress.input_digest }),
    ref('app_public_claim', claim.id, { provider_instance_id: claim.provider_instance_id, resource_type: claim.resource_type,
      resource_id: claim.resource_id, claimed_resource_revision: claim.claimed_resource_revision, released_at: claim.released_at }));
  const authorization_snapshot = AppRunAuthorizationSnapshotSchema.parse({ schema_version: APP_RUN_CONTRACT_VERSIONS.run,
    authenticated_subject: { actor_type: 'app_public', endpoint_id: endpoint.id, ingress_id: ingress.id },
    authority_refs: refs.sort((a, b) => `${a.authority_kind}\0${a.authority_id}`.localeCompare(`${b.authority_kind}\0${b.authority_id}`)),
  });
  return { ...native, authorization_snapshot, endpoint, ingress, claim, public_input };
}

export type ReviewedNativeCapture = Awaited<ReturnType<typeof captureReviewedNativeInTransaction>>;
export type ReviewedPublicNativeCapture = Awaited<ReturnType<typeof captureReviewedPublicNativeInTransaction>>;
