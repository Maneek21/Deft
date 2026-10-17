import {and,eq,sql} from 'drizzle-orm';
import {appInstallations,appVersions,appGrantSnapshots,appRuntimeRegistrations,appResourceBindings,appRuntimeBindings,orgMembers,users} from '@deft/db/schema';
import {AppConnectionPinsSchema,type AppConnectionPins,type AppConnectionProjection} from './app-connection-contract.js';
import {assertExperienceWeb,type ExperienceCaller} from './app-experience-service.js';
import {samplePrivateAccessClock} from './app-private-access-clock.js';
import {exposureUnavailable} from './app-experience-exposure-contract.js';
import type {ExperienceExposureTransaction} from './app-experience-exposure-db.js';

/** Cleanup has its own owner authority. Retained rows nominate exact custody;
 * revoked consent, inactive app state and expired read/Send leases grant no I/O
 * and cannot prevent the current human owner discarding their own credentials. */
export async function loadOwnerConnectionCleanup(tx:ExperienceExposureTransaction,caller:ExperienceCaller,rawPins:AppConnectionPins,
 purpose:'status'|'disconnect',clock:()=>Date=()=>new Date(),signal?:AbortSignal):Promise<AppConnectionProjection>{
 const pins=AppConnectionPinsSchema.parse(rawPins);signal?.throwIfAborted();
 if(pins.org_id!==caller.org_id||pins.owner_user_id!==caller.user_id||!Number.isFinite(caller.access_expires_at))throw exposureUnavailable();
 // Follow the normal member -> App -> registration -> binding -> web lock order.
 await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${caller.org_id} AND user_id=${caller.user_id} FOR SHARE`);
 const [member]=await tx.select().from(orgMembers).where(and(eq(orgMembers.org_id,caller.org_id),eq(orgMembers.user_id,caller.user_id))).limit(1);
 const [human]=await tx.select({kind:users.kind}).from(users).where(eq(users.id,caller.user_id)).limit(1);
 if(!member?.is_active||member.role==='guest'||human?.kind!=='human')throw exposureUnavailable();
 const [installation]=await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id,caller.org_id),eq(appInstallations.id,pins.installation_id))).limit(1).for('share');
 const [version]=await tx.select().from(appVersions).where(and(eq(appVersions.org_id,caller.org_id),eq(appVersions.id,pins.app_version_id),eq(appVersions.installation_id,pins.installation_id))).limit(1).for('share');
 const [grant]=await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id,caller.org_id),eq(appGrantSnapshots.id,pins.grant_snapshot_id),eq(appGrantSnapshots.app_installation_id,pins.installation_id),eq(appGrantSnapshots.app_version_id,pins.app_version_id))).limit(1).for('share');
 if(!installation||installation.org_id!==caller.org_id||installation.id!==pins.installation_id
  ||!version||version.org_id!==caller.org_id||version.id!==pins.app_version_id||version.installation_id!==pins.installation_id
  ||!['5','6','7'].includes(version.protocol_version)||!grant||grant.org_id!==caller.org_id||grant.id!==pins.grant_snapshot_id
  ||grant.app_installation_id!==pins.installation_id||grant.app_version_id!==pins.app_version_id||grant.snapshot_kind!=='effective')throw exposureUnavailable();
 const [locator]=await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id,caller.org_id),eq(appResourceBindings.id,pins.resource_binding_id),eq(appResourceBindings.owner_user_id,caller.user_id))).limit(1);
 if(!locator)throw exposureUnavailable();
 const [registration]=await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id,caller.org_id),eq(appRuntimeRegistrations.id,locator.runtime_registration_id))).limit(1).for('share');
 const [binding]=await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id,caller.org_id),eq(appResourceBindings.id,pins.resource_binding_id),eq(appResourceBindings.owner_user_id,caller.user_id))).limit(1).for('share');
 if(!registration||!binding||binding.id!==pins.resource_binding_id||binding.owner_user_id!==caller.user_id||binding.org_id!==caller.org_id
  ||registration.org_id!==caller.org_id||binding.runtime_registration_id!==registration.id
  ||[binding,registration].some(row=>row.app_installation_id!==pins.installation_id||row.app_version_id!==pins.app_version_id||row.grant_snapshot_id!==pins.grant_snapshot_id)
  ||binding.target_key!==pins.target_key||binding.resource_key!==pins.resource_key||typeof binding.descriptor_digest!=='string')throw exposureUnavailable();
 if(pins.action_binding_id){
  const [action]=await tx.select().from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,caller.org_id),eq(appRuntimeBindings.id,pins.action_binding_id))).limit(1).for('share');
  if(!action||action.org_id!==caller.org_id||action.id!==pins.action_binding_id||action.app_installation_id!==pins.installation_id||action.app_version_id!==pins.app_version_id||action.grant_snapshot_id!==pins.grant_snapshot_id||action.action_key!==pins.action_key
   ||action.owner_resource_binding_id!==null&&action.owner_resource_binding_id!==binding.id||action.owner_resource_binding_id===null&&pins.target_key!=='primary')throw exposureUnavailable();
 }
 const web=await assertExperienceWeb(tx,caller),current=await samplePrivateAccessClock(tx,clock);
 const expires_at=Math.min(caller.access_expires_at!,web.expires_at.getTime());signal?.throwIfAborted();
 if(expires_at<=current.current().getTime())throw exposureUnavailable();
 // Empty operations/content policy is deliberate. This projection can only
 // inspect or discard the exact retained account; it admits no provider access.
 return Object.freeze({...pins,purpose,web_session_id:caller.sid,experience_session_id:caller.sid,
  runtime_registration_id:registration.id,descriptor_digest:binding.descriptor_digest,allowed_operations:[],
  lifecycle_epoch:installation.lifecycle_epoch,grant_epoch:installation.grant_epoch,runtime_epoch:registration.runtime_epoch,
  expires_at,checked_at:current.current().getTime()});
}
