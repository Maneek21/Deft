import {isDeepStrictEqual} from 'node:util';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {auditLog,appExperienceConsentGrants,appConnectionSessions,appResourceBindings} from '@deft/db/schema';
import {ExperienceConsentScopeSchema,experienceConsentDigest,type ExperienceConsentScope} from './app-experience-consent-contract.js';
import type {UpgradeContinuityProof,UpgradeTx} from './app-upgrade-trust-continuity.js';
import {AppError} from './app-errors.js';

type Binding={id:string;runtime_registration_id:string;descriptor_digest:string};
/** Only proven release identities may move; the actual disclosure permission
 * (including every destination, operation, declaration and deadline) is exact. */
export function sameUpgradeExperiencePermission(before:ExperienceConsentScope,after:ExperienceConsentScope,
 proof:UpgradeContinuityProof,source:Binding,target:Binding&{runtime_epoch:number}){
 if(before.org_id!==proof.org_id||before.owner_user_id!==proof.owner_id||before.installation_id!==proof.installation_id
  ||before.app_version_id!==proof.prior_version_id||before.grant_snapshot_id!==proof.source_scope.grant_snapshot_id
  ||before.lifecycle_epoch!==proof.source_scope.lifecycle_epoch||before.grant_epoch!==proof.source_scope.grant_epoch
  ||after.org_id!==proof.org_id||after.owner_user_id!==proof.owner_id||after.installation_id!==proof.installation_id
  ||after.app_version_id!==proof.version_id||after.grant_snapshot_id!==proof.grant_id
  ||after.lifecycle_epoch!==proof.lifecycle_epoch||after.grant_epoch!==proof.grant_epoch)return false;
 const projected=structuredClone(before);
 for(const key of ['app_version_id','app_name','app_version','package_digest','manifest_digest','grant_snapshot_id','grant_snapshot_digest',
  'lifecycle_epoch','grant_epoch','artifact_digest','experience_label'] as const)Object.assign(projected,{[key]:after[key]});
 for(const resource of projected.resources){
  if(resource.binding_id!==source.id)continue;
  if(resource.registration_id!==source.runtime_registration_id||resource.runtime_epoch!==proof.source_scope.runtime_epoch
   ||resource.descriptor_digest!==source.descriptor_digest)return false;
  const next=after.resources.find(r=>r.binding_id===target.id&&r.resource_key===resource.resource_key);
  if(!next||next.registration_id!==target.runtime_registration_id||next.descriptor_digest!==target.descriptor_digest||next.runtime_epoch!==target.runtime_epoch)return false;
  resource.binding_id=next.binding_id;resource.registration_id=next.registration_id;resource.runtime_epoch=next.runtime_epoch;resource.descriptor_digest=next.descriptor_digest;
 }
 return isDeepStrictEqual(projected,after);
}

/** Called only with the fresh scope from the ordinary locked Experience reader.
 * Current owner/Web, declaration and resource checks are unchanged. */
export async function acquireTrustedUpgradeExperienceConsent(tx:UpgradeTx,scope:ExperienceConsentScope){
 const digest=experienceConsentDigest(scope);
 const [revoked]=await tx.select({id:appExperienceConsentGrants.id}).from(appExperienceConsentGrants).where(and(
  eq(appExperienceConsentGrants.org_id,scope.org_id),eq(appExperienceConsentGrants.owner_user_id,scope.owner_user_id),
  eq(appExperienceConsentGrants.app_installation_id,scope.installation_id),eq(appExperienceConsentGrants.experience_key,scope.experience_key),
  eq(appExperienceConsentGrants.scope_digest,digest),sql`${appExperienceConsentGrants.revoked_at} IS NOT NULL`)).limit(1);
 if(revoked)return null;
 const candidates=await tx.select({id:auditLog.entity_id}).from(auditLog).where(and(eq(auditLog.org_id,scope.org_id),
  eq(auditLog.actor_type,'system'),eq(auditLog.action,'app.upgrade_continuity.authorized'),
  sql`${auditLog.metadata}->>'version_id'=${scope.app_version_id}`,sql`${auditLog.metadata}->>'owner_id'=${scope.owner_user_id}`,
  sql`${auditLog.metadata}->>'installation_id'=${scope.installation_id}`,
  sql`EXISTS (SELECT 1 FROM audit_log completed WHERE completed.org_id=${auditLog.org_id} AND completed.entity_id=${auditLog.entity_id}
    AND completed.actor_type='system' AND completed.action='app.upgrade_continuity.completed'
    AND completed.metadata->>'app_version_id'=${scope.app_version_id} AND completed.metadata->>'state'='installed')`)).limit(17);
 if(candidates.length>16)return null;
 const {readContinuityProof,assertContinuityProof}=await import('./app-upgrade-trust-continuity.js');
 const {AppConnectionSessionRecordSchema}=await import('./app-connection-session-service.js');
 for(const candidate of candidates){
  const proof=await readContinuityProof(tx,scope.org_id,candidate.id!);
  if(proof.owner_id!==scope.owner_user_id||proof.installation_id!==scope.installation_id||proof.version_id!==scope.app_version_id)continue;
  try{await assertContinuityProof(tx,proof,true,false);}catch(error){if(error instanceof AppError)continue;throw error;}
  const [connection]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,scope.org_id),
   eq(appConnectionSessions.owner_user_id,scope.owner_user_id),eq(appConnectionSessions.session_id,proof.request_id))).limit(1);
  const parsed=AppConnectionSessionRecordSchema.safeParse(connection?.record);
  if(!parsed.success)continue;const record=parsed.data;
  if(record.state!=='connected'||record.scope.app_version_id!==scope.app_version_id||record.scope.owner_user_id!==scope.owner_user_id
   ||record.scope.installation_id!==scope.installation_id||record.scope.grant_snapshot_id!==proof.grant_id
   ||record.scope.lifecycle_epoch!==proof.lifecycle_epoch||record.scope.grant_epoch!==proof.grant_epoch)continue;
  const bindings=await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id,scope.org_id),
   sql`${appResourceBindings.id} IN (${proof.source_scope.resource_binding_id},${record.scope.resource_binding_id})`));
  const source=bindings.find(b=>b.id===proof.source_scope.resource_binding_id),target=bindings.find(b=>b.id===record.scope.resource_binding_id);
  if(!source||!target||target.state!=='active'||target.app_version_id!==scope.app_version_id||target.owner_user_id!==scope.owner_user_id)continue;
  const grants=await tx.select().from(appExperienceConsentGrants).where(and(eq(appExperienceConsentGrants.org_id,scope.org_id),
   eq(appExperienceConsentGrants.owner_user_id,scope.owner_user_id),eq(appExperienceConsentGrants.app_installation_id,scope.installation_id),
   eq(appExperienceConsentGrants.app_version_id,proof.prior_version_id),eq(appExperienceConsentGrants.experience_key,scope.experience_key),
   isNull(appExperienceConsentGrants.revoked_at))).limit(33).for('share');
  if(grants.length>32)continue;
  for(const grant of grants){
   const before=ExperienceConsentScopeSchema.safeParse(grant.snapshot);
   if(!before.success||experienceConsentDigest(before.data)!==grant.scope_digest||!sameUpgradeExperiencePermission(before.data,scope,proof,source,{...target,runtime_epoch:record.scope.runtime_epoch}))continue;
   const [inserted]=await tx.insert(appExperienceConsentGrants).values({org_id:scope.org_id,owner_user_id:scope.owner_user_id,
    app_installation_id:scope.installation_id,app_version_id:scope.app_version_id,experience_key:scope.experience_key,
    scope_digest:digest,snapshot:scope}).onConflictDoNothing().returning();
   if(!inserted)return null;
   await tx.insert(auditLog).values({org_id:scope.org_id,actor_type:'system',actor_id:scope.owner_user_id,
    action:'app.upgrade_continuity.experience_consent_issued',entity_type:'app_experience_consent_grant',entity_id:inserted.id,
    metadata:{proof_id:proof.request_id,source_consent_grant_id:grant.id,prior_version_id:proof.prior_version_id,app_version_id:proof.version_id}});
   return inserted;
  }
 }
 return null;
}
