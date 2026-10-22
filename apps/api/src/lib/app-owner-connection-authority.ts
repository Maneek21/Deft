import { and, eq, inArray, exists, sql } from 'drizzle-orm';
import { appOwnerConnectionAdmissions, orgMembers, users, capabilityProviderSnapshots, appConnectionConsentContinuations, type appRuntimeRegistrations, type appResourceBindings } from '@deft/db/schema';
import { alias } from 'drizzle-orm/pg-core';
import type { AppRunTransaction } from './app-run-repository.js';
import { loadReviewedAttachmentApp } from './app-attachment-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { OwnerConnectionAdmissionSnapshotSchema, type OwnerConnectionAdmissionReference } from './app-owner-connection-contract.js';
import { connectionProfileDigest, getAppConnectionSessionRegistry, type AppConnectionSessionRegistry } from './app-connection-session-registry.js';
import { isAppOwnerConnectionsEnabled } from './env.js';
import { AppError } from './app-errors.js';
import { runtimeActionDescriptors } from './app-runtime-review.js';
import { digestAppAuthorityDescriptor } from './app-authority-descriptor.js';
import { parseAppAuthorityManifest } from './app-authority-manifest.js';

type LockedReviewedApp = Pick<Awaited<ReturnType<typeof loadReviewedAttachmentApp>>, 'installation' | 'version' | 'grant'>
  & Partial<Pick<Awaited<ReturnType<typeof loadReviewedAttachmentApp>>, 'manifest'>>;

const factOwnerMember=alias(orgMembers,'connection_fact_owner_member'),factOperatorMember=alias(orgMembers,'connection_fact_operator_member');
const factOwnerUser=alias(users,'connection_fact_owner_user'),factOperatorUser=alias(users,'connection_fact_operator_user');
export type CurrentOwnerConnectionBindingFacts=Readonly<{org_id:string;owner_user_id:string;operator_user_id:string;
 resource_binding_id:string;runtime_registration_id:string;provider_snapshot:typeof capabilityProviderSnapshots.$inferSelect}>;
type CurrentBindingRead=Readonly<{binding:typeof appResourceBindings.$inferSelect;
 onFacts:(facts:CurrentOwnerConnectionBindingFacts)=>void}>;

/** Only an operational reader with this exact locked binding opts in. All facts
 * are read after the admission lock and current registry proof waits. LEFT JOINs
 * preserve missing participants/provider evidence as failures, not omissions. */
async function currentBindingFacts(tx:AppRunTransaction,orgId:string,row:typeof appOwnerConnectionAdmissions.$inferSelect,
 ownerId:string,binding:typeof appResourceBindings.$inferSelect):Promise<CurrentOwnerConnectionBindingFacts>{
 const rows=await tx.select({provider_snapshot:capabilityProviderSnapshots,
  owner:{user_id:factOwnerMember.user_id,active:factOwnerMember.is_active,role:factOwnerMember.role,kind:factOwnerUser.kind,is_agent:factOwnerUser.is_agent},
  operator:{user_id:factOperatorMember.user_id,active:factOperatorMember.is_active,role:factOperatorMember.role,kind:factOperatorUser.kind,is_agent:factOperatorUser.is_agent},
  pending:exists(tx.select({id:appConnectionConsentContinuations.session_id}).from(appConnectionConsentContinuations).where(and(
   eq(appConnectionConsentContinuations.org_id,orgId),eq(appConnectionConsentContinuations.resource_binding_id,binding.id),
   sql`${appConnectionConsentContinuations.record}->'activation_started'='true'::jsonb`,sql`${appConnectionConsentContinuations.record}->>'state'<>'connected'`))),
 }).from(appOwnerConnectionAdmissions)
  .leftJoin(factOwnerMember,and(eq(factOwnerMember.org_id,orgId),eq(factOwnerMember.user_id,ownerId)))
  .leftJoin(factOwnerUser,eq(factOwnerUser.id,factOwnerMember.user_id))
  .leftJoin(factOperatorMember,and(eq(factOperatorMember.org_id,orgId),eq(factOperatorMember.user_id,row.operator_user_id)))
  .leftJoin(factOperatorUser,eq(factOperatorUser.id,factOperatorMember.user_id))
  .leftJoin(capabilityProviderSnapshots,and(eq(capabilityProviderSnapshots.org_id,orgId),eq(capabilityProviderSnapshots.id,binding.provider_snapshot_id)))
  .where(and(eq(appOwnerConnectionAdmissions.org_id,orgId),eq(appOwnerConnectionAdmissions.id,row.id),eq(appOwnerConnectionAdmissions.review_digest,row.review_digest))).limit(2);
 if(rows.length!==1)throw ownerConnectionDenied();
 const current=rows[0]!;
 for(const [id,member] of [[ownerId,current.owner],[row.operator_user_id,current.operator]] as const){
  if(!member||member.user_id!==id||!member.active||member.role===null||!['owner','admin','member'].includes(member.role)
   ||member.kind!=='human'||member.is_agent!==false)throw ownerConnectionDenied();
 }
 if(current.pending||!current.provider_snapshot||current.provider_snapshot.org_id!==orgId
  ||current.provider_snapshot.id!==binding.provider_snapshot_id)throw ownerConnectionDenied();
 return {org_id:orgId,owner_user_id:ownerId,operator_user_id:row.operator_user_id,resource_binding_id:binding.id,
  runtime_registration_id:binding.runtime_registration_id,provider_snapshot:current.provider_snapshot};
}


export const ownerConnectionDenied = () => new AppError('Private owner connection authority unavailable', 'APP_ACCESS_DENIED', 403);
async function assertMembers(tx: AppRunTransaction, orgId: string, ids: readonly string[]) {
  const members = await tx.select({ user_id: orgMembers.user_id, active: orgMembers.is_active, role: orgMembers.role,
    kind: users.kind, is_agent: users.is_agent }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, orgId), inArray(orgMembers.user_id, [...new Set(ids)])));
  if (!ids.every(id => members.some(member => member.user_id === id && member.active
    && ['owner', 'admin', 'member'].includes(member.role) && member.kind === 'human' && member.is_agent === false))) throw ownerConnectionDenied();
  return members;
}
export async function assertOwnerConnectionMember(tx: AppRunTransaction, orgId: string, ownerId: string) {
  return (await assertMembers(tx, orgId, [ownerId]))[0]!;
}
export async function loadOwnerConnectionAdmission(tx: AppRunTransaction, orgId: string, reference: OwnerConnectionAdmissionReference,
  lockedReviewed?: LockedReviewedApp, ownerUserId?: string, onConnectionRegistry?: (registry: AppConnectionSessionRegistry) => void, currentBindingRead?:CurrentBindingRead) {
  if (!isAppOwnerConnectionsEnabled()) throw ownerConnectionDenied();
  const condition = and(eq(appOwnerConnectionAdmissions.org_id, orgId), eq(appOwnerConnectionAdmissions.id, reference.admission_id),
    eq(appOwnerConnectionAdmissions.review_digest, reference.admission_digest));
  const locator = lockedReviewed ? { app_installation_id: lockedReviewed.installation.id }
    : (await tx.select({ app_installation_id: appOwnerConnectionAdmissions.app_installation_id })
      .from(appOwnerConnectionAdmissions).where(condition).limit(1))[0];
  if (!locator) throw ownerConnectionDenied();
  // Only current authority readers may supply rows they already validated and
  // locked in this exact transaction. Admission/membership are always reread.
  const reviewed = lockedReviewed ? { ...lockedReviewed, manifest: lockedReviewed.manifest
    ?? parseAppAuthorityManifest(lockedReviewed.version.manifest, {org_id: orgId, app_version_id: lockedReviewed.version.id}) }
    : await loadReviewedAttachmentApp(tx, orgId, locator.app_installation_id);
  if (reviewed.installation.org_id !== orgId || reviewed.installation.id !== locator.app_installation_id
    || reviewed.installation.state !== 'active' || reviewed.version.state !== 'active'
    || reviewed.version.org_id !== orgId || reviewed.version.installation_id !== reviewed.installation.id
    || reviewed.version.protocol_version !== '7' || reviewed.installation.active_version_id !== reviewed.version.id
    || reviewed.grant.org_id !== orgId || reviewed.grant.app_installation_id !== reviewed.installation.id
    || reviewed.grant.app_version_id !== reviewed.version.id || reviewed.grant.snapshot_kind !== 'effective'
    || reviewed.installation.active_grant_snapshot_id !== reviewed.grant.id) throw ownerConnectionDenied();
  const [row] = await tx.select().from(appOwnerConnectionAdmissions).where(condition).limit(1).for('share');
  if (!row || row.state !== 'active' || row.revoked_at || row.app_installation_id !== reviewed.installation.id) throw ownerConnectionDenied();
  const snapshot = OwnerConnectionAdmissionSnapshotSchema.parse(row.snapshot);
  const policy = reviewed.manifest.owner_connections?.find(item => item.key === row.policy_key);
  // One current deployment/proof read belongs to this locked admission check.
  // Later invoke/disclosure phases acquire their own registry and mutable rows.
  const registry = policy && (policy.provider_profile_key !== undefined || policy.runtime_requirement_key !== undefined)
    ? await getAppConnectionSessionRegistry(tx) : undefined;
  const profile = registry && policy ? registry.profile(orgId, reviewed.installation.id, policy, row.operator_user_id) : undefined;
  if (profile ? snapshot.connection_profile_digest !== connectionProfileDigest(profile)
    || snapshot.connection_transport_digest !== registry!.transportDigest(orgId, reviewed.installation.id, profile)
    || digestAppGrantValue(snapshot.connection_profile) !== digestAppGrantValue(profile)
    : snapshot.connection_profile !== undefined || snapshot.connection_profile_digest !== undefined) throw ownerConnectionDenied();
  if (!policy || digestAppGrantValue(snapshot) !== row.review_digest || snapshot.org_id !== orgId
    || snapshot.installation_id !== row.app_installation_id || snapshot.app_version_id !== reviewed.version.id
    || snapshot.grant_snapshot_id !== reviewed.grant.id || row.app_version_id !== reviewed.version.id || row.grant_snapshot_id !== reviewed.grant.id
    || snapshot.operator_user_id !== row.operator_user_id || snapshot.package_digest !== reviewed.version.package_digest
    || snapshot.grant_snapshot_digest !== reviewed.grant.snapshot_digest || snapshot.lifecycle_epoch !== reviewed.installation.lifecycle_epoch
    || snapshot.grant_epoch !== reviewed.installation.grant_epoch || snapshot.policy_digest !== digestAppGrantValue(policy)
    || digestAppGrantValue(snapshot.policy) !== digestAppGrantValue(policy)) throw ownerConnectionDenied();
  const factBinding=currentBindingRead?.binding;
  if(factBinding&&(factBinding.org_id!==orgId||factBinding.owner_user_id!==ownerUserId
    ||factBinding.app_installation_id!==row.app_installation_id||factBinding.app_version_id!==row.app_version_id
    ||factBinding.grant_snapshot_id!==row.grant_snapshot_id||factBinding.resource_key!==policy.resource_key))throw ownerConnectionDenied();
  const bindingFacts=currentBindingRead&&ownerUserId
    ?await currentBindingFacts(tx,orgId,row,ownerUserId,currentBindingRead.binding):undefined;
  if(!currentBindingRead)await assertMembers(tx, orgId, [row.operator_user_id, ...(ownerUserId ? [ownerUserId] : [])]);
  else if(!bindingFacts)throw ownerConnectionDenied();
  const descriptor = reviewed.manifest.sync_descriptors.find(item => item.key === policy.resource_key);
  const actions = runtimeActionDescriptors(reviewed.manifest).filter(item => policy.action_keys.includes(item.action_key))
    .map(item => ({ action_key: item.action_key, contract_digest: item.contract_digest }))
    .sort((a,b) => a.action_key < b.action_key ? -1 : a.action_key > b.action_key ? 1 : 0);
  if (!descriptor || snapshot.resource_descriptor_digest !== await digestAppAuthorityDescriptor(descriptor, { org_id: orgId, app_version_id: reviewed.version.id })
    || digestAppGrantValue(snapshot.actions) !== digestAppGrantValue(actions)) throw ownerConnectionDenied();
  // The registry stays transaction-local and never enters a serializable
  // admission/snapshot result. Publish it only after every current check passed.
  if (registry) onConnectionRegistry?.(registry);
  if(bindingFacts)currentBindingRead?.onFacts(bindingFacts);
  return { row, snapshot, policy, reviewed, reference };
}
export async function assertOwnerConnectionRegistration(tx: AppRunTransaction, registration: typeof appRuntimeRegistrations.$inferSelect,
  input: { owner_user_id: string; resource_key?: string; action_key?: string; lockedReviewed?: LockedReviewedApp; onConnectionRegistry?: (registry: AppConnectionSessionRegistry) => void;
    currentBindingRead?:CurrentBindingRead }) {
  if (!registration.owner_connection_admission_id || !registration.owner_connection_admission_digest) throw ownerConnectionDenied();
  const binding=input.currentBindingRead?.binding;
  if(binding&&(registration.state!=='active'||binding.state!=='active'||binding.org_id!==registration.org_id
    ||binding.owner_user_id!==input.owner_user_id||binding.runtime_registration_id!==registration.id
    ||binding.app_installation_id!==registration.app_installation_id||binding.app_version_id!==registration.app_version_id
    ||binding.grant_snapshot_id!==registration.grant_snapshot_id||input.resource_key&&binding.resource_key!==input.resource_key))throw ownerConnectionDenied();
  let facts:CurrentOwnerConnectionBindingFacts|undefined;
  const admission = await loadOwnerConnectionAdmission(tx, registration.org_id, { admission_id: registration.owner_connection_admission_id,
    admission_digest: registration.owner_connection_admission_digest }, input.lockedReviewed, input.owner_user_id, input.onConnectionRegistry,
    binding?{binding,onFacts:value=>{facts=value;}}:undefined);
  if (registration.reviewed_by_user_id !== input.owner_user_id || registration.operator_user_id !== admission.row.operator_user_id
    || registration.app_installation_id !== admission.row.app_installation_id || registration.app_version_id !== admission.row.app_version_id
    || registration.grant_snapshot_id !== admission.row.grant_snapshot_id || input.resource_key && input.resource_key !== admission.policy.resource_key
    || input.action_key && !admission.policy.action_keys.includes(input.action_key)) throw ownerConnectionDenied();
  if(input.currentBindingRead){if(!facts)throw ownerConnectionDenied();input.currentBindingRead.onFacts(facts);}
  return admission;
}
