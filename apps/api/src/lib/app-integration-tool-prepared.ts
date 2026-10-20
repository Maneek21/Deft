import {verifiedPreparedRecordAction} from './app-data-prepared-effect.js';
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import {AppDataRuntimeRequestSchema,AppDataRuntimeAuthorityRequestSchema} from '@deft/app-kit/core';
import {db} from './db.js';
import type {AppRunTransaction,AppRunSafeView} from './app-run-repository.js';
import type {ExperienceCaller} from './app-experience-service.js';
import {readIntegrationTool} from './app-integration-tool-store.js';
import {currentOriginalTool} from './app-integration-tool-runtime.js';
import {integrationDigest,preparedLocator,type IntegrationToolJournalRow} from './app-integration-tool-journal.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {captureAppIntegrationPreparedProvenance,type AppIntegrationPreparedProvenance} from './app-integration-prepared-provenance.js';
const denied=()=>Error('APP_INTEGRATION_PREPARED_AUTHORITY_STALE');
function locatorInput(row:IntegrationToolJournalRow){
 const p=row.prepared;if(!p||row.state!=='completed'||Date.parse(p.expires_at)<=Date.now())throw denied();
 return {operation:p.kind==='record'?'read_prepared' as const:'read_prepared_resource_action' as const,input:{store_key:row.metadata.target.store_key,
  ...(p.kind==='resource'?{resource_key:row.metadata.envelope.scope.resource_key}:{}),snapshot_id:p.snapshot_id,snapshot_digest:p.snapshot_digest}};
}
export function originalPreparedProvenance(row:IntegrationToolJournalRow):AppIntegrationPreparedProvenance{
 const p=row.prepared;if(!p)throw denied();const m=row.metadata;
 return captureAppIntegrationPreparedProvenance({invocation_id:m.envelope.request_id,invocation_digest:integrationDigest(m),prepared_kind:p.kind,snapshot_id:p.snapshot_id,snapshot_digest:p.snapshot_digest,
  action_key:p.action_key,installation_id:m.target.installation_id,account_ref:m.target.account_ref,resource_binding_id:m.target.resource_binding_id,store_key:m.target.store_key,
  expires_at:new Date(Math.min(Date.parse(p.expires_at),m.authority_expires_at)).toISOString()});
}
export function assertOriginalPrepared(row:IntegrationToolJournalRow,p:AppIntegrationPreparedProvenance){
 if(!isDeepStrictEqual(originalPreparedProvenance(row),p)||row.state!=='completed'||Date.parse(p.expires_at)<=Date.now())throw denied();
}
/** Same original UUID, immutable read only. It cannot dispatch preparation and
 * does not use the expired HTTP lease as the original grant's deadline. */
export async function integrationPreparedReadAuthority(raw:unknown,authorization:string|undefined){
 const input=AppDataRuntimeAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const row=await readIntegrationTool(input.request_id);if(!row)throw denied();const {account}=await currentOriginalTool(row),read=locatorInput(row),m=row.metadata;
 if(input.operation!==read.operation||input.input_digest!==integrationDigest(read)||!isDeepStrictEqual(input.scope,m.envelope.scope)||!isDeepStrictEqual(input.connection,m.envelope.connection)
  ||!isDeepStrictEqual(input.authority,m.envelope.authority)||Date.parse(input.expires_at)>Math.min(account.expires_at,m.authority_expires_at,Date.parse(row.prepared!.expires_at),Date.now()+30000)
  ||Date.parse(input.expires_at)<=Date.now())throw denied();
 registry.authenticate(input.scope,authorization);return {...input,allowed:true as const};
}
export async function readOriginalPrepared(caller:ExperienceCaller,id:string,signal?:AbortSignal){
 const row=await readIntegrationTool(id);if(!row||row.metadata.caller.org_id!==caller.org_id||row.metadata.caller.user_id!==caller.user_id)throw denied();
 const {account,declaration,action}=await currentOriginalTool(row),read=locatorInput(row);
 const request=AppDataRuntimeRequestSchema.parse({schema_version:'deft.app_data_runtime.v1',request_id:id,scope:row.metadata.envelope.scope,connection:row.metadata.envelope.connection,authority:row.metadata.envelope.authority,
  ...read,expires_at:new Date(Math.min(Date.now()+30000,account.expires_at,row.metadata.authority_expires_at,Date.parse(row.prepared!.expires_at))).toISOString()});
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(),Math.max(1,Date.parse(request.expires_at)-Date.now()));signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
 try{const reply=await (await getAppConnectionSessionRegistry()).dataRuntime(account.scope,account.profile).request(request,controller.signal);
  const result=reply.result;if(!result||result.outcome!=='completed'||result.request_id!==id||result.operation!==read.operation||result.input_digest!==integrationDigest(read))throw denied();
  const prepared=result.prepared??result.prepared_resource;if(!prepared||!isDeepStrictEqual(preparedLocator(prepared),row.prepared))throw denied();
  if(result.prepared)verifiedPreparedRecordAction(result.prepared,action?.action_binding_id,account.store);
  await currentOriginalTool(row);controller.signal.throwIfAborted();return {row,account,declaration,action,prepared,provenance:originalPreparedProvenance(row)};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function guardOriginalPrepared(tx:AppRunTransaction,caller:Pick<ExperienceCaller,'org_id'|'user_id'>,p:AppIntegrationPreparedProvenance,input:Record<string,string|number|boolean>){
 const row=await readIntegrationTool(p.invocation_id,tx,true);if(!row||row.metadata.caller.org_id!==caller.org_id||row.metadata.caller.user_id!==caller.user_id)throw denied();
 assertOriginalPrepared(row,p);const current=await currentOriginalTool(row,tx),m=row.metadata,kind=row.prepared!.kind;
 const extras=[kind==='record'?'record_action_version':'resource_action_version',kind==='record'?'record_store_key':'resource_store_key','connection_session_id','connection_revision','data_consent_id','data_consent_digest','prepared_digest'];
 const original=Object.fromEntries(Object.entries(input).filter(([key])=>!extras.includes(key)));
 if(input[extras[0]!]!==(kind==='record'?'deft.app_prepared_record_action.v1':'deft.app_prepared_resource_action.v1')||input[extras[1]!]!==m.target.store_key
  ||input.snapshot_id!==p.snapshot_id||input.prepared_digest!==p.snapshot_digest||input.connection_session_id!==m.envelope.connection.session_id||input.connection_revision!==m.envelope.connection.session_revision
  ||input.data_consent_id!==m.grant.id||input.data_consent_digest!==m.grant.digest||integrationDigest(original)!==row.prepared!.input_digest)throw denied();
 return {row,...current};
}
export async function linkOriginalPrepared(tx:AppRunTransaction,caller:ExperienceCaller,run:AppRunSafeView,p:AppIntegrationPreparedProvenance,input:Record<string,string|number|boolean>){
 const {row,action}=await guardOriginalPrepared(tx,caller,p,input);if(!action)throw denied();const digest=integrationDigest(input);
 if(row.run_id!==null){if(row.run_id!==run.id||row.run_input_digest!==digest||row.runtime_binding_id!==action.action_binding_id)throw denied();return;}
 const result=await tx.execute(sql`UPDATE app_integration_data_invocations SET accepted_run_id=${run.id},accepted_input_digest=${digest},accepted_runtime_binding_id=${action.action_binding_id},revision=revision+1,updated_at=clock_timestamp() WHERE request_id=${p.invocation_id} AND state='completed' AND accepted_run_id IS NULL RETURNING request_id`);
 if(result.rows.length!==1)throw denied();
}
/** Returning null alone permits ordinary browser handling. Any nominated
 * original delegated grant/preparation forces this branch and fails closed. */
export async function authorizeReleasedIntegrationTool(n:{org_id:string;owner_id:string;installation_id:string;app_version_id:string;grant_snapshot_id:string;runtime_binding_id:string;operation_name:string;run_id?:string;input:Record<string,string|number|boolean>}):Promise<boolean|null>{
 const results=await db.execute(sql`SELECT request_id FROM app_integration_data_invocations WHERE org_id=${n.org_id} AND context->>'kind'='tool' AND (accepted_run_id=${n.run_id??''} OR prepared_locator->>'snapshot_id'=${String(n.input.snapshot_id)}) LIMIT 3`);
 if(!results.rows.length){const grant=await db.execute(sql`SELECT id FROM app_integration_principal_grants WHERE org_id=${n.org_id} AND id::text=${String(n.input.data_consent_id)} LIMIT 1`);return grant.rows.length?false:null;}
 if(!n.run_id)return false;
 return db.transaction(async tx=>{for(const item of results.rows){const row=await readIntegrationTool(String(item.request_id),tx,true);if(!row||row.run_id!==n.run_id)continue;
  const m=row.metadata;if(m.caller.user_id!==n.owner_id||m.target.installation_id!==n.installation_id||m.envelope.scope.app_version_id!==n.app_version_id||m.envelope.scope.grant_snapshot_id!==n.grant_snapshot_id
   ||row.runtime_binding_id!==n.runtime_binding_id||row.prepared?.action_key!==n.operation_name||row.run_input_digest!==integrationDigest(n.input))return false;
  await guardOriginalPrepared(tx,{org_id:n.org_id,user_id:n.owner_id},originalPreparedProvenance(row),n.input);return true;}return false;});
}
