import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {appRuntimeRegistrations,orgMembers} from '@deft/db/schema';
import type {AppConnectionSessionScope} from '@deft/app-kit/core';
import type {ModuleActor} from '@deft/shared/modules';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {currentAppConnectionReadAuthority} from './app-connection-session-authority.js';
import {runtimeRenewalPersistentPrincipal} from './app-runtime-renewal.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';

export const RuntimeBackgroundAccessRequestSchema=z.strictObject({registration:z.strictObject({
 org_id:z.string().uuid(),runtime_registration_id:z.string().uuid(),operator_user_id:z.string().uuid(),
 runtime_epoch:z.number().int().positive(),profile_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),
 target_key:z.string().min(1).max(128),resource_key:z.string().min(1).max(128),
})});
const guards=new WeakSet<WebAuthorityGuard>();
export const isRuntimeServiceGuard=(guard:WebAuthorityGuard|undefined)=>!!guard&&guards.has(guard);
const denied=()=>new AppError('Background access requires reconnect','APP_ACCESS_DENIED',403);
const distant=()=>new Date(8_640_000_000_000_000);

/** A deployment credential nominates only its own operator/registration. The
 * configured service identity is enrollment; an old bearer is never authority.
 * The ordinary live readers still validate current membership, consent, grant,
 * deployment and all reviewed bindings at issuance and every operation. */
export async function runtimeBackgroundAccessAuthority(raw:unknown,authorization:string|undefined){
 const {registration}=RuntimeBackgroundAccessRequestSchema.parse(raw);
 const [locator]=await db.select().from(appRuntimeRegistrations).where(and(
  eq(appRuntimeRegistrations.org_id,registration.org_id),eq(appRuntimeRegistrations.id,registration.runtime_registration_id))).limit(1);
 if(!locator)throw denied();
 const registry=await getAppConnectionSessionRegistry();
 const nomination={...registration,installation_id:locator.app_installation_id} as AppConnectionSessionScope;
 // Authenticate against operator configuration before resolving any owner data.
 registry.authenticate(nomination,authorization);
 const caller={org_id:registration.org_id,user_id:registration.operator_user_id,access_expires_at:distant().getTime()};
 const target={installation_id:locator.app_installation_id,target_key:registration.target_key};
 const base=Object.assign(async(_tx:AppRunTransaction)=>{}, {current_web_session_expires_at:distant});
 const current=await currentAppConnectionReadAuthority(caller,target,base,'none');
 const scope=current.scope;
 if(scope.owner_user_id!==registration.operator_user_id||scope.runtime_registration_id!==registration.runtime_registration_id
  ||scope.runtime_epoch!==registration.runtime_epoch||scope.profile_digest!==registration.profile_digest||scope.resource_key!==registration.resource_key
  ||scope.consent_lifetime!=='until_revoked')throw denied();
 registry.authenticate(scope,authorization);
 const principal=async(tx:AppRunTransaction)=>{
  const [row]=await tx.select({role:orgMembers.role}).from(orgMembers).where(and(eq(orgMembers.org_id,scope.org_id),
   eq(orgMembers.user_id,scope.operator_user_id))).limit(1);
  if(!row||!await runtimeRenewalPersistentPrincipal(tx,
   {org_id:scope.org_id,operator_user_id:scope.operator_user_id,role:row.role}))throw denied();
  return row;
 };
 const enrolled=await db.transaction(principal);
 const guard:WebAuthorityGuard=Object.assign(async(tx:AppRunTransaction)=>{
  registry.authenticate(scope,authorization);
  // Reuse the exact current-scope reader within the issuing transaction. No
  // recursive guard and no fake browser session are introduced.
  const live=await currentAppConnectionReadAuthority(caller,target,base,'none',tx);
  if(JSON.stringify(live.scope)!==JSON.stringify(scope))throw denied();
  const row=await principal(tx);
  if(row.role!==enrolled.role)throw denied();
 },{current_web_session_expires_at:distant});
 guards.add(guard);
 const actor:ModuleActor={kind:'human',org_id:scope.org_id,actor_id:scope.operator_user_id,
  role:enrolled.role as 'owner'|'admin'|'member',source:'rest',scopes:[]};
 // The legacy SID column accepts nonempty enrollment provenance. Persistent
 // service renewal never interprets this value as a browser session identifier.
 return {actor,caller:{...caller,sid:'runtime-service:'+scope.runtime_registration_id},guard,scope,profile:current.profile};
}
