import {isDeepStrictEqual} from 'node:util';
import type {AppRunTransaction} from './app-run-repository.js';
import type {AppIntegrationToolOperation} from '../../../../packages/app-kit/src/app-integration-tools.js';
export type AppIntegrationToolCaller=Readonly<{org_id:string;user_id:string;kind:'human'|'defty'|'personal_mcp';
 principal_id:string;access_expires_at:number;authorization_version?:number;conversation_id?:string;employee_id?:string}>;
export type AppIntegrationToolTarget=Readonly<{installation_id:string;account_ref:string;resource_binding_id:string;store_key:string}>;
export type AppIntegrationToolGrant=Readonly<{id:string;revision:number;org_id:string;owner_user_id:string;target:AppIntegrationToolTarget;
 principal_kind:'defty'|'personal_mcp';principal_id:string;operations:readonly AppIntegrationToolOperation[];expires_at:number;revoked_at:number|null}>;
export interface AppIntegrationToolAuthorityPorts<Tx>{
 /** Verifies live human/membership, exact personal token/version or canonical
  * private Defty DM. Employee/OAuth and author-supplied actor inputs deny. */
 principal(caller:AppIntegrationToolCaller,tx?:Tx):Promise<{identity:string;expires_at:number}>;
 grants(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,tx?:Tx):Promise<readonly AppIntegrationToolGrant[]>;
 /** Current installation, signed store/resource, connected stable account,
  * independent data/action consent and custody/publication generations. */
 account(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,operation:AppIntegrationToolOperation,tx?:Tx):Promise<{identity:string;expires_at:number}>;
 clock?:()=>number;
}
const denied=()=>new Error('APP_INTEGRATION_TOOL_ACCESS_DENIED');
/** Concrete Host actor adapter. It checks a real identity, never creates a SID.
 * Token scopes alone are deliberately insufficient; the independent grant is
 * checked by current() below, then current installation/account authority. */
export async function currentAppIntegrationToolPrincipal(tx:AppRunTransaction,caller:AppIntegrationToolCaller){
 const {and,eq,isNull}=await import('drizzle-orm');
 const {orgMembers,users,webSessions,mcpTokens,agentEmployees,spaces,spaceMembers}=await import('@deft/db/schema');
 const {isCanonicalDeftyEmployee}=await import('./defty-identity.js');
 const [member]=await tx.select().from(orgMembers).where(and(eq(orgMembers.org_id,caller.org_id),eq(orgMembers.user_id,caller.user_id))).for('share');
 const [human]=await tx.select({kind:users.kind}).from(users).where(eq(users.id,caller.user_id));
 if(!member?.is_active||member.role==='guest'||human?.kind!=='human')throw denied();
 let identity:string,expires_at=caller.access_expires_at;
 if(caller.kind==='human'){
  const [session]=await tx.select().from(webSessions).where(and(eq(webSessions.org_id,caller.org_id),eq(webSessions.user_id,caller.user_id),eq(webSessions.id,caller.principal_id))).for('share');
  if(!session||session.revoked_at)throw denied();expires_at=Math.min(expires_at,session.expires_at.getTime());identity=JSON.stringify(['web',session.id,session.expires_at.toISOString()]);
 }else if(caller.kind==='personal_mcp'){
  const [token]=await tx.select().from(mcpTokens).where(and(eq(mcpTokens.org_id,caller.org_id),eq(mcpTokens.user_id,caller.user_id),eq(mcpTokens.id,caller.principal_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.revoked_at))).for('share');
  if(!token||token.agent_employee_id||token.app_run_authorization_version!==caller.authorization_version)throw denied();
  identity=JSON.stringify(['personal_mcp',token.id,token.app_run_authorization_version]);
 }else if(caller.kind==='defty'){
  if(caller.principal_id!==caller.user_id||!caller.employee_id||!caller.conversation_id)throw denied();
  const [employee]=await tx.select().from(agentEmployees).where(and(eq(agentEmployees.org_id,caller.org_id),eq(agentEmployees.id,caller.employee_id))).for('share');
  const [space]=await tx.select().from(spaces).where(and(eq(spaces.org_id,caller.org_id),eq(spaces.id,caller.conversation_id),eq(spaces.type,'dm'),eq(spaces.is_archived,false))).for('share');
  if(!employee?.is_active||!isCanonicalDeftyEmployee(employee)||!space)throw denied();
  const members=await tx.select({id:users.id,is_agent:users.is_agent,kind:users.kind}).from(spaceMembers).innerJoin(users,eq(users.id,spaceMembers.user_id)).where(eq(spaceMembers.space_id,space.id)).for('share');
  if(!employee.user_id||members.length!==2||!members.some(row=>row.id===caller.user_id&&row.kind==='human')
   ||!members.some(row=>row.id===employee.user_id&&row.is_agent&&row.kind==='agent'))throw denied();
  identity=JSON.stringify(['defty',caller.user_id,employee.id,space.id,members.map(row=>[row.id,row.kind]).sort()]);
 }else throw denied();
 if(!Number.isFinite(expires_at)||expires_at<=Date.now())throw denied();return {identity,expires_at};
}
export function createAppIntegrationToolAuthority<Tx>(ports:AppIntegrationToolAuthorityPorts<Tx>){
 const now=ports.clock??Date.now;
 async function current(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,operation:AppIntegrationToolOperation,tx?:Tx){
  if(!['human','defty','personal_mcp'].includes(caller.kind)||!Number.isFinite(caller.access_expires_at)||caller.access_expires_at<=now()
   ||caller.kind==='personal_mcp'&&(!Number.isSafeInteger(caller.authorization_version)||(caller.authorization_version??0)<1))throw denied();
  if(caller.kind==='defty'&&(!caller.conversation_id||!caller.employee_id||caller.principal_id!==caller.user_id))throw denied();
  const principal=await ports.principal(caller,tx);let grant:AppIntegrationToolGrant|undefined;
  if(caller.kind!=='human'){
   const rows=await ports.grants(caller,target,tx);if(rows.length!==1)throw denied();grant=rows[0];
   if(!grant||grant.org_id!==caller.org_id||grant.owner_user_id!==caller.user_id||grant.principal_kind!==caller.kind
    ||grant.principal_id!==caller.principal_id||!isDeepStrictEqual(grant.target,target)||grant.revoked_at!==null
    ||!grant.operations.includes(operation)||!Number.isSafeInteger(grant.revision)||grant.revision<1)throw denied();
  }
  const account=await ports.account(caller,target,operation,tx);
  const expiry=Math.min(caller.access_expires_at,principal.expires_at,account.expires_at,grant?.expires_at??Infinity);
  if(!principal.identity||!account.identity||!Number.isFinite(expiry)||expiry<=now())throw denied();
  return Object.freeze({identity:JSON.stringify([caller.kind,caller.principal_id,caller.authorization_version,principal.identity,
   grant?.id??null,grant?.revision??null,account.identity,operation]),expires_at:expiry});
 }
 return Object.freeze({current,async capture(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,operation:AppIntegrationToolOperation){
  const retained=structuredClone({caller,target});const initial=await current(retained.caller,retained.target,operation);
  return Object.freeze({...initial,async recheck(tx?:Tx){const value=await current(retained.caller,retained.target,operation,tx);
   if(value.identity!==initial.identity||initial.expires_at<=now())throw denied();return value;}});
 }});
}
