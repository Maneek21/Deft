import {currentIntegrationPolicyAuthority,type AppIntegrationPolicyAuthority} from './app-integration-policy-authority.js';
export type {AppIntegrationPolicyAuthority} from './app-integration-policy-authority.js';
import {currentAppConnectionReadAuthority} from './app-connection-session-authority.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {AppDataRuntimeAuthorityRequestSchema,type AppDataRuntimeRequest} from '@deft/app-kit';
import {appConnectionSessions,orgMembers,users} from '@deft/db/schema';
import {db} from './db.js';
import {currentConnectionSessionLocators} from './app-connection-current-locators.js';
import {currentAppDataAuthority,appDataDenied,appDataDigest} from './app-data-authority.js';
import type {AppIntegrationToolOperation} from '../../../../packages/app-kit/src/app-integration-tools.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {loadLiveAttachmentSyncBindingAuthority} from './app-attachment-sync-authority.js';
import {currentAppIntegrationToolPrincipal,type AppIntegrationToolCaller} from './app-integration-tool-authority.js';
import {createAppIntegrationDataGateway,type AppIntegrationInvocation,type AppIntegrationAccountScope} from './app-integration-data-gateway.js';
import type {AppIntegrationSourceCaller} from './app-integration-source.js';
import type {AppIntegrationSourcePurpose} from '../../../../packages/app-kit/src/app-integration-source.js';
import type {AppRunTransaction} from './app-run-repository.js';
const callerSchema=z.strictObject({org_id:z.string().min(1),user_id:z.string().min(1),kind:z.enum(['human','defty','personal_mcp','capture_policy','notification_policy']),
 principal_id:z.string().min(1),access_expires_at:z.number().finite().optional(),authorization_version:z.number().int().positive().optional(),
 conversation_id:z.string().min(1).optional(),employee_id:z.string().min(1).optional(),
 capture_delivery:z.strictObject({job_id:z.string().min(1),lock_token:z.string().min(1),policy_revision:z.number().int().positive()}).optional(),
 notification_delivery:z.strictObject({job_id:z.string().min(1),lock_token:z.string().min(1),policy_revision:z.number().int().positive()}).optional()});
const targetSchema=z.strictObject({installation_id:z.string().min(1),account_ref:z.string().min(1).max(512),store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)});
const metadataSchema=z.strictObject({caller:callerSchema,target:targetSchema,authority:AppDataRuntimeAuthorityRequestSchema});
/** Public caller extraction is Host-owned. These metadata fields are never
 * accepted in an App/Runtime request and contain no bearer or input content. */
export function createPostgresAppIntegrationDataGateway(options:{policyAuthority:AppIntegrationPolicyAuthority;notificationAuthority?:AppIntegrationPolicyAuthority}){
 async function account(caller:AppIntegrationSourceCaller,target:AppIntegrationAccountScope,purpose:AppIntegrationSourcePurpose,tx?:AppRunTransaction,tool?:{operation:AppIntegrationToolOperation;action?:{action_key:string;action_binding_id:string}}){
  const actor=callerSchema.parse(caller),owner={org_id:actor.org_id,user_id:actor.user_id};
  if((actor.kind==='capture_policy')!==(purpose==='knowledge_capture')||(actor.kind==='notification_policy')!==(purpose==='notification_projection'))throw appDataDenied();
  const candidates=await currentConnectionSessionLocators(tx??db,owner,target.installation_id).limit(17);
  if(candidates.length>16)throw appDataDenied();
  const matches=candidates.filter(({session})=>{const row=session.record as {account?:{account_ref?:string}};return row.account?.account_ref===target.account_ref;});
  if(matches.length!==1)throw appDataDenied();const stored=matches[0]!.session;
  const record=stored.record as {scope:{resource_binding_id:string};session_id:string;revision:number};
  // The ordinary reviewed account reader is reused with an actual principal
  // guard. A web session is required only for actual human browser callers.
  const access=actor.access_expires_at??Date.now()+30000;
  let principalIdentity='',principalExpiry=access;
  const guard=Object.assign(async(transaction:AppRunTransaction)=>{
   if(actor.kind==='capture_policy'||actor.kind==='notification_policy'){
    // Policy/job locks come after App/member/account locks below. Membership
    // and live binding authority are independently checked by the reader.
    const [member]=await transaction.select().from(orgMembers).where(and(eq(orgMembers.org_id,owner.org_id),eq(orgMembers.user_id,owner.user_id))).for('share');
    const [human]=await transaction.select({kind:users.kind}).from(users).where(eq(users.id,owner.user_id));
    if(!member?.is_active||member.role==='guest'||human?.kind!=='human')throw appDataDenied();return;
   }
   if(!Number.isFinite(actor.access_expires_at)||actor.kind==='personal_mcp'&&!actor.authorization_version)throw appDataDenied();
   const result=await currentAppIntegrationToolPrincipal(transaction,actor as AppIntegrationToolCaller);
   principalIdentity=result.identity;principalExpiry=Math.min(principalExpiry,result.expires_at);
  },{current_web_session_expires_at:()=>new Date(principalExpiry)});
  const reviewed=await currentAppDataAuthority({...owner,access_expires_at:access},stored.session_id,target.store_key,guard,false,undefined,tool?.action??'none');
  if(reviewed.connection.account_ref!==target.account_ref||reviewed.scope.resource_binding_id!==record.scope.resource_binding_id)throw appDataDenied();
  if(tx){
   const locked=await currentAppConnectionReadAuthority({...owner,access_expires_at:access},{installation_id:reviewed.scope.installation_id,target_key:reviewed.scope.target_key},guard,tool?.action??'none',tx);
   if(!isDeepStrictEqual(locked.scope,reviewed.scope)||!isDeepStrictEqual(locked.action_consents??[],reviewed.action_consents??[])
    ||!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:owner.org_id,owner_user_id:owner.user_id,session_id:stored.session_id,purpose:'saved_read'}))throw appDataDenied();
   const live=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:owner.org_id,resource_binding_id:reviewed.scope.resource_binding_id,clock:()=>new Date()});
   const [session]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,owner.org_id),eq(appConnectionSessions.owner_user_id,owner.user_id),eq(appConnectionSessions.session_id,stored.session_id))).for('share');
   if(!live||live.binding.owner_user_id!==owner.user_id||live.version.id!==reviewed.scope.app_version_id||live.grant.id!==reviewed.scope.grant_snapshot_id
    ||live.installation.lifecycle_epoch!==reviewed.scope.lifecycle_epoch||live.installation.grant_epoch!==reviewed.scope.grant_epoch
    ||!session||!isDeepStrictEqual(session.record,stored.record))throw appDataDenied();
   await guard(tx);
  }
  let permission:{identity:string;expires_at:number};
  let delegated_grant:{id:string;revision:number;digest:string}|undefined;
  if(actor.kind==='capture_policy'||actor.kind==='notification_policy')permission=await currentIntegrationPolicyAuthority(options,actor,{...target,resource_binding_id:reviewed.scope.resource_binding_id},purpose,tx);
  else if(actor.kind==='human')permission={identity:principalIdentity,expires_at:principalExpiry};
  else{
   const result=await (tx??db).execute(sql`SELECT id, revision, operations, expires_at FROM app_integration_principal_grants
    WHERE org_id=${owner.org_id} AND owner_user_id=${owner.user_id} AND installation_id=${target.installation_id}
    AND resource_binding_id=${reviewed.scope.resource_binding_id} AND account_ref=${target.account_ref} AND store_key=${target.store_key}
    AND principal_kind=${actor.kind} AND principal_id=${actor.principal_id} AND revoked_at IS NULL FOR SHARE`);
   const rows=result.rows as {id:string;revision:number;operations:string[];expires_at:Date|string}[];
   const operation=tool?.operation??'read';
   if(rows.length!==1||!rows[0]!.operations.includes(operation))throw appDataDenied();
   const row=rows[0]!;permission={identity:JSON.stringify([principalIdentity,row.id,row.revision,operation]),expires_at:Math.min(principalExpiry,new Date(row.expires_at).getTime())};
   if(tool)delegated_grant={id:row.id,revision:row.revision,digest:appDataDigest({kind:'independent_integration_tool_grant',id:row.id,revision:row.revision,principal:principalIdentity,
    target:{...target,resource_binding_id:reviewed.scope.resource_binding_id},operation,expires_at:new Date(row.expires_at).toISOString()})};
  }
  const expires_at=Math.min(reviewed.expires_at,permission.expires_at);
  if(!permission.identity||!Number.isFinite(expires_at)||expires_at<=Date.now())throw appDataDenied();
  if(tool&&!delegated_grant)throw appDataDenied();
  return {...reviewed,...(delegated_grant?{delegated_grant}:{}),authority:{consent_id:delegated_grant?.id??null,consent_digest:delegated_grant?.digest??null,data_policy_digest:reviewed.data_policy_digest},
   resource_binding_id:reviewed.scope.resource_binding_id,resource_key:reviewed.scope.resource_key,
   identity:JSON.stringify([permission.identity,reviewed.scope,reviewed.connection,reviewed.data_policy_digest,...(tool?[reviewed.action_consents??[]]:[])]),expires_at};
 }
 const journal={
  async begin(row:AppIntegrationInvocation){const context=metadataSchema.parse({caller:row.caller,target:row.target,authority:row.context});
   if(Buffer.byteLength(JSON.stringify(context))>32768)throw appDataDenied();
   const result=await db.execute(sql`INSERT INTO app_integration_data_invocations(request_id,org_id,owner_user_id,installation_id,principal_kind,principal_id,purpose,
    authority_identity,authority_expires_at,operation,input_digest,context,state,revision,expires_at)
    VALUES(${row.context.request_id},${row.caller.org_id},${row.caller.user_id},${row.target.installation_id},${row.caller.kind},${row.caller.principal_id},${row.purpose},
    ${row.identity},${new Date(row.authority_expires_at)},${row.context.operation},${row.context.input_digest},${JSON.stringify(context)}::jsonb,'inflight',1,${new Date(row.context.expires_at)})
    ON CONFLICT(request_id) DO NOTHING RETURNING request_id`);return result.rows.length===1;},
  async read(id:string):Promise<AppIntegrationInvocation|null>{const result=await db.execute(sql`SELECT * FROM app_integration_data_invocations WHERE request_id=${id}`);
   const row=result.rows[0] as {context:unknown;authority_identity:string;authority_expires_at:Date|string;purpose:AppIntegrationSourcePurpose;state:AppIntegrationInvocation['state']}|undefined;
   if(!row)return null;const context=metadataSchema.parse(row.context);return {caller:context.caller,target:context.target,purpose:row.purpose,
    identity:row.authority_identity,authority_expires_at:new Date(row.authority_expires_at).getTime(),context:context.authority,state:row.state};},
  async finish(id:string,state:'completed'|'indeterminate'){await db.execute(sql`UPDATE app_integration_data_invocations SET state=${state},revision=revision+1,updated_at=clock_timestamp()
    WHERE request_id=${id} AND state='inflight'`);}
 };
 const gateway=createAppIntegrationDataGateway({account,journal,
  async authenticate(scope,authorization){(await getAppConnectionSessionRegistry()).authenticate(scope,authorization);},
  async transport(reviewed,request,signal){return (await getAppConnectionSessionRegistry()).dataRuntime(reviewed.scope,reviewed.profile as Parameters<Awaited<ReturnType<typeof getAppConnectionSessionRegistry>>['dataRuntime']>[1]).request(request,signal);}
 });
 return Object.freeze({...gateway,toolAccount:(caller:AppIntegrationToolCaller,target:AppIntegrationAccountScope,operation:AppIntegrationToolOperation,tx?:AppRunTransaction,action?:{action_key:string;action_binding_id:string})=>account(caller,target,'tool_read',tx,{operation,...(action?{action}:{})})});
}
