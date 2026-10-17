import {appConsentDeadline,type AppConsentLifetime} from '@deft/app-kit';
import {and,eq} from 'drizzle-orm';
import {orgMembers,users,webSessions,appResourceBindings,type appRuntimeBindings,type appRuntimeRegistrations} from '@deft/db/schema';
import {loadRuntimeOwnerTarget} from './app-runtime-owner-target.js';
import type {AppRunTransaction} from './app-run-repository.js';
import {APP_RUNTIME_SESSION_MS} from './app-runtime-contract.js';

export type RuntimeRenewalPins={renewable_until:Date|null;renewal_web_session_id:string|null;renewal_operator_role:string|null;renewal_lifetime?:AppConsentLifetime|null};
export const runtimeRenewalOptedIn=(pins:RuntimeRenewalPins)=>[pins.renewable_until,pins.renewal_web_session_id,pins.renewal_operator_role,pins.renewal_lifetime].some(value=>value!=null);
export async function runtimeRenewalTargetOwner(tx:AppRunTransaction,orgId:string,resourceId:string|null){
 if(!resourceId)return undefined;
 const [row]=await tx.select({owner:appResourceBindings.owner_user_id}).from(appResourceBindings).where(and(eq(appResourceBindings.org_id,orgId),eq(appResourceBindings.id,resourceId)));
 if(!row?.owner)throw Error('Runtime target unavailable');return row.owner;
}
export async function runtimeRenewalTargetDeadline(tx:AppRunTransaction,binding:typeof appRuntimeBindings.$inferSelect,registration:typeof appRuntimeRegistrations.$inferSelect,participants:readonly string[],persistent=false){
 const owner=await runtimeRenewalTargetOwner(tx,registration.org_id,binding.owner_resource_binding_id);if(!owner){if(persistent)throw Error('Persistent renewal requires owner target');return undefined;}
 if(!participants.includes(owner))throw Error('Runtime target changed');
 const target=await loadRuntimeOwnerTarget(tx,{org_id:registration.org_id,owner_user_id:owner,resource_binding_id:binding.owner_resource_binding_id!,installation_id:registration.app_installation_id,app_version_id:registration.app_version_id,grant_snapshot_id:registration.grant_snapshot_id,operator_user_id:registration.operator_user_id,prelocked_participant_ids:participants});
 const deadline=appConsentDeadline(target.binding.consent_expires_at,target.binding.consent_lifetime??undefined);
 if(persistent&&deadline!==Infinity)throw Error('Persistent renewal requires persistent owner consent');
 return deadline===Infinity?undefined:target.binding.consent_expires_at!;
}
/** Called after the existing membership/App/runtime locks. SID remains last. */
export async function runtimeRenewalPrincipal(tx:AppRunTransaction,input:{org_id:string;operator_user_id:string;sid:string;role:string},now:Date,lock=true){
 const query=tx.select().from(webSessions).where(and(eq(webSessions.id,input.sid),eq(webSessions.org_id,input.org_id),eq(webSessions.user_id,input.operator_user_id)));
 const [web]=await (lock?query.for('share'):query);
 const [member]=await tx.select({role:orgMembers.role,active:orgMembers.is_active}).from(orgMembers).where(and(eq(orgMembers.org_id,input.org_id),eq(orgMembers.user_id,input.operator_user_id)));
 const [human]=await tx.select({kind:users.kind,is_agent:users.is_agent}).from(users).where(eq(users.id,input.operator_user_id));
 return web&&!web.revoked_at&&web.expires_at>now&&member?.active&&member.role===input.role&&['owner','admin','member'].includes(input.role)&&human?.kind==='human'&&human.is_agent===false?web.expires_at:null;
}
/** Persistent service permission follows the current named human and role,
 * not the browser session that originally reviewed issuance. */
export async function runtimeRenewalPersistentPrincipal(tx:AppRunTransaction,input:{org_id:string;operator_user_id:string;role:string}){
 const [member]=await tx.select({role:orgMembers.role,active:orgMembers.is_active}).from(orgMembers).where(and(eq(orgMembers.org_id,input.org_id),eq(orgMembers.user_id,input.operator_user_id)));
 const [human]=await tx.select({kind:users.kind,is_agent:users.is_agent}).from(users).where(eq(users.id,input.operator_user_id));
 return !!member?.active&&member.role===input.role&&['owner','admin','member'].includes(input.role)&&human?.kind==='human'&&human.is_agent===false;
}
export function runtimeRenewalDeadline(input:{now:Date;current_expires_at:Date;expected_expires_at:Date;renewable_until:Date|null;principal_expires_at:Date|null;target_expires_at?:Date;renewal_lifetime?:AppConsentLifetime}){
 const values=[input.now,input.current_expires_at,input.expected_expires_at,...(input.renewable_until?[input.renewable_until]:[]),...(input.principal_expires_at?[input.principal_expires_at]:[]),...(input.target_expires_at?[input.target_expires_at]:[])].map(value=>value.getTime());
 if(values.some(value=>!Number.isFinite(value))||(input.renewal_lifetime==='until_revoked'?(input.renewable_until!==null||input.principal_expires_at!==null):(!input.renewable_until||!input.principal_expires_at)))return null;
 const ceiling=Math.min(input.renewable_until?.getTime()??Infinity,input.principal_expires_at?.getTime()??Infinity,input.target_expires_at?.getTime()??Infinity),current=input.current_expires_at.getTime();
 if(current<=input.now.getTime()||current>ceiling||input.expected_expires_at.getTime()>current)return null;
 // An older expectation is a lost-ACK/concurrent replay: return current state.
 return new Date(input.expected_expires_at.getTime()<current?current:Math.min(ceiling,Math.max(current,input.now.getTime()+APP_RUNTIME_SESSION_MS)));
}
