import {verifiedPreparedRecordAction} from './app-data-prepared-effect.js';
import {and,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {appVersions,appGrantSnapshots,appRuntimeBindings} from '@deft/db/schema';
import {db} from './db.js';
import {AppIntegrationToolsDeclarationSchema,AppIntegrationToolRequestSchema,AppIntegrationToolRuntimeRequestSchema,AppIntegrationToolRuntimeResultSchema,AppIntegrationToolRuntimeAuthorityRequestSchema,type AppIntegrationToolDeclaration} from '../../../../packages/app-kit/src/app-integration-tools.js';
import {parseAppIntegrationToolInput} from './app-integration-tools.js';
import {getAppIntegrationDataGateway} from './app-integration-runtime-gateway.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {IntegrationCallerSchema,toolMetadata,assertToolCallback,integrationDigest,preparedLocator,type IntegrationToolJournalRow} from './app-integration-tool-journal.js';
import {beginIntegrationTool,readIntegrationTool,finishIntegrationTool} from './app-integration-tool-store.js';
import type {AppIntegrationToolCaller} from './app-integration-tool-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';
const denied=()=>Error('APP_INTEGRATION_TOOL_ACCESS_DENIED');
export async function currentToolDeclaration(scope:{org_id:string;app_version_id:string;grant_snapshot_id:string},key:string,tx:Pick<AppRunTransaction,'select'>=db){
 const [version]=await tx.select().from(appVersions).where(and(eq(appVersions.org_id,scope.org_id),eq(appVersions.id,scope.app_version_id)));
 const [grant]=await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id,scope.org_id),eq(appGrantSnapshots.id,scope.grant_snapshot_id)));
 const declarations=AppIntegrationToolsDeclarationSchema.parse((version?.manifest as Record<string,unknown>|undefined)?.integration_tools);
 if(!grant||!isDeepStrictEqual(declarations,(grant.canonical_snapshot as Record<string,unknown>).integration_tools))throw denied();
 const declaration=declarations.find(row=>row.key===key&&row.visibility==='delegated_tools');if(!declaration)throw denied();return declaration;
}
async function actionBinding(caller:AppIntegrationToolCaller,target:{installation_id:string;resource_binding_id:string},declaration:AppIntegrationToolDeclaration,tx?:AppRunTransaction){
 if(!declaration.action_key)return undefined;
 const rows=await (tx??db).select().from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,caller.org_id),eq(appRuntimeBindings.app_installation_id,target.installation_id),
  eq(appRuntimeBindings.owner_resource_binding_id,target.resource_binding_id),eq(appRuntimeBindings.reviewed_by_user_id,caller.user_id),eq(appRuntimeBindings.action_key,declaration.action_key),eq(appRuntimeBindings.state,'active'))).limit(2).for('share');
 if(rows.length!==1)throw denied();return {action_key:declaration.action_key,action_binding_id:rows[0]!.id};
}
/** Reconstructs authority only from the original row. HTTP lease expiry is used
 * only for dispatch/callback; later review is bounded by original grant expiry. */
export async function currentOriginalTool(row:IntegrationToolJournalRow,tx?:AppRunTransaction){
 const m=row.metadata;if(m.authority_expires_at<=Date.now())throw denied();
 const declaration=await currentToolDeclaration(m.envelope.scope,m.envelope.tool_key,tx);
 const action=await actionBinding(m.caller,m.target,declaration,tx);
 const account=await getAppIntegrationDataGateway().toolAccount(m.caller,m.target,m.envelope.tool_operation,tx,action);
 if(!account.delegated_grant||!isDeepStrictEqual(account.delegated_grant,m.grant)||account.identity!==m.authority_identity
  ||!isDeepStrictEqual(account.scope,m.envelope.scope)||!isDeepStrictEqual(account.connection,m.envelope.connection)
  ||!isDeepStrictEqual(account.authority,m.envelope.authority)||integrationDigest(declaration)!==m.declaration_digest)throw denied();
 return {account,declaration,action};
}
export async function integrationToolAuthority(raw:unknown,authorization:string|undefined){
 const input=AppIntegrationToolRuntimeAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const row=await readIntegrationTool(input.request_id);if(!row||row.state!=='inflight'||Date.parse(row.metadata.envelope.expires_at)<=Date.now())throw denied();
 const {declaration}=await currentOriginalTool(row);assertToolCallback(row.metadata,declaration,input);
 const after=await readIntegrationTool(input.request_id);if(!after||after.state!=='inflight'||!isDeepStrictEqual(after.metadata,row.metadata))throw denied();
 registry.authenticate(input.scope,authorization);return {...input,allowed:true as const};
}
export async function executeIntegrationTool(caller:AppIntegrationToolCaller,raw:unknown,signal?:AbortSignal){
 const actor=IntegrationCallerSchema.parse(caller),request=AppIntegrationToolRequestSchema.parse(raw);signal?.throwIfAborted();
 // The installed version is discovered from the owner's current account, with
 // grant operation selected from the signed declaration, never tool-name guesses.
 const grants=await db.execute(sql`SELECT DISTINCT g.account_ref,g.store_key,g.resource_binding_id,v.manifest FROM app_integration_principal_grants g JOIN app_installations i ON i.org_id=g.org_id AND i.id=g.installation_id JOIN app_versions v ON v.org_id=i.org_id AND v.id=i.active_version_id WHERE g.org_id=${actor.org_id} AND g.owner_user_id=${actor.user_id} AND g.installation_id=${request.installation_id} AND g.principal_kind=${actor.kind} AND g.principal_id=${actor.principal_id} AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()`);
 const matches=grants.rows.flatMap(g=>{const parsed=AppIntegrationToolsDeclarationSchema.safeParse((g.manifest as Record<string,unknown>)?.integration_tools);
  return parsed.success?parsed.data.filter(d=>d.key===request.tool_key&&d.visibility==='delegated_tools'&&d.store_key===g.store_key).map(declaration=>({g,declaration})):[];});
 if(!matches.length||matches.some(({declaration})=>!isDeepStrictEqual(declaration,matches[0]!.declaration)))throw denied();
 const declaration=matches[0]!.declaration,input=parseAppIntegrationToolInput(declaration,request.input);
 if(declaration.mode==='catalog'){
  const accounts=[];for(const {g,declaration:d} of matches){const target={installation_id:request.installation_id,account_ref:String(g.account_ref),store_key:String(g.store_key)};
   try{const account=await getAppIntegrationDataGateway().toolAccount(actor,target,'read');await currentToolDeclaration(account.scope,d.key);accounts.push({...target,resource_binding_id:account.scope.resource_binding_id});}catch{/* No disclosure of unavailable accounts. */}}
  return {accounts};
 }
 const selected=matches.filter(({g,declaration:d})=>d.account_input_key&&input[d.account_input_key]===g.account_ref);if(selected.length!==1)throw denied();
 const target={installation_id:request.installation_id,account_ref:String(selected[0]!.g.account_ref),resource_binding_id:String(selected[0]!.g.resource_binding_id),store_key:declaration.store_key};
 const action=await actionBinding(actor,target,declaration),account=await getAppIntegrationDataGateway().toolAccount(actor,target,declaration.operation,undefined,action);
 await currentToolDeclaration(account.scope,declaration.key);
 if(!account.delegated_grant)throw denied();
 if(declaration.data_operations.includes('prepare_record_mirror')){
  // Host-side effect: the agent nominates an exact saved record for a declared
  // record-mirror policy. No runtime provider IO, no web session and no caller
  // scope; the owner's current data authority is re-derived under the agent's
  // already-validated integration grant principal and the nomination only lands
  // a pending approval card (the receipt is issued later by the human review).
  if(!action)throw denied();
  const current=await agentMirrorCurrent(actor,declaration,action,account.connection.session_id);
  const nomination=buildRecordMirrorNomination(declaration,input,current,request.request_id);
  const {nominateRecordMirror}=await import('./app-record-mirror-service.js');
  const nominated=await nominateRecordMirror(actor,current,nomination);
  return {request_id:request.request_id,state:'completed',review_required:true,action_id:nominated.action_id,approval_status:nominated.approval_status};
 }
 if(declaration.mode==='status'){
  if(!declaration.status_tool_key||!declaration.status_input_pins||!Object.keys(declaration.status_input_pins).length)throw denied();
  const filters=Object.entries(declaration.status_input_pins).map(([outer,original])=>{if(input[outer]===undefined)throw denied();return sql`j.context->'field_digests'->>${original}=${integrationDigest(input[outer])}`;});
  const rows=await db.execute(sql`SELECT j.request_id,j.accepted_run_id,r.state,r.safe_outcome FROM app_integration_data_invocations j LEFT JOIN app_runs r ON r.org_id=j.org_id AND r.id=j.accepted_run_id
   WHERE j.org_id=${actor.org_id} AND j.owner_user_id=${actor.user_id} AND j.principal_kind=${actor.kind} AND j.principal_id=${actor.principal_id} AND j.installation_id=${target.installation_id}
   AND j.context->>'kind'='tool' AND j.context->'target'->>'account_ref'=${target.account_ref} AND j.context->'target'->>'store_key'=${target.store_key}
   AND j.context->'envelope'->>'tool_key'=${declaration.status_tool_key} AND ${sql.join(filters,sql` AND `)} ORDER BY j.created_at DESC LIMIT 2`);
  if(rows.rows.length>1)throw Error('APP_INTEGRATION_STATUS_AMBIGUOUS');
  const found=rows.rows[0];if(found){const original=await readIntegrationTool(String(found.request_id));if(!original)throw denied();await currentOriginalTool(original);}
  return found?{request_id:found.request_id,run_id:found.accepted_run_id,state:found.state??'review_required',outcome:found.safe_outcome??null}:{state:'not_found'};
 }
 const source_refs=[];
 if(declaration.source_input_key){
  const nominated=input[declaration.source_input_key],ids=Array.isArray(nominated)?nominated:[nominated];
  if(!ids.length||ids.length>25||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw denied();
  const {getAppIntegrationCaptureRuntime}=await import('./app-integration-capture-service.js'),source=await getAppIntegrationCaptureRuntime();
  for(const logical_id of ids){const snapshot=await source.resolveOpaque(actor,{installation_id:target.installation_id,account_ref:target.account_ref,store_key:target.store_key},String(logical_id),'tool_read',signal);source_refs.push(snapshot.publication.target.ref);}
 }
 const outer=AppIntegrationToolRuntimeRequestSchema.parse({schema_version:'deft.app_integration_tool_runtime.v1',request_id:request.request_id,scope:account.scope,connection:account.connection,authority:account.authority,
  tool_key:declaration.key,tool_operation:declaration.operation,store_key:declaration.store_key,input,source_refs,expires_at:new Date(Math.min(Date.now()+30000,account.expires_at)).toISOString(),
  ...(declaration.mode==='review'?{prepare_expires_at:new Date(Math.min(Date.now()+300000,account.expires_at)).toISOString()}:{})});
 const metadata=toolMetadata(outer,declaration,{caller:actor,target,grant:account.delegated_grant,authority_identity:account.identity,authority_expires_at:account.expires_at});
 if(!await beginIntegrationTool(metadata)){
  const original=await readIntegrationTool(request.request_id);if(!original||original.metadata.caller.org_id!==actor.org_id||original.metadata.caller.user_id!==actor.user_id
   ||original.metadata.caller.kind!==actor.kind||original.metadata.caller.principal_id!==actor.principal_id||original.metadata.input_digest!==metadata.input_digest||original.metadata.envelope.tool_key!==metadata.envelope.tool_key||original.metadata.declaration_digest!==metadata.declaration_digest||!isDeepStrictEqual(original.metadata.target,target))throw denied();
  await currentOriginalTool(original);return {request_id:request.request_id,state:original.state,run_id:original.run_id,review_required:!!original.prepared&&!original.run_id};
 }
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(),Math.max(1,Date.parse(outer.expires_at)-Date.now()));signal?.addEventListener('abort',abort,{once:true});
 try{
  signal?.throwIfAborted();await currentOriginalTool({metadata,state:'inflight',prepared:null,run_id:null,run_input_digest:null,runtime_binding_id:null});
  const result=AppIntegrationToolRuntimeResultSchema.parse(await (await getAppConnectionSessionRegistry()).integrationToolRuntime(account.scope,account.profile).request(outer,controller.signal));
  if(result.request_id!==outer.request_id||result.tool_key!==outer.tool_key||result.tool_operation!==outer.tool_operation||result.store_key!==outer.store_key||result.input_digest!==metadata.input_digest)throw denied();
  controller.signal.throwIfAborted();await currentOriginalTool({metadata,state:'inflight',prepared:null,run_id:null,run_input_digest:null,runtime_binding_id:null});
  if(result.outcome!=='completed'){await finishIntegrationTool(outer.request_id,'indeterminate');return {request_id:outer.request_id,state:'indeterminate'};}
  if(result.data_result?.prepared)verifiedPreparedRecordAction(result.data_result.prepared,action?.action_binding_id,account.store);
  const prepared=declaration.mode==='review'?preparedLocator(result.data_result?.prepared??result.data_result?.prepared_resource):null;
  if(result.data_result&&(result.data_result.request_id!==outer.request_id||!declaration.data_operations.includes(result.data_result.operation as typeof declaration.data_operations[number])))throw denied();
  if(prepared&&(prepared.snapshot_id!==outer.request_id||prepared.action_key!==declaration.action_key||Date.parse(prepared.expires_at)>account.expires_at))throw denied();
  if(prepared?.kind==='record')for(const [field,value] of [['record_id',prepared.record_id],['expected_revision',prepared.revision]] as const){
   const pin=declaration.input_pins.find(p=>p.operation==='prepare_action'&&p.inner_field===field);
   if(!pin||metadata.field_digests[pin.outer_key]!==integrationDigest(value))throw denied();
  }
  await finishIntegrationTool(outer.request_id,'completed',prepared);
  return prepared?{request_id:outer.request_id,state:'completed',review_required:true}:result;
 }catch(error){const row=await readIntegrationTool(outer.request_id);if(row?.state==='inflight')await finishIntegrationTool(outer.request_id,'indeterminate');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** Resolves the owner's current data authority WITH consent, under the agent's
 * already-validated integration grant principal. This never uses a web session
 * and never accepts a caller-supplied scope: the principal guard is the exact
 * one the gateway applies, so a revoked/foreign grant or an inactive principal
 * yields no mirror nomination. */
async function agentMirrorCurrent(actor:AppIntegrationToolCaller,declaration:AppIntegrationToolDeclaration,action:{action_key:string;action_binding_id:string},sessionId:string){
 if(!declaration.action_key)throw denied();
 const {currentAppIntegrationToolPrincipal}=await import('./app-integration-tool-authority.js');
 const {currentAppDataAuthority,appDataDenied}=await import('./app-data-authority.js');
 const owner={org_id:actor.org_id,user_id:actor.user_id,access_expires_at:actor.access_expires_at};
 let principalExpiry=actor.access_expires_at;
 const guard=Object.assign(async(tx:AppRunTransaction)=>{
  const principal=await currentAppIntegrationToolPrincipal(tx,actor);
  if(!principal.identity||!Number.isFinite(principal.expires_at)||principal.expires_at<=Date.now())throw appDataDenied();
  principalExpiry=Math.min(principalExpiry,principal.expires_at);
 },{current_web_session_expires_at:()=>new Date(principalExpiry)});
 return currentAppDataAuthority(owner,sessionId,declaration.store_key,guard,true,undefined,{action_key:declaration.action_key,action_binding_id:action.action_binding_id});
}
/** Pure nomination assembly: the exact record plus the owner's resolved
 * store/mirror pins. The agent never names a mirror, account or lifetime; those
 * come from the signed declaration and the owner's current consent. */
export function buildRecordMirrorNomination(declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>,current:{store:{record_mirrors?:readonly {key:string;action_key:string;max_authority_seconds:number;max_attempts_per_day:number}[]};connection:{session_id:string};expires_at:number},requestId:string,now=Date.now()){
 const policy=current.store.record_mirrors?.find(row=>row.action_key===declaration.action_key);
 if(!policy)throw denied();
 const pin=declaration.input_pins.find(row=>row.operation==='prepare_record_mirror'&&row.inner_field==='record_id');
 if(!pin)throw denied();
 const recordId=input[pin.outer_key];
 if(typeof recordId!=='string')throw denied();
 return {connection_session_id:current.connection.session_id,store_key:declaration.store_key,mirror_key:policy.key,record_id:recordId,request_id:requestId,expected_revision:0,expires_at:new Date(Math.min(current.expires_at,now+policy.max_authority_seconds*1000)).toISOString(),max_attempts_per_day:policy.max_attempts_per_day};
}
